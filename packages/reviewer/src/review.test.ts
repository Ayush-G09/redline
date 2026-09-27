import { describe, expect, it } from 'vitest'
import { parseDiff } from '@redline/core'
import type { Finding } from '@redline/core'
import { FatalError, RetriableError } from './client'
import { pieces, ScriptedClient } from './fake'
import { review } from './review'

const two = (n: number) => Array.from({ length: n }, (_, i) => `diff --git a/f${i}.ts b/f${i}.ts\n--- a/f${i}.ts\n+++ b/f${i}.ts\n@@ -1,2 +1,3 @@\n keep\n+added in ${i} ${'z'.repeat(300)}\n keep2\n`).join('')
const files = parseDiff(two(1))
const line = (o: Partial<Finding> & { path?: string } = {}) => JSON.stringify({ path: 'f0.ts', line: 2, kind: 'bug', severity: 'high', message: 'Broken.', ...o }) + '\n'
const noSleep = async () => {}

describe('review', () => {
  it('returns the comments the model made', async () => {
    const r = await review(new ScriptedClient(() => ({ chunks: [line()], usage: { inputTokens: 100, outputTokens: 20 } })), files)
    expect(r.findings).toHaveLength(1)
    expect(r.findings[0]).toMatchObject({ path: 'f0.ts', line: 2, kind: 'bug', source: 'scripted' })
    expect(r.usage).toEqual({ inputTokens: 100, outputTokens: 20, requests: 1 })
    expect(r.errors).toEqual([])
  })

  it('reads an answer that arrives a few characters at a time', async () => {
    const r = await review(new ScriptedClient(() => ({ chunks: pieces(line() + line({ kind: 'security' }), 7) })), files)
    expect(r.findings.map((f) => f.kind).sort()).toEqual(['bug', 'security'])
  })

  it('calls onFinding as comments complete, before the review is over', async () => {
    const order: string[] = []
    const client = new ScriptedClient(() => ({ chunks: [line(), line({ kind: 'security' })] }))
    await review(client, files, { onFinding: (f) => order.push(f.kind) })
    expect(order).toEqual(['bug', 'security'])
  })

  it('drops made-up places and reports them, without failing the review', async () => {
    const r = await review(new ScriptedClient(() => ({ chunks: [line({ line: 999 }), line({ path: 'ghost.ts' }), line()] })), files)
    expect(r.findings).toHaveLength(1)
    expect(r.dropped.map((d) => d.reason).sort()).toEqual(['line-not-in-diff', 'unknown-path'])
  })

  it('keeps one copy of a problem two prompts both found', async () => {
    const many = parseDiff(two(1))
    const client = new ScriptedClient(() => ({ chunks: [line(), line()] }))
    expect((await review(client, many)).findings).toHaveLength(1)
  })

  it('orders comments by severity and honours maxFindings', async () => {
    const answer = [line({ severity: 'low', line: 1 }), line({ severity: 'high', line: 3 }), line({ severity: 'medium', line: 2, kind: 'security' })].join('')
    const r = await review(new ScriptedClient(() => ({ chunks: [answer] })), files, { maxFindings: 2 })
    expect(r.findings.map((f) => f.severity)).toEqual(['high', 'medium'])
  })

  it('reports files it did not review', async () => {
    const d = parseDiff(two(1) + 'diff --git a/package-lock.json b/package-lock.json\n--- a/package-lock.json\n+++ b/package-lock.json\n@@ -1 +1 @@\n-a\n+b\n')
    const r = await review(new ScriptedClient(() => ({ chunks: [] })), d)
    expect(r.skipped).toEqual([{ path: 'package-lock.json', reason: 'generated or lock file' }])
  })

  it('makes no request at all when there is nothing to review', async () => {
    const client = new ScriptedClient(() => ({ chunks: [line()] }))
    const r = await review(client, [])
    expect(client.calls).toHaveLength(0)
    expect(r.findings).toEqual([])
  })

  it('spreads a big change over several prompts and merges the answers', async () => {
    const big = parseDiff(two(8))
    const client = new ScriptedClient((req) => {
      const ids = [...req.user.matchAll(/### f(\d)\.ts/g)].map((m) => m[1])
      return { chunks: ids.map((i) => line({ path: `f${i}.ts` })) }
    })
    const r = await review(client, big, { budget: 1000 })
    expect(client.calls.length).toBeGreaterThan(2)
    expect(r.findings.map((f) => f.path).sort()).toEqual(Array.from({ length: 8 }, (_, i) => `f${i}.ts`))
  })

  it('never has more prompts in flight than the limit', async () => {
    const client = new ScriptedClient(() => ({ chunks: [] }), 15)
    await review(client, parseDiff(two(10)), { budget: 500, concurrency: 3 })
    expect(client.calls.length).toBeGreaterThan(5)
    expect(client.maxActive).toBeLessThanOrEqual(3)
    expect(client.maxActive).toBeGreaterThan(1)
  })
})

describe('review: when the provider misbehaves', () => {
  it('retries a busy provider, honouring retry-after, then succeeds', async () => {
    const waits: number[] = []
    const client = new ScriptedClient((_r, n) => (n < 2 ? { first: new RetriableError('busy', n === 0 ? 5000 : undefined) } : { chunks: [line()] }))
    const r = await review(client, files, { backoffMs: 100, sleep: async (ms) => { waits.push(ms) } })
    expect(r.findings).toHaveLength(1)
    expect(r.errors).toEqual([])
    expect(waits).toEqual([5000, 200]) // the provider's retry-after, then our own backoff (100 * 2^1)
    expect(r.usage.requests).toBe(3)
  })

  it('gives up after the retry limit and says the review is incomplete', async () => {
    const client = new ScriptedClient(() => ({ first: new RetriableError('overloaded') }))
    const r = await review(client, files, { retries: 2, sleep: noSleep })
    expect(client.calls).toHaveLength(3)
    expect(r.findings).toEqual([])
    expect(r.errors).toHaveLength(1)
    expect(r.errors[0]).toMatch(/overloaded.*after 2 retries/)
  })

  it('does not retry a fatal error such as a bad key', async () => {
    const client = new ScriptedClient(() => ({ first: new FatalError('HTTP 401') }))
    const r = await review(client, files, { sleep: noSleep })
    expect(client.calls).toHaveLength(1)
    expect(r.errors[0]).toContain('HTTP 401')
  })

  it('does not start over once comments have already streamed out, and keeps them', async () => {
    const client = new ScriptedClient(() => ({ chunks: [line()], then: new RetriableError('connection dropped') }))
    const r = await review(client, files, { sleep: noSleep })
    expect(client.calls).toHaveLength(1)
    expect(r.findings).toHaveLength(1)
    expect(r.errors[0]).toMatch(/some comments may be missing/)
  })

  it('a failing prompt does not stop the others', async () => {
    const client = new ScriptedClient((req) => (req.user.includes('### f0.ts') ? { first: new FatalError('boom') } : { chunks: [line({ path: 'f3.ts' })] }))
    const r = await review(client, parseDiff(two(4)), { budget: 500, concurrency: 1, sleep: noSleep })
    expect(r.errors).toHaveLength(1)
    expect(r.findings.map((f) => f.path)).toEqual(['f3.ts'])
  })

  it('a cut-off answer is reported as dropped', async () => {
    const r = await review(new ScriptedClient(() => ({ chunks: [line().slice(0, 40)] })), files)
    expect(r.findings).toEqual([])
    expect(r.dropped.map((d) => d.reason)).toEqual(['truncated'])
  })

  it('stops when told to', async () => {
    const ctl = new AbortController()
    const client = new ScriptedClient(() => { ctl.abort(); return { first: new RetriableError('x') } })
    await expect(review(client, files, { signal: ctl.signal, sleep: noSleep })).rejects.toThrow()
  })
})

describe('review: extraSystem (learned "do not repeat" instructions)', () => {
  it('is appended to the system prompt sent to the model', async () => {
    let seenSystem = ''
    const capturing = new ScriptedClient((req) => { seenSystem = req.system; return { chunks: [] } })
    await review(capturing, files, { extraSystem: '\n\nDo not report X again.' })
    expect(seenSystem).toContain('Do not report X again.')
    expect(seenSystem.startsWith('You are a careful senior engineer')).toBe(true)
  })
  it('leaves the prompt untouched when there is nothing learned yet', async () => {
    let seenSystem = ''
    const capturing = new ScriptedClient((req) => { seenSystem = req.system; return { chunks: [] } })
    await review(capturing, files)
    expect(seenSystem).not.toContain('do not repeat')
  })
})
