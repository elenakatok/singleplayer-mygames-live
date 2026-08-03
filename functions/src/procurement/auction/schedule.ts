// ═══════════════════════════════════════════════════════════════════════════════
// Procurement Auction (open format) — THE DECREMENT SCHEDULE. Pure.
//
// ⚠⚠ `step(currentPrice)` IS A SCHEDULE EVALUATED AGAINST THE PRICE, NOT A SCALAR
// (spec §13.1, open §3). This shape is frozen at spec time because it is expensive to
// change later: the eventual auction-engine extraction needs ONE direction-neutral step
// concept rather than an `increment` and a `decrement` — the SAA lesson. A game that
// stored a single number would have to be migrated to reach it.
//
// ⚠ IT IS A FLOOR ON HOW FAR YOU MUST MOVE, NOT A FIXED INCREMENT (open §4.2). A player
// who knows their cost is 34 and sees a standing bid of 48 may bid 36 directly rather
// than walking 46 → 44 → 42 → 40 → 38. Jump bidding is legal, useful, and worth
// surfacing in the debrief. The BOTS never jump (open §4.3, the SAA precedent: bots bid
// the minimum legal amount; whether jumping pays is a question for the humans, and the
// bots do not try to answer it).
//
// ⚠ THE BAND TEST IS STRICT `>`, AND THE VECTOR PINS IT. Open §8.1 step 4: at a
// standing bid of 80 the step in force is 5, not 10 — so `above: 80` does NOT include
// 80 itself. An inclusive test would make the trace 80 → 70 and every later row wrong.
// This is the single most load-bearing comparison in the file.
// ═══════════════════════════════════════════════════════════════════════════════

/** One band: while the price is strictly above `above`, the minimum move is `step`. */
export interface DecrementBand {
  above: number
  step: number
}

/**
 * The minimum legal move at the current price.
 *
 * Bands are searched in the order given; callers normalize to descending `above` when
 * reading from config (`parseDecrementSchedule`), because order IS the semantics here.
 * A price below every band's threshold falls through to the last band's step — with the
 * shipped schedule the last band is `above: 0`, so that is only reachable at a price of
 * zero or less, which the reserve makes unreachable in play.
 */
export function stepAt(price: number, schedule: readonly DecrementBand[]): number {
  if (schedule.length === 0) throw new Error('[procurement] empty decrement schedule')
  for (const band of schedule) {
    if (price > band.above) return band.step
  }
  return schedule[schedule.length - 1].step
}

/**
 * The highest bid that is legal against the current standing bid — `standing − step`.
 *
 * ⚠ THE CEILING, NOT THE REQUIRED BID. A legal bid is anything AT OR BELOW this
 * (open §4.2). Naming it `maxLegalBid` rather than `nextBid` is deliberate: the bots
 * happen to bid exactly this, and a name that implied "the next bid" would invite a
 * screen to present it to the player as the move to make, which would quietly train
 * jump bidding out of the game.
 */
export function maxLegalBid(standing: number, schedule: readonly DecrementBand[]): number {
  return standing - stepAt(standing, schedule)
}

/** Is `amount` a legal bid against `standing`? Whole ECU, and at or under the ceiling. */
export function isLegalBid(
  amount: number,
  standing: number,
  schedule: readonly DecrementBand[],
): boolean {
  if (!Number.isInteger(amount)) return false
  return amount <= maxLegalBid(standing, schedule)
}
