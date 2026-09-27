import { describe, expect, it } from 'vitest'
import { FeedbackStore, fingerprint } from './feedback'
import type { Finding } from './findings'

const f = (over: Partial<Finding> = {}): Finding => ({ path: 'a.ts', line: 1, kind: 'bug', severity: 'medium', message: 'Missing await on db.query call', ...over })

describe('fingerprint', () => {
  it('is the same for messages about the same pattern with different specifics', () => {
    expect(fingerprint(f())).toBe(fingerprint(f({ message: 'Missing await on `db.save` call' })))
    expect(fingerprint(f({ message: 'Missing await on db.query call 42' }))).toBe(fingerprint(f()))
  })
  it('differs by kind even for identical wording', () => {
    expect(fingerprint(f({ kind: 'bug' }))).not.toBe(fingerprint(f({ kind: 'security' })))
  })
  it('differs for a genuinely different problem', () => {
    expect(fingerprint(f())).not.toBe(fingerprint(f({ message: 'SQL built by string concatenation' })))
  })
  it('is stable and non-empty even for a short or unusual message', () => {
    expect(fingerprint(f({ message: 'Bad.' }))).toMatch(/^bug:/)
    expect(fingerprint(f({ message: '' }))).toBe('bug:')
  })
})

describe('FeedbackStore', () => {
  it('says nothing until a pattern has been dismissed enough times', () => {
    const s = new FeedbackStore()
    expect(s.learnedInstructions()).toBe('')
    s.recordDismissal(f())
    expect(s.learnedInstructions()).toBe('') // one dismissal could just be a one-off disagreement
    s.recordDismissal(f({ message: 'Missing await on db.save call' })) // same pattern, second time
    expect(s.learnedInstructions()).toContain('bug')
    expect(s.isLearnedFalseAlarm(f())).toBe(true)
  })

  it('only suppresses the pattern that was actually dismissed', () => {
    const s = new FeedbackStore()
    s.recordDismissal(f()); s.recordDismissal(f())
    expect(s.isLearnedFalseAlarm(f({ kind: 'security', message: 'SQL built by string concatenation' }))).toBe(false)
  })

  it('accepting a dismissed comment again can undo it', () => {
    const s = new FeedbackStore()
    s.recordDismissal(f()); s.recordDismissal(f())
    expect(s.isLearnedFalseAlarm(f())).toBe(true)
    s.forgetOne(f())
    expect(s.isLearnedFalseAlarm(f())).toBe(false)
  })

  it('keeps the most-dismissed patterns first and respects maxLearned', () => {
    const s = new FeedbackStore({ maxLearned: 1, minCount: 1 })
    s.recordDismissal(f({ message: 'pattern one' }))
    s.recordDismissal(f({ message: 'pattern two' }))
    s.recordDismissal(f({ message: 'pattern two' })) // dismissed twice, should rank first
    const text = s.learnedInstructions()
    expect(text).toContain('pattern two')
    expect(text).not.toContain('pattern one')
  })

  it('a dismissal older than the age limit stops counting', () => {
    const s = new FeedbackStore({ maxAgeMs: 1000 })
    s.recordDismissal(f(), 0); s.recordDismissal(f(), 0)
    expect(s.isLearnedFalseAlarm(f(), 500)).toBe(true)
    expect(s.isLearnedFalseAlarm(f(), 5000)).toBe(false)
  })

  it('round-trips through a snapshot', () => {
    const s = new FeedbackStore()
    s.recordDismissal(f()); s.recordDismissal(f())
    const restored = FeedbackStore.fromSnapshot(s.snapshot())
    expect(restored.isLearnedFalseAlarm(f())).toBe(true)
    expect(restored.learnedInstructions()).toBe(s.learnedInstructions())
  })

  it('never turns an accept into a false alarm: only dismissals count', () => {
    const s = new FeedbackStore()
    // forgetOne on something never dismissed does nothing and does not crash
    s.forgetOne(f())
    expect(s.isLearnedFalseAlarm(f())).toBe(false)
  })
})
