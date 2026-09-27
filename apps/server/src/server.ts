import { createServer as createHttp } from 'node:http'
import type { IncomingMessage, Server } from 'node:http'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'
import type { WebSocket } from 'ws'
import type { LlmClient, ReviewOptions } from '@redline/reviewer'
import type { Config } from './config'
import { Dashboard } from './dashboard'
import type { DashboardEvent } from './dashboard'
import type { GitHubClient } from './github'
import { KeyedQueue } from './queue'
import type { QueueOptions } from './queue'
import { verifySignature } from './signature'
import { reviewPull } from './worker'
import type { Outcome, ReviewJob } from './worker'

export interface ServerDeps {
  config: Config
  github: GitHubClient
  llm: LlmClient
  log?: (msg: string) => void
  queue?: Partial<QueueOptions>
  reviewOptions?: Partial<ReviewOptions>
  /** the live dashboard: streams review progress and learns from accept/dismiss. A fresh one is made if not given. */
  dashboard?: Dashboard
  now?: () => number
}

const DASHBOARD_HTML = fileURLToPath(new URL('../public/dashboard.html', import.meta.url))

const MAX_BODY = 2 * 1024 * 1024
const ACTIONS = new Set(['opened', 'synchronize', 'reopened', 'ready_for_review'])
const NAME = /^[A-Za-z0-9_.-]{1,100}$/
const SHA = /^[0-9a-f]{40}$/

class TooLarge extends Error {}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > MAX_BODY) { reject(new TooLarge()); req.destroy(); return }
      parts.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(parts)))
    req.on('error', reject)
  })
}

export interface RedlineServer {
  http: Server
  queue: KeyedQueue<ReviewJob>
  outcomes: { key: string; outcome: Outcome | { type: 'failed'; error: string }; at: number }[]
  dashboard: Dashboard
  listen(port: number): Promise<number>
  close(): Promise<void>
}

/**
 * Receives GitHub webhooks, and turns the ones that matter (a pull request opened, pushed to, reopened or made ready)
 * into review jobs. Everything untrusted is checked before anything is queued: the signature, the shape of the payload,
 * that the repository belongs to an allowed owner, that this delivery was not already handled, and that this pull
 * request has not used up its hourly allowance of reviews.
 */
