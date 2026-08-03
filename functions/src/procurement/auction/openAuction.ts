import { maxLegalBid, stepAt, type DecrementBand } from './schedule'
import { pick, type Rng } from './rng'

// ═══════════════════════════════════════════════════════════════════════════════
// Procurement Auction (OPEN DESCENDING) — the bidding state machine. Pure: no
// Firestore, no game imports, no Date, no Math.random.
//
// ⚠⚠ THIS IS THE ONE PLACE THIS GAME DIVERGES FROM EVERY OTHER SINGLE-PLAYER GAME.
// The other four (pd, pricing, newsvendor, forecast) are one-submit-per-round: submit →
// compute → reveal, atomic. This format is an UNBOUNDED EXCHANGE — the standing bid is
// public, anyone may undercut, and a round may contain one player action or twenty, with
// the count unknown in advance. `Singleplayer_Loop_Audit_Findings.md` §B.3 found exactly
// this shape inexpressible as stage-engine stages, which is why the loop is bespoke and
// why the exchange is handled BELOW the round loop: only the RESOLVED round is appended
// to `rounds[]`.
//
// ⚠ SERVER-AUTHORITATIVE. The client never decides who is winning. Every transition is a
// pure function here; the callable persists the result and streams the events with
// `botDelayMs` spacing (a UX concern that must NEVER reach a bot's decision — open §3).
//
// ⚠ NO CLOCK, AND A ROUND MAY WAIT FOREVER (open §4.4). That is correct rather than a
// compromise: this is a single-player game, so a player who sits idle blocks nobody. The
// state machine's `waiting` status is a legitimate resting place, not a stall.
//
// ⚠ PRICE TIES ARE IMPOSSIBLE HERE (open §4.3). An equal bid is illegal — every bid must
// undercut by at least the step — so the sealed format's tie rules do not apply and the
// only collision that exists is RESPONSE ORDERING among willing bots, which is
// seeded-random.
// ═══════════════════════════════════════════════════════════════════════════════

export interface OpenBot {
  bidderId: string
  cost: number
}

export interface OpenSettings {
  reserve: number
  schedule: readonly DecrementBand[]
  playerId: string
  playerCost: number
  bots: readonly OpenBot[]
  /** Seeded — the same stream as the cost draws, so a seeded run reproduces exactly. */
  rng: Rng
  /**
   * ⚠ TEST HOOK, AND ONLY THAT. Open §8 forces bot response order to
   * lowest-index-willing "for the test only"; in play it is seeded-random. Defaults to
   * random, so forgetting to set it cannot silently make play deterministic.
   */
  order?: 'random' | 'lowestIndex'
}

export type OpenEvent =
  | { kind: 'bid'; bidderId: string; amount: number; isPlayer: boolean }
  | { kind: 'dropOut'; bidderId: string }

export type OpenStatus =
  /** Waiting for the player. The cascade has halted; Bid and Drop Out are live. */
  | 'waiting'
  /** The round is over. `winnerId` and `price` are final. */
  | 'resolved'

export interface OpenState {
  status: OpenStatus
  /** The current standing bid. Opens AT THE RESERVE, which stands unowned (open §4.1). */
  standing: number
  /** Who holds it. `null` means the incumbent's price stands and nobody has bid. */
  holder: string | null
  /** Bots that have permanently declined. Declining is FINAL — the price only falls, so
   *  a bot that cannot act now can never act later (open §4.3). */
  stopped: string[]
  playerOut: boolean
  /** Every bid and drop-out, in order — the replayable round history (open §5.2). */
  history: OpenEvent[]
  winnerId: string | null
  price: number | null
}

