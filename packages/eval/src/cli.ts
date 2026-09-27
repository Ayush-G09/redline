import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { baselineReview, matchFindings } from '@redline/core'
import { createClient } from '@redline/reviewer'
import { llmReviewer } from './llm'
import { builtCases, report, runEval } from './runner'

// npm run eval                       score the rule-based baseline
// npm run eval -- --detail           also list every miss and wrong comment
// npm run eval -- --llm              score a language model (GEMINI_API_KEY in the environment or .env, or a local Ollama)
// npm run eval -- --llm --provider ollama --model qwen2.5-coder:3b     a model on this machine, no key
// npm run eval -- --llm --limit 10   only the first 10 cases (the free Gemini tier allows a limited number of requests a day)
const args = process.argv.slice(2)
const detail = args.includes('--detail')
const useLlm = args.includes('--llm')
const arg = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined }

const limit = Number(arg('--limit') ?? Infinity)
const cases = builtCases().slice(0, limit)
console.log(`${cases.length} cases, ${cases.reduce((n, c) => n + c.expected.length, 0)} planted problems\n`)

let name = 'Baseline (pattern rules)'
let run
let extra = ''

if (useLlm) {
  if (existsSync('.env')) process.loadEnvFile('.env')
  let client
  try {
    client = createClient(process.env, { provider: arg('--provider'), model: arg('--model') })
  } catch (e) {
    console.error((e as Error).message)
    process.exit(2)
  }
  const { reviewer, stats } = llmReviewer(client)
  name = `Language model (${client.name})`
  const t0 = Date.now()
  run = await runEval(reviewer, cases, { concurrency: client.maxConcurrency ?? 3, onProgress: (done, total, id, ms) => console.error(`  [${done}/${total}] ${id} (${(ms / 1000).toFixed(1)}s)`) })
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
