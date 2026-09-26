import { appendFileSync, readFileSync } from 'node:fs'
import { runAction } from './run'

// GitHub passes an action's inputs as INPUT_<NAME> variables. They only fill in settings that are not already set.
const fromInput = (input: string, name: string) => {
  const v = process.env[`INPUT_${input.toUpperCase()}`]
  if (v && !process.env[name]) process.env[name] = v
}
fromInput('provider', 'REDLINE_PROVIDER')
fromInput('model', 'REDLINE_MODEL')
fromInput('max-files', 'REDLINE_MAX_FILES')
fromInput('post-clean', 'REDLINE_POST_CLEAN')
if (!process.env.GITHUB_TOKEN && process.env.INPUT_TOKEN) process.env.GITHUB_TOKEN = process.env.INPUT_TOKEN

const eventPath = process.env.GITHUB_EVENT_PATH
if (!eventPath) {
  console.error('GITHUB_EVENT_PATH is not set: this is meant to run inside a GitHub Action.')
  process.exit(1)
}

const result = await runAction(process.env, readFileSync(eventPath, 'utf8'), { log: (l) => console.log(l) })

// annotations show up on the workflow run page
const line = result.message.replace(/\r?\n/g, '%0A')
console.log(result.exitCode === 0 ? `::notice title=Redline::${line}` : `::error title=Redline::${line}`)
if (process.env.GITHUB_STEP_SUMMARY) {
  try { appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Redline\n\n${result.message}\n`) } catch { /* the summary is a nicety */ }
}
process.exit(result.exitCode)