/**
 * Can this bot make a legal, profitable bid at the current standing price?
 *
 * ⚠ THE COMPARISON IS `>=`, NOT `>` — decided 2026-08-02, open §4.3. A bot's lowest
 * possible bid EQUALS its cost: it will bid at cost for zero profit and never below.
 * This is "stay in while the price is above your cost, then stop" read inclusively, and
 * it matches what students are told the dominant strategy is (KC O4). Strict `>` would
 * make bots stop one step early and quietly hand the player extra wins. Open §8.3 case 2
 * is the case most likely to be got wrong, and it turns on exactly this character.
 *
 * ⚠ THE HOLDER CLAUSE IS NOT PART OF MERIT, deliberately. A bot that currently holds the
 * standing bid may not undercut ITSELF — that is what makes the cascade terminate — but
 * it is not out of the auction: if someone undercuts it, it may answer. Folding the
 * holder test in here would mark the holder permanently stopped and end the duel a step
 * early.
 */
function hasMerit(bot: OpenBot, standing: number, s: OpenSettings): boolean {
  // Absent, not high-bidding: a supplier whose cost exceeds the incumbent's price has no
  // bid worth making and is not a bidder at all (open §4.3).
  if (bot.cost > s.reserve) return false
  return maxLegalBid(standing, s.schedule) >= bot.cost
}

/** Open the auction: the reserve stands, unowned, and the cascade runs to quiescence. */
export function openAuction(s: OpenSettings): OpenState {
  const state: OpenState = {
    status: 'waiting',
    standing: s.reserve,
    holder: null,
    // ⚠ BOTS PRICED OUT BY THE RESERVE ARE STOPPED FROM THE OPENING (open §4.3). This is
    // what makes the active-bidder count honest: otherwise the player is told five
    // suppliers are bidding when only three can.
    stopped: s.bots.filter(b => b.cost > s.reserve).map(b => b.bidderId),
    playerOut: false,
    history: [],
    winnerId: null,
    price: null,
  }
  return settle(state, s)
}

/**
 * Drive the bot cascade until no bot will undercut, then apply the termination rule.
 *
 * ⚠ THE CASCADE HALTS ON ITS OWN, BEFORE THE PLAYER ACTS, AND THAT IS NOT A STALL
 * (open §2). In the reference trace the bots walk the price from 110 down to 48 in ten
 * steps and stop there, because the bot then holding the low bid is the lowest-cost bot
 * and no other bot can beat it. Nobody ever undercuts themselves.
 */
function settle(state: OpenState, s: OpenSettings): OpenState {
  let cur = state
  // A bound, not a policy: every step strictly lowers the standing bid by at least 1 and
  // the price is bounded below by the lowest cost, so this cannot spin. It exists so a
  // future schedule with a zero step raises loudly instead of hanging a request.
  let guard = 0

  for (;;) {
    if (++guard > 10_000) {
      throw new Error('[procurement] open cascade did not terminate — is a step size 0?')
    }

    // Mark every bot whose merit has just failed. Permanent: the price only falls.
    const stopped = new Set(cur.stopped)
    for (const bot of s.bots) {
      if (!stopped.has(bot.bidderId) && !hasMerit(bot, cur.standing, s)) {
        stopped.add(bot.bidderId)
      }
    }
    cur = { ...cur, stopped: [...stopped] }

    // Willing = has merit, and does not already hold the bid.
    const willing = s.bots.filter(b => !stopped.has(b.bidderId) && cur.holder !== b.bidderId)
    if (willing.length === 0) return terminate(cur, s)

    // ⚠ RESPONSE ORDER IS SEEDED-RANDOM (open §4.3). Fixed ordering would make the same
    // bot always jump first, which reads as mechanical. `lowestIndex` exists only so the
    // conformance vector can pin a trace.
    const chosen = s.order === 'lowestIndex' ? willing[0] : pick(s.rng, willing)

    // ⚠ THE MINIMUM LEGAL MOVE, NEVER A JUMP (open §4.3, the SAA precedent). Whether
    // jumping pays is a question for the humans; the bots do not try to answer it.
    const amount = maxLegalBid(cur.standing, s.schedule)

    cur = {
      ...cur,
      standing: amount,
      holder: chosen.bidderId,
      history: [...cur.history, { kind: 'bid', bidderId: chosen.bidderId, amount, isPlayer: false }],
    }
  }
}

