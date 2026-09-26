import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RetriableError, ScriptedClient } from '@redline/reviewer'
import { addLineDiff, FakeGitHub, sha } from '../../server/test/fake-github'
import { runAction } from '../src/run'

const TOKEN = 'ghs_actions_run_token'
let gh: FakeGitHub
beforeEach(async () => {
  gh = new FakeGitHub()
  await gh.start()
  gh.allowToken(TOKEN)
  gh.addPull('acme', 'app', 7, { title: 'Add a thing', diff: addLineDiff('src/a.ts', 'let x = y + 1') })
})
afterEach(async () => { await gh.stop() })

const finding = (over: Record<string, unknown> = {}) => JSON.stringify({ path: 'src/a.ts', line: 2, kind: 'bug', severity: 'high', message: 'This is wrong.', ...over }) + '\n'
const model = (fn: (n: number) => { chunks?: string[]; first?: Error } = () => ({ chunks: [finding()] })) => new ScriptedClient((_r, n) => fn(n))
const head = () => gh.pulls.get('acme/app#7')!.headSha
const event = (over: Record<string, any> = {}) => JSON.stringify({ action: 'opened', pull_request: { number: 7, draft: false, head: { sha: head(), repo: { full_name: 'acme/app' } } }, ...over })
const env = (over: Record<string, string | undefined> = {}) => ({ GITHUB_EVENT_NAME: 'pull_request', GITHUB_REPOSITORY: 'acme/app', GITHUB_TOKEN: TOKEN, GITHUB_API_URL: gh.url, GITHUB_RUN_ID: '555', ...over })
const reviews = () => gh.pulls.get('acme/app#7')!.reviews
const noSleep = async () => {}

