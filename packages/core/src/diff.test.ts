import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTwoFilesPatch } from 'diff'
import { describe, expect, it } from 'vitest'
import { applyHunks, DiffParseError, parseDiff } from './diff'

const GIT = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,4 +1,5 @@ function top() {
 one
-two
+TWO
+two and a half
 three
 four
@@ -20,2 +21,2 @@ class X {
 x
-y
+z
`

describe('parseDiff: the basics', () => {
  it('reads a modified file with two hunks and exact line numbers', () => {
    const [f] = parseDiff(GIT)
    expect(f).toMatchObject({ path: 'src/a.ts', oldPath: 'src/a.ts', newPath: 'src/a.ts', status: 'modified', binary: false })
    expect(f.hunks).toHaveLength(2)
    expect(f.hunks[0]).toMatchObject({ oldStart: 1, oldLines: 4, newStart: 1, newLines: 5, section: 'function top() {' })
    const lines = f.hunks[0].lines.map((l) => [l.kind, l.oldLine, l.newLine, l.text])
    expect(lines).toEqual([
      ['ctx', 1, 1, 'one'], ['del', 2, null, 'two'], ['add', null, 2, 'TWO'], ['add', null, 3, 'two and a half'], ['ctx', 3, 4, 'three'], ['ctx', 4, 5, 'four'],
    ])
    expect(f.hunks[1].lines.map((l) => [l.kind, l.oldLine, l.newLine])).toEqual([['ctx', 20, 21], ['del', 21, null], ['add', null, 22]])
  })

  it('reads new, deleted and renamed files', () => {
    const d = `diff --git a/new.txt b/new.txt
new file mode 100644
index 0000000..e69de29
--- /dev/null
+++ b/new.txt
@@ -0,0 +1,2 @@
+hello
+world
diff --git a/gone.txt b/gone.txt
deleted file mode 100644
index e69de29..0000000
--- a/gone.txt
+++ /dev/null
@@ -1 +0,0 @@
-bye
diff --git a/old name.ts b/new name.ts
similarity index 100%
rename from old name.ts
rename to new name.ts
`
    const f = parseDiff(d)
    expect(f.map((x) => [x.path, x.status])).toEqual([['new.txt', 'added'], ['gone.txt', 'deleted'], ['new name.ts', 'renamed']])
    expect(f[0].hunks[0].lines.map((l) => l.newLine)).toEqual([1, 2])
    expect(f[1].hunks[0].lines[0]).toMatchObject({ kind: 'del', oldLine: 1 })
    expect(f[2].oldPath).toBe('old name.ts')
    expect(f[2].hunks).toEqual([])
  })

  it('treats a header with no counts as one line, and flags binary files', () => {
    const f = parseDiff(`diff --git a/x b/x
--- a/x
+++ b/x
@@ -3 +3 @@
-a
+b
diff --git a/i.png b/i.png
Binary files a/i.png and b/i.png differ
`)
    expect(f[0].hunks[0]).toMatchObject({ oldStart: 3, oldLines: 1, newStart: 3, newLines: 1 })
    expect(f[1]).toMatchObject({ path: 'i.png', binary: true })
  })

  it('remembers "no newline at end of file"', () => {
    const [f] = parseDiff(`--- a/x
+++ b/x
@@ -1 +1 @@
-a
\\ No newline at end of file
+b
`)
    expect(f.hunks[0].lines[0].noNewline).toBe(true)
    expect(f.hunks[0].lines[1].noNewline).toBeUndefined()
  })

  it('reads a plain `diff -u` with timestamps and no diff --git line', () => {
    const [f] = parseDiff(`--- a/f.txt\t2024-01-01 10:00:00
+++ b/f.txt\t2024-01-02 10:00:00
@@ -1,2 +1,2 @@
 keep
-old
+new
`)
    expect(f.path).toBe('f.txt')
    expect(f.hunks[0].lines).toHaveLength(3)
  })

  it('handles paths git had to quote', () => {
    const [f] = parseDiff(`diff --git "a/sp ace.txt" "b/sp ace.txt"
--- "a/sp ace.txt"
+++ "b/sp ace.txt"
@@ -1 +1 @@
-a
+b
`)
    expect(f.path).toBe('sp ace.txt')
  })

  it('ignores text around the diff (commit headers, blank lines)', () => {
    const f = parseDiff(`From abc Mon Sep 17 00:00:00 2001
Subject: [PATCH] thing

---
 a.txt | 2 +-

${GIT}`)
    expect(f.map((x) => x.path)).toEqual(['src/a.ts'])
  })

  it('reads CRLF diffs without keeping the carriage returns', () => {
    const [f] = parseDiff(GIT.replace(/\n/g, '\r\n'))
    expect(f.path).toBe('src/a.ts')
    expect(f.hunks[0].lines[1].text).toBe('two')
  })

  it('returns nothing for empty input', () => {
    expect(parseDiff('')).toEqual([])
    expect(parseDiff('\n')).toEqual([])
  })
})

describe('parseDiff: things that look like headers but are content', () => {
  it('a removed line that starts with "-- " and an added line that starts with "++ " stay content', () => {
    const [f] = parseDiff(`--- a/q.sql
+++ b/q.sql
@@ -1,3 +1,3 @@
 select 1;
--- a comment
+++ b comment
 select 2;
`)
    expect(f.hunks[0].lines.map((l) => [l.kind, l.text])).toEqual([['ctx', 'select 1;'], ['del', '-- a comment'], ['add', '++ b comment'], ['ctx', 'select 2;']])
  })

  it('a line inside a hunk that looks like a hunk header is content', () => {
    const [f] = parseDiff(`--- a/x
+++ b/x
@@ -1,2 +1,2 @@
 a
-@@ -9 +9 @@ old
+@@ -9 +9 @@ new
`)
    expect(f.hunks).toHaveLength(1)
    expect(f.hunks[0].lines.map((l) => l.text)).toEqual(['a', '@@ -9 +9 @@ old', '@@ -9 +9 @@ new'])
  })

  it('an empty line inside a hunk is an empty context line (some tools strip the leading space)', () => {
    const [f] = parseDiff(`--- a/x
+++ b/x
@@ -1,3 +1,3 @@
 a

-b
+c
`)
    expect(f.hunks[0].lines.map((l) => [l.kind, l.text])).toEqual([['ctx', 'a'], ['ctx', ''], ['del', 'b'], ['add', 'c']])
  })
})

describe('parseDiff: refuses diffs that do not add up', () => {
  it('a truncated hunk', () => {
    expect(() => parseDiff('--- a/x\n+++ b/x\n@@ -1,3 +1,3 @@\n a\n-b\n')).toThrow(DiffParseError)
  })
  it('a line with an unknown marker inside a hunk', () => {
    expect(() => parseDiff('--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n a\n?b\n')).toThrow(/unexpected line/)
  })
  it('a hunk before any file', () => {
    expect(() => parseDiff('@@ -1 +1 @@\n-a\n+b\n')).toThrow(/before any file/)
  })
  it('more added lines than the header promised', () => {
    expect(() => parseDiff('--- a/x\n+++ b/x\n@@ -1,1 +1,1 @@\n-a\n+b\n+c\n')).not.toThrow() // the extra line is outside the hunk, so it is ignored as stray text
  })
})

// ---------------------------------------------------------------------------------------------------------------
// The strongest check: an independent tool writes the diff, we parse it, and applying what we parsed to the old
// file must give back exactly the new file. If a single line number or hunk were wrong, this fails.
// ---------------------------------------------------------------------------------------------------------------

function rng(seed: number) {
  let a = seed >>> 0
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}

const WORDS = ['alpha', 'beta', '', '  indented', '-- dashes', '++ pluses', '@@ -1 +1 @@', '\ttab', 'x = 1;', '}', 'return null', '--- three', '+++ four']

function randomFile(r: () => number, n: number) {
  return Array.from({ length: n }, (_, i) => `${WORDS[Math.floor(r() * WORDS.length)]}${r() < 0.5 ? '' : ` #${i}`}`)
}
function mutate(r: () => number, lines: string[]) {
  const out = [...lines]
  const edits = 1 + Math.floor(r() * 6)
  for (let e = 0; e < edits; e++) {
    const at = Math.floor(r() * (out.length + 1))
    const roll = r()
    if (roll < 0.35) out.splice(at, 0, ...randomFile(r, 1 + Math.floor(r() * 3)))
    else if (roll < 0.7) out.splice(at, 1 + Math.floor(r() * 3))
    else if (at < out.length) out[at] = `${out[at]} changed`
  }
  return out
}

describe('parseDiff against an independent diff writer (property test)', () => {
  it('parse then apply gives back the new file, for 300 random edits', () => {
    const r = rng(20240607)
    for (let n = 0; n < 300; n++) {
      const before = randomFile(r, 1 + Math.floor(r() * 40))
      const after = mutate(r, before)
      if (after.length === 0) continue // jsdiff writes an empty file as one blank line; git does it properly (covered by the git test)
      const text = createTwoFilesPatch('a/f.txt', 'b/f.txt', before.join('\n') + '\n', after.join('\n') + '\n', '', '', { context: Math.floor(r() * 5) })
      const files = parseDiff(text)
      if (before.join('\n') === after.join('\n')) { expect(files.flatMap((f) => f.hunks)).toEqual([]); continue }
      expect(files, `case ${n}`).toHaveLength(1)
      let got: string[]
      try { got = applyHunks(before, files[0].hunks) } catch (e) { throw new Error(`case ${n}: ${(e as Error).message}
BEFORE ${JSON.stringify(before)}
AFTER ${JSON.stringify(after)}
${text}`) }
      expect(got, `case ${n}`).toEqual(after)
      // and every line number really points at that line of its file
      for (const h of files[0].hunks) for (const l of h.lines) {
        if (l.newLine !== null) expect(after[l.newLine - 1], `case ${n} new ${l.newLine}`).toBe(l.text)
        if (l.oldLine !== null) expect(before[l.oldLine - 1], `case ${n} old ${l.oldLine}`).toBe(l.text)
      }
    }
  })
})

function gitAvailable() {
  try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true } catch { return false }
}

describe.skipIf(!gitAvailable())('parseDiff against real git', () => {
  it('parses `git diff` for random edits across several files, and applying it rebuilds every file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'redline-'))
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.autocrlf=false', ...args], { cwd: dir, encoding: 'utf8', maxBuffer: 1 << 26 })
    try {
      git('init', '-q')
      mkdirSync(join(dir, 'src'))
      const r = rng(99)
      const names = ['src/a.ts', 'src/b.ts', 'c.txt', 'src/deep name.ts']
      const before = new Map<string, string[]>()
      for (const n of names) { const l = randomFile(r, 5 + Math.floor(r() * 40)); before.set(n, l); writeFileSync(join(dir, n), l.join('\n') + '\n') }
      git('add', '-A'); git('commit', '-qm', 'base')
      const after = new Map<string, string[]>()
      for (const n of names) { const l = mutate(r, before.get(n) as string[]); after.set(n, l); writeFileSync(join(dir, n), l.join('\n') + '\n') }
      const text = git('diff', '--no-color')
      const files = parseDiff(text)
      for (const n of names) {
        const f = files.find((x) => x.path === n)
        if ((before.get(n) as string[]).join('\n') === (after.get(n) as string[]).join('\n')) { expect(f).toBeUndefined(); continue }
        expect(f, n).toBeDefined()
        expect(applyHunks(before.get(n) as string[], (f as NonNullable<typeof f>).hunks), n).toEqual(after.get(n))
      }
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
