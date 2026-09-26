import { execFileSync } from 'node:child_process'
import { DiffParseError, parseDiff } from '@redline/core'
import type { Finding } from '@redline/core'
import { createClient, listGeminiModels, listOllamaModels, review } from '@redline/reviewer'

export interface Io {
  out(line: string): void
  err(line: string): void
  cwd: string
  readStdin(): Promise<string>
  color: boolean
}

const USAGE = `Redline: review code changes with an AI model. Free with Gemini (a free key) or Ollama (on your machine, no key).

  redline review [--base <ref>] [--staged] [--stdin] [options]
  redline models [--provider gemini|ollama]

  --base <ref>       compare the current branch with this one (default: origin/main, main or master)
  --staged           review only what is staged for commit
  --stdin            read a unified diff from standard input
  --provider <name>  gemini | ollama | anthropic   (default: Gemini if GEMINI_API_KEY is set, else Ollama)
  --model <name>     the model to use (see "redline models")
  --fail-on <level>  exit with code 1 if there is a comment at this severity or worse: high | medium | low
  --json             print the result as JSON instead of text
  --title <text>     a title for the change (helps the model)

Exit codes: 0 done, 1 a comment reached --fail-on, 2 bad usage or setup, 3 the review is incomplete (part of it failed).`

const SEV = { high: 0, medium: 1, low: 2 } as const

function parseArgs(argv: string[]) {
  const flags = new Set(['--staged', '--stdin', '--json', '--help', '-h'])
  const withValue = new Set(['--base', '--provider', '--model', '--fail-on', '--title'])
  const o: Record<string, string | boolean> = {}
  const positional: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (flags.has(a)) o[a.replace(/^-+/, '')] = true
    else if (withValue.has(a)) {
      const v = argv[++i]
      if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value`)
      o[a.slice(2)] = v
    } else if (a.startsWith('-')) throw new Error(`Unknown option ${a}`)
    else positional.push(a)
  }
  return { o, positional }
}

const git = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'pipe'] })
const gitOk = (cwd: string, args: string[]) => { try { git(cwd, args); return true } catch { return false } }

function defaultBase(cwd: string): string {
  try { return git(cwd, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).trim() } catch { /* not set */ }
  for (const b of ['origin/main', 'main', 'origin/master', 'master']) if (gitOk(cwd, ['rev-parse', '--verify', '--quiet', b])) return b
  throw new Error('Could not find a branch to compare with. Pass --base <branch>.')
}

/** Runs the command line tool. Returns the exit code, and writes everything through `io` so it can be tested. */
export async function runCli(argv: string[], env: Record<string, string | undefined>, io: Io): Promise<number> {
  const paint = (code: string, s: string) => (io.color ? `\u001b[${code}m${s}\u001b[0m` : s)
  let cmd = 'review'
  let rest = argv
  if (argv[0] === 'models' || argv[0] === 'review') { cmd = argv[0]; rest = argv.slice(1) }
  let parsed
  try { parsed = parseArgs(rest) } catch (e) { io.err(`${(e as Error).message}\n\n${USAGE}`); return 2 }
  const { o } = parsed
  if (o.help || o.h) { io.out(USAGE); return 0 }

  if (cmd === 'models') {
    const provider = String(o.provider ?? env.REDLINE_PROVIDER ?? (env.GEMINI_API_KEY ? 'gemini' : 'ollama'))
    try {
      if (provider === 'gemini') {
        if (!env.GEMINI_API_KEY) { io.err('GEMINI_API_KEY is not set. Get a free key at https://aistudio.google.com/apikey'); return 2 }
        for (const m of await listGeminiModels(env.GEMINI_API_KEY, fetch, env.GEMINI_BASE_URL || undefined)) io.out(`${m.id}${m.description ? `   ${m.description}` : ''}`)
      } else if (provider === 'ollama') {
        const list = await listOllamaModels(env.OLLAMA_HOST || undefined)
        if (list.length === 0) io.out('No models downloaded yet. Get one with: ollama pull qwen2.5-coder:3b')
        for (const m of list) io.out(m)
      } else { io.err(`Listing models is supported for gemini and ollama, not "${provider}".`); return 2 }
      return 0
    } catch (e) {
      const msg = (e as Error).message
      io.err(provider === 'ollama' && /fetch failed|ECONNREFUSED|Cannot reach/i.test(msg) ? 'Cannot reach Ollama. Is it installed and running? (start it with "ollama serve")' : msg)
      return 2
    }
  }

  const failOn = o['fail-on'] as string | undefined
  if (failOn !== undefined && !(failOn in SEV)) { io.err(`--fail-on must be high, medium or low`); return 2 }

  let diff: string
  try {
    if (o.stdin) diff = await io.readStdin()
    else if (o.staged) diff = git(io.cwd, ['diff', '--cached', '--no-color'])
    else {
      const base = typeof o.base === 'string' ? o.base : defaultBase(io.cwd)
      diff = git(io.cwd, ['diff', '--no-color', `${base}...HEAD`])
    }
  } catch (e) {
    io.err(`Could not get the diff: ${(e as Error).message.split('\n')[0]}`)
    return 2
  }
  let files
  try { files = parseDiff(diff) } catch (e) { io.err(e instanceof DiffParseError ? `That does not look like a valid diff: ${e.message}` : (e as Error).message); return 2 }
  if (files.length === 0) { io.out('No changes to review.'); return 0 }

  let llm
  try { llm = createClient(env, { provider: o.provider as string | undefined, model: o.model as string | undefined }) } catch (e) { io.err((e as Error).message); return 2 }

  const json = !!o.json
  if (!json) io.out(paint('2', `Reviewing ${files.length} file${files.length === 1 ? '' : 's'} with ${llm.name}...`))
  const show = (f: Finding) => {
    const badge = paint(f.severity === 'high' ? '31' : f.severity === 'medium' ? '33' : '36', `${f.severity} ${f.kind}`)
    io.out(`\n${paint('1', `${f.path}:${f.line}`)}  ${badge}\n  ${f.message.replace(/\n/g, '\n  ')}`)
  }
  const t0 = Date.now()
  const result = await review(llm, files, { title: typeof o.title === 'string' ? o.title : undefined, onFinding: json ? undefined : show })
  const secs = ((Date.now() - t0) / 1000).toFixed(1)

  if (json) {
    io.out(JSON.stringify({ model: llm.name, findings: result.findings, skipped: result.skipped, errors: result.errors, dropped: result.dropped.length, usage: result.usage }, null, 2))
  } else {
    const n = result.findings.length
    io.out(`\n${n === 0 && result.errors.length === 0 ? paint('32', 'Nothing to flag.') : `${n} comment${n === 1 ? '' : 's'}.`} (${secs}s${result.usage.outputTokens ? `, ${result.usage.inputTokens} in / ${result.usage.outputTokens} out tokens` : ''})`)
    for (const s of result.skipped) io.out(paint('2', `Not reviewed: ${s.path} (${s.reason})`))
    if (result.dropped.length) io.out(paint('2', `${result.dropped.length} unusable model comment${result.dropped.length === 1 ? '' : 's'} ignored (they pointed at places not in the diff or were malformed).`))
  }
  if (result.errors.length) {
    for (const e of result.errors) io.err(paint('31', `Incomplete: ${e}`))
    return 3
  }
  if (failOn !== undefined && result.findings.some((f) => SEV[f.severity] <= SEV[failOn as keyof typeof SEV])) return 1
  return 0
}
