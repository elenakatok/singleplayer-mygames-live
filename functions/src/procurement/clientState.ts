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
// Part 2 §5.1): the reserve, the RIVAL cost range, the round count, the bid increment.
// The rival cost range in particular IS the lesson — the equilibrium markup the debrief
// discusses is only computable by a student who knows it (Part 1 §1, deck slide 4).
//
// ⚠ THE PLAYER'S OWN RANGE IS NOT HERE. See the note beside `rivalCostMax` below — §4
// says a student is told the rival distribution ONLY.
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
    // ⚠⚠ THE PLAYER'S OWN COST RANGE IS ABSENT, AND THAT IS SPEC §4, NOT A PREFERENCE:
    // "Students are told the rival distribution only; their own range is never mentioned
    // because it is not needed to bid well." It follows from §5.2 — a bidder's own cost
    // DISTRIBUTION does not enter their optimization, because their cost is realized
    // before they bid. Only the realized number matters, and they are shown that.
    //
    // Naming the range would invite reasoning about an irrelevant quantity ("my cost is
    // 55, that's high for my range, so…") and would hint at the deliberate player/rival
    // asymmetry (U[10,60] vs U[10,110]) the spec keeps quiet.
    //
    // ⚠ IT IS OMITTED FROM THE PAYLOAD, not merely from the screens. A field the server
    // never sends cannot be rendered by a later screen that did not know the rule.
    bidIncrementUnit: config.bidIncrementUnit,
    currencyLabel: config.currencyLabel,
    /**
     * Open format only — inert and harmless in a sealed instance.
     *
     * ⚠ THE SCREEN NEEDS BOTH SCHEDULES, AND NEITHER IS SECRET. The decrement schedule is
     * printed as "bids must fall by at least N" and pre-fills the bid box (open §5.1); the
     * delay schedule tells the client HOW LONG TO WAIT before asking whether a bot is due.
     * The client's timing is advisory in any case — `advanceOne` re-checks `nextBotAtMs`
     * server-side (§4.6) — so a client that ignored the delays would gain a bid it was
     * going to get anyway, one moment early.
     *
     * ⚠ `botDelayMs` IS GONE (open §3, 2026-08-04). The scalar pair could not serve both
     * phases of the auction; see DEFAULT_DELAY_SCHEDULE in config.ts.
     */
    decrementSchedule: config.decrementSchedule,
    delaySchedule: config.delaySchedule,
    delayJitterMs: config.delayJitterMs,
  }
}
