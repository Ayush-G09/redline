import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RetriableError, ScriptedClient } from '@redline/reviewer'
import type { Scripted } from '@redline/reviewer'
import type { Config } from '../src/config'
import { GitHubClient } from '../src/github'
import { createServer } from '../src/server'
import type { RedlineServer } from '../src/server'
import { sign } from '../src/signature'
import { addLineDiff, FakeGitHub, sha } from './fake-github'

const SECRET = 'webhook-secret-for-tests'
const config = (over: Partial<Config> = {}): Config => ({
  port: 0, appId: '424242', privateKey: '', webhookSecret: SECRET, anthropicKey: 'unused', model: 'm', githubApi: '', allowedOwners: ['acme'],
  concurrency: 2, postClean: true, maxFiles: 150, maxReviewsPerPrPerHour: 12, ...over,
})

let gh: FakeGitHub
let srv: RedlineServer
let base = ''
let llm: ScriptedClient
let logs: string[]

/** What a model would say about the tiny diff in these tests: one comment on the added line (line 2 of src/a.ts). */
const finding = (over: Record<string, unknown> = {}) => JSON.stringify({ path: 'src/a.ts', line: 2, kind: 'bug', severity: 'high', message: 'This is wrong.', ...over }) + '\n'
const answers = (fn: (n: number) => Scripted = () => ({ chunks: [finding()] })) => new ScriptedClient((_r, n) => fn(n))

async function boot(over: Partial<Config> = {}, model: ScriptedClient = answers(), delayMs = 0) {
  gh = new FakeGitHub()
  await gh.start()
  gh.addPull('acme', 'app', 7, { title: 'Add a thing', diff: addLineDiff('src/a.ts', 'let x = y + 1') })
  const github = new GitHubClient({ appId: gh.appId, privateKey: gh.privateKey, apiUrl: gh.url })
  llm = delayMs ? new ScriptedClient((_r, n) => ({ chunks: [finding()] }), delayMs) : model
  logs = []
  srv = createServer({ config: config(over), github, llm, log: (m) => logs.push(m), queue: { sleep: async () => {}, backoffMs: 1 }, reviewOptions: { sleep: async () => {}, backoffMs: 1 } })
  base = `http://localhost:${await srv.listen(0)}`
}
beforeEach(() => boot())
afterEach(async () => { await srv.close(); await gh.stop() })

const payload = (o: Record<string, any> = {}) => ({
  action: 'opened',
  installation: { id: 99 },
  repository: { name: 'app', owner: { login: 'acme' } },
  pull_request: { number: 7, draft: false, state: 'open', head: { sha: gh.pulls.get('acme/app#7')?.headSha } },
  ...o,
})
let deliveryCounter = 0
async function hook(body: unknown, opts: { event?: string; secret?: string; delivery?: string; raw?: string; sig?: string | null } = {}) {
  const raw = opts.raw ?? JSON.stringify(body)
  const headers: Record<string, string> = { 'content-type': 'application/json', 'x-github-event': opts.event ?? 'pull_request', 'x-github-delivery': opts.delivery ?? `d-${++deliveryCounter}` }
  if (opts.sig !== null) headers['x-hub-signature-256'] = opts.sig ?? sign(opts.secret ?? SECRET, raw)
  const r = await fetch(`${base}/webhooks/github`, { method: 'POST', headers, body: raw })
  return { status: r.status, body: (await r.json().catch(() => null)) as any }
}
const reviews = () => gh.pulls.get('acme/app#7')?.reviews ?? []
const settle = () => srv.queue.idle()

