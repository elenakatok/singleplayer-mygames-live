import { zScoresSampleSD } from '@mygames/game-engine'

// ═══════════════════════════════════════════════════════════════════════════════
// Forecasting — pure class-wide scoring. No Firestore, no I/O.
//
// ⚠⚠ PARTICIPATION ONLY. FORECAST ACCURACY IS NEVER GRADED (spec §6), and in this game
// that rule is under more pressure than anywhere else on the platform: every student
// has a single, clean, comparable number — their MSE — sitting on the participant doc,
// and the whole game is built to make that number meaningful. "Grade them on MSE" is
// therefore a genuinely tempting mistake with the data right there.
//
// It is not done, and the design makes it awkward to do by accident: note what is
// ABSENT from ParticipantInput below. There is no mse field, no mae, no accuracy and no
// bonus — so grading on accuracy would take a signature change, not a slip.
//
// Why the rule bites here specifically: a student's MSE is dominated by σ² (spec §2.3 —
// the floor is 900 against a best-achievable 902), so most of the variation between two
// competent students is the luck of their own draws rather than skill. Grading it would
// grade the random number generator. The LESSON lands in the debrief and the Tier-3
// benchmark box, which is exactly where spec §5a says it should.
//
// The KC score rides ALONGSIDE participation on the family's normal path — carried
// through to the push as knowledge_check_score, never folded into raw_score or
// normalized_score. The KC is the assessed component of this game (spec §8), so keeping
// the two separate is what makes the grade legible.
//
// The shape is newsvendor's, pricing's and PD's scoreClass: finishers get raw_score 1,
// so the z-score pool is all-1s and the shared engine's zero-SD guard returns
// normalized_score 0 for every finisher (the documented degenerate-pool behaviour).
// Everyone else gets the platform no-show floor of −2 with raw_score null, and is
// excluded from the pool so they never create variance.
// ═══════════════════════════════════════════════════════════════════════════════

export interface ForecastParticipantInput {
  participant_id: string
  /**
   * True iff the student FINISHED — `finished_at` is stamped, which happens exactly
   * when the last configured month is submitted. Elena's rule for this family: a
   * finished game is full participation; never-finished or absent is the floor.
   */
  finished: boolean
  /** Months actually played — REPORT ONLY. Never scored. */
  months_played: number
  /** The KC score (0–1), or null if the KC was not completed. Passed through. */
  knowledge_check_score: number | null
}

export interface ForecastScoredParticipant {
  /** Participation: 1 for finishers, null for everyone else (no-show). */
  raw_score: number | null
  /** Z-score: 0 for every finisher (zero-SD pool); −2 for everyone else. */
  normalized_score: number | null
  /** Passed straight through — never folded into the participation score. */
  knowledge_check_score: number | null
  months_played: number
}

export interface ForecastClassScore {
  results: Record<string, ForecastScoredParticipant>
  finishers: number
}

/** The family no-show floor (matching pennies, poll, PD, pricing and newsvendor). */
export const NO_SHOW_SCORE = -2

/** Scores an entire instance. Pure and idempotent: same inputs ⇒ same outputs, with no
 *  randomness anywhere (nothing is ranked, so there is no tie to break). */
export function scoreClass(participants: ForecastParticipantInput[]): ForecastClassScore {
  const finishers = participants.filter(p => p.finished)

  // All-1s pool → the zero-SD guard returns 0 for each. Kept (rather than hardcoding 0)
  // so forecast normalizes through the same engine path as every other game.
  const finisherZ = zScoresSampleSD(finishers.map(() => 1))

  const results: Record<string, ForecastScoredParticipant> = {}
  let zi = 0
  for (const p of participants) {
    results[p.participant_id] = p.finished
      ? {
          raw_score: 1,
          normalized_score: finisherZ[zi++] ?? 0,
          knowledge_check_score: p.knowledge_check_score,
          months_played: p.months_played,
        }
      : {
          raw_score: null,
          normalized_score: NO_SHOW_SCORE,
          // A student who answered the KC but never finished still keeps their KC
          // score — the two are independent, and the KC is graded on its own path.
          knowledge_check_score: p.knowledge_check_score,
          months_played: p.months_played,
        }
  }

  return { results, finishers: finishers.length }
}