/**
 * The cascade has halted. Is the round over, or is it waiting for the player?
 *
 * | Situation | Outcome | (open §4.4) |
 * |---|---|---|
 * | player holds | player wins, paid their own final bid |
 * | a bot holds, player still in | **waits — indefinitely, no timeout** |
 * | a bot holds, player out | that bot wins at the standing bid |
 * | nobody ever bid, player out | no award, everyone earns 0 |
 */
function terminate(state: OpenState, s: OpenSettings): OpenState {
  if (state.holder === s.playerId) {
    return { ...state, status: 'resolved', winnerId: s.playerId, price: state.standing }
  }
  if (!state.playerOut) {
    // The resting place. Bid and Drop Out remain live; nothing times out.
    return { ...state, status: 'waiting' }
  }
  // Player is out. Whoever holds the bid takes it — or nobody, if nobody ever bid.
  //
  // ⚠ AN EDGE THE SPEC DOES NOT STATE, IMPLEMENTED CONSERVATIVELY AND FLAGGED. If the
  // player somehow held the standing bid and then dropped out with no bot able to
  // undercut, this awards NOTHING rather than awarding to a player who has left. That
  // state is unreachable through the public API — a player action always settles, and a
  // settle in which the player holds and no bot is willing resolves as a player win
  // before any further action is possible — so this is a defensive branch, not a rule.
  // Raise it with Elena rather than treating this line as the decision.
  const holderIsGone = state.holder === null || state.holder === s.playerId
  return holderIsGone
    ? { ...state, status: 'resolved', winnerId: null, price: null }
    : { ...state, status: 'resolved', winnerId: state.holder, price: state.standing }
}

export type BidRejection =
  | { ok: false; reason: string }

export type BidAccepted = { ok: true; state: OpenState }

/**
 * The player bids.
 *
 * ⚠ VALIDATION IS A GATE WITH A VISIBLE MESSAGE, NOT A SILENT FILTER (open §8.3 case 3).
 * A rejected bid changes nothing and tells the player why.
 *
 * ⚠ A BID BELOW THE PLAYER'S OWN COST IS LEGAL AND IS NEVER BLOCKED (open §8.3 case 4).
 * If it wins, the profit is negative. Losing money is a legitimate mistake and part of
 * the lesson; the lecture's own scatter shows students doing it.
 */
export function playerBid(state: OpenState, s: OpenSettings, amount: number): BidAccepted | BidRejection {
  // ⚠ THE MORE SPECIFIC REASON FIRST, DELIBERATELY. Dropping out always settles the
  // round, so a dropped-out player is ALSO in the `resolved` state — checking `resolved`
  // first would tell them "this auction has already ended", which is true but unhelpful
  // and hides the fact that it ended because THEY left. Drop Out is final and the player
  // should be told so in those words (open §4.5).
  if (state.playerOut) {
    return { ok: false, reason: 'You have dropped out of this auction — that is final.' }
  }
  if (state.status === 'resolved') {
    return { ok: false, reason: 'This auction has already ended.' }
  }
  if (!Number.isInteger(amount)) {
    return { ok: false, reason: 'Bids are whole ECU only.' }
  }
  if (amount < 0) {
    return { ok: false, reason: 'A bid cannot be negative.' }
  }
  const ceiling = maxLegalBid(state.standing, s.schedule)
  if (amount > ceiling) {
    const step = stepAt(state.standing, s.schedule)
    return {
      ok: false,
      reason: `The current price is ${state.standing}. You must bid at least ${step} lower — ` +
        `${ceiling} or less.`,
    }
  }

  const next: OpenState = {
    ...state,
    standing: amount,
    holder: s.playerId,
    history: [...state.history, { kind: 'bid', bidderId: s.playerId, amount, isPlayer: true }],
  }
  return { ok: true, state: settle(next, s) }
}

