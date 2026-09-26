export type LineKind = 'add' | 'del' | 'ctx'

export interface DiffLine {
  kind: LineKind
  /** line number in the old file (null for added lines) */
  oldLine: number | null
  /** line number in the new file (null for deleted lines) */
  newLine: number | null
  text: string
  /** the file has no newline after this line ("\ No newline at end of file") */
  noNewline?: boolean
}

export interface Hunk {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  /** the text after the second @@ (usually the enclosing function) */
  section: string
  lines: DiffLine[]
}

export interface DiffFile {
  oldPath: string | null
  newPath: string | null
  /** the path to show: the new one, or the old one for a deletion */
  path: string
  status: 'added' | 'deleted' | 'modified' | 'renamed'
  binary: boolean
  hunks: Hunk[]
}

export class DiffParseError extends Error {
  constructor(message: string, readonly line: number) {
    super(`${message} (diff line ${line})`)
  }
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/

/** Turns a git-style quoted path ("a/with space") into plain text, and drops the a/ b/ prefix and any trailing timestamp. */
function cleanPath(raw: string, prefix: 'a/' | 'b/'): string | null {
  let p = raw.replace(/\t.*$/, '').trim() // `diff -u` appends a tab and a timestamp
  if (p === '/dev/null') return null
  if (p.startsWith('"') && p.endsWith('"')) {
    p = p.slice(1, -1).replace(/\\(["\\tn])|\\([0-7]{3})/g, (_m, c: string | undefined, oct: string | undefined) => {
      if (oct) return String.fromCharCode(parseInt(oct, 8))
      return c === 't' ? '\t' : c === 'n' ? '\n' : (c as string)
    })
  }
  return p.startsWith(prefix) ? p.slice(2) : p
}

/**
 * Reads a unified diff (`git diff`, `git diff --no-index`, `diff -u`, or GitHub's `.diff`) into files, hunks and lines
 * with exact old and new line numbers. Hunks are read by their declared line counts, not by guessing from the text, so a
 * removed line that happens to start with "-- " or a context line that is empty is not mistaken for something else.
 * Anything that does not add up (a hunk that ends early, counts that do not match) raises a DiffParseError instead of
 * silently producing wrong positions.
 */
export function parseDiff(text: string): DiffFile[] {
  const lines = text.split('\n')
  if (lines.length && lines[lines.length - 1] === '') lines.pop() // the newline that ends the diff
  const files: DiffFile[] = []
  let cur: DiffFile | null = null
  let i = 0

  const start = (): DiffFile => {
    const f: DiffFile = { oldPath: null, newPath: null, path: '', status: 'modified', binary: false, hunks: [] }
    files.push(f)
    return f
  }
  const finish = () => {
    if (!cur) return
    cur.path = cur.newPath ?? cur.oldPath ?? ''
    if (cur.oldPath === null && cur.newPath !== null) cur.status = 'added'
    else if (cur.newPath === null && cur.oldPath !== null) cur.status = 'deleted'
    else if (cur.oldPath !== cur.newPath) cur.status = 'renamed'
  }

  while (i < lines.length) {
    const line = lines[i].replace(/\r$/, '') // header lines may end in CRLF; hunk lines are read from lines[i] directly below

    if (line.startsWith('diff --git ')) {
      finish()
      cur = start()
      // "diff --git a/x b/y": the paths are repeated on the ---/+++ lines when there are changes; this covers pure renames and mode changes
      const m = /^diff --git (?:"(a\/.*?)"|(a\/\S+)) (?:"(b\/.*?)"|(b\/\S+))$/.exec(line)
      if (m) { cur.oldPath = cleanPath(m[1] ?? m[2], 'a/'); cur.newPath = cleanPath(m[3] ?? m[4], 'b/') }
      i++
      continue
    }
    if (cur && /^(new file mode|deleted file mode|similarity index|dissimilarity index|index |old mode|new mode)/.test(line)) {
      if (line.startsWith('new file mode')) cur.oldPath = null
      if (line.startsWith('deleted file mode')) cur.newPath = null
      i++
      continue
    }
    if (cur && line.startsWith('rename from ')) { cur.oldPath = line.slice(12); i++; continue }
    if (cur && line.startsWith('rename to ')) { cur.newPath = line.slice(10); i++; continue }
    if (cur && (line.startsWith('Binary files ') || line === 'GIT binary patch')) { cur.binary = true; i++; continue }

    if (line.startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) {
      if (!cur || cur.hunks.length > 0) { finish(); cur = start() } // a plain `diff -u` has no "diff --git" line
      cur.oldPath = cleanPath(line.slice(4), 'a/')
      cur.newPath = cleanPath(lines[i + 1].slice(4), 'b/')
      i += 2
      continue
    }

    const h = HUNK.exec(line)
    if (h) {
      if (!cur) throw new DiffParseError('hunk before any file header', i + 1)
      const hunk: Hunk = {
        oldStart: Number(h[1]), oldLines: h[2] === undefined ? 1 : Number(h[2]),
        newStart: Number(h[3]), newLines: h[4] === undefined ? 1 : Number(h[4]),
        section: h[5] ?? '', lines: [],
      }
      let oldLeft = hunk.oldLines
      let newLeft = hunk.newLines
      let oldNo = hunk.oldStart
      let newNo = hunk.newStart
      const headerLine = i + 1
      i++
      while (oldLeft > 0 || newLeft > 0 || (i < lines.length && lines[i].startsWith('\\'))) {
        if (i >= lines.length) throw new DiffParseError(`hunk @@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} ended early`, headerLine)
        const raw = lines[i]
        if (raw.startsWith('\\')) {
          const prev = hunk.lines[hunk.lines.length - 1]
          if (!prev) throw new DiffParseError('"no newline" marker with nothing before it', i + 1)
          prev.noNewline = true
          i++
          continue
        }
        const tag = raw[0]
        const body = raw.slice(1).replace(/\r$/, '')
        if (tag === '+' && newLeft > 0) { hunk.lines.push({ kind: 'add', oldLine: null, newLine: newNo++, text: body }); newLeft-- }
        else if (tag === '-' && oldLeft > 0) { hunk.lines.push({ kind: 'del', oldLine: oldNo++, newLine: null, text: body }); oldLeft-- }
        else if ((tag === ' ' || raw === '') && oldLeft > 0 && newLeft > 0) { hunk.lines.push({ kind: 'ctx', oldLine: oldNo++, newLine: newNo++, text: body }); oldLeft--; newLeft-- }
        else throw new DiffParseError(`unexpected line inside hunk: ${JSON.stringify(raw.slice(0, 40))}`, i + 1)
        i++
      }
      cur.hunks.push(hunk)
      continue
    }

    // anything else between files (commit messages, "Index:", "====", blank lines) is ignored
    i++
  }
  finish()
  return files.filter((f) => f.path !== '' || f.hunks.length > 0)
}

/**
 * Applies a file's hunks to its old contents, returning the new contents (as lines). Throws if a context or removed
 * line does not match. Used to prove the parser's line numbers are right: parsing then applying must give the new file.
 */
export function applyHunks(oldLines: readonly string[], hunks: readonly Hunk[]): string[] {
  const out: string[] = []
  let at = 0 // next old line (0-based) not yet copied
  for (const h of hunks) {
    // a pure insertion names the line *before* the change (some tools write -1,0 for an insertion into an empty file, so never go past the end)
    const startIdx = h.oldLines === 0 ? Math.min(h.oldStart, oldLines.length) : h.oldStart - 1
    if (startIdx < at) throw new Error('hunks overlap or are out of order')
    while (at < startIdx) out.push(oldLines[at++])
    for (const l of h.lines) {
      if (l.kind === 'add') { out.push(l.text); continue }
      if (oldLines[at] !== l.text) throw new Error(`old line ${at + 1} is ${JSON.stringify(oldLines[at])}, the diff expects ${JSON.stringify(l.text)}`)
      at++
      if (l.kind === 'ctx') out.push(l.text)
    }
  }
  while (at < oldLines.length) out.push(oldLines[at++])
  return out
}
