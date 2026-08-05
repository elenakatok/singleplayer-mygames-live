import { maxLegalBid, type DecrementBand } from './schedule'

// ═══════════════════════════════════════════════════════════════════════════════
// PERFECT-PLAY PROFIT FOR AN OPEN ROUND — THE CLOSED FORM (Elena, 2026-08-04).
//
//   profit = (second-lowest cost among all bidders, including the player) − player cost,
//            when the player's cost is the lowest
//          = 0 otherwise
//
// ⚠⚠ THIS REPLACED A SAMPLED REPLAY, and the reason is worth keeping. CP4b first computed
// the benchmark by replaying the whole auction with the player exiting at their own cost;
// that inherited the seeded-random bot ORDERING, which BUILD_NOTES §2 measured moving the
// halt price by up to 10 ECU. Elena's correction: **the ordering noise is a
// large-increment phenomenon.** Increments here are 2 and 1 in the endgame — where the
// outcome is actually settled — and small relative to the cost spread, so the auction
// converges on the lowest-cost bidder winning at the second-lowest cost regardless of who
// bids when. **Ordering changes the path, not the destination.**
//
// It is also the standard theoretical result Elena teaches, so the student's screen and
// the lecture now assert the same number instead of two numbers that nearly agree.
//
// ⚠ NO RNG, NO SEED, NO STREAM. The old version needed a separately-keyed stream so a
// hypothetical replay could not disturb the real auction's draws; there is nothing to
// disturb now. That whole coupling is gone rather than merely unused.
//
// ⚠⚠ ONE PLACE WHERE THE CLOSED FORM AND THE MECHANISM GENUINELY PART COMPANY — see
// `perfectPlayProfit`'s note on the ceiling, and BUILD_NOTES §6j on the discretization
// gap, which is REPORTED rather than smoothed over.
// ═══════════════════════════════════════════════════════════════════════════════

export interface PerfectPlay {
  /** Would a player following the dominant strategy have taken this contract? */
  won: boolean
  /** What they would have been paid. Null when they would not have won. */
  price: number | null
  /** ⚠ NEVER NEGATIVE. Perfect play does not bid below its own cost, and a loser earns
   *  nothing rather than losing something (Part 1 §7 step 5). */
  profit: number
}

/**
 * @param playerCost  the student's own drawn cost for the round
 * @param botCosts    every simulated supplier's cost — from the rules-denied truth doc
 * @param reserve     the incumbent's price; the auction opens here (§4.1)
 * @param schedule    the decrement schedule, for the first-legal-bid ceiling
 */
export function perfectPlayProfit(
  playerCost: number,
  botCosts: readonly number[],
  reserve: number,
  schedule: readonly DecrementBand[],
): PerfectPlay {
  const none: PerfectPlay = { won: false, price: null, profit: 0 }

  // ⚠ A SUPPLIER WHOSE COST EXCEEDS THE INCUMBENT'S PRICE IS ABSENT FROM THE AUCTION
  // (§4.3) — not a bidder who bids high. That applies to the student too: above the
  // reserve there is no bid worth making, so perfect play earns nothing.
  if (playerCost > reserve) return none

  /**
   * ⚠⚠ THE CEILING, AND WHY IT IS PART OF THE CLOSED FORM. The auction opens AT the
   * reserve and the first legal bid is `reserve − step(reserve)`, so nobody is ever paid
   * more than that — however empty the field. Without this cap, a round in which every
   * rival is priced out would report a benchmark of `reserve − cost` and overstate what
   * was winnable by a whole top step (§8.3 case 7: the player wins unopposed at 100, not
   * at 110).
   *
   * It also silently handles §4.1's known artifact — a supplier costing between the
   * ceiling and the reserve can never bid — because such a rival raises the second-lowest
   * cost above the ceiling and the cap takes over.
   */
  const ceiling = maxLegalBid(reserve, schedule)

  const rivals = botCosts.filter(c => c <= reserve)
  const lowestRival = rivals.length > 0 ? Math.min(...rivals) : null

  // ⚠ NON-STRICT, AND THAT IS DELIBERATE. A rival matching the student's cost can hold the
  // price down to it, leaving nothing above cost to win — the same zero the strict reading
  // ("second-lowest − own cost" with the tie as the second-lowest) produces. Written as a
  // comparison rather than relying on the arithmetic so the intent is legible.
  if (lowestRival !== null && lowestRival <= playerCost) return none

  // The student is the cheapest supplier: perfect play takes the contract at the
  // second-lowest cost in the field — or at the ceiling, whichever binds first.
  const price = Math.min(lowestRival ?? Number.POSITIVE_INFINITY, ceiling)

  // Unreachable given the guards above except when the student's own cost sits between the
  // ceiling and the reserve, where they cannot make even the first legal bid.
  if (price < playerCost) return none

  return { won: true, price, profit: price - playerCost }
}
