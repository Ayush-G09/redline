import { score } from '@redline/core'
import type { CaseResult, DiffFile, Finding, Score } from '@redline/core'
import { build } from './builder'
import type { BuiltCase } from './builder'
import { CASES } from './cases'

/** Anything that reads a change and returns comments: the rule baseline now, a language model later. */
export type Reviewer = (files: readonly DiffFile[], meta: { id: string; title: string }) => Finding[] | Promise<Finding[]>

export const builtCases = (): BuiltCase[] => CASES.map(build)

export interface Run {
  score: Score
  results: (CaseResult & { title: string })[]
}

export async function runEval(review: Reviewer, cases: BuiltCase[] = builtCases(), { concurrency = 1 }: { concurrency?: number } = {}): Promise<Run> {
  const results: Run['results'] = new Array(cases.length)
  let next = 0
  const worker = async () => {
    while (next < cases.length) {
      const i = next++
      const c = cases[i]
      const findings = await review(c.files, { id: c.id, title: c.title })
      results[i] = { id: c.id, title: c.title, files: c.files, findings, expected: c.expected }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, cases.length) }, worker))
  return { score: score(results), results }
}

const pct = (x: number) => `${(x * 100).toFixed(0)}%`.padStart(4)

/** A readable report: the headline numbers, a per-kind table, and exactly what was missed or wrongly flagged. */
export function report(run: Run, name: string): string {
  const s = run.score
  const out: string[] = []
  out.push(`${name}`)
  out.push(`  precision ${pct(s.precision)}   recall ${pct(s.recall)}   F1 ${pct(s.f1)}`)
  out.push(`  ${s.tp} found, ${s.fn} missed, ${s.fp} wrong (${s.invalid} pointed outside the diff)`)
  out.push(`  ${s.falseAlarms} false alarms across ${s.cleanCases} clean changes`)
  out.push('')
  out.push('  kind             found  missed  wrong  recall')
  for (const [k, v] of Object.entries(s.perKind)) {
    if (v.tp + v.fn + v.fp === 0) continue
    out.push(`  ${k.padEnd(16)} ${String(v.tp).padStart(5)} ${String(v.fn).padStart(7)} ${String(v.fp).padStart(6)}  ${pct(v.recall)}`)
  }
  return out.join('\n')
}
