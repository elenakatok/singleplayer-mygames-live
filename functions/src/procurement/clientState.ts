import type { ProcurementConfig } from './config'

// ═══════════════════════════════════════════════════════════════════════════════
// Procurement Auction — WHAT A STUDENT MAY SEE, as a function signature.
//
// ⚠⚠ `clientParams` TAKES A ProcurementConfig AND CANNOT REACH A SEED. The seed lives on
// `ProcurementInstance` (instance.ts) and is never destructured into anything that
// reaches a return statement, so the leak this whitelist exists to prevent would have to
// be written deliberately — it cannot happen by a careless spread.
//
// Every field below is printed on the student's own bidding screen anyway (Part 1 §6.1,
// Part 2 §5.1): the reserve, both cost ranges, the round count, the bid increment. The
// rival cost range in particular IS the lesson — the equilibrium markup the debrief
// discusses is only computable by a student who knows it (Part 1 §1, deck slide 4).
// ═══════════════════════════════════════════════════════════════════════════════

export type Phase = 'kc' | 'play' | 'debrief' | 'done'

/**
 * Where the student is in the flow, derived from the stored stamps rather than from
 * re-counting rounds, so the read path and the write path agree on one fact.
 *
 * ⚠ TODO(build): the KC leg is decided by the CONFIG plus whether the graded set has
 * been answered; that lands with the pool in Checkpoint 2. Until then a student with an
 * empty pool has nothing to answer and goes straight to play, which is correct
 * behaviour for an unconfigured instance rather than a placeholder.
 */
export function phaseOf(pData: Record<string, unknown>): Phase {
  if (pData.finalized_at != null) return 'done'
  if (pData.finished_at != null) return 'debrief'
  return 'play'
}

/** Everything the bidding screen prints, and nothing else. */
export function clientParams(config: ProcurementConfig) {
  return {
    format: config.format,
    rounds: config.rounds,
    rivalCount: config.rivalCount,
    /** Total bidders including the student (Part 1 §3). Derived here so no screen
     *  re-derives it and gets the +1 wrong. */
    totalBidders: config.rivalCount + 1,
    reserve: config.reserve,
    rivalCostMin: config.rivalCostDist.min,
    rivalCostMax: config.rivalCostDist.max,
    playerCostMin: config.playerCostDist.min,
    playerCostMax: config.playerCostDist.max,
    bidIncrementUnit: config.bidIncrementUnit,
    currencyLabel: config.currencyLabel,
    /** Open format only — inert and harmless in a sealed instance. */
    decrementSchedule: config.decrementSchedule,
    botDelayMs: config.botDelayMs,
  }
}
