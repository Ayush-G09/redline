import type { DiffFile } from './diff'
import { checkFinding, KINDS } from './findings'
import type { Finding, Kind } from './findings'

/** A problem that is really there, written down by whoever built the test case. */
export interface Expected {
  path: string
  line: number
  endLine?: number
  kind: Kind
}

export interface Match { finding: Finding; expected: Expected }

export interface KindScore { tp: number; fp: number; fn: number; precision: number; recall: number }

export interface Score {
  tp: number
  fp: number
  fn: number
  /** of the comments made, how many were right */
  precision: number
  /** of the real problems, how many were found */
  recall: number
  f1: number
  /** comments that pointed at a place that is not in the diff (never counted as right) */
  invalid: number
  /** comments made on changes that had nothing wrong with them */
  falseAlarms: number
  cleanCases: number
  perKind: Record<Kind, KindScore>
}

export interface MatchOptions {
  /** how many lines off a comment may be and still count as pointing at the problem */
  tolerance?: number
}

const overlaps = (a0: number, a1: number, b0: number, b1: number) => a0 <= b1 && b0 <= a1

/**
 * Pairs comments with real problems one to one: same file, same kind, and the comment's lines touch the problem's lines
 * (give or take `tolerance`). One to one matters: ten comments on the same line must not each score a hit, and one
 * comment must not cover two separate problems. The closest pairs are taken first, so the pairing does not depend on the
 * order the comments came in.
 */
export function matchFindings(findings: readonly Finding[], expected: readonly Expected[], { tolerance = 2 }: MatchOptions = {}) {
  const candidates: { fi: number; ei: number; dist: number }[] = []
  findings.forEach((f, fi) => expected.forEach((e, ei) => {
    if (f.path !== e.path || f.kind !== e.kind) return
    const f0 = f.line
    const f1 = f.endLine ?? f.line
    const e0 = e.line
    const e1 = e.endLine ?? e.line
    if (!overlaps(f0, f1, e0 - tolerance, e1 + tolerance)) return
    candidates.push({ fi, ei, dist: Math.abs(f0 - e0) + Math.abs(f1 - e1) })
  }))
  candidates.sort((a, b) => a.dist - b.dist || a.fi - b.fi || a.ei - b.ei)
  const usedF = new Set<number>()
  const usedE = new Set<number>()
  const matches: Match[] = []
  for (const c of candidates) {
    if (usedF.has(c.fi) || usedE.has(c.ei)) continue
    usedF.add(c.fi)
    usedE.add(c.ei)
    matches.push({ finding: findings[c.fi], expected: expected[c.ei] })
  }
  return {
    matches,
    falsePositives: findings.filter((_, i) => !usedF.has(i)),
    misses: expected.filter((_, i) => !usedE.has(i)),
  }
}

export interface CaseResult {
  id: string
  files: readonly DiffFile[]
  findings: readonly Finding[]
  expected: readonly Expected[]
}

const ratio = (a: number, b: number) => (b === 0 ? 0 : a / b)

/**
 * Scores a reviewer over many test cases. A comment that points at a place outside the diff counts as wrong (and is
 * reported as `invalid`), whatever it says. A case with no real problems is a "clean" case: any comment there is a false alarm.
 */
export function score(results: readonly CaseResult[], opts: MatchOptions = {}): Score {
  const perKind = Object.fromEntries(KINDS.map((k) => [k, { tp: 0, fp: 0, fn: 0, precision: 0, recall: 0 }])) as Record<Kind, KindScore>
  let tp = 0
  let fp = 0
  let fn = 0
  let invalid = 0
  let falseAlarms = 0
  let cleanCases = 0
  for (const r of results) {
    const usable = r.findings.filter((f) => checkFinding(r.files, f) === null)
    const bad = r.findings.length - usable.length
    invalid += bad
    const m = matchFindings(usable, r.expected, opts)
    tp += m.matches.length
    fp += m.falsePositives.length + bad
    fn += m.misses.length
    for (const x of m.matches) perKind[x.expected.kind].tp++
    for (const x of m.falsePositives) perKind[x.kind].fp++
    for (const x of m.misses) perKind[x.kind].fn++
    if (r.expected.length === 0) { cleanCases++; falseAlarms += r.findings.length }
  }
  for (const k of KINDS) {
    perKind[k].precision = ratio(perKind[k].tp, perKind[k].tp + perKind[k].fp)
    perKind[k].recall = ratio(perKind[k].tp, perKind[k].tp + perKind[k].fn)
  }
  const precision = ratio(tp, tp + fp)
  const recall = ratio(tp, tp + fn)
  return { tp, fp, fn, precision, recall, f1: ratio(2 * precision * recall, precision + recall), invalid, falseAlarms, cleanCases, perKind }
}
