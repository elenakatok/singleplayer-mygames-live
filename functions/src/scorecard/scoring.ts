import { zScoresSampleSD } from '@mygames/game-engine'

// ═══════════════════════════════════════════════════════════════════════════════
// Metalcraft Supplier Scorecard — pure class-wide scoring. No Firestore, no I/O.
//
// ⚠⚠ PARTICIPATION ONLY, AND HERE THAT IS A CORRECTNESS REQUIREMENT RATHER THAN A
// PREFERENCE (spec §7). Every other game in the family says "participation only" as
// policy. This one says it as arithmetic:
//
//   A student who plays CORRECTLY under low reliability EARNS LESS than one who works
//   flat out and gets lucky. Optimal play in the low condition is 51.56 ECU per contract
//   against always-high's 16.57 — but the STUDENT who stops working looks, on the
//   earnings column, exactly like a student who gave up.
//
// So grading earnings would grade the treatment, punish the lesson, and reward the
// students who ignored it. It is also dominated by bonus luck: one 120-ECU bonus swings
// a contract by more than a whole session's worth of good decisions.
//
// The design makes it awkward to do by accident: note what is ABSENT from
// `ScorecardParticipantInput` below. There is no earnings field, no effort gap and no
// bonus count — so grading on outcome would take a signature change, not a slip.
//
// ⚠ THE EFFORT GAP IS NOT A GRADE EITHER, and it is the more tempting mistake here
// because it is the headline column and it *looks* like a measure of insight. It is not:
// under §2.3's labelling a zero gap is a strong FINDING about a student who saw the
// number and worked anyway — data, not a failure. Grading it would also give every
// student a reason to produce the gap rather than to reason about it, which would
// destroy the measurement the whole design exists to take.
//
// The KC rides ALONGSIDE participation on the family's normal path — carried through as
// `knowledge_check_score`, never folded into raw_score. The KC is the assessed component
// (spec §9), and the classroom is what weights them.
//
// Shape is forecast's / newsvendor's / PD's scoreClass: finishers get raw_score 1, so the
// z-score pool is all-1s and the shared engine's zero-SD guard returns 0 for every
// finisher. Everyone else gets the platform no-show floor of −2.
// ═══════════════════════════════════════════════════════════════════════════════

export interface ScorecardParticipantInput {
  participant_id: string
  /**
   * True iff the student FINISHED — `finished_at` is stamped, which happens exactly when
   * the last period of the last contract is submitted.
   */
  finished: boolean
  /** Contracts completed — REPORT ONLY. Never scored. */
  contracts_completed: number
  /** The KC score (0–1), or null if not completed. Passed through untouched. */
  knowledge_check_score: number | null
}

export interface ScorecardScoredParticipant {
  raw_score: number | null
  normalized_score: number | null
  knowledge_check_score: number | null
  contracts_completed: number
}

export interface ScorecardClassScore {
  results: Record<string, ScorecardScoredParticipant>
  finishers: number
}

/** The family no-show floor (matching pennies, poll, PD, pricing, newsvendor, forecast). */
export const NO_SHOW_SCORE = -2

/** Scores an entire instance. Pure and idempotent; nothing here is random. */
export function scoreClass(participants: ScorecardParticipantInput[]): ScorecardClassScore {
  const finishers = participants.filter(p => p.finished)
  const finisherZ = zScoresSampleSD(finishers.map(() => 1))

  const results: Record<string, ScorecardScoredParticipant> = {}
  let zi = 0
  for (const p of participants) {
    results[p.participant_id] = p.finished
      ? {
          raw_score: 1,
          normalized_score: finisherZ[zi++] ?? 0,
          knowledge_check_score: p.knowledge_check_score,
          contracts_completed: p.contracts_completed,
        }
      : {
          raw_score: null,
          normalized_score: NO_SHOW_SCORE,
          // A student who answered the KC but never finished keeps their KC score —
          // the two are independent and the KC is graded on its own path.
          knowledge_check_score: p.knowledge_check_score,
          contracts_completed: p.contracts_completed,
        }
  }

  return { results, finishers: finishers.length }
}
