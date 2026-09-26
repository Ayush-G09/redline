import { baselineReview, matchFindings } from '@redline/core'
import { builtCases, report, runEval } from './runner'

// npm run eval            score the rule-based baseline
// npm run eval -- --detail  also list every miss and wrong comment
const detail = process.argv.includes('--detail')
const cases = builtCases()
const run = await runEval((files) => baselineReview(files), cases)
console.log(`${cases.length} cases, ${cases.reduce((n, c) => n + c.expected.length, 0)} planted problems\n`)
console.log(report(run, 'Baseline (pattern rules)'))

if (detail) {
  console.log('\nDetail')
  for (const r of run.results) {
    const m = matchFindings(r.findings, r.expected)
    if (m.misses.length === 0 && m.falsePositives.length === 0) continue
    console.log(`  ${r.id}: ${r.title}`)
    for (const x of m.misses) console.log(`    missed   ${x.kind} at ${x.path}:${x.line}`)
    for (const x of m.falsePositives) console.log(`    wrong    ${x.kind} at ${x.path}:${x.line}  (${x.source ?? '?'})`)
  }
}