/**
 * The player drops out.
 *
 * ⚠ A DELIBERATE STRATEGIC ACTION, RECORDED AS PLAY — never a timeout, never an absence
 * (open §4.5). Final for the auction: the price only falls, so re-entry would be
 * incoherent rather than merely inconvenient.
 *
 * ⚠ THE PLAYER STILL SEES WHERE IT LANDS. The remaining bots settle among themselves and
 * the final price is returned. Watching the price settle after you quit is most of the
 * lesson — it is the direct evidence for whether you stopped too early.
 */
export function playerDropOut(state: OpenState, s: OpenSettings): OpenState {
  if (state.status === 'resolved' || state.playerOut) return state
  const next: OpenState = {
    ...state,
    playerOut: true,
    history: [...state.history, { kind: 'dropOut', bidderId: s.playerId }],
  }
  return settle(next, s)
}

/**
 * How many bidders could still act — the "N of M still bidding" counter (open §5.1).
 *
 * ⚠ EXCLUDES BOTS PRICED OUT BY THE RESERVE FROM THE OPENING (open §4.3). That is the
 * stated requirement, and `openAuction` implements it by stopping them before the first
 * cascade step rather than filtering here.
 *
 * ⚠ DEFINITIONAL CHOICE, FLAGGED FOR ELENA: "still bidding" is read here as "could make a
 * FURTHER bid" — not stopped, not dropped out. A bot that holds the low bid but cannot
 * legally go lower is therefore NOT counted, even though it is winning. The alternative
 * reading ("still in the auction") would count it. The spec's sample screen shows "3 of 5"
 * without pinning which reading produced it, so this is a screen decision, not a rule —
 * raise it at CP4 rather than treating this line as settled.
 */
export function activeBidderCount(state: OpenState, s: OpenSettings): number {
  const stopped = new Set(state.stopped)
  const bots = s.bots.filter(b => !stopped.has(b.bidderId)).length
  return bots + (state.playerOut ? 0 : 1)
}

/** Total bidders in the auction, including those the reserve priced out. The `M` in
 *  "N of M" — the player plus every rival, whether or not any of them can act. */
export function totalBidderCount(s: OpenSettings): number {
  return s.bots.length + 1
}

/**
 * The player's EXIT PRICE for the Tier-3 scatter (open §7), and whether it is censored.
 *
 * ⚠⚠ THE CENSORING DISTINCTION IS CAPTURED AT ROUND END, NOT RECONSTRUCTED LATER. That
 * is a spec requirement and it is a statistical one, not a convenience:
 *
 *   • A LOSING player's exit price is the standing price at the moment they stopped
 *     bidding or dropped out. It is their REVEALED stopping point, directly observable.
 *   • A WINNING player's exit price is their final bid — but the auction STOPPED BEFORE
 *     REACHING their true limit, so all we know is that their stopping point was at or
 *     below it. This is CENSORED, and winners must be a DISTINCT SERIES on the scatter.
 *
 * Treating a winner's final bid as a revealed stopping point would misstate what the data
 * shows. Hence `censored` travels with the number, from here, at the moment it is known.
 */
export function playerExit(state: OpenState, s: OpenSettings): {
  exitPrice: number | null
  censored: boolean
} {
  const won = state.winnerId === s.playerId
  const lastPlayerBid = [...state.history]
    .reverse()
    .find((e): e is Extract<OpenEvent, { kind: 'bid' }> => e.kind === 'bid' && e.isPlayer)

  if (won) {
    // Censored: the auction ended before the player was pushed to their limit.
    return { exitPrice: lastPlayerBid?.amount ?? null, censored: true }
  }
  // Revealed: the price they declined to beat. For a player who never bid at all this is
  // the standing price they walked away from, which is still a genuine stopping point.
  return { exitPrice: state.standing, censored: false }
}
