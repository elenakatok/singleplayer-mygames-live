// ═══════════════════════════════════════════════════════════════════════════════
// Procurement Auction (open format) — THE BAND SCHEDULES. Pure.
//
// ⚠⚠ `step(currentPrice)` AND `delay(currentPrice)` ARE SCHEDULES EVALUATED AGAINST THE
// PRICE, NOT SCALARS (spec §13.1, open §3). This shape is frozen at spec time because it
// is expensive to change later: the eventual auction-engine extraction needs ONE
// direction-neutral step concept rather than an `increment` and a `decrement` — the SAA
// lesson. A game that stored a single number would have to be migrated to reach it.
//
// ⚠⚠ ONE BAND-LOOKUP HELPER SERVES BOTH (open §3: "should share the band-lookup helper
// rather than reimplementing it"). `bandAt` is that helper; `stepAt` and `delayAt` are
// one line each on top of it. Two lookups would be two chances to disagree about whether
// the band test is inclusive — and the §8 vector turns on exactly that character.
//
// ⚠ THE STEP IS A FLOOR ON HOW FAR YOU MUST MOVE, NOT A FIXED INCREMENT (open §4.2). A
// player who knows their cost is 34 and sees a standing bid of 48 may bid 36 directly
// rather than walking 46 → 44 → 42 → 40 → 38. Jump bidding is legal, useful, and worth
// surfacing in the debrief. The BOTS never jump (open §4.3, the SAA precedent: bots bid
// the minimum legal amount; whether jumping pays is a question for the humans, and the
// bots do not try to answer it).
//
// ⚠ THE BAND TEST IS STRICT `>`, AND THE VECTOR PINS IT. Open §8.1 step 4: at a
// standing bid of 80 the step in force is 5, not 10 — so `above: 80` does NOT include
// 80 itself. An inclusive test would make the trace 80 → 70 and every later row wrong.
// This is the single most load-bearing comparison in the file, and because `delayAt`
// shares the lookup it is also the reason the PACING changes band at exactly the price
// the STEP does — which is what makes open §2's phase arithmetic come out.
// ═══════════════════════════════════════════════════════════════════════════════

/** One band of a schedule. While the price is strictly above `above`, this band is in
 *  force. Both concrete band types below extend it, and `bandAt` reads only this field. */
export interface Band {
  above: number
}

/** One band of the DECREMENT schedule: the minimum legal move at prices in this band. */
export interface DecrementBand extends Band {
  step: number
}

/** One band of the DELAY schedule: how long a bot waits before acting, at prices in this
 *  band (open §3). Fast in the coarse bands, slow in the fine ones, so pacing follows
 *  tension automatically without any special-casing of "phase 1" and "phase 2". */
export interface DelayBand extends Band {
  delayMs: number
}

/**
 * ⚠⚠ THE ONE BAND LOOKUP. Everything schedule-shaped in this game goes through here.
 *
 * Bands are searched in the order given; callers normalize to descending `above` when
 * reading from config (`parseDecrementSchedule` / `parseDelaySchedule`), because order IS
 * the semantics here. A price below every band's threshold falls through to the LAST
 * band — with the shipped schedules the last band is `above: 0`, so that is only
 * reachable at a price of zero or less, which the reserve makes unreachable in play.
 */
export function bandAt<T extends Band>(price: number, bands: readonly T[]): T {
  if (bands.length === 0) throw new Error('[procurement] empty band schedule')
  for (const band of bands) {
    if (price > band.above) return band
  }
  return bands[bands.length - 1]
}

/** The minimum legal move at the current price. */
export function stepAt(price: number, schedule: readonly DecrementBand[]): number {
  return bandAt(price, schedule).step
}

/**
 * How long a bot waits before acting at the current price (open §3).
 *
 * ⚠ THIS IS PACING, AND IT MUST NEVER REACH A BOT'S DECISION. A bot bids on cost and the
 * standing price alone (open §4.3); how long it waited is a UX property of the same
 * schedule shape and nothing more. Open §3 applies it to a bot's answer to a PLAYER bid
 * as well as to bot-vs-bot steps — an instant reply reads as a machine.
 */
export function delayAt(price: number, schedule: readonly DelayBand[]): number {
  return bandAt(price, schedule).delayMs
}

/**
 * The highest bid that is legal against the current standing bid — `standing − step`.
 *
 * ⚠ THE CEILING, NOT THE REQUIRED BID. A legal bid is anything AT OR BELOW this
 * (open §4.2). Naming it `maxLegalBid` rather than `nextBid` is deliberate: the bots
 * happen to bid exactly this, and a name that implied "the next bid" would invite a
 * screen to present it to the player as the move to make, which would quietly train
 * jump bidding out of the game. (§5.1's "Minimum next bid" label is the SCREEN's wording
 * for the same number, read from the player's side: the least far they must move.)
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
