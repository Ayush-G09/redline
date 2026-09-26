import { describe, expect, it } from 'vitest'
import { parseDiff } from './diff'
import { addedLines, checkFinding, commentableLines } from './findings'
import type { Finding } from './findings'
import { matchFindings, score } from './scoring'
import type { CaseResult, Expected } from './scoring'

const DIFF = `diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -10,3 +10,4 @@
 ctx10
+added11
 ctx11
 ctx12
@@ -30,2 +31,2 @@
-old
+new32
 ctx33
`
const files = parseDiff(DIFF)
const f = (line: number, kind: Finding['kind'] = 'bug', extra: Partial<Finding> = {}): Finding => ({ path: 'a.ts', line, kind, severity: 'medium', message: 'm', ...extra })
const e = (line: number, kind: Expected['kind'] = 'bug', endLine?: number): Expected => ({ path: 'a.ts', line, kind, endLine })

describe('commentable lines', () => {
  it('lists the new-file lines that appear in the diff: added and context, never removed ones', () => {
    expect([...(commentableLines(files).get('a.ts') as Set<number>)].sort((x, y) => x - y)).toEqual([10, 11, 12, 13, 31, 32])
  })
  it('lists only added lines for addedLines', () => {
    expect([...(addedLines(files).get('a.ts') as Map<number, string>)]).toEqual([[11, 'added11'], [31, 'new32']])
  })
  it('a deleted file has nothing to comment on', () => {
    const d = parseDiff('diff --git a/x b/x\ndeleted file mode 100644\n--- a/x\n+++ /dev/null\n@@ -1 +0,0 @@\n-bye\n')
    expect(commentableLines(d).size).toBe(0)
  })
})

describe('checkFinding', () => {
  it('accepts a comment on a line in the diff', () => expect(checkFinding(files, f(11))).toBeNull())
  it('rejects made-up places', () => {
    expect(checkFinding(files, f(500))).toBe('line-not-in-diff')
    expect(checkFinding(files, f(20))).toBe('line-not-in-diff') // in the file, but not in the diff
    expect(checkFinding(files, f(11, 'bug', { path: 'nope.ts' }))).toBe('unknown-path')
  })
  it('rejects bad ranges, kinds and empty messages', () => {
    expect(checkFinding(files, f(12, 'bug', { endLine: 11 }))).toBe('bad-range')
    expect(checkFinding(files, f(1.5))).toBe('bad-range')
    expect(checkFinding(files, f(11, 'nonsense' as never))).toBe('bad-kind')
    expect(checkFinding(files, f(11, 'bug', { message: '  ' }))).toBe('empty-message')
  })
  it('a range must start and end inside the diff', () => {
    expect(checkFinding(files, f(11, 'bug', { endLine: 13 }))).toBeNull()
    expect(checkFinding(files, f(11, 'bug', { endLine: 20 }))).toBe('line-not-in-diff')
  })
})

describe('matchFindings', () => {
  it('matches the right file, kind and place, with a little slack', () => {
    const m = matchFindings([f(12)], [e(11)])
    expect(m.matches).toHaveLength(1)
    expect(m.falsePositives).toEqual([])
    expect(m.misses).toEqual([])
  })
  it('does not match the wrong kind, the wrong file, or a distant line', () => {
    expect(matchFindings([f(11, 'security')], [e(11)]).matches).toHaveLength(0)
    expect(matchFindings([f(11, 'bug', { path: 'b.ts' })], [e(11)]).matches).toHaveLength(0)
    expect(matchFindings([f(20)], [e(11)]).matches).toHaveLength(0)
  })
  it('ten comments on one problem score one hit and nine false alarms', () => {
    const many = Array.from({ length: 10 }, () => f(11))
    const m = matchFindings(many, [e(11)])
    expect(m.matches).toHaveLength(1)
    expect(m.falsePositives).toHaveLength(9)
  })
  it('one comment cannot cover two separate problems', () => {
    const m = matchFindings([f(11)], [e(11), e(12)])
    expect(m.matches).toHaveLength(1)
    expect(m.misses).toHaveLength(1)
  })
  it('pairs the closest first, whatever order comments arrive in', () => {
    const a = matchFindings([f(11), f(13)], [e(13), e(11)])
    const b = matchFindings([f(13), f(11)], [e(11), e(13)])
    for (const m of [a, b]) {
      expect(m.matches.map((x) => [x.finding.line, x.expected.line]).sort()).toEqual([[11, 11], [13, 13]])
    }
  })
  it('uses ranges: a comment spanning the problem counts', () => {
    expect(matchFindings([f(10, 'bug', { endLine: 13 })], [e(12)]).matches).toHaveLength(1)
  })
})

describe('score', () => {
  const c = (id: string, findings: Finding[], expected: Expected[]): CaseResult => ({ id, files, findings, expected })
  it('computes precision, recall and f1', () => {
    const s = score([c('1', [f(11), f(12, 'style' as never)], [e(11), e(32)])])
    // 'style' is not a real kind, so it is invalid and counts against precision
    expect(s).toMatchObject({ tp: 1, fp: 1, fn: 1, invalid: 1 })
    expect(s.precision).toBeCloseTo(0.5)
    expect(s.recall).toBeCloseTo(0.5)
    expect(s.f1).toBeCloseTo(0.5)
  })
  it('counts a comment outside the diff as wrong even if it names the right problem', () => {
    const s = score([c('1', [f(20)], [e(20)])])
    expect(s.tp).toBe(0)
    expect(s.invalid).toBe(1)
  })
  it('reports false alarms on changes that had nothing wrong', () => {
    const s = score([c('clean1', [f(11), f(12)], []), c('clean2', [], []), c('bad', [f(11)], [e(11)])])
    expect(s.cleanCases).toBe(2)
    expect(s.falseAlarms).toBe(2)
    expect(s.tp).toBe(1)
  })
  it('breaks results down by kind', () => {
    const s = score([c('1', [f(11, 'bug'), f(32, 'security')], [e(11, 'bug'), e(32, 'performance')])])
    expect(s.perKind.bug).toMatchObject({ tp: 1, fp: 0, fn: 0 })
    expect(s.perKind.security).toMatchObject({ tp: 0, fp: 1 })
    expect(s.perKind.performance).toMatchObject({ fn: 1 })
  })
  it('has no divide-by-zero when nothing was said or expected', () => {
    const s = score([c('1', [], [])])
    expect(s).toMatchObject({ precision: 0, recall: 0, f1: 0, tp: 0 })
  })
})
