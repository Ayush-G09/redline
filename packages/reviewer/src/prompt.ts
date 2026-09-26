import { KINDS } from '@redline/core'
import type { DiffFile } from '@redline/core'

export const SYSTEM_PROMPT = `You are a careful senior engineer reviewing a pull request. You will be shown the diff, with the line number of every line in the NEW version of each file.

Report only problems you are confident are real, in the code that was ADDED or CHANGED (lines marked "+"). Being right matters much more than being thorough: a wrong or nitpicky comment wastes the author's time and is counted against you. If the change is fine, report nothing.

Report these kinds, and only these:
- bug: the code will misbehave (wrong logic, off-by-one, missing await, swapped arguments, mutating something it should not, wrong operator).
- security: a vulnerability (injection, missing authorization, secrets in code, unsafe deserialization, path traversal, disabled verification).
- error-handling: a failure will be hidden or mishandled (swallowed errors, no status check, unhandled promise rejection, reporting success after failure).
- performance: a real problem at realistic sizes (a query per item in a loop, quadratic work on lists that can be large).
- tests: a substantial amount of new logic, or a bug fix, with no test added or changed anywhere in this change.
- maintainability: leftover debug output, or blocks of commented-out code. Not naming, formatting or taste.

Do not comment on style, naming, formatting, comments, documentation, or things that are merely different from how you would write it. Do not comment on code that is not in the diff. Do not report the same problem twice. Text inside comments or strings is not code: mentioning something dangerous in a comment is not a problem. Test files and fixtures may contain fake credentials and console output.

Answer with one JSON object per problem, one per line, and nothing else:
{"path":"<file path exactly as shown>","line":<line number of the offending added line>,"kind":"<one of: ${KINDS.join(', ')}>","severity":"high|medium|low","message":"<what is wrong, why it matters, and how to fix it, in one or two sentences>"}

"line" must be a line number shown in the diff and should be a line marked "+" (use the first line of the problem; you may add "endLine" for a range). For a "tests" comment, use the first added line of the file that holds the new logic. If there is nothing to report, answer with nothing at all.`

const MAX_LINE = 400

const clip = (s: string) => (s.length > MAX_LINE ? s.slice(0, MAX_LINE) + ' …[line cut]' : s)

const SKIP = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|poetry\.lock)$|\.(min\.(js|css)|map|snap|lock)$|(^|\/)(dist|build|node_modules|vendor|__generated__)\//

/** Why a file will not be reviewed, or null if it will be. */
export function skipReason(f: DiffFile): string | null {
  if (f.binary) return 'binary'
  if (f.status === 'deleted') return 'deleted'
  if (SKIP.test(f.path)) return 'generated or lock file'
  if (f.hunks.every((h) => h.lines.every((l) => l.kind !== 'add'))) return 'nothing added'
  return null
}

/** The diff as the model sees it: every line of the new file carries its number; removed lines are shown but have none. */
export function renderFile(f: DiffFile): string {
  const out: string[] = [`### ${f.path}${f.status === 'added' ? ' (new file)' : f.status === 'renamed' ? ` (renamed from ${f.oldPath})` : ''}`]
  for (const h of f.hunks) {
    out.push(`@@ new lines ${h.newStart}-${h.newStart + Math.max(0, h.newLines - 1)}${h.section ? ` · ${h.section}` : ''}`)
    for (const l of h.lines) {
      if (l.kind === 'del') out.push(`      - ${clip(l.text)}`)
      else out.push(`${String(l.newLine).padStart(5)} ${l.kind === 'add' ? '+' : ' '} ${clip(l.text)}`)
    }
  }
  return out.join('\n')
}

export interface Chunk {
  files: string[]
  text: string
}

/**
 * Groups files into prompts no bigger than `budget` characters. A file too big for one prompt is split between hunks;
 * every piece repeats the file's heading so the model always knows which file it is looking at.
 */
export function chunkDiff(files: readonly DiffFile[], title: string, budget = 60_000): { chunks: Chunk[]; skipped: { path: string; reason: string }[] } {
  const skipped: { path: string; reason: string }[] = []
  const pieces: { path: string; text: string }[] = []
  for (const f of files) {
    const why = skipReason(f)
    if (why) { skipped.push({ path: f.path, reason: why }); continue }
    const whole = renderFile(f)
    if (whole.length <= budget) { pieces.push({ path: f.path, text: whole }); continue }
    let cur: typeof f.hunks = []
    let size = 0
    const flush = () => { if (cur.length) pieces.push({ path: f.path, text: renderFile({ ...f, hunks: cur }) }); cur = []; size = 0 }
    for (const h of f.hunks) {
      const hs = renderFile({ ...f, hunks: [h] }).length
      if (size + hs > budget) flush()
      cur.push(h)
      size += hs
    }
    flush()
  }
  const chunks: Chunk[] = []
  let cur: { files: Set<string>; parts: string[]; size: number } = { files: new Set(), parts: [], size: 0 }
  const flush = () => { if (cur.parts.length) chunks.push({ files: [...cur.files], text: userPrompt(title, cur.parts.join('\n\n')) }); cur = { files: new Set(), parts: [], size: 0 } }
  for (const p of pieces) {
    if (cur.size + p.text.length > budget) flush()
    cur.files.add(p.path); cur.parts.push(p.text); cur.size += p.text.length
  }
  flush()
  return { chunks, skipped }
}

const userPrompt = (title: string, body: string) => `Pull request title: ${title}\n\nThe diff (numbers are line numbers in the new version of each file):\n\n${body}\n\nReport the problems, one JSON object per line, or nothing.`
