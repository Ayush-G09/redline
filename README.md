# Redline

An AI reviewer for GitHub pull requests that **measures its own quality**. Comments stream in as they are written,
only ever land on lines that are really in the diff, and every change to the reviewer is scored against a set of known
problems, so "is it better?" has a number for an answer.

**Phase 1 of 5** (diff engine and evaluation harness, no AI yet). Next: the LLM reviewer, GitHub App and queue,
live dashboard, deploy.

## Run it

```bash
npm install
npm test                    # 47 tests
npm run eval                # score the baseline reviewer
npm run eval -- --detail    # ...and list every miss and wrong comment
```

## What is here

- **Diff parser** (`packages/core/src/diff.ts`): unified diff to files, hunks and exact old/new line numbers. Handles new,
  deleted, renamed and binary files, quoted paths, CRLF, "no newline at end of file", and content that looks like a header
  (a removed line starting `-- `). It reads hunks by their declared line counts and refuses diffs that do not add up.
- **Placement check**: a comment is only valid if its file and lines are in the diff (GitHub rejects anything else, and a
  model will make places up). Invalid comments are dropped, and counted against the reviewer.
- **Scoring**: comments are paired one-to-one with the known problems (same file, same kind, overlapping lines), so
  spamming a line cannot score twice. It reports precision, recall, F1, false alarms on clean changes, and a per-kind table.
- **Golden set** (`packages/eval`): 34 small pull requests with 27 planted problems (security, bugs, error handling,
  performance, tests, maintainability), 7 clean changes and several traps that only look bad. The diffs are written by the
  `diff` library and the problem lines are located from the diff itself, so a mis-written case fails loudly.
- **Baseline reviewer**: line-by-line patterns. It exists so every smarter reviewer has a number to beat.

## Current numbers

| Reviewer | Precision | Recall | F1 |
| --- | --- | --- | --- |
| Baseline (pattern rules) | 86% | 44% | 59% |

It finds what a pattern can (eval, hardcoded keys, SQL by string-joining, `= ` in an `if`) and none of what needs
understanding (a missing `await`, swapped arguments, an off-by-one, a missing authorization check). It also raises two
false alarms on the trap cases. Those are the gaps the model has to close.

## How the parser is verified

- Hand-written cases for each format quirk.
- A property test: 300 random edits are diffed by an independent library, parsed by this code, and the parsed hunks applied
  to the old file must give back the new file exactly, with every line number pointing at the right text.
- The same check against real `git diff` output over several files.
- Mutation checks: deliberately breaking the parser (off-by-one line numbers, wrong hunk length, mishandled blank context
  lines) makes tests fail.