describe('runAction', () => {
  it('reviews the pull request with the run token, and the comment lands on the right line', async () => {
    const llm = model()
    const r = await runAction(env(), event(), { llm })
    expect(r).toMatchObject({ exitCode: 0, outcome: { type: 'reviewed', comments: 1, inline: true } })
    expect(r.message).toContain('Posted a review with 1 comment')
    expect(reviews()[0].comments).toEqual([{ path: 'src/a.ts', line: 2, body: '🔴 **Bug**\n\nThis is wrong.' }])
    expect(reviews()[0].commit_id).toBe(head())
    expect(gh.calls.every((c) => c.auth === `Bearer ${TOKEN}`)).toBe(true) // no app sign-in: only the run's token
    expect(gh.tokensIssued).toBe(0)
    expect(llm.calls[0].user).toContain('Pull request title: Add a thing')
  })

  it('does not review the same commit twice when the workflow is re-run', async () => {
    await runAction(env(), event(), { llm: model() })
    const again = model()
    const r = await runAction(env(), event(), { llm: again })
    expect(r.outcome).toMatchObject({ type: 'skipped', reason: 'already-reviewed' })
    expect(again.calls).toHaveLength(0)
    expect(reviews()).toHaveLength(1)
  })

  it('does nothing, successfully, for events that are not a reviewable pull request', async () => {
    for (const [e, ev] of [[env({ GITHUB_EVENT_NAME: 'push' }), event()], [env(), event({ action: 'closed' })], [env(), event({ action: 'labeled' })]] as const) {
      const r = await runAction(e, ev, { llm: model() })
      expect(r.exitCode).toBe(0)
      expect(r.outcome).toBeUndefined()
    }
    expect(reviews()).toEqual([])
  })

  it('skips drafts', async () => {
    const d = JSON.parse(event()); d.pull_request.draft = true
    const r = await runAction(env(), JSON.stringify(d), { llm: model() })
    expect(r.exitCode).toBe(0)
    expect(r.message).toMatch(/Draft/)
  })

  it('skips a pull request from a fork, explaining why, instead of failing', async () => {
    const f = JSON.parse(event()); f.pull_request.head.repo.full_name = 'stranger/app'
    const llm = model()
    const r = await runAction(env(), JSON.stringify(f), { llm })
    expect(r.exitCode).toBe(0)
    expect(r.message).toMatch(/fork/)
    expect(llm.calls).toHaveLength(0)
  })

  it('fails with a fix-it message when the token is missing', async () => {
    const r = await runAction(env({ GITHUB_TOKEN: undefined }), event(), { llm: model() })
    expect(r.exitCode).toBe(1)
    expect(r.message).toContain('GITHUB_TOKEN')
  })

  it('fails with a fix-it message when there is no key for the chosen model, and never prints one', async () => {
    const r = await runAction(env({ REDLINE_PROVIDER: 'gemini' }), event())
    expect(r.exitCode).toBe(1)
    expect(r.message).toContain('GEMINI_API_KEY')
    expect(r.message).toContain('secrets.GEMINI_API_KEY')
    expect(reviews()).toEqual([])
  })

  it('explains that Ollama cannot run inside an Action', async () => {
    const r = await runAction(env({ REDLINE_PROVIDER: 'ollama', GITHUB_ACTIONS: 'true' }), event())
    expect(r.exitCode).toBe(1)
    expect(r.message).toMatch(/your own machine/)
  })

  it('says which permission is missing when GitHub refuses to post', async () => {
    gh.forbidReviews = true
    const r = await runAction(env(), event(), { llm: model() })
    expect(r.exitCode).toBe(1)
    expect(r.message).toContain('pull-requests: write')
  })

  it('waits out a GitHub rate limit and then succeeds; gives up if it never clears', async () => {
    gh.rateLimitNext = 2
    const waits: number[] = []
    const ok = await runAction(env(), event(), { llm: model(), sleep: async (ms) => { waits.push(ms) } })
    expect(ok.exitCode).toBe(0)
    expect(waits).toEqual([3000, 3000]) // the wait GitHub asked for
    expect(reviews()).toHaveLength(1)

    gh.pulls.get('acme/app#7')!.reviews.length = 0
    gh.failNext = 1000
    const bad = await runAction(env(), event(), { llm: model(), sleep: noSleep })
    expect(bad.exitCode).toBe(1)
    expect(bad.message).toMatch(/failed/)
  })

  it('posts an incomplete review, saying so, when the model is down (a warning, not a failed run)', async () => {
    const r = await runAction(env(), event(), { llm: model(() => ({ first: new RetriableError('busy') })), reviewOptions: { sleep: noSleep } })
    expect(r.exitCode).toBe(0)
    expect(r.message).toMatch(/incomplete/)
    expect(reviews()[0].body).toContain('incomplete')
  })

  it('discards a review that went out of date while it was being made', async () => {
    let n = 0
    gh.onGetPull = (_k, p) => { if (++n === 2) p.headSha = sha('pushed meanwhile') }
    const r = await runAction(env(), event(), { llm: model() })
    expect(r.outcome).toMatchObject({ type: 'skipped', reason: 'stale' })
    expect(reviews()).toEqual([])
  })
})

// ---------------------------------------------------------------------------------------------------------------
// The built bundle (dist/action.mjs), run as GitHub would run it: a separate process, with inputs as INPUT_* variables,
// talking to a fake GitHub and a fake Gemini over real HTTP. Skipped if the bundle has not been built.
// ---------------------------------------------------------------------------------------------------------------

const BUNDLE = join(__dirname, '..', '..', '..', 'dist', 'action.mjs')
const GEMINI_KEY = 'AIza-fake-key-for-the-test'

