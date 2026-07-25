import { describe, it, expect } from 'vitest'
import { scoreClass, NO_SHOW_SCORE, type PdParticipantInput } from '../src/pd/scoring'

// Pure participation-scoring tests (no emulator). Spec §6.

const p = (
  participant_id: string, finished: boolean, rounds_played = 0, kc: number | null = null,
): PdParticipantInput => ({ participant_id, finished, rounds_played, knowledge_check_score: kc })

describe('scoreClass — participation only (spec §6)', () => {
  it('gives every finisher raw 1 and normalized 0 (the zero-SD pool)', () => {
    const { results } = scoreClass([p('a', true, 13), p('b', true, 13), p('c', true, 13)])
    for (const id of ['a', 'b', 'c']) {
      expect(results[id].raw_score).toBe(1)
      expect(results[id].normalized_score).toBe(0)
    }
  })

  it('gives the no-show floor to someone who never launched', () => {
    const { results } = scoreClass([p('absent', false, 0)])
    expect(results.absent.raw_score).toBeNull()
    expect(results.absent.normalized_score).toBe(NO_SHOW_SCORE)
    expect(NO_SHOW_SCORE).toBe(-2)
  })

  it('gives the floor to someone who played rounds but never FINISHED', () => {
    // Elena's rule for this game: a finished game is participation; a partial one is
    // not. rounds_played is carried for the report so the call can be revisited.
    const { results } = scoreClass([p('quit', false, 7)])
    expect(results.quit.normalized_score).toBe(NO_SHOW_SCORE)
    expect(results.quit.rounds_played).toBe(7)
  })

  it('counts finishers', () => {
    const { finishers } = scoreClass([p('a', true, 11), p('b', false, 3), p('c', true, 11)])
    expect(finishers).toBe(2)
  })

  it('excludes non-finishers from the pool, so they create no variance', () => {
    // If the −2s entered the z pool, the finishers would stop being 0.
    const withAbsentees = scoreClass([p('a', true, 12), p('b', false), p('c', false)])
    expect(withAbsentees.results.a.normalized_score).toBe(0)
  })

  it('is deterministic — a re-run is byte-identical (no tie-break, nothing ranked)', () => {
    const inputs = [p('a', true, 10), p('b', false), p('c', true, 20, 0.75)]
    expect(scoreClass(inputs)).toEqual(scoreClass(inputs))
  })

  it('handles an empty instance without dividing by zero', () => {
    expect(scoreClass([])).toEqual({ results: {}, finishers: 0 })
  })
})

describe('⚠ prison-years are NEVER graded (spec §6, §11)', () => {
  it('has no input field for years at all — grading them would take a signature change', () => {
    const input = p('a', true, 15)
    expect(Object.keys(input).sort()).toEqual(
      ['finished', 'knowledge_check_score', 'participant_id', 'rounds_played'],
    )
  })

  it('scores two finishers identically however differently their games went', () => {
    // The whole pedagogical point: a student who cooperated into a GRIM grudge and
    // served 60 years must not be graded below one who defected every round.
    const { results } = scoreClass([p('cooperator', true, 15), p('defector', true, 15)])
    expect(results.cooperator.normalized_score).toBe(results.defector.normalized_score)
    expect(results.cooperator.raw_score).toBe(results.defector.raw_score)
  })

  it('passes the KC score through without folding it into participation', () => {
    const { results } = scoreClass([p('a', true, 12, 0.5), p('b', true, 12, 1)])
    expect(results.a.knowledge_check_score).toBe(0.5)
    expect(results.b.knowledge_check_score).toBe(1)
    // …and participation is untouched by it.
    expect(results.a.raw_score).toBe(results.b.raw_score)
    expect(results.a.normalized_score).toBe(results.b.normalized_score)
  })

  it('keeps a KC score even for a student who never finished the game', () => {
    const { results } = scoreClass([p('kc-only', false, 2, 0.75)])
    expect(results['kc-only'].knowledge_check_score).toBe(0.75)
    expect(results['kc-only'].normalized_score).toBe(NO_SHOW_SCORE)
  })
})
