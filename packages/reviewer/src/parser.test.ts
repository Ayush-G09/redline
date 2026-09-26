import { describe, expect, it } from 'vitest'
import { parseDiff } from '@redline/core'
import { FindingParser } from './parser'
import type { Parsed } from './parser'

const files = parseDiff(`diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,4 @@
 one
+two
 three
 four
`)
const obj = (o: Record<string, unknown>) => JSON.stringify({ path: 'src/a.ts', line: 2, kind: 'bug', severity: 'high', message: 'Broken.', ...o })
const run = (chunks: string[]) => {
  const p = new FindingParser(files)
  const out: Parsed[] = chunks.flatMap((c) => p.push(c))
  out.push(...p.end())
  return out
}
const findings = (out: Parsed[]) => out.flatMap((x) => ('finding' in x ? [x.finding] : []))
const reasons = (out: Parsed[]) => out.flatMap((x) => ('dropped' in x ? [x.dropped.reason] : []))

describe('FindingParser: reading the model', () => {
  it('reads one object per line', () => {
    const out = run([obj({}) + '\n' + obj({ line: 3, kind: 'security' }) + '\n'])
    expect(findings(out).map((f) => [f.line, f.kind])).toEqual([[2, 'bug'], [3, 'security']])
  })
  it('ignores prose, markdown fences, brackets and commas around the objects', () => {
    const text = 'Here is my review:\n```json\n[\n' + obj({}) + ',\n' + obj({ line: 3 }) + '\n]\n```\nHope that helps! {not json}'
    const out = run([text])
    expect(findings(out)).toHaveLength(2)
    expect(reasons(out)).toEqual(['not-json'])
  })
  it('reads pretty-printed objects that span many lines', () => {
    const out = run([JSON.stringify({ path: 'src/a.ts', line: 2, kind: 'bug', severity: 'low', message: 'x' }, null, 2)])
    expect(findings(out)).toHaveLength(1)
  })
  it('is not confused by braces and quotes inside the message', () => {
    const msg = 'Use `if (x) { return }` and "quotes" and a \\ backslash } {'
    const out = run([obj({ message: msg })])
    expect(findings(out)).toHaveLength(1)
    expect(findings(out)[0].message).toBe(msg)
  })
  it('gives the same result wherever the text is cut', () => {
    const text = 'prose\n' + obj({ message: 'a } b' }) + '\n' + obj({ line: 3, message: 'c "d"' }) + '\ntrailing'
    const whole = findings(run([text]))
    for (let cut = 1; cut < text.length; cut++) expect(findings(run([text.slice(0, cut), text.slice(cut)])), `cut at ${cut}`).toEqual(whole)
    expect(findings(run([...text]))).toEqual(whole) // one character at a time
  })
  it('emits a finding as soon as its object is complete, not at the end', () => {
    const p = new FindingParser(files)
    const text = obj({})
    expect(p.push(text.slice(0, -1))).toEqual([])
    expect(findings(p.push('}'))).toHaveLength(1)
  })
  it('says nothing for an empty answer', () => {
    expect(run([''])).toEqual([])
    expect(run(['No problems found.'])).toEqual([])
  })
})

describe('FindingParser: checking what it read', () => {
  it('drops comments on lines that are not in the diff', () => {
    expect(reasons(run([obj({ line: 99 })]))).toEqual(['line-not-in-diff'])
    expect(reasons(run([obj({ line: 4 })]))).toEqual([]) // line 4 is context, in the diff
  })
  it('drops comments on files that are not in the diff', () => {
    expect(reasons(run([obj({ path: 'src/other.ts' })]))).toEqual(['unknown-path'])
  })
  it('drops bad kinds, bad shapes and missing fields, with the reason', () => {
    const out = run([obj({ kind: 'style' }), obj({ line: '2' }), obj({ path: undefined }), obj({ message: undefined }), obj({ endLine: 1 }), '[1] {"a":1}'])
    expect(reasons(out)).toEqual(['bad-kind', 'missing-line', 'missing-path', 'missing-message', 'bad-range', 'missing-path'])
    expect(findings(out)).toEqual([])
  })
  it('a cut-off object is reported as truncated', () => {
    expect(reasons(run([obj({}).slice(0, 30)]))).toEqual(['truncated'])
  })
  it('tidies what it keeps: leading ./ on paths, default severity, endLine equal to line, long messages', () => {
    const [f] = findings(run([obj({ path: './src/a.ts', severity: 'urgent', endLine: 2, message: 'x'.repeat(2000) })]))
    expect(f.path).toBe('src/a.ts')
    expect(f.severity).toBe('medium')
    expect(f.endLine).toBeUndefined()
    expect(f.message.length).toBeLessThanOrEqual(600)
  })
  it('keeps a valid range', () => {
    const [f] = findings(run([obj({ line: 2, endLine: 4 })]))
    expect(f.endLine).toBe(4)
  })
  it('counts the objects it saw, so "found nothing" differs from "said something unreadable"', () => {
    const p = new FindingParser(files)
    p.push(obj({ kind: 'nope' }))
    expect(p.objects).toBe(1)
  })
})
