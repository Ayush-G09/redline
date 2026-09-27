import { DiffParseError, parseDiff } from '@redline/core'
import type { DiffFile } from '@redline/core'
import { review } from '@redline/reviewer'
import type { LlmClient, ReviewOptions, ReviewResult } from '@redline/reviewer'
import type { Dashboard } from './dashboard'
import { hasMarker, marker, summary, toComments } from './format'
import { GitHubError } from './github'
import type { GitHubClient } from './github'

export interface ReviewJob {
  owner: string
  repo: string
  number: number
  /** the commit this job was queued for */
  headSha: string
  installationId: number
  deliveryId: string
}

export type Outcome =
  | { type: 'reviewed'; comments: number; incomplete: boolean; inline: boolean; reviewId: number }
  | { type: 'skipped'; reason: 'closed' | 'draft' | 'stale' | 'already-reviewed' | 'too-many-files' | 'nothing-to-say' }
  | { type: 'cancelled' }
  | { type: 'noted'; reason: 'diff-too-large' | 'unreadable-diff' }

export interface WorkerDeps {
  github: GitHubClient
  llm: LlmClient
  /** post a review even when nothing was found (default true: it tells the author the reviewer ran) */
  postClean?: boolean
  /** do not review changes touching more files than this */
  maxFiles?: number
  /** overrides for the model call (retry timing, budget), mainly for tests */
  reviewOptions?: Partial<ReviewOptions>
  /** streams progress to the live dashboard and supplies learned "don't repeat this" instructions, if given */
  dashboard?: Dashboard
  log?: (msg: string) => void
}

/**
 * Reviews one pull request at one commit and posts the result as a single GitHub review.
 * Before spending model time, and again before posting, it checks the pull request is still open and still at the
 * commit we were asked about: a push in the meantime makes this review out of date (a newer job will have been queued).
 */
export async function reviewPull(deps: WorkerDeps, job: ReviewJob, signal: AbortSignal): Promise<Outcome> {
  const { github, llm, postClean = true, maxFiles = 150, log = () => {}, reviewOptions = {}, dashboard } = deps
  const { owner, repo, number: n, installationId: inst } = job
  const where = `${owner}/${repo}#${n}@${job.headSha.slice(0, 7)}`
  const dashKey = `${owner}/${repo}#${n}`.toLowerCase()

  const pull = await github.getPull(inst, owner, repo, n)
  if (pull.state !== 'open') return { type: 'skipped', reason: 'closed' }
  if (pull.draft) return { type: 'skipped', reason: 'draft' }
  if (pull.headSha !== job.headSha) { log(`${where}: stale (now ${pull.headSha.slice(0, 7)})`); return { type: 'skipped', reason: 'stale' } }
  if (pull.changedFiles > maxFiles) return { type: 'skipped', reason: 'too-many-files' }
  if (signal.aborted) return { type: 'cancelled' }

  const existing = await github.listReviews(inst, owner, repo, n)
  if (existing.some((r) => hasMarker(r.body, job.headSha))) { log(`${where}: already reviewed`); return { type: 'skipped', reason: 'already-reviewed' } }

  const note = async (reason: 'diff-too-large' | 'unreadable-diff', text: string): Promise<Outcome> => {
    await github.createReview(inst, owner, repo, n, { commitId: job.headSha, body: `**Redline** ${text}\n\n${marker(job.headSha)}`, comments: [] })
    return { type: 'noted', reason }
  }

  let diff: string
  try {
    diff = await github.getDiff(inst, owner, repo, n)
  } catch (e) {
    if (e instanceof GitHubError && (e.status === 406 || e.status === 413)) return note('diff-too-large', 'could not review this change: GitHub says the diff is too large to fetch.')
    throw e
  }
  let files: DiffFile[]
  try {
    files = parseDiff(diff)
  } catch (e) {
    if (e instanceof DiffParseError) {
      log(`${where}: unreadable diff: ${e.message}`)
      return note('unreadable-diff', 'could not read the diff of this change, so it was not reviewed.')
    }
    throw e
  }
  if (signal.aborted) return { type: 'cancelled' }

  dashboard?.jobStart(dashKey, pull.title)
  const learned = dashboard?.feedback.learnedInstructions() || undefined
  const result: ReviewResult = await review(llm, files, {
    ...reviewOptions,
    title: pull.title,
    signal,
    extraSystem: learned,
    onFinding: (f) => { dashboard?.finding(dashKey, f); reviewOptions.onFinding?.(f) },
  })
  if (signal.aborted) return { type: 'cancelled' }

  // a push while the model was working makes this review describe code that is no longer there
  const now = await github.getPull(inst, owner, repo, n)
  if (now.headSha !== job.headSha || now.state !== 'open') { log(`${where}: changed while reviewing, discarding`); return { type: 'skipped', reason: 'stale' } }
  if (signal.aborted) return { type: 'cancelled' }

  const incomplete = result.errors.length > 0
  if (result.findings.length === 0 && !incomplete && !postClean) return { type: 'skipped', reason: 'nothing-to-say' }

  let inline = true
  let reviewId: number
  try {
    reviewId = await github.createReview(inst, owner, repo, n, { commitId: job.headSha, body: summary(result, job.headSha), comments: toComments(result.findings) })
  } catch (e) {
    // GitHub refuses the whole review if any one comment cannot be placed. Do not lose the findings: list them in the body instead.
    if (!(e instanceof GitHubError) || e.status !== 422 || result.findings.length === 0) throw e
    log(`${where}: GitHub rejected the inline comments (${e.message}); posting them in the summary`)
    inline = false
    reviewId = await github.createReview(inst, owner, repo, n, { commitId: job.headSha, body: summary(result, job.headSha, { fallback: result.findings }), comments: [] })
  }
  log(`${where}: posted review ${reviewId} with ${result.findings.length} comment(s)${incomplete ? ' (incomplete)' : ''}`)
  return { type: 'reviewed', comments: result.findings.length, incomplete, inline, reviewId }
}
