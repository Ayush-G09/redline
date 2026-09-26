import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runCli } from '../src/cli'
import type { Io } from '../src/cli'

// A real git repository, and a fake Ollama over real HTTP that answers like a small local model would.

let dir: string
let ollama: Server
let host = ''
let asked: { body: any }[] = []
let answer: () => { status?: number; lines?: unknown[] } = () => ({ lines: [] })

const git = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: dir, encoding: 'utf8' })
const finding = (o: Record<string, unknown> = {}) => ({ path: 'src/a.ts', line: 2, kind: 'bug', severity: 'high', message: 'This is wrong.', ...o })

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'redline-cli-'))
  git('init', '-q', '-b', 'main')
  mkdirSync(join(dir, 'src'))
  writeFileSync(join(dir, 'src/a.ts'), 'line one\nline two\nline three\n')
  git('add', '-A'); git('commit', '-qm', 'base')
  git('checkout', '-q', '-b', 'feature')
  writeFileSync(join(dir, 'src/a.ts'), 'line one\nlet x = y + 1\nline two\nline three\n')
  git('add', '-A'); git('commit', '-qm', 'change')

  asked = []
  ollama = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    if (req.url === '/api/tags') return res.end(JSON.stringify({ models: [{ name: 'qwen2.5-coder:3b' }] }))
    asked.push({ body: JSON.parse(Buffer.concat(chunks).toString() || '{}') })
    const a = answer()
    res.statusCode = a.status ?? 200
    if (a.status) return res.end(JSON.stringify({ error: "model 'nope' not found" }))
    const text = (a.lines ?? []).map((l) => JSON.stringify(l)).join('\n')
    res.write(JSON.stringify({ message: { content: text.slice(0, 20) }, done: false }) + '\n')
    res.write(JSON.stringify({ message: { content: text.slice(20) }, done: false }) + '\n')
    res.end(JSON.stringify({ message: { content: '' }, done: true, prompt_eval_count: 300, eval_count: 60 }) + '\n')
  })
  await new Promise<void>((r) => ollama.listen(0, () => r()))
  host = `http://localhost:${(ollama.address() as { port: number }).port}`
})
afterEach(() => { ollama.close(); rmSync(dir, { recursive: true, force: true }) })

const env = () => ({ REDLINE_PROVIDER: 'ollama', OLLAMA_HOST: host })
async function run(args: string[], over: Record<string, string | undefined> = {}, stdin = '') {
  const out: string[] = []
  const err: string[] = []
  const io: Io = { out: (l) => out.push(l), err: (l) => err.push(l), cwd: dir, color: false, readStdin: async () => stdin }
  const code = await runCli(args, { ...env(), ...over }, io)
  return { code, out: out.join('\n'), err: err.join('\n') }
}

