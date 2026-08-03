import { zScoresSampleSD } from '@mygames/game-engine'

// ═══════════════════════════════════════════════════════════════════════════════
// Procurement Auction — pure class-wide scoring. No Firestore, no I/O.
//
// ⚠⚠ PARTICIPATION ONLY. AUCTION PROFIT IS NEVER GRADED (Part 1 §11), and the pressure
// to grade it here is the same as in forecast: every student ends with one clean
// comparable number — cumulative profit across eight rounds — and the whole game is
// built to make it meaningful.
//
// It is not graded, and the shape below makes doing it by accident awkward: note what
// is ABSENT from ParticipantInput. There is no profit field and no win count, so
// grading on outcome would take a signature change, not a slip.
//
// Why the rule bites here specifically: profit is dominated by the student's own drawn
// cost and by how the rivals' independent draws fell. A student who drew a cost of 15
// and one who drew 55 are not playing the same game, and the markup decision — the
// thing actually being taught — is judged in the debrief and the Tier-3 scatter against
// the equilibrium line, which is where Part 1 §12 says it belongs.
//
// The KC score rides ALONGSIDE participation on the family's normal path, carried
// through to the push as knowledge_check_score and never folded into raw_score. The KC
// is the assessed component (Part 1 §11), so keeping the two apart is what makes the
// grade legible.
//
// The shape is forecast's, newsvendor's, pricing's and PD's scoreClass: finishers get
// raw_score 1, so the z-score pool is all-1s and the shared engine's zero-SD guard
// returns normalized_score 0 for every finisher. Everyone else gets the platform
// no-show floor of −2 with raw_score null, and is excluded from the pool so they never
// create variance.
// ═══════════════════════════════════════════════════════════════════════════════

export interface ProcurementParticipantInput {
  participant_id: string
  /**
   * True iff the student FINISHED — `finished_at` is stamped, which happens exactly
   * when the last configured round resolves. Elena's rule for this family: a finished
   * game is full participation; never-finished or absent is the floor.
   */
  finished: boolean
  /** Rounds actually played — REPORT ONLY. Never scored. */
  rounds_played: number
  /** The KC score (0–1), or null if the KC was not completed. Passed through. */
  knowledge_check_score: number | null
}

export interface ProcurementScoredParticipant {
  /** Participation: 1 for finishers, null for everyone else (no-show). */
  raw_score: number | null
  /** Z-score: 0 for every finisher (zero-SD pool); −2 for everyone else. */
  normalized_score: number | null
  /** Passed straight through — never folded into the participation score. */
  knowledge_check_score: number | null
  rounds_played: number
}

export interface ProcurementClassScore {
  results: Record<string, ProcurementScoredParticipant>
  finishers: number
}

/** The family no-show floor (matching pennies, poll, PD, pricing, newsvendor, forecast). */
export const NO_SHOW_SCORE = -2

/** Scores an entire instance. Pure and idempotent: same inputs ⇒ same outputs, with no
 *  randomness anywhere (the cost draws already happened and are stored), so a re-run is
 *  byte-identical rather than merely equivalent. */
export function scoreClass(participants: ProcurementParticipantInput[]): ProcurementClassScore {
  const finishers = participants.filter(p => p.finished)

  // All-1s pool → the zero-SD guard returns 0 for each. Kept (rather than hardcoding 0)
  // so this game normalizes through the same engine path as every other.
  const finisherZ = zScoresSampleSD(finishers.map(() => 1))

  const results: Record<string, ProcurementScoredParticipant> = {}
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
