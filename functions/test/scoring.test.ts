import { describe, it, expect } from 'vitest'
import { scoreClass, type ParticipantInput } from '../src/pennies/scoring'

// Pure scoring tests (no emulator). Runs under `npm test`.

const P = (id: string, bid: number | null, submitted = bid != null, priorWon = false): ParticipantInput =>
  ({ participant_id: id, submitted, bid, priorWon })

describe('scoreClass — winner, profit, grading', () => {
  it('highest bid wins; winner profit = true_value − bid; others profit 0', () => {
    const r = scoreClass([P('a', 3.0), P('b', 5.0), P('c', 4.0)], 3.5)
    expect(r.winnerId).toBe('b')
    expect(r.results.b.won).toBe(true)
    expect(r.results.b.profit).toBeCloseTo(3.5 - 5.0) // −1.5 (winner's curse)
    expect(r.results.a.won).toBe(false)
    expect(r.results.a.profit).toBe(0)
    expect(r.results.c.profit).toBe(0)
  })

  it('every submitter gets participation raw 1 and normalized 0 (zero-SD pool)', () => {
    const r = scoreClass([P('a', 1), P('b', 2), P('c', 9)], 3.5)
    for (const id of ['a', 'b', 'c']) {
      expect(r.results[id].raw_score).toBe(1)
      expect(r.results[id].normalized_score).toBe(0)
    }
  })

  it('non-submitter gets raw null, normalized −2, profit null; excluded from pool', () => {
    const r = scoreClass([P('a', 5), P('b', null, false)], 3.5)
    expect(r.results.b.raw_score).toBeNull()
    expect(r.results.b.normalized_score).toBe(-2)
    expect(r.results.b.profit).toBeNull()
    expect(r.results.b.won).toBe(false)
    // The lone submitter still normalizes to 0.
    expect(r.results.a.normalized_score).toBe(0)
  })

  it('no submitters → no winner, everyone −2', () => {
    const r = scoreClass([P('a', null, false), P('b', null, false)], 3.5)
    expect(r.winnerId).toBeNull()
    expect(r.results.a.normalized_score).toBe(-2)
  })
})

describe('scoreClass — tie break + idempotency', () => {
  it('ties broken by injected rng (deterministic under test)', () => {
    const tied = [P('a', 5), P('b', 5), P('c', 5)]
    expect(scoreClass(tied, 3.5, () => 0).winnerId).toBe('a')     // floor(0*3)=0
    expect(scoreClass(tied, 3.5, () => 0.99).winnerId).toBe('c')  // floor(0.99*3)=2
  })

  it('a prior winner among the tied high bidders is preserved (idempotent re-run)', () => {
    const tied = [P('a', 5), P('b', 5, true, true), P('c', 5)]
    // Even with rng pointing at 'a', the prior winner 'b' is kept.
    const r = scoreClass(tied, 3.5, () => 0)
    expect(r.winnerId).toBe('b')
    expect(r.results.b.won).toBe(true)
  })
})
