import type { DiffFile } from './diff'

export const KINDS = ['bug', 'security', 'error-handling', 'tests', 'performance', 'maintainability'] as const
export type Kind = (typeof KINDS)[number]
export type Severity = 'high' | 'medium' | 'low'

/** One review comment: a problem at a place in the new version of a file. */
export interface Finding {
  path: string
  /** first line in the NEW file (a line that appears in the diff) */
  line: number
  /** last line, when the problem spans several (defaults to `line`) */
  endLine?: number
  kind: Kind
  severity: Severity
  message: string
  /** which rule or model produced it, for debugging */
  source?: string
}

/** Lines of the new file that appear in the diff, per path. GitHub only lets a review comment sit on these. */
export function commentableLines(files: readonly DiffFile[]): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>()
  for (const f of files) {
    if (f.binary || f.status === 'deleted') continue
    const set = out.get(f.path) ?? new Set<number>()
    for (const h of f.hunks) for (const l of h.lines) if (l.newLine !== null) set.add(l.newLine)
    out.set(f.path, set)
  }
  return out
}

/** Lines that were added, per path (the ones a reviewer is really judging). */
export function addedLines(files: readonly DiffFile[]): Map<string, Map<number, string>> {
  const out = new Map<string, Map<number, string>>()
  for (const f of files) {
    if (f.binary) continue
    const m = out.get(f.path) ?? new Map<number, string>()
    for (const h of f.hunks) for (const l of h.lines) if (l.kind === 'add' && l.newLine !== null) m.set(l.newLine, l.text)
    out.set(f.path, m)
  }
  return out
}

export type Problem = 'unknown-path' | 'line-not-in-diff' | 'bad-range' | 'bad-kind' | 'empty-message'

/**
 * Is this comment something we can really post? A comment on a file or line that is not in the diff would either be
 * rejected by GitHub or, worse, land on the wrong line, so it is dropped. (A model can and will make these up.)
 */
export function checkFinding(files: readonly DiffFile[], f: Finding): Problem | null {
  if (!(KINDS as readonly string[]).includes(f.kind)) return 'bad-kind'
  if (!f.message.trim()) return 'empty-message'
  const lines = commentableLines(files).get(f.path)
  if (!lines) return 'unknown-path'
  const end = f.endLine ?? f.line
  if (!Number.isInteger(f.line) || !Number.isInteger(end) || end < f.line) return 'bad-range'
  if (!lines.has(f.line) || !lines.has(end)) return 'line-not-in-diff'
  return null
}
