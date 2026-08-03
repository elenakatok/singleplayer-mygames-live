// ═══════════════════════════════════════════════════════════════════════════════
// Procurement Auction — THE EQUILIBRIUM BID FUNCTION β(c). Pure: no Firestore, no game
// imports, no randomness.
//
// ⚠⚠ ONE FUNCTION SERVES TWO PURPOSES, AND THAT IS THE POINT OF THE WHOLE GAME.
// It is what the BOTS play (spec §5.1) and it is simultaneously the PLAYER's optimal
// bid (spec §5.2) — the derivation shows the player's maximizer is the same function
// the bots use, for any k and any player cost, from any range. So:
//   • the bots sit exactly on the "Optimal" line of the §9 scatter, which is why that
//     plot documents its own benchmark instead of asserting it;
//   • the §8 counterfactual ("your equilibrium bid would have been 49") costs nothing,
//     because the formula is already here;
//   • "a perfect player would have earned X" is this function against the same realized
//     rival bids.
// If this file is ever wrong, three separate screens lie in agreement with each other.
//
// ⚠⚠ THE GENERAL, RESERVE-CONDITIONED FORM IS IMPLEMENTED — NOT THE SIMPLE ONE.
// Spec §5.1 is explicit about why, and it is the kind of thing that looks like
// over-engineering right up until it isn't:
//
//        (θmax − c)ⁿ − (θmax − r)ⁿ
//   β(c) = c + ─────────────────────────      for c ≤ r
//              n · (θmax − c)ⁿ⁻¹
//
//   β(c) = NO BID                             for c > r
//
// At the default r = θmax the second numerator term vanishes and this collapses EXACTLY
// to β(c) = c + (θmax − c)/n — the SoPHIE formula, and the one every worked number in
// the spec uses. But the simple form is the equilibrium ONLY at that default. The
// reserve is instructor-adjustable (spec §3.1), so shipping the simple form would mean
// the bots stop being optimal the moment anyone lowers it — quietly falsifying the
// "Optimal" line, the one thing that plot exists to assert. One extra term buys
// correctness under every setting.
//
// The conformance requirement in §5.1 is asserted in `procurementEquilibrium.test.ts`: at
// r = θmax the general form returns the simple form's values across the FULL cost range,
// and at r < θmax bots with cost > r return no bid.
//
// ⚠⚠ IF YOU ARE HERE TO SIMPLIFY THIS FUNCTION, READ THIS FIRST. At the default reserve
// the two forms are mathematically identical, so the default-reserve conformance test —
// the thorough one, every integer cost, several bidder counts — STILL PASSES after the
// simplification. Exactly ONE assertion catches it: the lowered-reserve divergence test,
// labelled load-bearing in that file. Verified by mutation on 2026-08-03. Deleting the
// second numerator term is not dead-arithmetic removal; it silently falsifies the
// "Optimal" line on the §9 scatter at every non-default reserve.
// ═══════════════════════════════════════════════════════════════════════════════

export interface EquilibriumSettings {
  /** θmax — the TOP OF THE RIVAL COST RANGE, always. Never the player's own max: the
   *  player's optimal bid is computed against the RIVALS' distribution (spec §5.2). */
  rivalCostMax: number
  /** r — the reserve. Bid ceiling, and the incumbent's price. */
  reserve: number
  /** n = rivalCount + 1 — TOTAL bidders, not rivals. Off-by-one here changes every
   *  bid in the game and every reference line on every chart. */
  totalBidders: number
}

/**
 * The equilibrium bid at cost `c`, or **null** when the bidder has no bid worth making.
 *
 * Returns null iff `c > reserve` — a supplier whose cost exceeds the incumbent's price
 * is ABSENT from the auction, not a bidder who bids high (spec §3.1, §5.1). The
 * distinction matters for the active-bidder count the open format displays.
 *
 * ⚠ ROUNDING HAPPENS HERE, BEFORE ANY COMPARISON (spec §5.1). The displayed bid and the
 * compared bid must be the same number — rounding at render time instead would let a
 * bot lose a tie it visibly drew.
 */
export function equilibriumBid(cost: number, s: EquilibriumSettings): number | null {
  const { rivalCostMax: tmax, reserve: r, totalBidders: n } = s

  if (!Number.isFinite(cost)) return null
  // Absent, not high-bidding. See the header.
  if (cost > r) return null
  if (n < 1) throw new Error(`[procurement] totalBidders must be >= 1; got ${n}`)

  const gap = tmax - cost

  // ⚠ THE DEGENERATE POINT, HANDLED EXPLICITLY. At cost = θmax both numerator and
  // denominator are zero — 0/0 — and the limit is the cost itself. Spec §7 step 2 leans
  // on this ("Bot bids never exceed the reserve: β(110) = 110"), so a NaN here would
  // silently delete the highest-cost bot from the auction instead of having it bid at
  // the reserve and lose.
  if (gap <= 0) return round(cost)

  const numerator = Math.pow(gap, n) - Math.pow(tmax - r, n)
  const denominator = n * Math.pow(gap, n - 1)
  const bid = cost + numerator / denominator

  return round(bid)
}

/**
 * Nearest whole ECU. Half-up, matching the spec's worked numbers (β(47) = 59.6 → 60).
 *
 * `Math.round` is half-up for positives, which is all this ever sees: β(c) ≥ c ≥ 0 for
 * every admissible cost.
 */
function round(n: number): number {
  return Math.round(n)
}

/**
 * The SIMPLE form, `c + (θmax − c)/n` — the lecture's formula and the deck's `Bid =
 * Cost + X(θmax − Cost)` with X = 1/n.
 *
 * ⚠ EXPORTED FOR THE CONFORMANCE ASSERTION ONLY, and it is not used in play. Its whole
 * job is to be the independent expectation that `equilibriumBid` is checked against at
 * the default reserve — an oracle written from the spec rather than derived from the
 * implementation. Using it in play would reintroduce exactly the bug the general form
 * exists to prevent, so nothing outside the tests may import it.
 */
export function simpleEquilibriumBid(cost: number, rivalCostMax: number, totalBidders: number): number {
  return Math.round(cost + (rivalCostMax - cost) / totalBidders)
}
