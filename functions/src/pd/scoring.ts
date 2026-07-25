import { zScoresSampleSD } from '@mygames/game-engine'

// ═══════════════════════════════════════════════════════════════════════════════
// Repeated PD — pure class-wide scoring (spec §6). No Firestore, no I/O.
//
// ⚠⚠ PARTICIPATION ONLY. CUMULATIVE PRISON-YEARS ARE NEVER GRADED (spec §6, §11).
// They are a game OUTCOME: they appear in the history table, the reports, and the
// debrief, and they enter NO score, in NO direction. That is deliberate and
// pedagogical — a student who cooperates into a GRIM opponent's grudge and serves 60
// years must not be graded below one who defected every round. Note what is absent
// from ParticipantInput below: there is no years field to grade, so grading them
// would take a signature change, not a slip.
//
// The KC score rides ALONGSIDE participation on the family's normal path — it is
// carried through to the push as knowledge_check_score and never folded into
// raw_score or normalized_score.
//
// The shape is pennies' scoreClass with the auction parts removed: finishers get
// raw_score 1, so the z-score pool is all-1s and the shared engine's zero-SD guard
// returns normalized_score 0 for every finisher (the documented degenerate-pool
// behavior). Everyone else gets the platform no-show floor of −2 with raw_score null,
// and is excluded from the pool so they never create variance.
// ═══════════════════════════════════════════════════════════════════════════════

export interface PdParticipantInput {
  participant_id: string
  /**
   * True iff the student FINISHED the game — `finished_at` is stamped, which happens
   * exactly when the last drawn round is submitted. Elena's rule for this game:
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

export interface PdScoredParticipant {
  /** Participation: 1 for finishers, null for everyone else (no-show). */
  raw_score: number | null
  /** Z-score: 0 for every finisher (zero-SD pool); −2 for everyone else. */
  normalized_score: number | null
  /** Passed straight through — never folded into the participation score. */
  knowledge_check_score: number | null
  rounds_played: number
}

export interface PdClassScore {
  results: Record<string, PdScoredParticipant>
  finishers: number
}

/** The family no-show floor (SAA convention, matching pennies). */
export const NO_SHOW_SCORE = -2

/** Scores an entire instance. Pure and idempotent: same inputs ⇒ same outputs, with
 *  no randomness anywhere (PD has no tie-break to make — nothing is ranked). */
export function scoreClass(participants: PdParticipantInput[]): PdClassScore {
  const finishers = participants.filter(p => p.finished)

  // All-1s pool → the zero-SD guard returns 0 for each. Kept (rather than hardcoding
  // 0) so PD normalizes through the same engine path as every other game.
  const finisherZ = zScoresSampleSD(finishers.map(() => 1))

  const results: Record<string, PdScoredParticipant> = {}
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
