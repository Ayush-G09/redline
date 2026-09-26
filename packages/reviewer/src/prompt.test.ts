import { describe, expect, it } from 'vitest'
import { parseDiff } from '@redline/core'
import { chunkDiff, renderFile, skipReason, SYSTEM_PROMPT } from './prompt'

const DIFF = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -8,4 +8,4 @@ function top() {
 keep8
-old9
+new9
 keep10
 keep11
@@ -50,2 +50,3 @@ function other() {
 keep50
+added51
 keep52
`

describe('renderFile', () => {
  it('shows the new-file line number on every line but removed ones, and marks added lines', () => {
    const [f] = parseDiff(DIFF)
    const text = renderFile(f).split('\n')
    expect(text[0]).toBe('### src/a.ts')
    expect(text[1]).toBe('@@ new lines 8-11 · function top() {')
    expect(text.slice(2, 6)).toEqual(['    8   keep8', '      - old9', '    9 + new9', '   10   keep10'])
    expect(text).toContain('   51 + added51')
  })
  it('cuts absurdly long lines', () => {
    const [f] = parseDiff(`--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+${'y'.repeat(5000)}\n`)
    expect(renderFile(f).length).toBeLessThan(700)
  })
  it('says when a file is new or renamed', () => {
    const [n] = parseDiff('diff --git a/n b/n\nnew file mode 100644\n--- /dev/null\n+++ b/n\n@@ -0,0 +1 @@\n+x\n')
    expect(renderFile(n)).toContain('### n (new file)')
  })
})

describe('skipReason', () => {
  const one = (path: string, body = '@@ -1 +1 @@\n-a\n+b\n') => parseDiff(`--- a/${path}\n+++ b/${path}\n${body}`)[0]
  it('skips lock files, generated output and minified code', () => {
    for (const p of ['package-lock.json', 'dist/app.js', 'a/b/vendor/x.js', 'bundle.min.js', 'x.snap']) expect(skipReason(one(p)), p).toBe('generated or lock file')
  })
  it('skips deleted files and pure deletions', () => {
    expect(skipReason(parseDiff('diff --git a/x b/x\ndeleted file mode 100644\n--- a/x\n+++ /dev/null\n@@ -1 +0,0 @@\n-a\n')[0])).toBe('deleted')
    expect(skipReason(one('src/a.ts', '@@ -1,2 +1 @@\n keep\n-gone\n'))).toBe('nothing added')
  })
  it('reviews ordinary source', () => expect(skipReason(one('src/a.ts'))).toBeNull())
})

describe('chunkDiff', () => {
  it('puts small changes in one prompt with the title', () => {
    const { chunks, skipped } = chunkDiff(parseDiff(DIFF), 'Fix things')
    expect(chunks).toHaveLength(1)
    expect(chunks[0].text).toContain('Pull request title: Fix things')
    expect(chunks[0].files).toEqual(['src/a.ts'])
    expect(skipped).toEqual([])
  })
  it('reports skipped files instead of losing track of them', () => {
    const d = DIFF + 'diff --git a/package-lock.json b/package-lock.json\n--- a/package-lock.json\n+++ b/package-lock.json\n@@ -1 +1 @@\n-a\n+b\n'
    expect(chunkDiff(parseDiff(d), 't').skipped).toEqual([{ path: 'package-lock.json', reason: 'generated or lock file' }])
  })
  it('splits into several prompts under the budget, and every added line is in exactly one', () => {
    const many = Array.from({ length: 12 }, (_, i) => `diff --git a/f${i}.ts b/f${i}.ts\n--- a/f${i}.ts\n+++ b/f${i}.ts\n@@ -1 +1 @@\n-a\n+line in file ${i} ${'z'.repeat(200)}\n`).join('')
    const { chunks } = chunkDiff(parseDiff(many), 't', 1500)
    expect(chunks.length).toBeGreaterThan(2)
    for (let i = 0; i < 12; i++) expect(chunks.filter((c) => c.text.includes(`line in file ${i} `)), `file ${i}`).toHaveLength(1)
    for (const c of chunks) expect(c.text.length).toBeLessThan(2500)
  })
  it('splits one huge file between hunks, repeating its heading', () => {
    const hunks = Array.from({ length: 10 }, (_, i) => `@@ -${i * 100 + 1} +${i * 100 + 1} @@\n-a${i}\n+b${i} ${'q'.repeat(300)}\n`).join('')
    const { chunks } = chunkDiff(parseDiff(`--- a/big.ts\n+++ b/big.ts\n${hunks}`), 't', 1200)
    expect(chunks.length).toBeGreaterThan(2)
    for (const c of chunks) expect(c.text).toContain('### big.ts')
    for (let i = 0; i < 10; i++) expect(chunks.filter((c) => c.text.includes(`b${i} q`))).toHaveLength(1)
  })
  it('makes no prompts for a change with nothing to review', () => {
    expect(chunkDiff([], 't').chunks).toEqual([])
  })
})

describe('the instructions', () => {
  it('list every kind of comment that can be scored, and demand a strict output format', () => {
    for (const k of ['bug', 'security', 'error-handling', 'performance', 'tests', 'maintainability']) expect(SYSTEM_PROMPT).toContain(k)
    expect(SYSTEM_PROMPT).toContain('one JSON object per problem')
    expect(SYSTEM_PROMPT).toMatch(/nothing at all/)
  })
})
