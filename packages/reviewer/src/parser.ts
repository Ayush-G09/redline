import { checkFinding, KINDS } from '@redline/core'
import type { DiffFile, Finding, Kind, Severity } from '@redline/core'

export interface Dropped {
  raw: string
  reason: string
}

export type Parsed = { finding: Finding } | { dropped: Dropped }

const SEVERITIES: readonly Severity[] = ['high', 'medium', 'low']
const MAX_MESSAGE = 600

/**
 * Turns the model's text into findings as it arrives. It looks for complete `{ ... }` objects and ignores whatever
 * surrounds them: prose, markdown fences, an array's brackets and commas, pretty-printing. Where the text is split
 * between network chunks does not matter. Every object is then checked: right shape, a known kind, and a place that is
 * really in the diff. Anything that fails is reported as dropped with the reason, never quietly shown.
 */
export class FindingParser {
  private depth = 0
  private inString = false
  private escaped = false
  private current = ''
  /** how many objects were found; useful to tell "found nothing wrong" from "said something we could not read" */
  objects = 0

  constructor(private readonly files: readonly DiffFile[], private readonly source = 'llm') {}

  push(text: string): Parsed[] {
    const out: Parsed[] = []
    for (const ch of text) {
      if (this.depth === 0) {
        if (ch === '{') { this.depth = 1; this.current = '{' }
        continue
      }
      this.current += ch
      if (this.inString) {
        if (this.escaped) this.escaped = false
        else if (ch === '\\') this.escaped = true
        else if (ch === '"') this.inString = false
        continue
      }
      if (ch === '"') this.inString = true
      else if (ch === '{') this.depth++
      else if (ch === '}') {
        this.depth--
        if (this.depth === 0) { out.push(this.finish(this.current)); this.current = '' }
      }
    }
    return out
  }

  /** Call when the text is over. An object that never closed was cut off (usually by the token limit). */
  end(): Parsed[] {
    if (this.depth === 0) return []
    const raw = this.current
    this.depth = 0; this.inString = false; this.escaped = false; this.current = ''
    return [{ dropped: { raw: raw.slice(0, 200), reason: 'truncated' } }]
  }

  private finish(raw: string): Parsed {
    this.objects++
    const drop = (reason: string): Parsed => ({ dropped: { raw: raw.slice(0, 200), reason } })
    let o: any
    try { o = JSON.parse(raw) } catch { return drop('not-json') }
    if (typeof o !== 'object' || o === null || Array.isArray(o)) return drop('not-an-object')
    if (typeof o.path !== 'string') return drop('missing-path')
    if (!Number.isInteger(o.line)) return drop('missing-line')
    if (o.endLine !== undefined && o.endLine !== null && !Number.isInteger(o.endLine)) return drop('bad-range')
    if (typeof o.message !== 'string') return drop('missing-message')
    if (!(KINDS as readonly string[]).includes(o.kind)) return drop('bad-kind')
    const severity: Severity = SEVERITIES.includes(o.severity) ? o.severity : 'medium'
    const f: Finding = {
      path: o.path.replace(/^\.?\//, ''),
      line: o.line,
      ...(o.endLine != null && o.endLine !== o.line ? { endLine: o.endLine } : {}),
      kind: o.kind as Kind,
      severity,
      message: o.message.trim().slice(0, MAX_MESSAGE),
      source: this.source,
    }
    const problem = checkFinding(this.files, f)
    return problem ? drop(problem) : { finding: f }
  }
}
