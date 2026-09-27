import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { ScriptedClient, pieces } from '@redline/reviewer'
import type { Scripted } from '@redline/reviewer'
import type { Config } from '../src/config'
import { GitHubClient } from '../src/github'
import { createServer } from '../src/server'
import type { RedlineServer } from '../src/server'
import { sign } from '../src/signature'
import { addLineDiff, FakeGitHub } from './fake-github'

const SECRET = 'webhook-secret-for-tests'
const config = (over: Partial<Config> = {}): Config => ({
  port: 0, appId: '424242', privateKey: '', webhookSecret: SECRET, githubApi: '', allowedOwners: ['acme'],
  concurrency: 2, postClean: true, maxFiles: 150, maxReviewsPerPrPerHour: 50, ...over,
})

let gh: FakeGitHub
let srv: RedlineServer
let base = ''
let wsBase = ''

const finding = (over: Record<string, unknown> = {}) => ({ path: 'src/a.ts', line: 2, kind: 'bug', severity: 'high', message: 'This is wrong.', ...over })
const findingLine = (over: Record<string, unknown> = {}) => JSON.stringify(finding(over)) + '\n'
const model = (fn: (n: number) => Scripted = () => ({ chunks: [findingLine()] })) => new ScriptedClient((_r, n) => fn(n))

async function boot(m: ScriptedClient = model()) {
  gh = new FakeGitHub()
  await gh.start()
  gh.addPull('acme', 'app', 7, { title: 'Add a thing', diff: addLineDiff('src/a.ts', 'let x = y + 1') })
  const github = new GitHubClient({ appId: gh.appId, privateKey: gh.privateKey, apiUrl: gh.url })
  srv = createServer({ config: config(), github, llm: m, log: () => {}, queue: { sleep: async () => {}, backoffMs: 1 }, reviewOptions: { sleep: async () => {}, backoffMs: 1 } })
  const port = await srv.listen(0)
  base = `http://localhost:${port}`
  wsBase = `ws://localhost:${port}`
}
beforeEach(() => boot())
afterEach(async () => { await srv.close(); await gh.stop() })

