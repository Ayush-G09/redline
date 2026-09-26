import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { baselineReview, matchFindings } from '@redline/core'
import { AnthropicClient } from '@redline/reviewer'
import { llmReviewer } from './llm'
import { builtCases, report, runEval } from './runner'

// npm run eval                       score the rule-based baseline
// npm run eval -- --detail           also list every miss and wrong comment
// npm run eval -- --llm              score the language model (needs ANTHROPIC_API_KEY in the environment or a .env file)
// npm run eval -- --llm --model <id> use a different model (default: REDLINE_MODEL or claude-sonnet-5)
const args = process.argv.slice(2)
const detail = args.includes('--detail')
const useLlm = args.includes('--llm')
const modelArg = args.indexOf('--model')

const cases = builtCases()
console.log(`${cases.length} cases, ${cases.reduce((n, c) => n + c.expected.length, 0)} planted problems\n`)

let name = 'Baseline (pattern rules)'
let run
let extra = ''

if (useLlm) {
  if (existsSync('.env')) process.loadEnvFile('.env')
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    console.error('ANTHROPIC_API_KEY is not set. Put it in a .env file next to package.json (which is gitignored), or export it, then run again.')
    process.exit(2)
  }
  const model = modelArg >= 0 ? args[modelArg + 1] : process.env.REDLINE_MODEL ?? 'claude-sonnet-5'
  const client = new AnthropicClient({ apiKey, model })
  const { reviewer, stats } = llmReviewer(client)
  name = `Language model (${model})`
  const t0 = Date.now()
  run = await runEval(reviewer, cases, { concurrency: 3 })
  const secs = ((Date.now() - t0) / 1000).toFixed(0)
  extra = `\n  ${stats.requests} requests, ${stats.inputTokens} input + ${stats.outputTokens} output tokens, ${secs}s`
  const dropped = Object.entries(stats.dropped).map(([k, v]) => `${v} ${k}`).join(', ')
  if (dropped) extra += `\n  dropped comments: ${dropped}`
  if (stats.errors.length) {
    extra += `\n\n  WARNING: ${stats.errors.length} request(s) failed, so this score is NOT reliable:\n${stats.errors.map((e) => `    ${e}`).join('\n')}`
  }
  mkdirSync('packages/eval/runs', { recursive: true })
  const file = `packages/eval/runs/${new Date().toISOString().replace(/[:.]/g, '-')}.json`
  writeFileSync(file, JSON.stringify({ name, at: new Date().toISOString(), score: run.score, stats, findings: Object.fromEntries(run.results.map((r) => [r.id, r.findings])) }, null, 2))
  extra += `\n  saved ${file}`
} else {
  run = await runEval((files) => baselineReview(files), cases)
}

console.log(report(run, name) + extra)

if (detail) {
  console.log('\nDetail')
  for (const r of run.results) {
    const m = matchFindings(r.findings, r.expected)
    if (m.misses.length === 0 && m.falsePositives.length === 0) continue
    console.log(`  ${r.id}: ${r.title}`)
    for (const x of m.misses) console.log(`    missed   ${x.kind} at ${x.path}:${x.line}`)
    for (const x of m.falsePositives) console.log(`    wrong    ${x.kind} at ${x.path}:${x.line}  ${x.message.slice(0, 90)}`)
  }
}