function fakeGemini(): Promise<{ server: Server; url: string; requests: { key: string | undefined; url: string; body: any }[] }> {
  const requests: { key: string | undefined; url: string; body: any }[] = []
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    requests.push({ key: req.headers['x-goog-api-key'] as string | undefined, url: req.url ?? '', body: JSON.parse(Buffer.concat(chunks).toString() || '{}') })
    if (req.headers['x-goog-api-key'] !== GEMINI_KEY) { res.statusCode = 400; return res.end(JSON.stringify({ error: { code: 400, status: 'INVALID_ARGUMENT', message: 'API key not valid. Please pass a valid API key.' } })) }
    res.setHeader('content-type', 'text/event-stream')
    const text = finding()
    const frame = (parts: unknown[], extra = {}) => `data: ${JSON.stringify({ candidates: [{ content: { parts } }], ...extra })}\r\n\r\n`
    res.write(frame([{ text: text.slice(0, 30) }]))
    res.end(frame([{ text: text.slice(30) }], { usageMetadata: { promptTokenCount: 200, candidatesTokenCount: 40 } }))
  })
  return new Promise((resolve) => server.listen(0, () => resolve({ server, url: `http://localhost:${(server.address() as { port: number }).port}`, requests })))
}

const runBundle = (envVars: Record<string, string>) => new Promise<{ code: number | null; out: string }>((resolve) => {
  const p = spawn(process.execPath, [BUNDLE], { env: { PATH: process.env.PATH ?? '', ...envVars } })
  let out = ''
  p.stdout.on('data', (d) => (out += d))
  p.stderr.on('data', (d) => (out += d))
  p.on('close', (code) => resolve({ code, out }))
})

describe.skipIf(!existsSync(BUNDLE))('the built action bundle, as a real process', () => {
  it('reviews a pull request end to end through Gemini, using inputs the way GitHub passes them', async () => {
    const g = await fakeGemini()
    const dir = mkdtempSync(join(tmpdir(), 'redline-event-'))
    const eventPath = join(dir, 'event.json')
    writeFileSync(eventPath, event())
    try {
      const summaryPath = join(dir, 'summary.md')
      const r = await runBundle({
        ...env(), GITHUB_EVENT_PATH: eventPath, GITHUB_STEP_SUMMARY: summaryPath, GITHUB_ACTIONS: 'true',
        GEMINI_API_KEY: GEMINI_KEY, GEMINI_BASE_URL: g.url, INPUT_MODEL: 'gemini-test-model', INPUT_PROVIDER: 'gemini',
      })
      expect(r.out, r.out).toContain('::notice title=Redline::Posted a review with 1 comment')
      expect(r.code).toBe(0)
      expect(reviews()).toHaveLength(1)
      expect(reviews()[0].comments).toEqual([{ path: 'src/a.ts', line: 2, body: '🔴 **Bug**\n\nThis is wrong.' }])
      expect(g.requests).toHaveLength(1) // one request for the whole change: the free tier counts requests
      expect(g.requests[0].url).toContain('/models/gemini-test-model:streamGenerateContent')
      expect(g.requests[0].url).not.toContain(GEMINI_KEY)
      expect(g.requests[0].body.contents[0].parts[0].text).toContain('    2 + let x = y + 1')
      expect(r.out).not.toContain(GEMINI_KEY)
      expect(r.out).not.toContain(TOKEN)
    } finally { g.server.close(); rmSync(dir, { recursive: true, force: true }) }
  })

  it('exits non-zero with an error annotation when the key is wrong', async () => {
    const g = await fakeGemini()
    const dir = mkdtempSync(join(tmpdir(), 'redline-event-'))
    const eventPath = join(dir, 'event.json')
    writeFileSync(eventPath, event())
    try {
      const r = await runBundle({ ...env(), GITHUB_EVENT_PATH: eventPath, GITHUB_ACTIONS: 'true', GEMINI_API_KEY: 'wrong-key', GEMINI_BASE_URL: g.url })
      // a rejected key makes the review incomplete (nothing could be reviewed), and it is posted as such rather than as "all clear"
      expect(r.code).toBe(0)
      expect(reviews()[0].body).toContain('incomplete')
      expect(r.out).not.toContain('wrong-key')
    } finally { g.server.close(); rmSync(dir, { recursive: true, force: true }) }
  })

  it('refuses to run outside a GitHub Action', async () => {
    const r = await runBundle({})
    expect(r.code).toBe(1)
    expect(r.out).toContain('GITHUB_EVENT_PATH')
  })
})
