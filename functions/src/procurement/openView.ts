import { maxLegalBid, stepAt } from './auction/schedule'
import {
  activeBidderCount, totalBidderCount, lastPlayerBid,
  type OpenSettings, type OpenState,
} from './auction/openAuction'
import { PLAYER_ID } from './round'

// ═══════════════════════════════════════════════════════════════════════════════
// OPEN FORMAT — WHAT A STUDENT MAY SEE OF THE LIVE AUCTION, as a whitelist.
//
// ⚠⚠ BUILT FIELD BY FIELD FROM NAMED LOCALS. It NEVER spreads `OpenState`, because that
// record carries two things a student must not have:
//
//   • nothing directly — no cost is in `OpenState` at all — but
//   • `stopped` IS a list of bot ids derived from their costs. "bot3 stopped at a
//     standing of 48" says its cost is above 46. Ship the array and a student reading the
//     network tab learns each rival's cost to within one step, every step, which is the
//     entire game.
//
// So `stopped` never crosses this boundary. What does is a COUNT — open §4.3 and §5.1
// require the active-bidder count to be visible, and require it to exclude bots the
// reserve priced out FROM THE OPENING. A scalar says "how many can still act"; it does
// not say WHICH, and it cannot be differenced back into a cost because a student sees
// only their own auction and only forward in time.
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
  /** ⚠ A COUNT, NEVER A LIST (see the header). Excludes bots priced out by the reserve
   *  from the opening (§4.3). */
  activeBidders: number
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
      ? { kind: 'dropOut' as const, label: bidderLabel(e.bidderId), amount: null, isYou: true }
      : {
        kind: 'bid' as const,
        label: bidderLabel(e.bidderId),
        amount: e.amount,
        isYou: e.isPlayer,
      }),
    activeBidders: activeBidderCount(state, s),
    totalBidders: totalBidderCount(s),
    winnerLabel: state.winnerId === null ? null : bidderLabel(state.winnerId),
    youWon: state.winnerId === PLAYER_ID,
    price: state.price,
  }
}
