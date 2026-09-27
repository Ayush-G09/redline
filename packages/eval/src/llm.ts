import { review } from '@redline/reviewer'
import type { LlmClient, ReviewResult } from '@redline/reviewer'
import type { Reviewer } from './runner'

export interface LlmRunStats {
  requests: number
  inputTokens: number
  outputTokens: number
  dropped: Record<string, number>
  errors: string[]
}

/** Wraps a model as an eval Reviewer, and keeps count of what it cost and what went wrong. */
export function llmReviewer(client: LlmClient): { reviewer: Reviewer; stats: LlmRunStats; results: Map<string, ReviewResult> } {
  const stats: LlmRunStats = { requests: 0, inputTokens: 0, outputTokens: 0, dropped: {}, errors: [] }
  const results = new Map<string, ReviewResult>()
  const reviewer: Reviewer = async (files, meta) => {
    const r = await review(client, files, { title: meta.title, onAttempt: (info) => { if (process.env.REDLINE_DEBUG) console.error(`    attempt ${info.attempt} for ${info.files.join(',')}`) } })
    results.set(meta.id, r)
    stats.requests += r.usage.requests
    stats.inputTokens += r.usage.inputTokens
    stats.outputTokens += r.usage.outputTokens
    for (const d of r.dropped) stats.dropped[d.reason] = (stats.dropped[d.reason] ?? 0) + 1
    for (const e of r.errors) stats.errors.push(`${meta.id}: ${e}`)
    return r.findings
  }
  return { reviewer, stats, results }
}
