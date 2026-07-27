import { describe, it, expect } from 'vitest'
import { scoreClass, NO_SHOW_SCORE, type PricingParticipantInput } from '../src/pricing/scoring'

// ═══════════════════════════════════════════════════════════════════════════════
// Participation scoring (spec §7). The load-bearing property is what is ABSENT:
// there is no profit field on the input, so profits cannot be graded by accident.
// ═══════════════════════════════════════════════════════════════════════════════

const p = (over: Partial<PricingParticipantInput> & { participant_id: string }): PricingParticipantInput => ({
  finished: false, rounds_played: 0, knowledge_check_score: null, ...over,
})

describe('participation only', () => {
  it('a finisher scores raw 1 and normalizes to 0 (zero-SD pool)', () => {
    const s = scoreClass([p({ participant_id: 'a', finished: true, rounds_played: 14 })])
    expect(s.results.a.raw_score).toBe(1)
    expect(s.results.a.normalized_score).toBe(0)
    expect(s.finishers).toBe(1)
  })

  it('a student who played but never finished gets the floor', () => {
    const s = scoreClass([p({ participant_id: 'b', finished: false, rounds_played: 6 })])
    expect(s.results.b.raw_score).toBeNull()
    expect(s.results.b.normalized_score).toBe(NO_SHOW_SCORE)
    // …and their rounds are still reported, so the call can be revisited per class.
    expect(s.results.b.rounds_played).toBe(6)
  })

  it('a student who never launched gets the same floor', () => {
    const s = scoreClass([p({ participant_id: 'c' })])
    expect(s.results.c.normalized_score).toBe(-2)
  })

  it('every finisher gets the SAME score, however they played', () => {
    // The pedagogical point: a student who explored the undercutting spiral into
    // losses is not graded below one who sat at the ceiling all game.
    const s = scoreClass([
      p({ participant_id: 'explorer', finished: true, rounds_played: 12 }),
      p({ participant_id: 'coaster', finished: true, rounds_played: 12 }),
    ])
    expect(s.results.explorer).toEqual(s.results.coaster)
  })

  it('⚠ there is no profit input at all — grading profit would take a signature change', () => {
    const input = p({ participant_id: 'a', finished: true })
    expect(Object.keys(input).sort())
      .toEqual(['finished', 'knowledge_check_score', 'participant_id', 'rounds_played'])
  })
})

describe('the KC score rides alongside, never folded in', () => {
  it('is passed through unchanged for a finisher', () => {
    const s = scoreClass([p({ participant_id: 'a', finished: true, knowledge_check_score: 0.75 })])
    expect(s.results.a.knowledge_check_score).toBe(0.75)
    expect(s.results.a.raw_score).toBe(1)          // unaffected by the KC
  })

  it('and is KEPT for a student who answered it but never finished', () => {
    const s = scoreClass([p({ participant_id: 'b', finished: false, knowledge_check_score: 1 })])
    expect(s.results.b.knowledge_check_score).toBe(1)
    expect(s.results.b.normalized_score).toBe(-2)  // the two are independent
  })

  it('a perfect KC does not rescue a no-show, and a zero KC does not sink a finisher', () => {
    const s = scoreClass([
      p({ participant_id: 'perfect-absent', finished: false, knowledge_check_score: 1 }),
      p({ participant_id: 'zero-finisher', finished: true, knowledge_check_score: 0 }),
    ])
    expect(s.results['perfect-absent'].normalized_score).toBe(-2)
    expect(s.results['zero-finisher'].normalized_score).toBe(0)
  })
})

describe('idempotence', () => {
  it('same inputs ⇒ byte-identical outputs (no randomness, nothing ranked)', () => {
    const inputs = [
      p({ participant_id: 'a', finished: true, rounds_played: 11 }),
      p({ participant_id: 'b', finished: false, rounds_played: 2 }),
      p({ participant_id: 'c', finished: true, rounds_played: 17, knowledge_check_score: 0.5 }),
    ]
    expect(JSON.stringify(scoreClass(inputs))).toBe(JSON.stringify(scoreClass(inputs)))
  })

  it('an empty class scores nothing rather than throwing', () => {
    expect(scoreClass([])).toEqual({ results: {}, finishers: 0 })
  })
})