describe('review', () => {
  it('reviews the branch against main, and prints the comment with file and line', async () => {
    answer = () => ({ lines: [finding()] })
    const r = await run(['review', '--base', 'main'])
    expect(r.code).toBe(0)
    expect(r.out).toContain('Reviewing 1 file with ollama:')
    expect(r.out).toContain('src/a.ts:2  high bug')
    expect(r.out).toContain('This is wrong.')
    expect(r.out).toContain('1 comment.')
    expect(r.out).toContain('300 in / 60 out tokens')
    expect(asked[0].body.messages[1].content).toContain('    2 + let x = y + 1') // the model sees numbered lines
    expect(asked[0].body.options.num_ctx).toBeGreaterThanOrEqual(8192) // Ollama's small default would cut the prompt
  })

  it('finds the base branch on its own', async () => {
    answer = () => ({ lines: [] })
    const r = await run([])
    expect(r.code).toBe(0)
    expect(r.out).toContain('Nothing to flag.')
  })

  it('reviews only staged changes with --staged', async () => {
    answer = () => ({ lines: [] })
    writeFileSync(join(dir, 'src/b.ts'), 'new file\n')
    git('add', 'src/b.ts')
    const r = await run(['--staged'])
    expect(r.out).toContain('Reviewing 1 file')
    expect(asked[0].body.messages[1].content).toContain('### src/b.ts')
    expect(asked[0].body.messages[1].content).not.toContain('src/a.ts')
  })

  it('reads a diff from standard input', async () => {
    answer = () => ({ lines: [finding({ path: 'x.ts', line: 1 })] })
    const r = await run(['--stdin'], {}, '--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-a\n+b\n')
    expect(r.out).toContain('x.ts:1')
  })

  it('prints machine-readable JSON with --json', async () => {
    answer = () => ({ lines: [finding()] })
    const r = await run(['--base', 'main', '--json'])
    const j = JSON.parse(r.out)
    expect(j.findings).toHaveLength(1)
    expect(j.findings[0]).toMatchObject({ path: 'src/a.ts', line: 2, kind: 'bug' })
    expect(j.model).toMatch(/^ollama:/)
  })

  it('exits 1 when a comment reaches --fail-on, and 0 when it does not', async () => {
    answer = () => ({ lines: [finding({ severity: 'medium' })] })
    expect((await run(['--base', 'main', '--fail-on', 'medium'])).code).toBe(1)
    expect((await run(['--base', 'main', '--fail-on', 'high'])).code).toBe(0)
    expect((await run(['--base', 'main'])).code).toBe(0)
  })

  it('ignores comments the model made up, and says how many', async () => {
    answer = () => ({ lines: [finding({ line: 99 }), finding()] })
    const r = await run(['--base', 'main'])
    expect(r.out).toContain('1 comment.')
    expect(r.out).toContain('1 unusable model comment ignored')
  })

  it('says there is nothing to review when nothing changed', async () => {
    git('checkout', '-q', 'main')
    const r = await run(['--base', 'main'])
    expect(r.code).toBe(0)
    expect(r.out).toBe('No changes to review.')
    expect(asked).toHaveLength(0)
  })

  it('exits 3, saying so, when the model could not be used, never "all clear"', async () => {
    answer = () => ({ status: 404 })
    const r = await run(['--base', 'main'])
    expect(r.code).toBe(3)
    expect(r.err).toContain('ollama pull')
    expect(r.out).not.toContain('Nothing to flag')
  })

  it('tells you how to fix it when Ollama is not running', async () => {
    const r = await run(['--base', 'main'], { OLLAMA_HOST: 'http://localhost:1' })
    expect(r.code).toBe(3)
    expect(r.err).toContain('ollama serve')
  })
})

describe('setup problems exit with 2 and a useful message', () => {
  it('unknown options, missing values, bad --fail-on', async () => {
    expect((await run(['--nope'])).code).toBe(2)
    expect((await run(['--base'])).code).toBe(2)
    expect((await run(['--fail-on', 'loud'])).err).toContain('high, medium or low')
  })
  it('no key for a hosted model', async () => {
    const r = await run(['--base', 'main'], { REDLINE_PROVIDER: 'gemini' })
    expect(r.code).toBe(2)
    expect(r.err).toContain('GEMINI_API_KEY')
    expect(r.err).toContain('aistudio.google.com')
  })
  it('a base branch that does not exist, and stdin that is not a diff', async () => {
    expect((await run(['--base', 'nope'])).code).toBe(2)
    expect((await run(['--stdin'], {}, '@@ -1,5 +1,5 @@\n a\n')).err).toContain('valid diff')
  })
  it('shows help', async () => {
    const r = await run(['--help'])
    expect(r.code).toBe(0)
    expect(r.out).toContain('redline review')
  })
})

describe('models', () => {
  it('lists the models downloaded to Ollama', async () => {
    const r = await run(['models'])
    expect(r.code).toBe(0)
    expect(r.out).toBe('qwen2.5-coder:3b')
  })
  it('explains what to do when Ollama is not running', async () => {
    const r = await run(['models'], { OLLAMA_HOST: 'http://localhost:1' })
    expect(r.code).toBe(2)
    expect(r.err).toContain('ollama serve')
  })
  it('asks for a key when listing Gemini models without one', async () => {
    const r = await run(['models', '--provider', 'gemini'])
    expect(r.code).toBe(2)
    expect(r.err).toContain('GEMINI_API_KEY')
  })
})
