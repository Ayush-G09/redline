import { describe, expect, it } from 'vitest'
import { Dashboard, dashboardFromSnapshot } from '../src/dashboard'

const f = (over: Record<string, unknown> = {}) => ({ path: 'a.ts', line: 3, kind: 'bug' as const, severity: 'high' as const, message: 'Missing await on db.query', ...over })

describe('Dashboard: streaming and history', () => {
  it('broadcasts job-start, finding and job-done to every listener', () => {
    const d = new Dashboard()
    const seen: unknown[] = []
    d.onEvent((e) => seen.push(e))
    d.jobStart('acme/app#1', 'Add a thing')
    const id = d.finding('acme/app#1', f())
    d.jobDone('acme/app#1', 'reviewed', 1, false)
    expect(seen).toEqual([
      { type: 'job-start', key: 'acme/app#1', title: 'Add a thing', at: expect.any(Number) },
      { type: 'finding', key: 'acme/app#1', id, finding: f(), at: expect.any(Number) },
      { type: 'job-done', key: 'acme/app#1', outcome: 'reviewed', comments: 1, incomplete: false, at: expect.any(Number) },
    ])
  })
  it('a listener that unsubscribes stops receiving events', () => {
    const d = new Dashboard()
    const seen: unknown[] = []
    const off = d.onEvent((e) => seen.push(e))
    off()
    d.jobStart('k', 't')
    expect(seen).toEqual([])
  })
  it('remembers findings for later lookup and listing, newest last, capped', () => {
    const d = new Dashboard({ maxFindings: 3 })
    const ids = [f({ line: 1 }), f({ line: 2 }), f({ line: 3 }), f({ line: 4 })].map((x) => d.finding('k', x))
    expect(d.get(ids[0])).toBeUndefined() // fell off the front
    expect(d.get(ids[3])?.finding.line).toBe(4)
    expect(d.recentFindings('k').map((x) => x.finding.line)).toEqual([2, 3, 4])
  })
  it('recentFindings filters by key', () => {
    const d = new Dashboard()
    d.finding('a', f())
    d.finding('b', f())
    expect(d.recentFindings('a')).toHaveLength(1)
    expect(d.recentFindings()).toHaveLength(2)
  })
})

describe('Dashboard: acting on a finding', () => {
  it('dismissing marks it, teaches the feedback store, and cannot be dismissed twice', () => {
    const d = new Dashboard()
    const id = d.finding('k', f())
    expect(d.act(id, 'dismissed')).toMatchObject({ status: 'dismissed' })
    expect(d.act(id, 'dismissed')).toBeNull() // already acted on
    expect(d.get(id)?.status).toBe('dismissed')
  })
  it('accepting does not teach the store to suppress anything', () => {
    const d = new Dashboard()
    const id = d.finding('k', f())
    d.act(id, 'accepted')
    expect(d.feedback.isLearnedFalseAlarm(f())).toBe(false)
  })
  it('two dismissals of the same pattern make the reviewer learn it', () => {
    const d = new Dashboard()
    d.act(d.finding('k', f()), 'dismissed')
    d.act(d.finding('k', f({ line: 9 })), 'dismissed') // same pattern, different line
    expect(d.feedback.learnedInstructions()).toContain('bug')
  })
  it('acting on an unknown id does nothing and does not throw', () => {
    const d = new Dashboard()
    expect(d.act('nope', 'accepted')).toBeNull()
  })
})

describe('dashboardFromSnapshot', () => {
  it('starts a new Dashboard already knowing what was learned before', () => {
    const d1 = new Dashboard()
    d1.act(d1.finding('k', f()), 'dismissed')
    d1.act(d1.finding('k', f({ line: 9 })), 'dismissed')
    const snap = d1.feedback.snapshot()
    const d2 = dashboardFromSnapshot(snap)
    expect(d2.feedback.isLearnedFalseAlarm(f())).toBe(true)
    expect(d2.recentFindings()).toEqual([]) // findings themselves are not part of the persisted snapshot
  })
})