describe('a pull request is opened', () => {
  it('is reviewed, and the comment lands on the right line of the right commit', async () => {
    const r = await hook(payload())
    expect(r).toMatchObject({ status: 202, body: { queued: true } })
    await settle()
    const [rev] = reviews()
    expect(rev.commit_id).toBe(gh.pulls.get('acme/app#7')?.headSha)
    expect(rev.comments).toEqual([{ path: 'src/a.ts', line: 2, body: '🔴 **Bug**\n\nThis is wrong.' }])
    expect(rev.body).toContain('left 1 comment')
    expect(rev.body).toContain('redline:review sha=')
    expect(srv.outcomes.at(-1)?.outcome).toMatchObject({ type: 'reviewed', comments: 1, inline: true })
  })

  it('gives the model the pull request title and the numbered diff', async () => {
    await hook(payload())
    await settle()
    expect(llm.calls[0].user).toContain('Pull request title: Add a thing')
    expect(llm.calls[0].user).toContain('    2 + let x = y + 1')
  })

  it('says so when it finds nothing (and stays quiet only if configured to)', async () => {
    await srv.close(); await gh.stop()
    await boot({}, answers(() => ({ chunks: [] })))
    await hook(payload()); await settle()
    expect(reviews()[0].body).toContain('found nothing to flag')
    expect(reviews()[0].comments).toEqual([])

    await srv.close(); await gh.stop()
    await boot({ postClean: false }, answers(() => ({ chunks: [] })))
    await hook(payload()); await settle()
    expect(reviews()).toEqual([])
    expect(srv.outcomes.at(-1)?.outcome).toMatchObject({ type: 'skipped', reason: 'nothing-to-say' })
  })
})

describe('who and what is allowed in', () => {
  it('rejects a bad or missing signature and does nothing', async () => {
    for (const opts of [{ secret: 'wrong' }, { sig: null }, { sig: 'sha256=00' }]) {
      expect((await hook(payload(), opts)).status).toBe(401)
    }
    await settle()
    expect(llm.calls).toHaveLength(0)
    expect(reviews()).toEqual([])
  })
  it('rejects a body changed after signing', async () => {
    const raw = JSON.stringify(payload())
    const r = await hook(null, { raw: raw.replace('"number":7', '"number":8'), sig: sign(SECRET, raw) })
    expect(r.status).toBe(401)
  })
  it('answers ping, and ignores other events and other actions', async () => {
    expect((await hook({}, { event: 'ping' })).status).toBe(200)
    expect((await hook({}, { event: 'issues' })).body.ignored).toMatch(/event issues/)
    expect((await hook(payload({ action: 'closed' }))).body.ignored).toMatch(/action closed/)
    expect((await hook(payload({ action: 'labeled' }))).status).toBe(202)
    await settle()
    expect(llm.calls).toHaveLength(0)
  })
  it('ignores repositories of owners that are not on the list (reviews cost money)', async () => {
    const r = await hook(payload({ repository: { name: 'app', owner: { login: 'stranger' } } }))
    expect(r.body.ignored).toBe('owner not allowed')
    await settle()
    expect(llm.calls).toHaveLength(0)
  })
  it('the owner check ignores case', async () => {
    expect((await hook(payload({ repository: { name: 'app', owner: { login: 'ACME' } } }))).body.queued).toBe(true)
    await settle()
  })
  it('ignores drafts, and reviews them when they are marked ready', async () => {
    const draft = payload(); draft.pull_request.draft = true
    expect((await hook(draft)).body.ignored).toBe('draft')
    expect((await hook(payload({ action: 'ready_for_review' }))).body.queued).toBe(true)
    await settle()
    expect(reviews()).toHaveLength(1)
  })
  it('refuses payloads with unexpected shapes, including names that could rewrite the API path', async () => {
    for (const bad of [
      payload({ repository: { name: 'app', owner: { login: '../orgs/x' } } }),
      payload({ repository: { name: 'a/b', owner: { login: 'acme' } } }),
      payload({ pull_request: { number: 'seven', head: { sha: 'a'.repeat(40) } } }),
      payload({ pull_request: { number: 7, head: { sha: 'not-a-sha' } } }),
      payload({ installation: undefined }),
      payload({ installation: { id: 'x' } }),
    ]) expect((await hook(bad)).status, JSON.stringify(bad).slice(0, 80)).toBe(400)
    expect((await hook(null, { raw: '{oops' , sig: sign(SECRET, '{oops') })).status).toBe(400)
  })
  it('refuses an enormous body', async () => {
    const big = JSON.stringify({ x: 'y'.repeat(3 * 1024 * 1024) })
    const r = await hook(null, { raw: big, sig: sign(SECRET, big) }).catch(() => ({ status: 413 }))
    expect([413, 400]).toContain(r.status)
  })
  it('only serves the webhook path', async () => {
    expect((await fetch(`${base}/other`)).status).toBe(404)
    expect((await fetch(`${base}/webhooks/github`)).status).toBe(404)
    expect((await fetch(`${base}/health`)).status).toBe(200)
  })
})

