import { createPublicKey, createVerify, generateKeyPairSync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config'
import { commentBody, hasMarker, marker, summary, toComments } from '../src/format'
import { appJwt } from '../src/jwt'
import { KeyedQueue, RetryJob } from '../src/queue'
import { sign, verifySignature } from '../src/signature'

describe('verifySignature', () => {
  const body = Buffer.from('{"action":"opened"}')
  it('accepts a good signature and rejects everything else', () => {
    expect(verifySignature('s3cret', body, sign('s3cret', body))).toBe(true)
    expect(verifySignature('other', body, sign('s3cret', body))).toBe(false)
    expect(verifySignature('s3cret', Buffer.from('{"action":"closed"}'), sign('s3cret', body))).toBe(false)
    expect(verifySignature('s3cret', body, undefined)).toBe(false)
    expect(verifySignature('s3cret', body, 'sha1=abc')).toBe(false)
    expect(verifySignature('s3cret', body, 'sha256=')).toBe(false)
    expect(verifySignature('s3cret', body, 'sha256=zzzz')).toBe(false)
    expect(verifySignature('s3cret', body, sign('s3cret', body).slice(0, -2))).toBe(false)
    expect(verifySignature('', body, sign('', body))).toBe(false) // an empty secret never validates anything
  })
})

describe('appJwt', () => {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } })
  it('is a valid RS256 token GitHub would accept: signed, issued by the app, short-lived, back-dated', () => {
    const t0 = 1_700_000_000_000
    const [h, b, s] = appJwt('123', privateKey, t0).split('.')
    expect(JSON.parse(Buffer.from(h, 'base64url').toString())).toEqual({ alg: 'RS256', typ: 'JWT' })
    const claims = JSON.parse(Buffer.from(b, 'base64url').toString())
    expect(claims).toEqual({ iat: 1_700_000_000 - 60, exp: 1_700_000_000 + 540, iss: '123' })
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(600)
    expect(createVerify('RSA-SHA256').update(`${h}.${b}`).verify(createPublicKey(publicKey), Buffer.from(s, 'base64url'))).toBe(true)
  })
  it('a tampered token does not verify', () => {
    const [h, , s] = appJwt('123', privateKey).split('.')
    const forged = Buffer.from(JSON.stringify({ iat: 1, exp: 2, iss: '999' })).toString('base64url')
    expect(createVerify('RSA-SHA256').update(`${h}.${forged}`).verify(createPublicKey(publicKey), Buffer.from(s, 'base64url'))).toBe(false)
  })
})

describe('KeyedQueue', () => {
  const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms))
  const noSleep = async () => {}

  it('runs jobs and reports completion', async () => {
    const done: number[] = []
    const q = new KeyedQueue<number>(async (n) => { done.push(n) }, { concurrency: 2, retries: 0, backoffMs: 0 })
    q.enqueue('a', 1); q.enqueue('b', 2)
    await q.idle()
    expect(done.sort()).toEqual([1, 2])
    expect(q.stats).toMatchObject({ enqueued: 2, completed: 2, failed: 0 })
  })

  it('never runs two jobs for one key at once, and runs the latest waiting one next', async () => {
    let active = 0
    let maxActive = 0
    const ran: number[] = []
    const q = new KeyedQueue<number>(async (n) => { active++; maxActive = Math.max(maxActive, active); await tick(15); ran.push(n); active-- }, { concurrency: 4, retries: 0, backoffMs: 0 })
    q.enqueue('pr', 1)
    await tick(2)
    q.enqueue('pr', 2)
    q.enqueue('pr', 3) // replaces 2 while 1 is still running
    await q.idle()
    expect(maxActive).toBe(1)
    expect(ran).toEqual([1, 3]) // 2 was dropped
    expect(q.stats.superseded).toBeGreaterThanOrEqual(2)
  })

  it('tells a running job to stop when a newer one arrives', async () => {
    const seen: string[] = []
    const q = new KeyedQueue<string>(async (v, { signal }) => {
      await tick(30)
      seen.push(`${v}:${signal.aborted ? 'aborted' : 'ok'}`)
    }, { concurrency: 1, retries: 0, backoffMs: 0 })
    q.enqueue('pr', 'old')
    await tick(5)
    q.enqueue('pr', 'new')
    await q.idle()
    expect(seen).toEqual(['old:aborted', 'new:ok'])
    expect(q.stats.completed).toBe(1) // the abandoned one is not counted as completed work
  })

  it('runs different keys in parallel up to the limit, oldest first', async () => {
    let active = 0
    let maxActive = 0
    const order: string[] = []
    const q = new KeyedQueue<string>(async (v) => { order.push(v); active++; maxActive = Math.max(maxActive, active); await tick(15); active-- }, { concurrency: 2, retries: 0, backoffMs: 0 })
    for (const k of ['a', 'b', 'c', 'd']) q.enqueue(k, k)
    await q.idle()
    expect(maxActive).toBe(2)
    expect(order).toEqual(['a', 'b', 'c', 'd'])
  })

  it('retries a job that asks to be retried, honouring the wait it names, then succeeds', async () => {
    const waits: number[] = []
    let n = 0
    const q = new KeyedQueue<null>(async () => { if (n++ < 2) throw new RetryJob('busy', n === 1 ? 5000 : undefined) }, { concurrency: 1, retries: 3, backoffMs: 100, sleep: async (ms) => { waits.push(ms) } })
    q.enqueue('k', null)
    await q.idle()
    expect(waits).toEqual([5000, 200])
    expect(q.stats).toMatchObject({ completed: 1, retried: 2, failed: 0 })
  })

  it('gives up after the retry limit and remembers the failure', async () => {
    const q = new KeyedQueue<string>(async () => { throw new RetryJob('still busy') }, { concurrency: 1, retries: 2, backoffMs: 1, sleep: noSleep })
    q.enqueue('k', 'payload')
    await q.idle()
    expect(q.stats).toMatchObject({ failed: 1, retried: 2, completed: 0 })
    expect(q.failed[0]).toMatchObject({ key: 'k', data: 'payload', error: 'still busy' })
  })

  it('does not retry an ordinary error', async () => {
    let calls = 0
    const q = new KeyedQueue<null>(async () => { calls++; throw new Error('bug') }, { concurrency: 1, retries: 5, backoffMs: 1, sleep: noSleep })
    q.enqueue('k', null)
    await q.idle()
    expect(calls).toBe(1)
    expect(q.stats.failed).toBe(1)
  })

  it('a job waiting to retry is dropped if something newer arrives for its key', async () => {
    const ran: string[] = []
    const q = new KeyedQueue<string>(async (v) => { ran.push(v); if (v === 'old') throw new RetryJob('busy', 60_000) }, { concurrency: 1, retries: 3, backoffMs: 1 })
    q.enqueue('k', 'old')
    await tick(10) // the old one has failed once and is now waiting a minute
    q.enqueue('k', 'new')
    await q.idle()
    expect(ran).toEqual(['old', 'new'])
  })

  it('one failing job does not stop the others', async () => {
    const done: string[] = []
    const q = new KeyedQueue<string>(async (v) => { if (v === 'bad') throw new Error('x'); done.push(v) }, { concurrency: 1, retries: 0, backoffMs: 0 })
    for (const v of ['a', 'bad', 'c']) q.enqueue(v, v)
    await q.idle()
    expect(done).toEqual(['a', 'c'])
  })

  it('idle resolves at once when empty', async () => {
    await new KeyedQueue<number>(async () => {}, { concurrency: 1, retries: 0, backoffMs: 0 }).idle()
  })
})

