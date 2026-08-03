// ═══════════════════════════════════════════════════════════════════════════════
// Procurement Auction — DIRECTION. Pure.
//
// ⚠ THE COMPARATOR IS PASSED IN, NOT HARDCODED (spec §7). `direction: 'reverse'`
// supplies "lowest wins"; a forward instance would supply "highest wins" and change
// NOTHING ELSE in the resolver. `direction` is a config key with exactly one legal value
// today (spec §3) — it is not instructor-facing, and it exists as a written-down value
// rather than an assumption because the eventual auction-engine extraction needs one
// direction-neutral concept and a value that was never written down is a value the
// extraction has to re-derive.
//
// Three things are direction-dependent and all three live here, so adding a forward
// auction is one object rather than a grep:
//   1. which of two bids is better,
//   2. what the reserve admits,
//   3. how a price and a cost become a payoff.
// ═══════════════════════════════════════════════════════════════════════════════

export interface AuctionDirection {
  /** True iff bid `a` beats bid `b`. */
  better(a: number, b: number): boolean
  /** True iff a bid of `amount` is admissible under `reserve`. */
  admissible(amount: number, reserve: number): boolean
  /**
   * The winner's payoff. ⚠ Only ever called for the WINNER — a loser earns exactly
   * zero and never a negative number (spec §7 step 5: a losing supplier incurs no
   * cost). The resolver enforces that; this function is not asked.
   */
  payoff(price: number, cost: number): number
}

/**
 * Reverse (procurement): the lowest bid wins, and a bid must be AT OR BELOW the reserve.
 *
 * ⚠ The payoff may be NEGATIVE, and that is not a bug (spec §6.2, vector case 4). Bids
 * below one's own cost are legal and never blocked — losing money is a legitimate
 * mistake and part of the lesson; the lecture's own scatter shows students doing it.
 */
export const REVERSE: AuctionDirection = {
  better: (a, b) => a < b,
  admissible: (amount, reserve) => amount <= reserve,
  payoff: (price, cost) => price - cost,
}

/**
 * Forward, for completeness of the abstraction — **not reachable from config today**
 * (`direction` has one legal value). Present so the direction-neutrality claim is
 * demonstrable rather than asserted: the resolver's tests run the same vectors through
 * both objects, which is what proves nothing about "lowest" leaked into the loop.
 */
export const FORWARD: AuctionDirection = {
  better: (a, b) => a > b,
  admissible: (amount, reserve) => amount >= reserve,
  payoff: (price, cost) => cost - price,
}
