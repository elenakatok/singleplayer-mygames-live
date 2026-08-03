import type { AuctionDirection } from './direction'
import { pick, type Rng } from './rng'

// ═══════════════════════════════════════════════════════════════════════════════
// Procurement Auction — THE RESOLVER (spec §7).
//
//   resolve(bids, settings) → { winnerId, price, perBidderOutcomes }
//
// ⚠⚠ BOTS ARE STRICTLY OUTSIDE THIS FILE, AND THAT IS NOT NEGOTIABLE (spec §5.3, §13.2).
// Bots are BID PRODUCERS. The resolver receives a list of bids and NEVER LEARNS WHICH
// CAME FROM A BOT — there is no `isBot` field on `SubmittedBid`, no player id in
// `ResolveSettings`, and no branch anywhere below that could treat one bidder
// differently from another. This is what makes the future all-human version a swap
// rather than a rewrite.
//
// It is also what makes the tie rule honest. See the tie note below: the spec's rule is
// uniform precisely BECAUSE the resolver cannot tell the player from a bot, so a
// "player wins ties" rule would have to be implemented somewhere that can — which is
// exactly the coupling this arrangement forbids.
//
// ⚠ PURE. No Firestore, no game imports, no Date, no Math.random. Randomness arrives as
// an injected `Rng`; direction arrives as an injected comparator. This is what lets the
// conformance vector run it directly, and lets a local Playwright script import it
// inward alongside deployed code.
//
// ⚠ THE SIGNATURE IS FROZEN (spec §13.4): `(bids, settings) → { winnerId, price,
// perBidderOutcomes }`, format-neutral, and already what the eBay spec listed under
// GENERAL. Do not add a field to the return type without checking §13.
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * One bid, as handed to the resolver.
 *
 * ⚠ `cost` TRAVELS WITH THE BID, and that is what keeps bidders indistinguishable. The
 * resolver needs a cost to compute the winner's payoff; taking "the player's cost" as a
 * separate setting would mean the resolver knew which bidder was the player. Instead
 * every bidder carries their own, and the resolver computes the payoff for whichever one
 * wins without ever asking what kind of bidder it was.
 */
export interface SubmittedBid {
  bidderId: string
  amount: number
  cost: number
}

export interface ResolveSettings {
  reserve: number
  direction: AuctionDirection
  /** Seeded — the SAME stream as the cost draws, so seeded runs stay reproducible. */
  rng: Rng
  /**
   * A bidder id that WINS ANY TIE IT IS PART OF. Omit for an all-random tie break.
   *
   * ⚠⚠ THIS IS HOW "THE PLAYER WINS TIES" IS EXPRESSED WITHOUT THE RESOLVER KNOWING WHAT
   * A PLAYER IS (Elena, 08-02; §7 step 4 as amended). The callable sets it to the
   * player's id, so player-vs-bot ties go to the player and bot-vs-bot ties stay seeded
   * random — the decided behaviour — while §5.3 and §13.2 hold exactly as before: there
   * is no `isBot` field, no player flag, and no bidder-index convention. The resolver
   * knows only that ONE ID HAS BEEN NOMINATED. It cannot tell whether that id belongs to
   * a human, and nothing here would behave differently if it did not.
   *
   * It also maps to a real procurement convention — incumbent preference on equal bids —
   * and stays coherent in the all-human auction, where it is simply OMITTED and every tie
   * is random. That path is exercised by its own test, deliberately: it is the one this
   * design exists to keep alive, and it is the one nothing else would notice rotting.
   */
  tieBreakPreference?: string
}

export interface BidderOutcome {
  bidderId: string
  /** The bid as submitted. `null` for a bidder who made no bid at all. */
  bid: number | null
  /** Was this bid discarded for failing the reserve (spec §7 step 2)? */
  admissible: boolean
  won: boolean
  /** Zero for every loser, always. Never negative for a loser (spec §7 step 5). */
  profit: number
}

