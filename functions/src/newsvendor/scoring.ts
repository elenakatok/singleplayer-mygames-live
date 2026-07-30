import { zScoresSampleSD } from '@mygames/game-engine'

// ═══════════════════════════════════════════════════════════════════════════════
// Newsvendor — pure class-wide scoring. No Firestore, no I/O.
//
// ⚠⚠ PARTICIPATION ONLY. PROFIT IS NEVER GRADED — the standing platform rule, and
// here it matters more than usual: this game has an explicit BENCHMARK stored for
// every period, so "grade them against Q*" is a genuinely tempting mistake with the
// data sitting right there. It is not done. The optimality gap is a teaching artifact
// for the debrief and the reports; it enters NO score, in NO direction.
//
// Note what is absent from ParticipantInput below: there is no profit field and no
// gap field, so grading either would take a signature change, not a slip.
//
// The KC score rides ALONGSIDE participation on the family's normal path — it is
// carried through to the push as knowledge_check_score and never folded into
// raw_score or normalized_score. In this game the KC is the assessed component
// (spec §9.1), so keeping the two separate is what makes the grade legible.
//
// The shape is pricing's and PD's scoreClass: finishers get raw_score 1, so the
// z-score pool is all-1s and the shared engine's zero-SD guard returns
// normalized_score 0 for every finisher (the documented degenerate-pool behaviour).
// Everyone else gets the platform no-show floor of −2 with raw_score null, and is
// excluded from the pool so they never create variance.
// ═══════════════════════════════════════════════════════════════════════════════

export interface NewsvendorParticipantInput {
  participant_id: string
  /**
   * True iff the student FINISHED — `finished_at` is stamped, which happens exactly
   * when the last configured period is submitted. Elena's rule for this family: a
   * finished game is full participation; never-finished or absent is the floor.
   */
  finished: boolean
  /** Periods actually played — REPORT ONLY. Never scored. */
  rounds_played: number
  /** The KC score (0–1), or null if the KC was not completed. Passed through. */
  knowledge_check_score: number | null
}

export interface NewsvendorScoredParticipant {
  /** Participation: 1 for finishers, null for everyone else (no-show). */
  raw_score: number | null
  /** Z-score: 0 for every finisher (zero-SD pool); −2 for everyone else. */
  normalized_score: number | null
  /** Passed straight through — never folded into the participation score. */
  knowledge_check_score: number | null
  rounds_played: number
}

export interface NewsvendorClassScore {
  results: Record<string, NewsvendorScoredParticipant>
  finishers: number
}

/** The family no-show floor (matching pennies, poll, PD and pricing). */
export const NO_SHOW_SCORE = -2

/** Scores an entire instance. Pure and idempotent: same inputs ⇒ same outputs, with
 *  no randomness anywhere (nothing is ranked, so there is no tie to break). */
export function scoreClass(participants: NewsvendorParticipantInput[]): NewsvendorClassScore {
  const finishers = participants.filter(p => p.finished)

  // All-1s pool → the zero-SD guard returns 0 for each. Kept (rather than hardcoding
  // 0) so newsvendor normalizes through the same engine path as every other game.
  const finisherZ = zScoresSampleSD(finishers.map(() => 1))

  const results: Record<string, NewsvendorScoredParticipant> = {}
  let zi = 0
  for (const p of participants) {
    results[p.participant_id] = p.finished
      ? {
          raw_score: 1,
          normalized_score: finisherZ[zi++] ?? 0,
          knowledge_check_score: p.knowledge_check_score,
          rounds_played: p.rounds_played,
        }
      : {
          raw_score: null,
          normalized_score: NO_SHOW_SCORE,
          // A student who answered the KC but never finished still keeps their KC
          // score — the two are independent, and the KC is graded on its own path.
          knowledge_check_score: p.knowledge_check_score,
          rounds_played: p.rounds_played,
        }
  }

  return { results, finishers: finishers.length }
}
