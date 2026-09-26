import type { Finding } from '@redline/core'
import type { ReviewResult } from '@redline/reviewer'
import type { ReviewComment } from './github'

const LABEL: Record<Finding['kind'], string> = {
  bug: 'Bug', security: 'Security', 'error-handling': 'Error handling', performance: 'Performance', tests: 'Tests', maintainability: 'Cleanup',
}
const ICON = { high: '🔴', medium: '🟠', low: '🟡' } as const

/** The hidden marker that lets us recognise our own review of a commit, so a retry or a redelivery cannot post it twice. */
export const marker = (sha: string) => `<!-- redline:review sha=${sha} -->`
export const hasMarker = (body: string, sha: string) => body.includes(marker(sha))

/** One line-level comment. Ranges are noted in the text: GitHub is stricter about multi-line placement than single lines. */
export function commentBody(f: Finding): string {
  const range = f.endLine && f.endLine > f.line ? ` (lines ${f.line}–${f.endLine})` : ''
  return `${ICON[f.severity]} **${LABEL[f.kind]}**${range}\n\n${f.message}`
}

export function toComments(findings: readonly Finding[]): ReviewComment[] {
  return findings.map((f) => ({ path: f.path, line: f.line, side: 'RIGHT' as const, body: commentBody(f) }))
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/** The top-of-review summary: what was found, what was not looked at, and whether the review is complete. */
export function summary(result: ReviewResult, sha: string, opts: { fallback?: readonly Finding[] } = {}): string {
  const lines: string[] = []
  const n = result.findings.length
  lines.push(n === 0 && result.errors.length === 0 ? '**Redline** found nothing to flag in this change.' : `**Redline** left ${plural(n, 'comment')} on this change.`)
  if (result.skipped.length) lines.push(`Not reviewed: ${result.skipped.map((s) => `\`${s.path}\` (${s.reason})`).join(', ')}.`)
  if (result.errors.length) lines.push(`⚠️ **This review is incomplete.** Part of the change could not be reviewed (${plural(result.errors.length, 'error')}), so the absence of a comment there means nothing.`)
  if (opts.fallback?.length) {
    lines.push('', 'These comments could not be attached to a line of the diff, so they are listed here:', '')
    for (const f of opts.fallback) lines.push(`- \`${f.path}:${f.line}\` ${ICON[f.severity]} **${LABEL[f.kind]}**: ${f.message}`)
  }
  lines.push('', '<sub>Automated review. It can be wrong: use your judgement.</sub>', marker(sha))
  return lines.join('\n')
}
