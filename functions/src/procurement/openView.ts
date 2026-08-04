import { maxLegalBid, stepAt } from './auction/schedule'
import {
  totalBidderCount, lastPlayerBid,
  type OpenSettings, type OpenState,
} from './auction/openAuction'
import { PLAYER_ID } from './round'

// ═══════════════════════════════════════════════════════════════════════════════
// OPEN FORMAT — WHAT A STUDENT MAY SEE OF THE LIVE AUCTION, as a whitelist.
//
// ⚠⚠ BUILT FIELD BY FIELD FROM NAMED LOCALS. It NEVER spreads `OpenState`, because that
// record carries something a student must not have. It is not a cost — there is no cost
// in `OpenState` at all — it is `stopped`: A LIST OF BOT IDS DERIVED FROM THEIR COSTS.
// "bot3 stopped at a standing of 48" says its cost is above 46. Ship the array and a
// student reading the network tab learns each rival's cost to within one step of the
// schedule, every step, which is the entire game.
//
// ⚠⚠ AND NEITHER DOES A COUNT OF IT CROSS (Elena, 2026-08-04). An earlier build sent
// `activeBidders` — "3 of 5 still bidding" — because open §4.3 and §5.1 asked for it. It
// is gone, the derivation is DELETED rather than unexported, and the spec is being updated
// to match:
//
//   **A competitor's departure is not announced in a live auction.** The player infers it
//   from silence, and silence is ambiguous between "priced out" and "still thinking". An
//   explicit count destroys that ambiguity — and it was the last client-side field derived
//   from bot cost state.
//
// ⚠ THE OPENING TOTAL STAYS. "There are 5 bidders in this auction" is a PARAMETER, stated
// up front in the deck, and the player needs `n` to reason at all. It never moves, so
// nothing about who is still in can be read off it.
//
// ⚠ THE BID HISTORY STAYS PUBLIC IN FULL, labels and all — and it is consistent with the
// above because of one invariant, stated and pinned on `OpenEvent`: **a bot never emits
// anything but a bid.** There is no "stopped" event and no bot drop-out event, and no
// code path that could produce one. Every row is an action somebody publicly took. A bid
// is an announcement; a departure is silence.
//
// ⚠ BIDDER LABELS AND AMOUNTS ONLY, IN THE HISTORY. Open §5.1: "Bidder labels are shown
// (`bot 3`) … Costs are never shown."
//
// ⚠ THE LABELS SAY "Bot", NOT "Rival" — open §5.1's own wording, and different from the
// sealed round-result table's "Rival 1". The two formats' screens are separate and each
// follows its own spec; the IDS underneath are `rival1..rivalN` in both, so `winner_id`
// and the reports do not fork.
// ═══════════════════════════════════════════════════════════════════════════════

/** `player` → "You"; `rival3` → "Bot 3"; anything else → itself (never reached). */
export function bidderLabel(bidderId: string): string {
  if (bidderId === PLAYER_ID) return 'You'
  const m = /^rival(\d+)$/.exec(bidderId)
  return m ? `Bot ${m[1]}` : bidderId
}

export interface ClientAuctionEvent {
  kind: 'bid' | 'dropOut'
  label: string
  /** Null on a drop-out. ⚠ There is no cost field here and there must never be one. */
  amount: number | null
  isYou: boolean
}

export interface ClientAuction {
  round: number
  /**
   * `bot_turn` — a bot is due; the client waits until `nextBotAtMs` and calls advance().
   * `waiting`  — the cascade has halted; Bid and Drop Out are live, with no timeout.
   * `resolved` — over.
   */
  status: OpenState['status']
  /** The current standing bid — ⚠ THE COMMITTED ONE. There is no other (§4.6). */
  standing: number
  /** Who holds it, as a label. Null = the incumbent's price stands and nobody has bid. */
  holderLabel: string | null
  youHold: boolean
  yourLastBid: number | null
  youAreOut: boolean
  /** ⚠ Declared back on submitBid so a collision can be DESCRIBED. It is never a reason
   *  to reject on its own (§4.6) — see `playerBid`. */
  sequence: number
  /** Epoch ms. Null unless `status` is 'bot_turn'. ⚠ ADVISORY: the client decides when to
   *  ask, the SERVER decides whether it was time. Lying about it gains nothing. */
  nextBotAtMs: number | null
  /** The step in force at the current standing — §5.1 states it, so the player never has
   *  to infer which band they are in. */
  step: number
  /** The highest legal next bid — §5.1's "Minimum next bid", and the bid box's pre-fill.
   *  Null once resolved. ⚠ A DEFAULT, NOT A CONSTRAINT: jump bidding stays fully available
   *  (§4.2) and the box is freely editable. */
  minNextBid: number | null
  history: ClientAuctionEvent[]
  /**
   * The total number of bidders — ⚠ THE OPENING PARAMETER, AND IT NEVER MOVES.
   *
   * ⚠⚠ THERE IS NO `activeBidders` AND THERE MUST NOT BE ONE. See the file header: a
   * competitor's departure is not announced in a live auction, and a running count was
   * the last client-side field derived from bot cost state. If you are about to add "how
   * many are left", you are re-adding it.
   */
  totalBidders: number
  winnerLabel: string | null
  youWon: boolean
  price: number | null
}

/** The live auction, as the student receives it. ⚠ THE WHITELIST — see the file header. */
export function toClientAuction(
  round: number,
  state: OpenState,
  s: OpenSettings,
): ClientAuction {
  const resolved = state.status === 'resolved'
  return {
    round,
    status: state.status,
    standing: state.standing,
    holderLabel: state.holder === null ? null : bidderLabel(state.holder),
    youHold: state.holder === PLAYER_ID,
    yourLastBid: lastPlayerBid(state, s),
    youAreOut: state.playerOut,
    sequence: state.sequence,
    nextBotAtMs: state.nextBotAtMs,
    step: stepAt(state.standing, s.schedule),
    minNextBid: resolved ? null : maxLegalBid(state.standing, s.schedule),
    history: state.history.map(e => e.kind === 'dropOut'
      ? {
        kind: 'dropOut' as const,
        label: bidderLabel(e.bidderId),
        amount: null,
        // ⚠ DERIVED, not hardcoded `true`. Only the player can drop out (see `OpenEvent`),
        // so this is always true today — writing it as a derivation means the day that
        // stops being so, this row does not silently claim a bot's exit was the player's.
        isYou: e.bidderId === PLAYER_ID,
      }
      : {
        kind: 'bid' as const,
        label: bidderLabel(e.bidderId),
        amount: e.amount,
        isYou: e.isPlayer,
      }),
    totalBidders: totalBidderCount(s),
    winnerLabel: state.winnerId === null ? null : bidderLabel(state.winnerId),
    youWon: state.winnerId === PLAYER_ID,
    price: state.price,
  }
}
