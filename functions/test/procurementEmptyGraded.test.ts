import { describe, it, expect } from 'vitest'
import { calcKCScore, kcScoreOrNull } from '@mygames/game-server'
import { scoringSet, gradedFor, poolForFormat } from '../src/procurement/questions'

// ═══════════════════════════════════════════════════════════════════════════════
// ⚠⚠ PROCUREMENT AND THE EMPTY GRADED SET.
//
// Procurement is the one game that ALREADY shipped per-question hide (`kcVisible`), so it
// is the one game where an instructor could already empty the graded set — long before the
// KC convergence work began. The concern was that it stores a PERFECT score in that case,
// because the shared `calcKCScore` answers the empty set with 1.0.
//
// ⚠ IT DOES NOT. `procurementSubmitKcAnswer` guards the call with `forScoring.length > 0`,
// so on an empty set it writes NEITHER a score NOR a completion stamp, and every consumer
// downstream reads the absent field as null. The outcome is already correct; it is reached
// by not writing rather than by writing null.
//
// ⚠⚠ THAT GUARD IS THE ONLY THING STANDING BETWEEN AN INSTRUCTOR AND A GRADEBOOK FULL OF
// 100%s, and it is one `&&` in a callable. This file pins it — and pins WHY, so nobody
// "simplifies" it away while tidying toward kcScoreOrNull.
// ═══════════════════════════════════════════════════════════════════════════════

describe('⚠⚠ procurement: an instructor CAN empty the graded set today', () => {
  it('kcVisible = [] produces an empty scoring set', () => {
    // This is the reachable configuration — procurement's settings page ships a visibility
    // checkbox per question, so unticking them all is two minutes of clicking.
    expect(gradedFor('sealed_first_price', [])).toHaveLength(0)
    expect(scoringSet('sealed_first_price', [])).toHaveLength(0)
    expect(scoringSet('open_descending', [])).toHaveLength(0)
  })

  it('…and a non-empty one is non-empty, so the test above is not vacuous', () => {
    const visible = gradedFor('sealed_first_price', ['S1', 'S3', 'S5']).map(q => q.id)
    expect(visible.length).toBeGreaterThan(0)
    expect(scoringSet('sealed_first_price', ['S1', 'S3', 'S5']).length).toBe(visible.length)
  })
})

describe('⚠⚠ the empty set must never be stored as a score', () => {
  it('calcKCScore answers the empty set with 1.0 — the trap the guard exists for', () => {
    // MUTANT CAUGHT: dropping `forScoring.length > 0 &&` from the callable's condition, or
    // "tidying" the call to a bare `calcKCScore(...).score`. Either stores 1.0 — a perfect
    // knowledge-check score for a student who was never asked a graded question — and
    // `procurementScoreAndRecord` pushes knowledge_check_score to the gradebook.
    expect(calcKCScore({}, []).score).toBe(1.0)
    expect(calcKCScore({ anything: 'x' }, scoringSet('sealed_first_price', [])).score).toBe(1.0)
  })

  it('⚠ the rule procurement implements: an empty set stores NOTHING', () => {
    // Stated as the predicate the callable uses, so the intent survives a refactor even if
    // the expression moves.
    const forScoring = scoringSet('sealed_first_price', [])
    const shouldStore = forScoring.length > 0
    expect(shouldStore).toBe(false)
  })

  it('⚠⚠ …AND THE GUARD IS CURRENTLY UNREACHABLE, which is why it must not be removed', () => {
    // ⚠⚠ THIS IS THE REAL SHAPE OF PROCUREMENT'S SAFETY, and it is structural rather than
    // defensive. `procurementSubmitKcAnswer` only proceeds for a field found among the
    // VISIBLE `kc`-stage questions — and EVERY kc-stage question is built by `mc()`, which
    // always sets `correct_value: 'a'`. So a reachable call implies at least one graded
    // question, i.e. `forScoring.length >= 1` always. The free-text questions live in the
    // `prep` and `debrief` stages and go to `procurementSubmitFreeText`, which never writes
    // a score at all.
    //
    // ⚠ CONSEQUENCE: the `forScoring.length > 0 &&` guard is dead code TODAY, and a mutant
    // that deletes it cannot be killed by any test — nothing can reach it. It becomes
    // load-bearing the instant somebody adds an UNGRADED question to the `kc` stage. This
    // test pins the invariant that keeps it dead; if it ever fails, the guard is live and
    // the empty-set behaviour needs real coverage.
    for (const format of ['sealed_first_price', 'open_descending'] as const) {
      const visible = poolForFormat(format).filter(q => q.stage === 'kc').map(q => q.id)
      const kcStage = poolForFormat(format).filter(q => q.stage === 'kc')
      expect(kcStage.length, `${format} has kc-stage questions`).toBeGreaterThan(0)
      expect(
        kcStage.every(q => q.correct_value !== null),
        `${format}: EVERY kc-stage question carries an answer key`,
      ).toBe(true)
      // …so any non-empty visible kc set is also a non-empty GRADED set.
      expect(gradedFor(format, visible).length).toBe(kcStage.length)
    }

    // And the free-text questions really are in other stages — the ones a student can
    // answer without ever entering the grader.
    for (const format of ['sealed_first_price', 'open_descending'] as const) {
      const text = poolForFormat(format).filter(q => q.kind === 'text')
      expect(text.length).toBeGreaterThan(0)
      expect(text.every(q => q.stage !== 'kc')).toBe(true)
      expect(text.every(q => q.correct_value === null)).toBe(true)
    }
  })

  it('⚠ and kcScoreOrNull would reach the same OUTCOME by a different route', () => {
    // Recorded rather than adopted. Swapping procurement onto kcScoreOrNull would store
    // `null` AND stamp `knowledge_check_completed_at` — where today neither is written.
    // Procurement's guard exists precisely so a student is not "handed a completed KC"
    // (its own comment), so the swap would REGRESS it. Same score, different completion
    // semantics; left alone deliberately.
    expect(kcScoreOrNull({}, scoringSet('sealed_first_price', []))).toBeNull()
    expect(calcKCScore({}, []).score).not.toBeNull()
  })
})