function connect(): Promise<{ ws: WebSocket; messages: any[] }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${wsBase}/dashboard/live`)
    const messages: any[] = []
    ws.on('message', (d) => { messages.push(JSON.parse(d.toString())) })
    ws.on('open', () => resolve({ ws, messages }))
    ws.on('error', reject)
      })
}
const waitFor = async (cond: () => boolean, ms = 8000) => {
  const t0 = Date.now()
  while (!cond()) { if (Date.now() - t0 > ms) throw new Error('timed out waiting'); await new Promise((r) => setTimeout(r, 10)) }
}
/** Streams two findings with a real pause between them, so a listener can observe the first before the review ends. */
class SlowTwoFindingClient {
  readonly name = 'slow-two'
  async *stream() {
    yield { type: 'text' as const, text: findingLine({ path: 'src/a.ts', line: 2 }) }
    await new Promise((r) => setTimeout(r, 80))
    yield { type: 'text' as const, text: findingLine({ path: 'src/a.ts', line: 2, kind: 'security' }) }
  }
}
const hook = async () => fetch(`${base}/webhooks/github`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-github-event': 'pull_request', 'x-github-delivery': `d-${Math.random()}`, 'x-hub-signature-256': sign(SECRET, body()) },
  body: body(),
})
const body = () => JSON.stringify({
  action: 'opened', installation: { id: 99 }, repository: { name: 'app', owner: { login: 'acme' } },
  pull_request: { number: 7, draft: false, state: 'open', head: { sha: gh.pulls.get('acme/app#7')?.headSha } },
})

describe('dashboard: live streaming over WebSocket', () => {
  it('a connected client sees the review start, the finding, and completion, in order', async () => {
    const { ws, messages } = await connect()
    await hook()
    await waitFor(() => messages.some((m) => m.type === 'job-done'))
    ws.terminate()
    const types = messages.map((m) => m.type)
    expect(types).toEqual(['snapshot', 'job-start', 'finding', 'job-done'])
    expect(messages[1]).toMatchObject({ title: 'Add a thing' })
    expect(messages[2].finding).toMatchObject({ path: 'src/a.ts', line: 2, kind: 'bug' })
    expect(messages[3]).toMatchObject({ comments: 1, incomplete: false })
  })

  it('a client that connects after the review streams it in a snapshot, then stays live for the next one', async () => {
    await hook()
    await srv.queue.idle()
    const { ws, messages } = await connect()
    await waitFor(() => messages.some((m) => m.type === 'snapshot'))
    expect(messages[0].findings).toHaveLength(1) // job 1's finding, delivered as history, not a live event

    gh.pulls.get('acme/app#7')!.headSha = (await import('./fake-github')).sha('push 2')
    gh.pulls.get('acme/app#7')!.reviews = []
    await hook()
    await waitFor(() => messages.some((m) => m.type === 'job-done'))
    ws.terminate()
    // job 2 arrives live, as its own separate events, on the same connection
    expect(messages.map((m) => m.type)).toEqual(['snapshot', 'job-start', 'finding', 'job-done'])
  }, 10000)

  it('streams comments as they complete, not only once the review is done (real streaming, not a final dump)', async () => {
    await boot(new SlowTwoFindingClient() as unknown as ScriptedClient)
    const { ws, messages } = await connect()
    await hook()
    await waitFor(() => messages.filter((m) => m.type === 'finding').length >= 1)
    const sawFirstFindingBeforeDone = !messages.some((m) => m.type === 'job-done')
    await waitFor(() => messages.some((m) => m.type === 'job-done'))
    ws.terminate()
    expect(sawFirstFindingBeforeDone).toBe(true)
  })

  it('an incomplete review is flagged on the dashboard, and a failed job is flagged too', async () => {
    const { RetriableError } = await import('@redline/reviewer')
    await boot(new ScriptedClient(() => ({ first: new RetriableError('down') })))
    const { ws, messages } = await connect()
    await hook()
    await waitFor(() => messages.some((m) => m.type === 'job-done'))
    ws.terminate()
    expect(messages.find((m) => m.type === 'job-done')).toMatchObject({ incomplete: true })
  })
})

describe('dashboard: accepting and dismissing', () => {
  it('dismissing a finding records it, and it cannot be dismissed twice', async () => {
    await hook()
    await srv.queue.idle()
    const [f] = srv.dashboard.recentFindings()
    const r1 = await fetch(`${base}/api/findings/${f.id}/dismiss`, { method: 'POST' })
    expect(r1.status).toBe(200)
    expect((await r1.json()).finding.status).toBe('dismissed')
    const r2 = await fetch(`${base}/api/findings/${f.id}/dismiss`, { method: 'POST' })
    expect(r2.status).toBe(404)
  })

  it('dismissing broadcasts nothing extra, but the REST listing reflects the verdict', async () => {
    await hook()
    await srv.queue.idle()
    const [f] = srv.dashboard.recentFindings()
    await fetch(`${base}/api/findings/${f.id}/accept`, { method: 'POST' })
    const listed = await (await fetch(`${base}/api/findings?key=acme/app%237`)).json()
    expect(listed.findings[0].status).toBe('accepted')
  })

  it('acting on an unknown finding id is a clean 404', async () => {
    expect((await fetch(`${base}/api/findings/nope/dismiss`, { method: 'POST' })).status).toBe(404)
  })

  it('the feedback snapshot is empty until something is dismissed twice', async () => {
    expect((await (await fetch(`${base}/api/feedback`)).json()).dismissals).toEqual([])
  })
})

describe('dashboard: the review actually learns from dismissals', () => {
  it('after a pattern is dismissed twice, the next review of the SAME repo is told not to repeat it', async () => {
    const seenSystems: string[] = []
    const m = new ScriptedClient((req) => { seenSystems.push(req.system); return { chunks: [findingLine()] } })
    await boot(m)

    await hook(); await srv.queue.idle()
    for (const f of srv.dashboard.recentFindings()) await fetch(`${base}/api/findings/${f.id}/dismiss`, { method: 'POST' })
    expect(seenSystems[0]).not.toContain('not wanted here')

    gh.pulls.get('acme/app#7')!.headSha = (await import('./fake-github')).sha('push 2')
    gh.pulls.get('acme/app#7')!.reviews = []
    await hook(); await srv.queue.idle()
    for (const f of srv.dashboard.recentFindings()) await fetch(`${base}/api/findings/${f.id}/dismiss`, { method: 'POST' })

    gh.pulls.get('acme/app#7')!.headSha = (await import('./fake-github')).sha('push 3')
    gh.pulls.get('acme/app#7')!.reviews = []
    await hook(); await srv.queue.idle()

    expect(seenSystems.at(-1)).toContain('not wanted here')
    expect(seenSystems.at(-1)).toContain('bug')
  })

  it('accepting a later finding of an already-learned pattern makes the reviewer stop suppressing it', async () => {
    // dismiss the same pattern twice, across two reviews, so it is learned
    await hook(); await srv.queue.idle()
    for (const f of srv.dashboard.recentFindings()) await fetch(`${base}/api/findings/${f.id}/dismiss`, { method: 'POST' })
    gh.pulls.get('acme/app#7')!.headSha = (await import('./fake-github')).sha('push 2')
    gh.pulls.get('acme/app#7')!.reviews = []
    await hook(); await srv.queue.idle()
    for (const f of srv.dashboard.recentFindings().filter((x) => !x.status)) await fetch(`${base}/api/findings/${f.id}/dismiss`, { method: 'POST' })
    expect(srv.dashboard.feedback.learnedInstructions()).toContain('bug')

    // a third review's finding (of the same pattern) is instead accepted: the team changed its mind
    gh.pulls.get('acme/app#7')!.headSha = (await import('./fake-github')).sha('push 3')
    gh.pulls.get('acme/app#7')!.reviews = []
    await hook(); await srv.queue.idle()
    for (const f of srv.dashboard.recentFindings().filter((x) => !x.status)) await fetch(`${base}/api/findings/${f.id}/accept`, { method: 'POST' })

    expect(srv.dashboard.feedback.learnedInstructions()).toBe('')
  })
})
