# Redline

An AI reviewer for GitHub pull requests that **measures its own quality**. Comments stream in as they are written,
only ever land on lines that are really in the diff, and every change to the reviewer is scored against a set of known
problems, so "is it better?" has a number for an answer.

**Phase 2 of 5**: diff engine, evaluation harness, and the language-model reviewer. Next: GitHub App and queue,
live dashboard, deploy.

## Run it

```bash
npm install
npm test                    # 103 tests
npm run eval                # score the baseline reviewer
npm run eval -- --detail    # ...and list every miss and wrong comment
npm run eval -- --llm       # score the language model (needs ANTHROPIC_API_KEY, see .env.example)
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

## The language-model reviewer (`packages/reviewer`)

- **Prompt**: every line of the new file is shown with its number, so the model cites real lines. The instructions
  favour being right over being thorough, name the six kinds of comment, and say what not to comment on. Big changes are
  split into prompts under a size budget (a huge file is split between hunks); lock files, generated output and
  deletions are skipped and reported.
- **Streaming parser**: reads complete `{...}` objects out of the text as it arrives and ignores everything around them
  (prose, code fences, brackets, pretty-printing). The result is identical wherever the network cuts the text. Each object
  is checked: right shape, known kind, and a place that is really in the diff. Anything else is dropped with a reason.
- **Reviewer**: prompts run in parallel (bounded), duplicates across prompts are merged, comments are ordered by
  severity, and busy providers are retried with backoff (honouring `retry-after`). If it still fails, the result says the
  review is incomplete instead of reporting "nothing found". Once comments have streamed out, it does not start over.
- **Provider**: a small `LlmClient` interface. `AnthropicClient` speaks the Messages API with streaming over plain
  `fetch`; the key is only ever a request header, never logged or put in an error. A scripted model runs the whole path in tests.

The pipeline is tested end to end with a scripted model that answers in awkward ways (prose, fences, tiny chunks),
invents places, is a line or two off, or is unavailable. **No real model has been scored yet**: that needs an API key.

## Current numbers

| Reviewer | Precision | Recall | F1 |
| --- | --- | --- | --- |
| Baseline (pattern rules) | 86% | 44% | 59% |
| Language model | not run yet | | |

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
