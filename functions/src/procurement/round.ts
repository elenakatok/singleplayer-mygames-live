import { makeRng } from './auction/rng'
import { drawCost, drawCosts } from './auction/costs'
import { equilibriumBid } from './auction/equilibrium'
import { resolve, type SubmittedBid } from './auction/resolve'
import { REVERSE } from './auction/direction'
import type { ProcurementConfig } from './config'

// ═══════════════════════════════════════════════════════════════════════════════
// Procurement Auction — ONE SEALED ROUND, end to end, as a PURE function.
//
// ⚠⚠ THE TWO DRAWS HAPPEN AT DIFFERENT MOMENTS AND MUST NOT BE MERGED (spec §4):
//
//   • `drawPlayerCost` runs at ROUND START. The bidding screen shows the student their
//     own cost before they bid, so it has to exist first.
//   • `resolveRound` draws the RIVAL costs, and it runs at RESOLUTION TIME, inside the
//     same transaction that accepts the bid.
//
// They use SEPARATE, INDEPENDENTLY KEYED streams for exactly this reason: a single
// stream would mean drawing the rivals' costs to reach the player's, which is precisely
// the "exists before the bid is committed" state §4 forbids. The harness asserts the
// ordering from the outside; nothing here can enforce it, and this comment is not the
// guarantee.
//
// ⚠ PURE. No Firestore, no `Date`, no `Math.random` except through an injected seed.
// This is what lets the conformance vector and the harness call it directly.
// ═══════════════════════════════════════════════════════════════════════════════

export const PLAYER_ID = 'player'
export const rivalId = (i: number) => `rival${i + 1}`

/** The equilibrium settings this instance's config implies. One derivation, so the bot
 *  bids, the counterfactual and the scatter's optimal line cannot drift apart. */
export function equilibriumSettingsFor(config: ProcurementConfig) {
  return {
    // ⚠ ALWAYS the RIVAL max — a bidder optimizes against the rivals' distribution, not
    // their own (spec §5.2). Passing playerCostDist.max here would be silently wrong for
    // every number on the scatter.
    rivalCostMax: config.rivalCostDist.max,
    reserve: config.reserve,
    totalBidders: config.rivalCount + 1,
  }
}

/**
 * The student's own cost for a round, drawn at ROUND START.
 *
 * ⚠ ONCE-ONLY BY CONSTRUCTION. A pure function of (seed, participantId, round), so a
 * re-read returns the same number without needing a stored flag — and a student who
 * reloads the bidding screen sees the cost they were already shown rather than a fresh,
 * friendlier one.
 */
export function drawPlayerCost(
  seed: string | null,
  participantId: string,
  round: number,
  config: ProcurementConfig,
): number {
  return drawCost(makeRng(seed, `${participantId}:playerCost:${round}`), config.playerCostDist)
}

export interface RoundResolution {
  playerCost: number
  playerBid: number
  rivalCosts: number[]
  /** null for a rival priced out by the reserve — ABSENT, not bidding high (§3.1). */
  rivalBids: (number | null)[]
  winnerId: string | null
  price: number | null
  playerWon: boolean
  playerProfit: number
  /** True when two or more bids tied at the lowest price. */
  tie: boolean
  /** True when the player was IN that tie but did not win it — the only case where the
   *  round result must explain itself (Elena, 08-03). */
  tiedAndLost: boolean
  /** What the player's equilibrium bid would have been at this cost, and how it would
   *  have fared against the SAME realized rival bids (§8 counterfactual). */
  equilibriumBid: number | null
  equilibriumWouldHaveWon: boolean
  /** Profit under the equilibrium bid against these same rivals — feeds "a perfect
   *  player would have earned X from your draws" (§9). */
  equilibriumProfit: number
}

/**
 * Resolve one sealed round.
 *
 * ⚠ THE RIVAL COSTS ARE DRAWN HERE, and this function must only ever be called after the
 * bid is in hand. Everything §4 requires about ordering is a property of the CALL SITE,
 * not of this function.
 */
