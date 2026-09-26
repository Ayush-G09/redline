# Redline

An AI reviewer for GitHub pull requests that **measures its own quality**. Comments stream in as they are written,
only ever land on lines that are really in the diff, and every change to the reviewer is scored against a set of known
problems, so "is it better?" has a number for an answer.

**Phase 3 of 5**: diff engine, evaluation harness, the language-model reviewer, and the GitHub App with its queue.
Next: live dashboard, deploy.

## Run it

```bash
npm install
npm test                    # 171 tests
npm start                   # run the GitHub App server (needs the settings in .env.example)
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

## The GitHub App (`apps/server`)

```
GitHub -- webhook --> verify signature --> checks --> queue (one slot per pull request) --> review --> post one review
```

- **Webhook**: the signature (HMAC-SHA256 over the raw bytes) is checked in constant time before anything else. Then the
  payload shape (names that could rewrite an API path are refused), that the owner is on `ALLOWED_OWNERS`, that it is not a
  draft, that this delivery was not already handled, and that the pull request has not used its hourly allowance.
- **Queue**: one job per pull request. A newer push drops any job still waiting and tells the running one to stop, so only the
  latest commit is ever reviewed. Different pull requests run in parallel up to a limit. Rate limits and server errors are
  retried with backoff (using GitHub's own wait time when it gives one).
- **Reviewing**: before spending model time, and again just before posting, it checks the pull request is still open and
  still at the commit it was asked about. Its own earlier review of a commit is recognised by a hidden marker, so a retry or
  a redelivery never posts twice. The result is one GitHub review with inline comments on the right lines.
- **When something goes wrong**: if GitHub refuses the inline comments (422), the findings are listed in the review summary
  instead of lost. If the model is unavailable, the review is posted marked **incomplete**, never as "nothing found". A diff
  that is too large or unreadable gets a note. Huge changes are skipped.
- **GitHub client**: signs in as the app (RS256 JWT), gets installation tokens and reuses them until shortly before they
  expire, shares one token request between simultaneous jobs, and replaces a token GitHub rejects.
- **Not persistent yet**: the queue lives in memory. If the server restarts, waiting jobs are lost (GitHub can redeliver from
  its webhook page, and the next push queues a new one).

It is tested against a fake GitHub server that speaks the real HTTP API and checks what GitHub checks (the JWT signature and
lifetime, that the commit is the pull request's head, that every comment is on a line in the diff), with a scripted model.

### Create the GitHub App

1. GitHub, Settings, Developer settings, GitHub Apps, **New GitHub App**.
2. **Webhook URL**: your server's `https://<host>/webhooks/github`. **Webhook secret**: make one up (this is
   `GITHUB_WEBHOOK_SECRET`). For local testing, expose your machine with a tunnel and use that URL.
3. **Repository permissions**: *Pull requests* read and write, *Contents* read, *Metadata* read. Nothing else.
4. **Subscribe to events**: *Pull request*.
5. Create it, note the **App ID**, then **Generate a private key** (downloads a `.pem`).
6. **Install** the app on the repositories you want reviewed.
7. Put the values in `.env` (see `.env.example`): the key on one line with `
` for line breaks.

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
