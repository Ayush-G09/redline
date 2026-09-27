import type { Finding, Kind } from './findings'

/**
 * A fingerprint groups findings that are "the same kind of comment", so dismissing one teaches the reviewer about the
 * pattern, not just that one exact line. It is the finding's kind plus the shape of its message with specifics (numbers,
 * quoted names, paths) removed, so "missing await on db.query" and "missing await on db.save" fingerprint the same, but
 * a security finding and a bug finding never do, even with similar wording.
 */
export function fingerprint(f: Pick<Finding, 'kind' | 'message'>): string {
  const words = f.message
    .toLowerCase()
    .replace(/`[^`]*`/g, ' ') // code spans often hold the specific name
    .replace(/\b[a-z_][\w]*(?:[.:][\w]+)+\b/g, ' ') // bare dotted/namespaced identifiers (db.query, foo::bar), even unquoted
    .replace(/[^a-z\s]+/g, ' ') // remaining numbers and punctuation are specifics, not the pattern
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w))
  return `${f.kind}:${words.slice(0, 8).join('-')}`
}

const STOPWORDS = new Set(['the', 'this', 'that', 'and', 'for', 'with', 'from', 'into', 'not', 'does', 'will', 'was', 'has', 'have', 'been', 'its', 'may', 'can'])

export interface DismissalRecord {
  fingerprint: string
  kind: Kind
  /** one real example, kept so a person reviewing the learned list can see what it means */
  example: string
  count: number
  lastAt: number
}

export interface FeedbackSnapshot {
  dismissals: DismissalRecord[]
}

export interface FeedbackOptions {
  /** a fingerprint dismissed at least this many times is worth telling the model about */
  minCount?: number
  /** never mention more than this many patterns (a long list is easy to skim past) */
  maxLearned?: number
  /** a dismissal older than this (ms) no longer counts: opinions on what is a false alarm can go stale */
  maxAgeMs?: number
}

/**
 * Remembers which kinds of comment a reviewer dismissed on a project, and turns that into a short set of instructions
 * for the next review. It only ever adds "do not say X again"; it can make the reviewer quieter, never louder, so a
 * bad dismissal costs a missed comment, not a wrong one.
 */
export class FeedbackStore {
  private readonly byFingerprint = new Map<string, DismissalRecord>()

  constructor(private readonly opts: FeedbackOptions = {}) {}

  /** Call when a person dismisses a comment as unwanted, wrong, or not worth raising. */
  recordDismissal(f: Pick<Finding, 'kind' | 'message'>, at = Date.now()): string {
    const fp = fingerprint(f)
    const have = this.byFingerprint.get(fp)
    if (have) { have.count++; have.lastAt = at }
    else this.byFingerprint.set(fp, { fingerprint: fp, kind: f.kind, example: f.message, count: 1, lastAt: at })
    return fp
  }

  /** Undoes one dismissal (a person can accept a comment they, or someone else, had dismissed). */
  forgetOne(f: Pick<Finding, 'kind' | 'message'>): void {
    const fp = fingerprint(f)
    const have = this.byFingerprint.get(fp)
    if (!have) return
    have.count--
    if (have.count <= 0) this.byFingerprint.delete(fp)
  }

  private live(now: number): DismissalRecord[] {
    const { minCount = 2, maxAgeMs = 90 * 24 * 3600_000 } = this.opts
    return [...this.byFingerprint.values()].filter((d) => d.count >= minCount && now - d.lastAt <= maxAgeMs)
  }

  /** Whether a fresh finding matches something dismissed enough times to suppress. Kept separate from the prompt text
   * so the server can also filter a model's answer directly, not only ask nicely. */
  isLearnedFalseAlarm(f: Pick<Finding, 'kind' | 'message'>, now = Date.now()): boolean {
    const fp = fingerprint(f)
    return this.live(now).some((d) => d.fingerprint === fp)
  }

  /** The instructions to append to the model's system prompt, or '' if nothing has been learned yet. */
  learnedInstructions(now = Date.now()): string {
    const { maxLearned = 8 } = this.opts
    const live = this.live(now).sort((a, b) => b.count - a.count).slice(0, maxLearned)
    if (live.length === 0) return ''
    const lines = live.map((d) => `- (${d.kind}) like: "${d.example}"`)
    return `\n\nThe team has told you these kinds of comment are not wanted here (reviewed and dismissed ${live.map((d) => d.count).join('/')} times each). Do not report anything matching these, even on different code:\n${lines.join('\n')}`
  }

  snapshot(): FeedbackSnapshot {
    return { dismissals: [...this.byFingerprint.values()].map((d) => ({ ...d })) }
  }

  static fromSnapshot(s: FeedbackSnapshot, opts?: FeedbackOptions): FeedbackStore {
    const store = new FeedbackStore(opts)
    for (const d of s.dismissals) store.byFingerprint.set(d.fingerprint, { ...d })
    return store
  }
}