export function resolveRound(
  seed: string | null,
  participantId: string,
  round: number,
  config: ProcurementConfig,
  playerCost: number,
  playerBid: number,
): RoundResolution {
  const eq = equilibriumSettingsFor(config)

  const rivalRng = makeRng(seed, `${participantId}:rivals:${round}`)
  const rivalCosts = drawCosts(rivalRng, config.rivalCostDist, config.rivalCount)
  const rivalBids = rivalCosts.map(c => equilibriumBid(c, eq))

  // ⚠ A rival with no bid is ABSENT from the auction, not a bidder at a high number, so
  // it never enters the bid list at all (§7 step 1).
  const bidsFrom = (playersBid: number): SubmittedBid[] => [
    { bidderId: PLAYER_ID, amount: playersBid, cost: playerCost },
    ...rivalBids.flatMap((amount, i) =>
      amount === null ? [] : [{ bidderId: rivalId(i), amount, cost: rivalCosts[i] }]),
  ]

  // ⚠ THE TIE STREAM IS ITS OWN, keyed separately from the costs. Sharing the cost
  // stream would make the tie draw depend on how many rivals were priced out, which is
  // the kind of coupling the positional-draw convention exists to prevent (rng.ts).
  const tieRng = makeRng(seed, `${participantId}:tie:${round}`)

  const actual = resolve(bidsFrom(playerBid), {
    reserve: config.reserve,
    direction: REVERSE,
    rng: tieRng,
    // ⚠ The player is NOMINATED, not identified. See resolve.ts — this is how
    // "player wins ties" is expressed without the resolver knowing what a player is.
    tieBreakPreference: PLAYER_ID,
  })

  const playerOutcome = actual.perBidderOutcomes.find(o => o.bidderId === PLAYER_ID)!
  const playerWon = playerOutcome.won

  // ── the counterfactual (§8) ────────────────────────────────────────────────
  // The SAME rival bids, the player's equilibrium bid instead of theirs. A fresh tie
  // stream, because this is a hypothetical and must not disturb the real one.
  const eqBid = equilibriumBid(playerCost, eq)
  let equilibriumWouldHaveWon = false
  let equilibriumProfit = 0
  if (eqBid !== null) {
    const hypo = resolve(bidsFrom(eqBid), {
      reserve: config.reserve,
      direction: REVERSE,
      rng: makeRng(seed, `${participantId}:counterfactual:${round}`),
      tieBreakPreference: PLAYER_ID,
    })
    const o = hypo.perBidderOutcomes.find(b => b.bidderId === PLAYER_ID)!
    equilibriumWouldHaveWon = o.won
    equilibriumProfit = o.profit
  }

  return {
    playerCost,
    playerBid,
    rivalCosts,
    rivalBids,
    winnerId: actual.winnerId,
    price: actual.price,
    playerWon,
    playerProfit: playerOutcome.profit,
    tie: actual.tie,
    // ⚠ Only true when the player MATCHED the winning price and still lost. Under the
    // nominated-preference rule that cannot happen in a player-vs-bot tie — the player
    // always takes those — so this fires only when the player tied a price that a
    // bot-vs-bot tie had already… in fact it cannot fire at all today. Kept because the
    // ALL-HUMAN path omits the nomination, where it fires normally, and because a screen
    // that showed two identical lowest bids with the other marked winner would read as a
    // bug (Elena, 08-03).
    tiedAndLost: actual.tie && !playerWon && playerOutcome.bid === actual.price,
    equilibriumBid: eqBid,
    equilibriumWouldHaveWon,
    equilibriumProfit,
  }
}

/** Is this bid acceptable at submit? ⚠ A VISIBLE GATE, NOT A SILENT FILTER (§6.2). */
export function validateBid(
  raw: unknown,
  config: ProcurementConfig,
  playerCost: number | null = null,
): { ok: true; bid: number } | { ok: false; reason: string } {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return { ok: false, reason: 'Enter a whole number of ECU.' }
  }
  if (!Number.isInteger(raw)) {
    return { ok: false, reason: 'Bids are whole ECU only — no decimals.' }
  }
  if (raw < 0) {
    return { ok: false, reason: 'A bid cannot be negative.' }
  }
  if (raw > config.reserve) {
    // The spec's own wording (§6.2).
    return {
      ok: false,
      reason: `Bids above the reserve price of ${config.reserve} will not be accepted.`,
    }
  }
  // ⚠⚠ BELOW YOUR OWN COST IS REFUSED (Elena, 2026-08-04) — and this SUPERSEDES Part 1
  // §6.2's "Bid < own cost | **Allowed.** Losing money is a legitimate mistake and part of
  // the lesson", which is being corrected in the spec.
  //
  // The reason is uniformity, not protection: open §4.3 already forbids a BOT from bidding
  // below its own cost, so the player was the only bidder in the auction permitted to do
  // something none of the others could. It is now ONE mechanism rule.
  //
  // ⚠ THE COST IS OPTIONAL HERE ON PURPOSE. `submitBid` runs the cheap shape and reserve
  // checks BEFORE its transaction, where the recorded cost is not yet in hand, and calls
  // again with the cost inside — the check that needs a read stays with the read. Passing
  // `null` therefore means "not yet known", never "no limit".
  if (playerCost !== null && raw < playerCost) {
    return {
      ok: false,
      reason: `Your cost is ${playerCost}. A bid of ${raw} would be below it, and no `
        + 'bidder in this auction may bid below their own cost.',
    }
  }
  return { ok: true, bid: raw }
}