describe('format', () => {
  const f = (over = {}) => ({ path: 'a.ts', line: 3, kind: 'bug' as const, severity: 'high' as const, message: 'Broken.', ...over })
  it('writes a readable comment, and notes a range', () => {
    expect(commentBody(f())).toBe('🔴 **Bug**\n\nBroken.')
    expect(commentBody(f({ endLine: 6, kind: 'security', severity: 'low' }))).toBe('🟡 **Security** (lines 3–6)\n\nBroken.')
  })
  it('attaches comments to the right side and line', () => {
    expect(toComments([f()])).toEqual([{ path: 'a.ts', line: 3, side: 'RIGHT', body: '🔴 **Bug**\n\nBroken.' }])
  })
  it('marks reviews so our own can be recognised', () => {
    expect(hasMarker(`hi\n${marker('abc123')}`, 'abc123')).toBe(true)
    expect(hasMarker(marker('abc123'), 'def456')).toBe(false)
  })
  const result = (o = {}) => ({ findings: [], dropped: [], skipped: [], errors: [], usage: { inputTokens: 0, outputTokens: 0, requests: 0 }, ...o })
  it('summarises a clean review, a review with comments, and an incomplete one differently', () => {
    expect(summary(result(), 'x')).toContain('found nothing to flag')
    expect(summary(result({ findings: [f(), f({ line: 4 })] }), 'x')).toContain('left 2 comments')
    const inc = summary(result({ errors: ['boom'] }), 'x')
    expect(inc).toContain('incomplete')
    expect(inc).not.toContain('found nothing')
  })
  it('lists what was not reviewed, and the comments it could not attach', () => {
    const s = summary(result({ findings: [f()], skipped: [{ path: 'package-lock.json', reason: 'generated or lock file' }] }), 'x', { fallback: [f()] })
    expect(s).toContain('`package-lock.json` (generated or lock file)')
    expect(s).toContain('`a.ts:3`')
  })
})

describe('loadConfig', () => {
  const ok = { GITHUB_APP_ID: '1', GITHUB_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----', GITHUB_WEBHOOK_SECRET: 'shh-very-secret', ANTHROPIC_API_KEY: 'sk-ant-xyz', ALLOWED_OWNERS: 'Ayush-G09, Someone' }
  it('reads settings, lowercases owners, restores key newlines, and applies defaults', () => {
    const c = loadConfig(ok)
    expect(c).toMatchObject({ appId: '1', allowedOwners: ['ayush-g09', 'someone'], port: 3200, concurrency: 2, postClean: true, maxReviewsPerPrPerHour: 12 })
    expect(c.privateKey).toContain('\nabc\n')
  })
  it('names what is missing but never prints a value', () => {
    let msg = ''
    try { loadConfig({ ...ok, GITHUB_WEBHOOK_SECRET: '', ALLOWED_OWNERS: '' }) } catch (e) { msg = (e as Error).message }
    expect(msg).toContain('GITHUB_WEBHOOK_SECRET')
    expect(msg).toContain('ALLOWED_OWNERS')
    expect(msg).not.toContain('sk-ant-xyz')
  })
  it('refuses a key that is not a PEM, a negative number, and an owner list with nothing in it', () => {
    expect(() => loadConfig({ ...ok, GITHUB_PRIVATE_KEY: 'nope' })).toThrow(/PEM/)
    expect(() => loadConfig({ ...ok, PORT: '-3' })).toThrow(/PORT/)
    expect(() => loadConfig({ ...ok, ALLOWED_OWNERS: ' , ' })).toThrow(/empty/)
  })
  it('will not start with no allowed owners at all: reviews cost money', () => {
    const { ALLOWED_OWNERS: _o, ...rest } = ok
    expect(() => loadConfig(rest)).toThrow(/ALLOWED_OWNERS/)
  })
})