describe('duplicates, pushes and races', () => {
  it('handles a redelivered webhook once', async () => {
    expect((await hook(payload(), { delivery: 'same' })).status).toBe(202)
    expect((await hook(payload(), { delivery: 'same' })).body.ignored).toBe('duplicate delivery')
    await settle()
    expect(reviews()).toHaveLength(1)
  })
  it('does not review the same commit twice even under a new delivery id (it recognises its own review)', async () => {
    await hook(payload()); await settle()
    await hook(payload()); await settle()
    expect(reviews()).toHaveLength(1)
    expect(llm.calls).toHaveLength(1)
    expect(srv.outcomes.at(-1)?.outcome).toMatchObject({ type: 'skipped', reason: 'already-reviewed' })
  })
  it('a push while the first review is running cancels it: only the newest commit is reviewed', async () => {
    await srv.close(); await gh.stop()
    await boot({}, answers(), 60)
    const p1 = gh.pulls.get('acme/app#7')!
    const first = p1.headSha
    await hook(payload({ action: 'opened' }))
    await new Promise((r) => setTimeout(r, 20)) // the model is mid-answer
    p1.headSha = sha('second push')
    await hook(payload({ action: 'synchronize' }))
    await settle()
    expect(reviews().map((r) => r.commit_id)).toEqual([p1.headSha])
    expect(reviews().some((r) => r.commit_id === first)).toBe(false)
  })
  it('if the pull request changes while the model works, the out-of-date review is discarded', async () => {
    let n = 0
    gh.onGetPull = (_k, pull) => { if (++n === 2) pull.headSha = sha('pushed during review') } // the second look, just before posting
    await hook(payload()); await settle()
    expect(reviews()).toEqual([])
    expect(srv.outcomes.at(-1)?.outcome).toMatchObject({ type: 'skipped', reason: 'stale' })
  })
  it('a job for a commit that is already out of date is skipped without calling the model', async () => {
    const stale = payload()
    gh.pulls.get('acme/app#7')!.headSha = sha('newer')
    await hook(stale); await settle()
    expect(llm.calls).toHaveLength(0)
    expect(srv.outcomes.at(-1)?.outcome).toMatchObject({ type: 'skipped', reason: 'stale' })
  })
  it('a pull request closed before its turn is skipped', async () => {
    gh.pulls.get('acme/app#7')!.state = 'closed'
    await hook(payload()); await settle()
    expect(llm.calls).toHaveLength(0)
    expect(srv.outcomes.at(-1)?.outcome).toMatchObject({ type: 'skipped', reason: 'closed' })
  })
  it('gives each pull request only so many reviews per hour', async () => {
    await srv.close(); await gh.stop()
    await boot({ maxReviewsPerPrPerHour: 2 })
    const p = gh.pulls.get('acme/app#7')!
    const results: any[] = []
    for (let i = 0; i < 4; i++) { p.headSha = sha(`push ${i}`); results.push((await hook(payload())).body); await settle() }
    expect(results.map((r) => !!r.queued)).toEqual([true, true, false, false])
    expect(results[2].ignored).toMatch(/too many reviews/)
    expect(reviews()).toHaveLength(2)
  })
})

