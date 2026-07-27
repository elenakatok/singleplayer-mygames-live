import { zScoresSampleSD } from '@mygames/game-engine'

// ═══════════════════════════════════════════════════════════════════════════════
// Pricing Game — pure class-wide scoring (spec §7). No Firestore, no I/O.
//
// ⚠⚠ PARTICIPATION ONLY. PROFITS ARE NEVER GRADED (spec §7). They are a game
// OUTCOME: they appear in the history table, the reports, and the debrief, and they
// enter NO score, in NO direction. That is deliberate and pedagogical — a student who
// discovers the undercutting spiral and ends the game near cost must not be graded
// below one who never explored. Note what is absent from ParticipantInput below:
// there is no profit field to grade, so grading profit would take a signature change,
// not a slip.
//
// The KC score rides ALONGSIDE participation on the family's normal path — it is
// carried through to the push as knowledge_check_score and never folded into
// raw_score or normalized_score.
//
// ⚠ TWO COURSE INSTANCES, TWO ENTRIES (spec §14). Nothing here knows about the
// Standard/PMG split, and nothing needs to: scoring is per instance, and each
// instance pushes its own gradebook row keyed by its own game_instance_id. A student
// who plays both gets two independent entries because they are two instances, not
// because anything here treats them specially.
//
// The shape is PD's scoreClass: finishers get raw_score 1, so the z-score pool is
// all-1s and the shared engine's zero-SD guard returns normalized_score 0 for every
// finisher (the documented degenerate-pool behaviour). Everyone else gets the platform
// no-show floor of −2 with raw_score null, and is excluded from the pool so they never
// create variance.
// ═══════════════════════════════════════════════════════════════════════════════

export interface PricingParticipantInput {
  participant_id: string
  /**
   * True iff the student FINISHED the game — `finished_at` is stamped, which happens
   * exactly when their last drawn round is submitted. Elena's rule for this family:
   * a finished game is full participation; never-finished or absent is the floor.
   * Deliberately not "played at least one round": partial play is not participation
   * here, and `rounds_played` is reported so the call can be revisited per class.
   */
  finished: boolean
  /** Rounds actually played — REPORT ONLY. Never scored. */
  rounds_played: number
  /** The KC score (0–1), or null if the KC was not completed. Passed through. */
  knowledge_check_score: number | null
}

export interface PricingScoredParticipant {
  /** Participation: 1 for finishers, null for everyone else (no-show). */
  raw_score: number | null
  /** Z-score: 0 for every finisher (zero-SD pool); −2 for everyone else. */
  normalized_score: number | null
  /** Passed straight through — never folded into the participation score. */
  knowledge_check_score: number | null
  rounds_played: number
}

export interface PricingClassScore {
  results: Record<string, PricingScoredParticipant>
  finishers: number
}

/** The family no-show floor (matching pennies, poll and PD). */
export const NO_SHOW_SCORE = -2

/** Scores an entire instance. Pure and idempotent: same inputs ⇒ same outputs, with
 *  no randomness anywhere (nothing is ranked, so there is no tie to break). */
export function scoreClass(participants: PricingParticipantInput[]): PricingClassScore {
  const finishers = participants.filter(p => p.finished)

  // All-1s pool → the zero-SD guard returns 0 for each. Kept (rather than hardcoding
  // 0) so pricing normalizes through the same engine path as every other game.
  const finisherZ = zScoresSampleSD(finishers.map(() => 1))

  const results: Record<string, PricingScoredParticipant> = {}
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
