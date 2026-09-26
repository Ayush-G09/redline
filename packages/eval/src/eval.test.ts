import { describe, expect, it } from 'vitest'
import { baselineReview, checkFinding, commentableLines, KINDS } from '@redline/core'
import type { Finding } from '@redline/core'
import { builtCases, runEval } from './runner'
import { CASES } from './cases'

const cases = builtCases()

describe('the golden set is well formed', () => {
  it('has enough cases, with unique ids, a mix of kinds, and clean changes', () => {
    expect(cases.length).toBeGreaterThanOrEqual(30)
    expect(new Set(CASES.map((c) => c.id)).size).toBe(CASES.length)
    const kinds = new Set(cases.flatMap((c) => c.expected.map((e) => e.kind)))
    for (const k of KINDS) expect(kinds.has(k), `no case plants a "${k}" problem`).toBe(true)
    expect(cases.filter((c) => c.expected.length === 0).length).toBeGreaterThanOrEqual(6)
  })
  it('every planted problem is on a line a reviewer could actually comment on', () => {
    for (const c of cases) {
      const ok = commentableLines(c.files)
      for (const e of c.expected) expect(ok.get(e.path)?.has(e.line), `${c.id}: ${e.path}:${e.line}`).toBe(true)
    }
  })
  it('every case has a diff that parses into the files it declares', () => {
    for (const [i, c] of cases.entries()) expect(c.files.map((f) => f.path).sort(), c.id).toEqual(CASES[i].files.map((f) => f.path).sort())
  })
})

describe('the harness measures what it claims to', () => {
  it('a reviewer that knows the answers scores 100%', async () => {
    const answers = new Map(cases.map((c) => [c.id, c.expected]))
    const run = await runEval((_files, m) => (answers.get(m.id) ?? []).map((e): Finding => ({ ...e, severity: 'high', message: 'planted' })))
    expect(run.score).toMatchObject({ precision: 1, recall: 1, f1: 1, fp: 0, fn: 0, falseAlarms: 0 })
  })
  it('a reviewer that says nothing has no recall', async () => {
    const run = await runEval(() => [])
    expect(run.score.recall).toBe(0)
    expect(run.score.fn).toBe(cases.reduce((n, c) => n + c.expected.length, 0))
  })
  it('a reviewer that comments on every added line cannot game it: recall is high but precision is terrible', async () => {
    const run = await runEval((files) => files.flatMap((f) => f.hunks.flatMap((h) => h.lines.filter((l) => l.kind === 'add').flatMap((l) => KINDS.map((kind): Finding => ({ path: f.path, line: l.newLine as number, kind, severity: 'low', message: 'spam' }))))))
    expect(run.score.precision).toBeLessThan(0.15)
    expect(run.score.falseAlarms).toBeGreaterThan(20)
  })
  it('a reviewer that is right but points at the wrong line gets no credit', async () => {
    const answers = new Map(cases.map((c) => [c.id, c.expected]))
    const run = await runEval((files, m) => (answers.get(m.id) ?? []).map((e): Finding => {
      const far = [...(commentableLines(files).get(e.path) ?? [])].filter((l) => Math.abs(l - e.line) > 4).sort((a, b) => Math.abs(a - e.line) - Math.abs(b - e.line))[0]
      return { ...e, line: far ?? e.line + 1000, severity: 'high', message: 'wrong place' }
    }))
    expect(run.score.tp).toBeLessThan(5)
  })
  it('comments on lines outside the diff are counted invalid, not silently accepted', async () => {
    const run = await runEval((_f, m) => (cases.find((c) => c.id === m.id)?.expected ?? []).map((e): Finding => ({ ...e, line: 9999, severity: 'high', message: 'x' })))
    expect(run.score.invalid).toBeGreaterThan(20)
    expect(run.score.tp).toBe(0)
  })
})

describe('the baseline reviewer (the number to beat)', () => {
  it('stays inside a known range, so changing the rules or the cases is a visible decision', async () => {
    const run = await runEval((files) => baselineReview(files))
    expect(run.score.precision).toBeGreaterThan(0.8)
    expect(run.score.recall).toBeGreaterThan(0.35)
    expect(run.score.recall).toBeLessThan(0.55) // it cannot understand code; if this jumps, the cases got easier
    expect(run.score.invalid).toBe(0)
  })
  it('only ever points at places that are in the diff', async () => {
    for (const c of cases) for (const f of baselineReview(c.files)) expect(checkFinding(c.files, f), `${c.id}: ${f.source}`).toBeNull()
  })
  it('does not read removed lines, test files or docs', () => {
    const c = (id: string) => cases.find((x) => x.id === id)!
    expect(baselineReview(c('trap-fixture').files)).toEqual([])
    expect(baselineReview(c('clean-docs').files)).toEqual([])
  })
})
