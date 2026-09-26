import { createHash, createPublicKey, createVerify, generateKeyPairSync } from 'node:crypto'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { commentableLines, parseDiff } from '@redline/core'

export interface FakePull {
  title: string
  state: 'open' | 'closed'
  draft: boolean
  headSha: string
  diff: string
  changedFiles?: number
  reviews: { id: number; body: string; commit_id: string; user: { login: string }; comments: { path: string; line: number; body: string }[] }[]
}

export interface Call { method: string; path: string; auth: string; accept: string }

/** Just enough of the GitHub API, over real HTTP, to run the real client against. It checks what GitHub would check. */
export class FakeGitHub {
  readonly publicKey: string
  readonly privateKey: string
  readonly pulls = new Map<string, FakePull>()
  calls: Call[] = []
  tokensIssued = 0
  installTokenLifetimeMs = 3_600_000
  /** answer the next N authenticated calls with a rate-limit error */
  rateLimitNext = 0
  /** answer the next N authenticated calls with a server error */
  failNext = 0
  /** reject the next installation token as revoked, once */
  rejectTokenOnce = false
  /** status to return when the diff is requested (e.g. 406 too large) */
  diffStatus = 200
  /** refuse inline comments (422) as if a position could not be resolved */
  rejectInline = false
  /** runs on every GET of a pull request, before answering (to change it "while the reviewer works") */
  onGetPull: ((key: string, pull: FakePull) => void) | null = null
  delayMs = 0
  private server!: Server
  private nextReview = 1000
  private validTokens = new Set<string>()
  private revoked = new Set<string>()
  appId = '424242'

  constructor() {
    const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } })
    this.publicKey = publicKey
    this.privateKey = privateKey
  }

  get url() { return `http://localhost:${(this.server.address() as { port: number }).port}` }

  addPull(owner: string, repo: string, n: number, p: Partial<FakePull> & { diff: string }): string {
    const key = `${owner}/${repo}#${n}`.toLowerCase()
    this.pulls.set(key, { title: 'A change', state: 'open', draft: false, headSha: sha(key + Math.random()), reviews: [], ...p })
    return key
  }

  async start() {
    this.server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://x')
      const auth = String(req.headers.authorization ?? '')
      const accept = String(req.headers.accept ?? '')
      this.calls.push({ method: req.method ?? '', path: url.pathname + url.search, auth, accept })
      const json = (status: number, body: unknown, headers: Record<string, string> = {}) => {
        res.statusCode = status
        res.setHeader('content-type', 'application/json')
        for (const [k, v] of Object.entries(headers)) res.setHeader(k, v)
        res.end(JSON.stringify(body))
      }
      const chunks: Buffer[] = []
      for await (const c of req) chunks.push(c as Buffer)
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined
      if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs))

      // installation tokens are minted by presenting the app's JWT
      const mint = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(url.pathname)
      if (mint && req.method === 'POST') {
        if (!this.verifyJwt(auth.replace(/^Bearer /, ''))) return json(401, { message: 'A JSON web token could not be decoded' })
        const token = `ghs_${++this.tokensIssued}_${mint[1]}`
        this.validTokens.add(token)
        return json(201, { token, expires_at: new Date(Date.now() + this.installTokenLifetimeMs).toISOString() })
      }

      const token = auth.replace(/^Bearer /, '')
      if (this.rejectTokenOnce && this.validTokens.has(token)) { this.rejectTokenOnce = false; this.revoked.add(token) }
      if (!this.validTokens.has(token) || this.revoked.has(token)) return json(401, { message: 'Bad credentials' })
      if (this.rateLimitNext > 0) { this.rateLimitNext--; return json(403, { message: 'API rate limit exceeded' }, { 'x-ratelimit-remaining': '0', 'retry-after': '3' }) }
      if (this.failNext > 0) { this.failNext--; return json(502, { message: 'Bad gateway' }) }

      const m = /^\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)(\/reviews)?$/.exec(url.pathname)
      if (!m) return json(404, { message: 'Not Found' })
      const key = `${m[1]}/${m[2]}#${m[3]}`.toLowerCase()
      const pull = this.pulls.get(key)
      if (!pull) return json(404, { message: 'Not Found' })

      if (!m[4] && req.method === 'GET') {
        if (accept.includes('diff')) {
          if (this.diffStatus !== 200) return json(this.diffStatus, { message: 'Sorry, the diff exceeded the maximum number of lines' })
          res.setHeader('content-type', 'application/vnd.github.v3.diff')
          return res.end(pull.diff)
        }
        this.onGetPull?.(key, pull)
        return json(200, { title: pull.title, state: pull.state, draft: pull.draft, head: { sha: pull.headSha }, changed_files: pull.changedFiles ?? countFiles(pull.diff), user: { login: 'dev' } })
      }
      if (m[4] && req.method === 'GET') {
        const page = Number(url.searchParams.get('page') ?? 1)
        const per = Number(url.searchParams.get('per_page') ?? 30)
        return json(200, pull.reviews.slice((page - 1) * per, page * per).map((r) => ({ id: r.id, body: r.body, commit_id: r.commit_id, user: r.user })))
      }
      if (m[4] && req.method === 'POST') {
        if (body.commit_id !== pull.headSha) return json(422, { message: 'Unprocessable Entity: commit_id is not part of the pull request' })
        const comments = (body.comments ?? []) as { path: string; line: number; side: string; body: string }[]
        const ok = comments.length ? commentableLines(parseDiff(pull.diff)) : new Map<string, Set<number>>()
        for (const c of comments) {
          if (this.rejectInline || c.side !== 'RIGHT' || !ok.get(c.path)?.has(c.line)) return json(422, { message: `Unprocessable Entity: Line could not be resolved (${c.path}:${c.line})` })
        }
        const review = { id: ++this.nextReview, body: body.body ?? '', commit_id: body.commit_id, user: { login: 'redline[bot]' }, comments: comments.map((c) => ({ path: c.path, line: c.line, body: c.body })) }
        pull.reviews.push(review)
        return json(200, { id: review.id })
      }
      return json(405, { message: 'Method Not Allowed' })
    })
    await new Promise<void>((r) => this.server.listen(0, () => r()))
  }

  async stop() {
    await new Promise<void>((r) => { this.server.close(() => r()); this.server.closeAllConnections?.() })
  }

  private verifyJwt(jwt: string): boolean {
    const [h, b, s] = jwt.split('.')
    if (!h || !b || !s) return false
    const header = JSON.parse(Buffer.from(h, 'base64url').toString())
    const claims = JSON.parse(Buffer.from(b, 'base64url').toString())
    if (header.alg !== 'RS256') return false
    const nowS = Date.now() / 1000
    if (claims.iss !== this.appId || claims.exp - claims.iat > 600 || claims.exp < nowS || claims.iat > nowS) return false
    return createVerify('RSA-SHA256').update(`${h}.${b}`).verify(createPublicKey(this.publicKey), Buffer.from(s, 'base64url'))
  }
}

/** GitHub counts files itself; ours may hold a diff we deliberately made unreadable. */
const countFiles = (diff: string) => { try { return parseDiff(diff).length } catch { return 1 } }

export const sha = (s: string) => createHash('sha1').update(s).digest('hex')

/** A small unified diff that adds one line to a file. */
export function addLineDiff(path: string, added: string, at = 2): string {
  return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,3 +1,4 @@\n line one\n${at === 2 ? '' : ' line two\n'}+${added}\n${at === 2 ? ' line two\n' : ''} line three\n`
}