describe('when things go wrong', () => {
  it('retries when GitHub rate-limits us, then succeeds', async () => {
    gh.rateLimitNext = 2
    await hook(payload()); await settle()
    expect(reviews()).toHaveLength(1)
    expect(srv.queue.stats.retried).toBeGreaterThanOrEqual(1)
  })
  it('retries after a GitHub server error', async () => {
    gh.failNext = 1
    await hook(payload()); await settle()
    expect(reviews()).toHaveLength(1)
  })
  it('gives up (and remembers it) if GitHub never recovers', async () => {
    gh.failNext = 1000
    await hook(payload()); await settle()
    expect(reviews()).toEqual([])
    expect(srv.queue.failed).toHaveLength(1)
    expect(srv.outcomes.at(-1)?.outcome).toMatchObject({ type: 'failed' })
  })
  it('posts an incomplete review, saying so, when the model is unavailable', async () => {
    await srv.close(); await gh.stop()
    await boot({}, answers(() => ({ first: new RetriableError('overloaded') })))
    await hook(payload()); await settle()
    expect(reviews()).toHaveLength(1)
    expect(reviews()[0].body).toContain('incomplete')
    expect(reviews()[0].body).not.toContain('found nothing')
    expect(srv.outcomes.at(-1)?.outcome).toMatchObject({ type: 'reviewed', incomplete: true })
  })
  it('does not post comments on lines that are not in the diff (the model made them up)', async () => {
    await srv.close(); await gh.stop()
    await boot({}, answers(() => ({ chunks: [finding({ line: 500 }), finding({ path: 'ghost.ts' }), finding()] })))
    await hook(payload()); await settle()
    expect(reviews()[0].comments.map((c) => c.line)).toEqual([2])
  })
  it('if GitHub still refuses the inline comments, the findings are put in the summary instead of lost', async () => {
    gh.rejectInline = true
    await hook(payload()); await settle()
    expect(reviews()).toHaveLength(1)
    expect(reviews()[0].comments).toEqual([])
    expect(reviews()[0].body).toContain('`src/a.ts:2`')
    expect(reviews()[0].body).toContain('This is wrong.')
    expect(srv.outcomes.at(-1)?.outcome).toMatchObject({ type: 'reviewed', inline: false })
  })
  it('leaves a note when GitHub says the diff is too large, and does not call the model', async () => {
    gh.diffStatus = 406
    await hook(payload()); await settle()
    expect(reviews()[0].body).toContain('too large')
    expect(llm.calls).toHaveLength(0)
  })
  it('leaves a note when the diff cannot be read', async () => {
    gh.pulls.get('acme/app#7')!.diff = 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,3 +1,3 @@\n a\n'
    await hook(payload()); await settle()
    expect(reviews()[0].body).toContain('could not read')
    expect(llm.calls).toHaveLength(0)
  })
  it('skips changes that touch too many files', async () => {
    gh.pulls.get('acme/app#7')!.changedFiles = 500
    await hook(payload()); await settle()
    expect(reviews()).toEqual([])
    expect(srv.outcomes.at(-1)?.outcome).toMatchObject({ type: 'skipped', reason: 'too-many-files' })
  })
  it('one pull request failing does not stop another', async () => {
    gh.addPull('acme', 'app', 8, { diff: addLineDiff('src/a.ts', 'ok') })
    gh.pulls.get('acme/app#7')!.state = 'closed'
    const other = payload(); other.pull_request.number = 8; other.pull_request.head.sha = gh.pulls.get('acme/app#8')!.headSha
    await hook(payload()); await hook(other); await settle()
    expect(gh.pulls.get('acme/app#8')!.reviews).toHaveLength(1)
  })
})

describe('health and secrets', () => {
  it('reports queue state and recent outcomes', async () => {
    await hook(payload()); await settle()
    const h = (await (await fetch(`${base}/health`)).json()) as any
    expect(h.ok).toBe(true)
    expect(h.queue.completed).toBe(1)
    expect(h.recent[0].outcome.type).toBe('reviewed')
  })
  it('never logs the webhook secret, tokens or the private key', async () => {
    gh.failNext = 1
    await hook(payload()); await settle()
    const all = logs.join('\n') + JSON.stringify(gh.calls.map((c) => c.path))
    for (const secret of [SECRET, gh.privateKey.slice(40, 80)]) expect(all).not.toContain(secret)
    expect(all).not.toMatch(/ghs_\d/)
  })
})
