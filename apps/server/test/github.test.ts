import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { GitHubClient, GitHubError } from '../src/github'
import { RetryJob } from '../src/queue'
import { addLineDiff, FakeGitHub } from './fake-github'

let gh: FakeGitHub
let client: GitHubClient
let clock = Date.now()
beforeEach(async () => {
  gh = new FakeGitHub()
  await gh.start()
  clock = Date.now()
  client = new GitHubClient({ appId: gh.appId, privateKey: gh.privateKey, apiUrl: gh.url, now: () => clock })
  gh.addPull('acme', 'app', 7, { diff: addLineDiff('src/a.ts', 'added') })
})
afterEach(async () => { await gh.stop() })

describe('GitHubClient: authentication', () => {
  it('signs in as the app (GitHub verifies the JWT), then calls as the installation', async () => {
    const pull = await client.getPull(1, 'acme', 'app', 7)
    expect(pull).toMatchObject({ title: 'A change', state: 'open', draft: false })
    expect(gh.tokensIssued).toBe(1)
    const api = gh.calls.find((c) => c.path.startsWith('/repos'))
    expect(api?.auth).toMatch(/^Bearer ghs_1_1$/)
  })
  it('reuses the installation token, and shares one request between simultaneous calls', async () => {
    await Promise.all([client.getPull(1, 'acme', 'app', 7), client.getPull(1, 'acme', 'app', 7), client.getPull(1, 'acme', 'app', 7)])
    await client.getPull(1, 'acme', 'app', 7)
    expect(gh.tokensIssued).toBe(1)
  })
  it('keeps separate tokens per installation', async () => {
    await client.getPull(1, 'acme', 'app', 7)
    await client.getPull(2, 'acme', 'app', 7)
    expect(gh.tokensIssued).toBe(2)
  })
  it('gets a fresh token shortly before the old one expires', async () => {
    gh.installTokenLifetimeMs = 90_000
    await client.getPull(1, 'acme', 'app', 7)
    clock += 20_000 // 70 seconds left: still fine
    await client.getPull(1, 'acme', 'app', 7)
    expect(gh.tokensIssued).toBe(1)
    clock += 20_000 // 50 seconds left: too close to rely on
    await client.getPull(1, 'acme', 'app', 7)
    expect(gh.tokensIssued).toBe(2)
  })
  it('replaces a token GitHub has revoked and repeats the call, once', async () => {
    await client.getPull(1, 'acme', 'app', 7)
    gh.rejectTokenOnce = true
    expect((await client.getPull(1, 'acme', 'app', 7)).title).toBe('A change')
    expect(gh.tokensIssued).toBe(2)
  })
  it('with the wrong private key it cannot sign in, and says so', async () => {
    const other = new FakeGitHub()
    const bad = new GitHubClient({ appId: gh.appId, privateKey: other.privateKey, apiUrl: gh.url })
    await expect(bad.getPull(1, 'acme', 'app', 7)).rejects.toMatchObject({ status: 401 })
  })
})

describe('GitHubClient: errors', () => {
  it('turns a rate limit into a retry, using the wait GitHub asked for', async () => {
    await client.getPull(1, 'acme', 'app', 7)
    gh.rateLimitNext = 1
    const err = await client.getPull(1, 'acme', 'app', 7).catch((e) => e)
    expect(err).toBeInstanceOf(RetryJob)
    expect(err.afterMs).toBe(3000)
  })
  it('turns a server error into a retry', async () => {
    gh.failNext = 1
    await client.getPull(1, 'acme', 'app', 7).then(() => { throw new Error('should have failed') }, (e) => expect(e).toBeInstanceOf(RetryJob))
  })
  it('turns a network failure into a retry', async () => {
    const dead = new GitHubClient({ appId: gh.appId, privateKey: gh.privateKey, apiUrl: 'http://localhost:1' })
    expect(await dead.getPull(1, 'acme', 'app', 7).catch((e) => e)).toBeInstanceOf(RetryJob)
  })
  it('does not retry a missing pull request', async () => {
    const err = await client.getPull(1, 'acme', 'app', 999).catch((e) => e)
    expect(err).toBeInstanceOf(GitHubError)
    expect(err.status).toBe(404)
  })
})

describe('GitHubClient: pull requests and reviews', () => {
  it('fetches the diff as text', async () => {
    const d = await client.getDiff(1, 'acme', 'app', 7)
    expect(d).toContain('+++ b/src/a.ts')
    expect(gh.calls.at(-1)?.accept).toContain('diff')
  })
  it('reports a diff that is too large as an error the caller can recognise', async () => {
    gh.diffStatus = 406
    expect(await client.getDiff(1, 'acme', 'app', 7).catch((e) => e)).toMatchObject({ status: 406 })
  })
  it('posts a review with inline comments on the right side', async () => {
    const pull = await client.getPull(1, 'acme', 'app', 7)
    const id = await client.createReview(1, 'acme', 'app', 7, { commitId: pull.headSha, body: 'summary', comments: [{ path: 'src/a.ts', line: 2, side: 'RIGHT', body: 'hello' }] })
    const stored = gh.pulls.get('acme/app#7')?.reviews[0]
    expect(stored).toMatchObject({ id, body: 'summary', commit_id: pull.headSha, comments: [{ path: 'src/a.ts', line: 2, body: 'hello' }] })
  })
  it('lists reviews across pages', async () => {
    const p = gh.pulls.get('acme/app#7')!
    for (let i = 0; i < 230; i++) p.reviews.push({ id: i, body: `r${i}`, commit_id: 'x', user: { login: 'u' }, comments: [] })
    expect(await client.listReviews(1, 'acme', 'app', 7)).toHaveLength(230)
  })
  it('gets a 422 when GitHub cannot place a comment', async () => {
    const pull = await client.getPull(1, 'acme', 'app', 7)
    const err = await client.createReview(1, 'acme', 'app', 7, { commitId: pull.headSha, body: 'b', comments: [{ path: 'src/a.ts', line: 400, side: 'RIGHT', body: 'x' }] }).catch((e) => e)
    expect(err).toMatchObject({ status: 422 })
  })
})
