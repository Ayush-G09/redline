import type { DiffFile, Finding } from '@redline/core'
import { FatalError, RetriableError } from './client'
import type { LlmClient } from './client'
import { FindingParser } from './parser'
import type { Dropped } from './parser'
import { chunkDiff, SYSTEM_PROMPT } from './prompt'

export interface ReviewOptions {
  title?: string
  /** characters per prompt (about four per token) */
  budget?: number
  maxTokens?: number
  /** how many prompts may be in flight at once */
  concurrency?: number
  /** how many times to retry a busy or dropped request */
  retries?: number
  /** wait before the first retry (ms); doubles each time */
  backoffMs?: number
  /** most comments to return, highest severity first */
  maxFindings?: number
  signal?: AbortSignal
  /** called the moment each valid comment is complete, before the whole review has finished */
  onFinding?: (f: Finding) => void
  sleep?: (ms: number) => Promise<void>
}

export interface ReviewResult {
  findings: Finding[]
  dropped: Dropped[]
  skipped: { path: string; reason: string }[]
  /** problems that stopped part of the review (after retries): the review is incomplete if this is not empty */
  errors: string[]
  usage: { inputTokens: number; outputTokens: number; requests: number }
}

const SEV = { high: 0, medium: 1, low: 2 } as const
const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/**
 * Reviews a diff with a model. The diff is cut into prompts of a sensible size and asked about in parallel; answers are
 * read as they stream, checked against the diff (made-up places are dropped), and merged (the same problem reported by
 * two prompts is kept once). If the provider is busy the request is retried with backoff; if it keeps failing, the
 * review says so in `errors` rather than pretending it found nothing.
 */
export async function review(client: LlmClient, files: readonly DiffFile[], opts: ReviewOptions = {}): Promise<ReviewResult> {
  const { title = '(untitled)', budget = client.budgetChars, maxTokens = 4096, concurrency = client.maxConcurrency ?? 4, retries = 3, backoffMs = 1000, maxFindings = 30, sleep = realSleep } = opts
  const { chunks, skipped } = chunkDiff(files, title, budget)
  const result: ReviewResult = { findings: [], dropped: [], skipped, errors: [], usage: { inputTokens: 0, outputTokens: 0, requests: 0 } }
  const seen = new Set<string>()

  const emit = (f: Finding) => {
    const key = `${f.path}:${f.line}:${f.kind}`
    if (seen.has(key)) return
    seen.add(key)
    result.findings.push(f)
    opts.onFinding?.(f)
  }

  const runChunk = async (text: string, files: string[]) => {
    for (let attempt = 0; ; attempt++) {
      const parser = new FindingParser(chunkFiles(files), client.name)
      let gotText = false
      const take = (items: ReturnType<FindingParser['push']>) => { for (const it of items) 'finding' in it ? emit(it.finding) : result.dropped.push(it.dropped) }
      try {
        result.usage.requests++
        for await (const ev of client.stream({ system: SYSTEM_PROMPT, user: text, maxTokens, signal: opts.signal })) {
          if (ev.type === 'usage') { result.usage.inputTokens += ev.inputTokens ?? 0; result.usage.outputTokens += ev.outputTokens ?? 0; continue }
          gotText = true
          take(parser.push(ev.text))
        }
        take(parser.end())
        return
      } catch (e) {
        take(parser.end())
        if (opts.signal?.aborted) throw e
        const retryable = e instanceof RetriableError && !gotText // once comments have streamed out, starting over would repeat them
        if (retryable && attempt < retries) {
          await sleep((e as RetriableError).retryAfterMs ?? backoffMs * 2 ** attempt)
          continue
        }
        result.errors.push(`${files.join(', ')}: ${(e as Error).message}${e instanceof FatalError ? '' : gotText ? ' (partway through; some comments may be missing)' : attempt ? ` (after ${attempt} retries)` : ''}`)
        return
      }
    }
  }

  const byPath = new Map(files.map((f) => [f.path, f]))
  const chunkFiles = (paths: string[]) => paths.map((p) => byPath.get(p)).filter((f): f is DiffFile => !!f)

  let next = 0
  const workers = Array.from({ length: Math.min(concurrency, chunks.length) }, async () => {
    while (next < chunks.length) {
      const c = chunks[next++]
      await runChunk(c.text, c.files)
    }
  })
  await Promise.all(workers)

  result.findings.sort((a, b) => SEV[a.severity] - SEV[b.severity] || a.path.localeCompare(b.path) || a.line - b.line)
  if (result.findings.length > maxFindings) result.findings.length = maxFindings
  return result
}
