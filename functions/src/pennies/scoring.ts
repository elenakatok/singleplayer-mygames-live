import { zScoresSampleSD } from '@mygames/game-engine'

// ═══════════════════════════════════════════════════════════════════════════════
// Jar of Pennies — pure class-wide scoring (spec §6, §7). No Firestore, no I/O —
// unit-tested directly. penniesScoreAndRecord reads/writes; this computes.
//
// GRADING is PARTICIPATION-ONLY (spec §7). Submitters get raw_score 1; the z-score
// pool is therefore all-1s, so the shared engine's zScoresSampleSD zero-SD guard
// (game-engine/scoring/zscore.ts:25) returns normalized_score 0 for every submitter
// — the documented degenerate-pool behavior. Non-submitters get normalized_score −2
// with raw_score null, the platform no-show convention (SAA), and are excluded from
// the pool so they never create variance. PROFIT IS A GAME OUTCOME, NEVER GRADED —
// it is computed for the report only and enters no score.
// ═══════════════════════════════════════════════════════════════════════════════

export interface ParticipantInput {
  participant_id: string
  /** True iff submitted_at is set. */
  submitted: boolean
  /** The submitted bid; null when not submitted. */
  bid: number | null
  /** won === true from a prior Score & Record run — preserved for idempotency. */
  priorWon?: boolean
}

export interface ScoredParticipant {
  won: boolean
  /** Winner: true_value − bid (typically negative). Other submitters: 0. Non-submitters: null. */
  profit: number | null
  /** Participation: 1 for submitters, null for non-submitters (no-show). */
  raw_score: number | null
  /** Z-score: 0 for every submitter (zero-SD pool); −2 for non-submitters. */
  normalized_score: number | null
}

export interface ClassScore {
  winnerId: string | null
  trueValue: number
  results: Record<string, ScoredParticipant>
}

/**
 * Scores an entire instance. `rng` is injectable so the random tie-break is
 * deterministic under test; defaults to Math.random in production.
 *
 * Idempotency (spec §6): the tie-break is random on the FIRST run, but if a tied
 * high bidder already carries won===true from a prior run, that winner is kept —
 * so re-running produces the same winner. A non-tie always reproduces exactly.
 */
export function scoreClass(
  participants: ParticipantInput[],
  trueValue: number,
  rng: () => number = Math.random,
): ClassScore {
  const submitters = participants.filter(p => p.submitted && p.bid != null)

  // Winner among submitters — highest bid, ties broken randomly (idempotency-aware).
  let winnerId: string | null = null
  if (submitters.length > 0) {
    const maxBid = Math.max(...submitters.map(p => p.bid as number))
    const tied = submitters.filter(p => p.bid === maxBid)
    const priorWinner = tied.find(p => p.priorWon)
    const winner = priorWinner ?? tied[Math.floor(rng() * tied.length)]
    winnerId = winner.participant_id
  }

  // Participation z-scores over the submitter pool only (all raw=1 → all 0 via guard).
  const submitterZ = zScoresSampleSD(submitters.map(() => 1))

  const results: Record<string, ScoredParticipant> = {}
  let zi = 0
  for (const p of participants) {
    if (p.submitted && p.bid != null) {
      const won = p.participant_id === winnerId
      results[p.participant_id] = {
        won,
        profit: won ? trueValue - p.bid : 0,
        raw_score: 1,
        normalized_score: submitterZ[zi] ?? 0,
      }
      zi++
    } else {
      // Launched but did not submit — no-show participation floor (spec §7).
      results[p.participant_id] = {
        won: false,
        profit: null,
        raw_score: null,
        normalized_score: -2,
      }
    }
  }

  return { winnerId, trueValue, results }
}