export interface ResolveResult {
  /** null when no bid was admissible — no award, everyone earns 0 (spec §7 step 6). */
  winnerId: string | null
  /** The winning bid — the winner is paid their OWN bid (first price). */
  price: number | null
  perBidderOutcomes: BidderOutcome[]
  /** True when the winner was chosen from two or more equal best bids. Reported so the
   *  round result can say so rather than leaving a student to wonder why they lost at
   *  the same number that won. */
  tie: boolean
}

/**
 * Resolve one auction.
 *
 * ⚠ THE TIE RULE (spec §7 step 4, as amended by Elena 08-02 — this supersedes the v3
 * document text, which was never edited to match the decision):
 *
 *   • A tie that includes `tieBreakPreference` goes to THAT BIDDER, always.
 *   • Every other tie is broken by the injected seeded stream.
 *
 * In play the callable nominates the player, so player-vs-bot ties go to the player and
 * bot-vs-bot ties stay random. The resolver still cannot distinguish a bot from a human
 * — see `tieBreakPreference` for why that matters and how it is preserved.
 *
 * Frequency, for context: with integer bids a tie at the minimum occurs in roughly 3% of
 * rounds — about one student in four sees one across 8 rounds. Immaterial to outcomes,
 * frequent enough that the branch must be defined rather than left to whatever `sort`
 * happens to do.
 */
export function resolve(bids: readonly SubmittedBid[], s: ResolveSettings): ResolveResult {
  const { reserve, direction, rng } = s

  // Step 2 — discard bids the reserve does not admit. A bidder who made no bid at all
  // is already absent from `bids`; this is only about bids that were MADE and refused.
  const admissible = bids.filter(b => direction.admissible(b.amount, reserve))

  if (admissible.length === 0) {
    // Step 6 — no award. Impossible under defaults; reachable when an instructor
    // configures the reserve below the cost range.
    return {
      winnerId: null,
      price: null,
      tie: false,
      perBidderOutcomes: bids.map(b => ({
        bidderId: b.bidderId,
        bid: b.amount,
        admissible: false,
        won: false,
        profit: 0,
      })),
    }
  }

  // Step 3 — the best admissible bid wins. `better` is injected, so nothing about
  // "lowest" is written into this loop.
  let best = admissible[0].amount
  for (const b of admissible) {
    if (direction.better(b.amount, best)) best = b.amount
  }

  const atBest = admissible.filter(b => b.amount === best)

  // Step 4 — the tie break.
  //
  // ⚠ THE DRAW IS CONSUMED UNCONDITIONALLY, BEFORE the preference is applied, and that
  // ordering is deliberate. `pick` advances the stream exactly once per resolve whether
  // or not there was a tie and whether or not the preference decided it — so the stream
  // position after a round never depends on the tie's composition. Consume it lazily and
  // two seeded runs that differed only in whether the player happened to tie would
  // diverge in every later draw, for a reason nothing in the spec mentions.
  const drawn = pick(rng, atBest)
  const preferred = s.tieBreakPreference === undefined
    ? undefined
    : atBest.find(b => b.bidderId === s.tieBreakPreference)
  const winner = preferred ?? drawn
  const tie = atBest.length > 1

  const admissibleIds = new Set(admissible.map(b => b.bidderId))

  return {
    winnerId: winner.bidderId,
    price: winner.amount,
    tie,
    perBidderOutcomes: bids.map(b => {
      const won = b.bidderId === winner.bidderId
      return {
        bidderId: b.bidderId,
        bid: b.amount,
        admissible: admissibleIds.has(b.bidderId),
        won,
        // Step 5 — the winner is paid their own bid; every loser earns exactly zero.
        // A losing supplier incurs no cost, so a loser's profit is never the negative
        // number a below-cost bid would imply.
        profit: won ? direction.payoff(winner.amount, b.cost) : 0,
      }
    }),
  }
}
