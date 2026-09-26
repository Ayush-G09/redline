import { appJwt } from './jwt'
import { RetryJob } from './queue'

export class GitHubError extends Error {
  constructor(message: string, readonly status: number) { super(message) }
}

export interface PullInfo {
  title: string
  state: string
  draft: boolean
  headSha: string
  changedFiles: number
  author: string
}

export interface ReviewComment {
  path: string
  line: number
  side: 'RIGHT'
  body: string
}

export interface ExistingReview { id: number; body: string; author: string; commitId: string }

export interface GitHubOptions {
  appId: string
  privateKey: string
  apiUrl?: string
  fetchImpl?: typeof fetch
  now?: () => number
}

interface Token { value: string; expiresAt: number }

/**
 * The parts of the GitHub API the reviewer needs, authenticated as a GitHub App installation. Installation tokens are
 * cached until shortly before they expire. Rate limits and server errors become RetryJob (with GitHub's own wait time
 * when it gives one); anything else the caller cannot fix by waiting is a GitHubError.
 */
export class GitHubClient {
  private readonly api: string
  private readonly doFetch: typeof fetch
  private readonly now: () => number
  private readonly tokens = new Map<number, Token>()
  private readonly inflight = new Map<number, Promise<string>>()

  constructor(private readonly o: GitHubOptions) {
    this.api = (o.apiUrl ?? 'https://api.github.com').replace(/\/$/, '')
    this.doFetch = o.fetchImpl ?? fetch
    this.now = o.now ?? Date.now
  }

  private async token(installationId: number, force = false): Promise<string> {
    const have = this.tokens.get(installationId)
    if (!force && have && have.expiresAt - this.now() > 60_000) return have.value
    const pending = this.inflight.get(installationId)
    if (pending) return pending // many jobs starting at once share one token request
    const p = (async () => {
      const res = await this.send(`/app/installations/${installationId}/access_tokens`, { method: 'POST', bearer: appJwt(this.o.appId, this.o.privateKey, this.now()) })
      const j = (await res.json()) as { token?: string; expires_at?: string }
      if (!j.token || !j.expires_at) throw new GitHubError('GitHub returned no installation token', 502)
      this.tokens.set(installationId, { value: j.token, expiresAt: Date.parse(j.expires_at) })
      return j.token
    })().finally(() => this.inflight.delete(installationId))
    this.inflight.set(installationId, p)
    return p
  }

  private async send(path: string, init: { method?: string; bearer: string; accept?: string; body?: unknown }): Promise<Response> {
    let res: Response
    try {
      res = await this.doFetch(this.api + path, {
        method: init.method ?? 'GET',
        headers: {
          authorization: `Bearer ${init.bearer}`,
          accept: init.accept ?? 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
          'user-agent': 'redline-reviewer',
          ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
        signal: AbortSignal.timeout(30_000),
      })
    } catch (e) {
      throw new RetryJob(`network error talking to GitHub: ${(e as Error).message}`)
    }
    if (res.ok) return res
    let detail = ''
    try { detail = ((await res.clone().json()) as { message?: string }).message ?? '' } catch { /* not json */ }
    const msg = `GitHub ${init.method ?? 'GET'} ${path.replace(/\/access_tokens$/, '/access_tokens')} -> ${res.status}${detail ? `: ${detail}` : ''}`
    const limited = res.status === 429 || (res.status === 403 && (res.headers.get('x-ratelimit-remaining') === '0' || /rate limit|abuse|secondary/i.test(detail)))
    if (limited) {
      const retryAfter = Number(res.headers.get('retry-after'))
      const reset = Number(res.headers.get('x-ratelimit-reset'))
      const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : Number.isFinite(reset) && reset > 0 ? Math.max(1000, reset * 1000 - this.now()) : 60_000
      throw new RetryJob(msg, Math.min(wait, 10 * 60_000))
    }
    if (res.status >= 500) throw new RetryJob(msg)
    throw new GitHubError(msg, res.status)
  }

  /** An authenticated call as the installation. A rejected token (revoked or expired early) is replaced once and the call repeated. */
  private async call(installationId: number, path: string, init: { method?: string; accept?: string; body?: unknown } = {}): Promise<Response> {
    try {
      return await this.send(path, { ...init, bearer: await this.token(installationId) })
    } catch (e) {
      if (e instanceof GitHubError && e.status === 401) return this.send(path, { ...init, bearer: await this.token(installationId, true) })
      throw e
    }
  }

  async getPull(installationId: number, owner: string, repo: string, n: number): Promise<PullInfo> {
    const j = (await (await this.call(installationId, `/repos/${owner}/${repo}/pulls/${n}`)).json()) as any
    return { title: String(j.title ?? ''), state: String(j.state), draft: !!j.draft, headSha: String(j.head?.sha ?? ''), changedFiles: Number(j.changed_files ?? 0), author: String(j.user?.login ?? '') }
  }

  async getDiff(installationId: number, owner: string, repo: string, n: number): Promise<string> {
    return (await this.call(installationId, `/repos/${owner}/${repo}/pulls/${n}`, { accept: 'application/vnd.github.v3.diff' })).text()
  }

  async listReviews(installationId: number, owner: string, repo: string, n: number): Promise<ExistingReview[]> {
    const out: ExistingReview[] = []
    for (let page = 1; page <= 10; page++) {
      const rows = (await (await this.call(installationId, `/repos/${owner}/${repo}/pulls/${n}/reviews?per_page=100&page=${page}`)).json()) as any[]
      for (const r of rows) out.push({ id: r.id, body: String(r.body ?? ''), author: String(r.user?.login ?? ''), commitId: String(r.commit_id ?? '') })
      if (rows.length < 100) break
    }
    return out
  }

  async createReview(installationId: number, owner: string, repo: string, n: number, review: { commitId: string; body: string; comments: ReviewComment[] }): Promise<number> {
    const res = await this.call(installationId, `/repos/${owner}/${repo}/pulls/${n}/reviews`, { method: 'POST', body: { commit_id: review.commitId, body: review.body, event: 'COMMENT', comments: review.comments } })
    return ((await res.json()) as { id: number }).id
  }
}
