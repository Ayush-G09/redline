import { randomUUID } from 'node:crypto'
import { FeedbackStore, fingerprint } from '@redline/core'
import type { Finding, FeedbackSnapshot } from '@redline/core'

export interface LiveFinding {
  id: string
  key: string
  finding: Finding
  /** undefined while the review is still in progress; set once a person acts on it */
  status?: 'accepted' | 'dismissed'
}

export type DashboardEvent =
  | { type: 'job-start'; key: string; title: string; at: number }
  | { type: 'finding'; key: string; id: string; finding: Finding; at: number }
  | { type: 'job-done'; key: string; outcome: string; comments: number; incomplete: boolean; at: number }
  | { type: 'job-failed'; key: string; error: string; at: number }
  | { type: 'snapshot'; findings: LiveFinding[] }

/**
 * Ties three things together for one repository: the live stream of a review in progress (for the dashboard page), a
 * short-lived record of every finding shown (so a person can accept or dismiss it after the fact), and the learned
 * feedback that quiets the reviewer down over time. One instance covers everything the dashboard needs.
 */
export class Dashboard {
  private readonly listeners = new Set<(e: DashboardEvent) => void>()
  private readonly findings = new Map<string, LiveFinding>()
  private readonly order: string[] = []
  readonly feedback: FeedbackStore
  private readonly maxFindings: number

  constructor(opts: { feedback?: FeedbackStore; maxFindings?: number } = {}) {
    this.feedback = opts.feedback ?? new FeedbackStore()
    this.maxFindings = opts.maxFindings ?? 500
  }

  onEvent(fn: (e: DashboardEvent) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private emit(e: DashboardEvent) { for (const fn of this.listeners) fn(e) }

  jobStart(key: string, title: string) { this.emit({ type: 'job-start', key, title, at: Date.now() }) }
  jobFailed(key: string, error: string) { this.emit({ type: 'job-failed', key, error, at: Date.now() }) }
  jobDone(key: string, outcome: string, comments: number, incomplete: boolean) { this.emit({ type: 'job-done', key, outcome, comments, incomplete, at: Date.now() }) }

  /** Records a finding and streams it to any connected dashboard. Returns the id it was given. */
  finding(key: string, finding: Finding): string {
    const id = randomUUID()
    this.findings.set(id, { id, key, finding })
    this.order.push(id)
    if (this.order.length > this.maxFindings) { const gone = this.order.shift() as string; this.findings.delete(gone) }
    this.emit({ type: 'finding', key, id, finding, at: Date.now() })
    return id
  }

  get(id: string): LiveFinding | undefined { return this.findings.get(id) }

  /** A person's verdict on one shown finding. Dismissing teaches the store; accepting can undo an earlier dismissal
   * of the same pattern (someone can be wrong once), and a finding can only be acted on once. */
  act(id: string, verdict: 'accepted' | 'dismissed'): LiveFinding | null {
    const f = this.findings.get(id)
    if (!f || f.status) return null
    f.status = verdict
    if (verdict === 'dismissed') this.feedback.recordDismissal(f.finding)
    else this.feedback.forgetOne(f.finding)
    return f
  }

  recentFindings(key?: string, limit = 100): LiveFinding[] {
    const all = this.order.map((id) => this.findings.get(id) as LiveFinding).filter((f) => !key || f.key === key)
    return all.slice(-limit)
  }
}

/** Builds a Dashboard whose feedback store starts from a previously saved snapshot (see `Dashboard.feedback.snapshot()`). */
export function dashboardFromSnapshot(snapshot: FeedbackSnapshot, opts: { maxFindings?: number } = {}): Dashboard {
  return new Dashboard({ ...opts, feedback: FeedbackStore.fromSnapshot(snapshot) })
}

export const findingKey = (owner: string, repo: string, n: number) => `${owner}/${repo}#${n}`.toLowerCase()
export { fingerprint }
