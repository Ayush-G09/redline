import { createTwoFilesPatch } from 'diff'
import { addedLines, parseDiff } from '@redline/core'
import type { DiffFile, Expected, Kind } from '@redline/core'

export interface FileChange {
  path: string
  /** contents before the change; leave out for a new file */
  before?: string[]
  after: string[]
}

export interface Planted {
  path: string
  /** text that appears on exactly one ADDED line of that file: that line is where the problem is */
  contains: string
  kind: Kind
  /** why it is a real problem (shown in reports) */
  why: string
}

export interface GoldenCase {
  id: string
  title: string
  files: FileChange[]
  planted: Planted[]
}

export interface BuiltCase {
  id: string
  title: string
  diff: string
  files: DiffFile[]
  expected: Expected[]
}

const text = (lines: string[]) => lines.map((l) => l + '\n').join('')

/**
 * Turns a hand-written case into a real unified diff (written by the `diff` library, which is independent of our
 * parser) and works out the line number of every planted problem from the diff itself. A case whose marker text is
 * missing or matches more than one added line is a mistake in the case, and fails loudly.
 */
export function build(c: GoldenCase): BuiltCase {
  const diff = c.files
    .map((f) => {
      const isNew = f.before === undefined
      const patch = createTwoFilesPatch(isNew ? '/dev/null' : `a/${f.path}`, `b/${f.path}`, text(f.before ?? []), text(f.after), '', '', { context: 3 })
      return `diff --git a/${f.path} b/${f.path}\n${isNew ? 'new file mode 100644\n' : ''}${patch.replace(/^=+\n/, '').replace(/\t\n/g, '\n')}`
    })
    .join('')
  const files = parseDiff(diff)
  const added = addedLines(files)
  const expected: Expected[] = c.planted.map((p) => {
    const hits = [...(added.get(p.path) ?? new Map<number, string>())].filter(([, t]) => t.includes(p.contains))
    if (hits.length !== 1) throw new Error(`case ${c.id}: "${p.contains}" matches ${hits.length} added lines in ${p.path}, expected exactly 1`)
    return { path: p.path, line: hits[0][0], kind: p.kind }
  })
  return { id: c.id, title: c.title, diff, files, expected }
}
