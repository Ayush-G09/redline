import { createClient } from '@redline/reviewer'
import type { LlmClient, ReviewOptions } from '@redline/reviewer'
import { GitHubClient, GitHubError } from '../../server/src/github'
import { RetryJob } from '../../server/src/queue'
import { reviewPull } from '../../server/src/worker'
import type { Outcome } from '../../server/src/worker'

export interface ActionResult {
  /** 0 for success and for "nothing to do"; 1 when the review could not be done */
  exitCode: number
  message: string
  outcome?: Outcome
}

export interface ActionDeps {
  llm?: LlmClient
  fetchImpl?: typeof fetch
  sleep?: (ms: number) => Promise<void>
  log?: (line: string) => void
  signal?: AbortSignal
  /** overrides for the model call (retry timing), mainly for tests */
  reviewOptions?: Partial<ReviewOptions>
}

const ACTIONS = new Set(['opened', 'synchronize', 'reopened', 'ready_for_review'])
const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

const say = (o: Outcome): string => {
  switch (o.type) {
    case 'reviewed': return `Posted a review with ${o.comments} comment${o.comments === 1 ? '' : 's'}${o.incomplete ? ' (incomplete: part of the change could not be reviewed)' : ''}${o.inline ? '' : ', listed in the summary because GitHub would not attach them to lines'}.`
    case 'skipped': return `Skipped (${o.reason}).`
    case 'noted': return `Left a note instead of a review (${o.reason}).`
    case 'cancelled': return 'Cancelled.'
  }
}

/**
 * Reviews the pull request a GitHub Action run was triggered for. It uses the run's own token to read the change and post
 * the review, so no GitHub App, private key or server is needed. Reviews that are not possible here (a fork's pull request
 * has no write access and no secrets) are skipped with a clear notice, not failed.
 */
export async function runAction(env: Record<string, string | undefined>, eventJson: string, deps: ActionDeps = {}): Promise<ActionResult> {
  const log = deps.log ?? (() => {})
  const sleep = deps.sleep ?? realSleep
  const fail = (message: string): ActionResult => ({ exitCode: 1, message })
  const skip = (message: string): ActionResult => ({ exitCode: 0, message })

  const eventName = env.GITHUB_EVENT_NAME
  if (eventName !== 'pull_request' && eventName !== 'pull_request_target') return skip(`Not a pull request event (${eventName ?? 'unknown'}); nothing to review.`)
  let event: any
  try { event = JSON.parse(eventJson) } catch { return fail('Could not read the event payload.') }
  if (!ACTIONS.has(event?.action)) return skip(`Nothing to do for action "${String(event?.action)}".`)

  const repoFull = env.GITHUB_REPOSITORY ?? ''
  const [owner, repo] = repoFull.split('/')
  const number = event?.pull_request?.number
  const headSha = event?.pull_request?.head?.sha
  if (!owner || !repo || !Number.isInteger(number) || typeof headSha !== 'string') return fail('The event payload is missing the repository, pull request number or commit.')
  if (event.pull_request.draft === true) return skip('Draft pull request: not reviewed until it is ready.')
  const headRepo = event.pull_request.head?.repo?.full_name
  if (headRepo && headRepo.toLowerCase() !== repoFull.toLowerCase()) {
    return skip('This pull request comes from a fork. GitHub gives such runs a read-only token and no secrets, so a review cannot be posted. (Maintainers can review it after pushing the branch to this repository.)')
  }

  const token = env.GITHUB_TOKEN
  if (!token) return fail('GITHUB_TOKEN is not set. Pass it in the workflow: env: { GITHUB_TOKEN: ${{ github.token }} }')

  let llm = deps.llm
  if (!llm) {
    try {
      llm = createClient(env, { provider: env.REDLINE_PROVIDER || undefined, model: env.REDLINE_MODEL || undefined })
    } catch (e) {
      return fail(`${(e as Error).message}\nIn a workflow, store the key as a repository secret and pass it: env: { GEMINI_API_KEY: \${{ secrets.GEMINI_API_KEY }} }`)
    }
  }
  if (llm.name.startsWith('ollama:') && env.GITHUB_ACTIONS === 'true') {
    return fail('Ollama runs on your own machine, so it is not available inside a GitHub Action. Use gemini here (or run "npm run review" locally for Ollama).')
  }

  const github = new GitHubClient({ token, apiUrl: env.GITHUB_API_URL || undefined, fetchImpl: deps.fetchImpl })
  const maxFiles = Number(env.REDLINE_MAX_FILES) > 0 ? Number(env.REDLINE_MAX_FILES) : 150
  log(`Reviewing ${repoFull}#${number} at ${headSha.slice(0, 7)} with ${llm.name}`)

  const job = { owner, repo, number, headSha, installationId: 0, deliveryId: env.GITHUB_RUN_ID ?? 'local' }
  const deps2 = { github, llm, postClean: env.REDLINE_POST_CLEAN !== 'false', maxFiles, log, reviewOptions: deps.reviewOptions }
  const ctl = new AbortController()
  const signal = deps.signal ? AbortSignal.any([deps.signal, ctl.signal]) : ctl.signal

  // there is no queue here: a rate limit or a busy GitHub is retried in place, a few times
  for (let attempt = 0; ; attempt++) {
    try {
      const outcome = await reviewPull(deps2, job, signal)
      return { exitCode: 0, message: say(outcome), outcome }
    } catch (e) {
      if (e instanceof RetryJob && attempt < 3) {
        const wait = Math.min(e.afterMs ?? 2000 * 2 ** attempt, 90_000)
        log(`${e.message}; trying again in ${Math.round(wait / 1000)}s`)
        await sleep(wait)
        continue
      }
      if (e instanceof GitHubError && (e.status === 403 || e.status === 401)) {
        return fail(`GitHub refused: ${e.message}\nThe workflow needs: permissions: { contents: read, pull-requests: write }`)
      }
      return fail(`The review failed: ${(e as Error).message}`)
    }
  }
}