export function createServer(deps: ServerDeps): RedlineServer {
  const { config, github, llm } = deps
  const log = deps.log ?? (() => {})
  const now = deps.now ?? Date.now
  const dashboard = deps.dashboard ?? new Dashboard()
  const outcomes: RedlineServer['outcomes'] = []
  const record = (key: string, outcome: RedlineServer['outcomes'][number]['outcome']) => { outcomes.push({ key, outcome, at: now() }); if (outcomes.length > 50) outcomes.shift() }

  const queue = new KeyedQueue<ReviewJob>(
    async (job, { signal }) => {
      const key = `${job.owner}/${job.repo}#${job.number}`
      const dashKey = key.toLowerCase()
      try {
        const outcome = await reviewPull({ github, llm, postClean: config.postClean, maxFiles: config.maxFiles, log, reviewOptions: deps.reviewOptions, dashboard }, job, signal)
        record(key, outcome)
        const comments = outcome.type === 'reviewed' ? outcome.comments : 0
        const incomplete = outcome.type === 'reviewed' && outcome.incomplete
        dashboard.jobDone(dashKey, outcome.type, comments, incomplete)
      } catch (e) {
        dashboard.jobFailed(dashKey, (e as Error).message)
        throw e
      }
    },
    {
      concurrency: config.concurrency, retries: 3, backoffMs: 2000,
      onEvent: (e) => {
        if (e.type === 'failed') record(e.key, { type: 'failed', error: e.detail ?? '' })
        log(`queue ${e.type} ${e.key}${e.detail ? `: ${e.detail}` : ''}`)
      },
      ...deps.queue,
    },
  )

  // ---- live dashboard: WebSocket broadcast + the small REST API it uses ----
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 })
  const sockets = new Set<WebSocket>()
  const send = (ws: WebSocket, e: DashboardEvent) => { try { ws.send(JSON.stringify(e)) } catch { /* client is gone */ } }
  const offEvent = dashboard.onEvent((e) => { for (const ws of sockets) send(ws, e) })

  const delivered = new Set<string>()
  const recent = new Map<string, number[]>() // pull request -> when we accepted reviews for it

  const http = createHttp(async (req, res) => {
    const send = (status: number, body: unknown) => {
      res.statusCode = status
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(body))
    }
    try {
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (req.method === 'GET' && url.pathname === '/health') {
        return send(200, { ok: true, queue: queue.stats, waitingOrRunning: queue.size, failed: queue.failed.length, recent: outcomes.slice(-10) })
      }
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/dashboard')) {
        res.setHeader('content-type', 'text/html; charset=utf-8')
        try { return res.end(await readFile(DASHBOARD_HTML)) } catch { res.statusCode = 500; return res.end('dashboard page missing') }
      }
      if (req.method === 'GET' && url.pathname === '/api/findings') {
        const key = url.searchParams.get('key') ?? undefined
        return send(200, { findings: dashboard.recentFindings(key) })
      }
      if (req.method === 'GET' && url.pathname === '/api/feedback') {
        return send(200, dashboard.feedback.snapshot())
      }
      if (req.method === 'POST' && /^\/api\/findings\/[^/]+\/(accept|dismiss)$/.test(url.pathname)) {
        const [, id, verb] = /^\/api\/findings\/([^/]+)\/(accept|dismiss)$/.exec(url.pathname) as RegExpExecArray
        const result = dashboard.act(id, verb === 'accept' ? 'accepted' : 'dismissed')
        if (!result) return send(404, { error: 'unknown finding, or it was already acted on' })
        return send(200, { ok: true, finding: result })
      }
      if (req.method !== 'POST' || url.pathname !== '/webhooks/github') return send(404, { error: 'not found' })

      let raw: Buffer
      try { raw = await readBody(req) } catch (e) { return send(e instanceof TooLarge ? 413 : 400, { error: 'bad body' }) }
      if (!verifySignature(config.webhookSecret, raw, req.headers['x-hub-signature-256'] as string | undefined)) return send(401, { error: 'bad signature' })

      const event = req.headers['x-github-event']
      const delivery = String(req.headers['x-github-delivery'] ?? '')
      if (event === 'ping') return send(200, { ok: true, pong: true })
      if (event !== 'pull_request') return send(202, { ignored: `event ${String(event)}` })

      let p: any
      try { p = JSON.parse(raw.toString('utf8')) } catch { return send(400, { error: 'bad json' }) }
      if (!ACTIONS.has(p?.action)) return send(202, { ignored: `action ${String(p?.action)}` })

      const owner = p?.repository?.owner?.login
      const repo = p?.repository?.name
      const number = p?.pull_request?.number
      const sha = p?.pull_request?.head?.sha
      const inst = p?.installation?.id
      if (typeof owner !== 'string' || !NAME.test(owner) || typeof repo !== 'string' || !NAME.test(repo) || !Number.isInteger(number) || number < 1 || typeof sha !== 'string' || !SHA.test(sha) || !Number.isInteger(inst)) {
        return send(400, { error: 'unexpected payload' })
      }
      if (!config.allowedOwners.includes(owner.toLowerCase())) { log(`ignored ${owner}/${repo}: owner not allowed`); return send(202, { ignored: 'owner not allowed' }) }
      if (p.pull_request.draft === true) return send(202, { ignored: 'draft' })
      if (p.pull_request.state && p.pull_request.state !== 'open') return send(202, { ignored: 'not open' })

      if (delivery) {
        if (delivered.has(delivery)) return send(200, { ignored: 'duplicate delivery' })
        delivered.add(delivery)
        if (delivered.size > 2000) delivered.delete(delivered.values().next().value as string)
      }

      const key = `${owner}/${repo}#${number}`.toLowerCase()
      const t = now()
      const window = (recent.get(key) ?? []).filter((x) => t - x < 3_600_000)
      if (window.length >= config.maxReviewsPerPrPerHour) { recent.set(key, window); log(`rate limit for ${key}`); return send(202, { ignored: 'too many reviews for this pull request this hour' }) }
      window.push(t)
      recent.set(key, window)

      const result = queue.enqueue(key, { owner, repo, number, headSha: sha, installationId: inst, deliveryId: delivery })
      return send(202, { queued: true, replaced: result === 'replaced' })
    } catch (e) {
      log(`webhook error: ${(e as Error).message}`)
      if (!res.headersSent) send(500, { error: 'internal error' })
    }
  })

  http.on('upgrade', (req: IncomingMessage, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname !== '/dashboard/live') { socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n'); socket.destroy(); return }
    wss.handleUpgrade(req, socket, head, (ws) => {
      sockets.add(ws)
      // a fresh viewer sees recent history at once, then live updates as they happen
      send(ws, { type: 'snapshot', findings: dashboard.recentFindings(undefined, 200), titles: dashboard.recentTitles() })
      ws.on('close', () => sockets.delete(ws))
      ws.on('error', () => sockets.delete(ws))
      ws.on('message', () => { /* the dashboard only listens; actions go through the REST API */ })
    })
  })

  return {
    http, queue, outcomes, dashboard,
    listen: (port) => new Promise((resolve) => http.listen(port, () => resolve((http.address() as { port: number }).port))),
    close: async () => {
      offEvent()
      for (const ws of sockets) ws.terminate()
      await new Promise<void>((r) => { http.close(() => r()); http.closeAllConnections?.() })
      await Promise.race([queue.idle(), new Promise((r) => setTimeout(r, 10_000))])
    },
  }
}
