import { maxLegalBid, stepAt, delayAt, type DecrementBand, type DelayBand } from './schedule'
import { pick, type Rng } from './rng'

// ═══════════════════════════════════════════════════════════════════════════════
// Procurement Auction (OPEN DESCENDING) — the bidding state machine. Pure: no
// Firestore, no game imports, no `Date`, no `Math.random`.
//
// ⚠⚠ ONE BOT BID, ONE COMMIT (open §4.6). THIS IS THE LOAD-BEARING DECISION IN THE
// FORMAT AND IT IS NOT A STYLE PREFERENCE.
//
// The obvious build — compute the whole cascade when the round opens, write it, and let
// the client animate it with `delayMs` spacing — is REJECTED. It means the server holds
// a standing price the screen has not reached, so a player who bids mid-animation bids
// against a number they cannot see. That is the CP3 stored-cost blocker in a new costume
// (a60cf51: shown 33, resolved against 58) and it is rejected on those grounds.
//
// Commit-per-step is the STRUCTURAL fix rather than the safer habit: nothing advances
// without a commit, so **the committed standing IS what the screen shows**. There is no
// window in which server and client disagree. That is an invariant, not a convention
// somebody has to remember — and remembering is exactly what failed in CP3.
//
// Two properties fall out for free: RESUME IS EXACT (a refresh lands on the true current
// standing, because every step is durable) and THE ROUND IS REPLAYABLE FROM ITS RECORD,
// which §5.2 and §7 both need anyway.
//
// ⚠⚠ THE CLIENT CONTROLS ONLY *WHEN* TO ASK, NEVER *WHAT* THE BOT BIDS. `advanceOne`
// recomputes the bot decision from stored state on every call and checks `nextBotAtMs`
// itself. A client that lies about timing gets a bid it would have received anyway, one
// moment early. There is no path by which a client supplies a bid amount for a bot.
//
// ⚠ THIS IS THE ONE PLACE THIS GAME DIVERGES FROM EVERY OTHER SINGLE-PLAYER GAME. The
// other five are one-submit-per-round: submit → compute → reveal, atomic. This format is
// an UNBOUNDED EXCHANGE — a round may contain one player action or twenty, with the count
// unknown in advance. `Singleplayer_Loop_Audit_Findings.md` §B.3 found exactly this shape
// inexpressible as stage-engine stages, which is why the loop is bespoke and why the
// exchange sits BELOW the round loop: only the RESOLVED round is appended to `rounds[]`.
//
// ⚠ NO CLOCK, AND A ROUND MAY WAIT FOREVER (open §4.4). Correct rather than a compromise:
// this is a single-player game, so a player who sits idle blocks nobody. `waiting` is a
// legitimate resting place, not a stall.
//
// ⚠ PRICE TIES ARE IMPOSSIBLE HERE (open §4.3). An equal bid is illegal — every bid must
// undercut by at least the step — so the sealed format's tie rules do not apply and the
// only collision that exists between BOTS is response ordering, which is seeded-random.
// (Player-vs-bot collisions are a different thing entirely and are handled by
// `playerBid`'s forgiving re-check — see there.)
// ═══════════════════════════════════════════════════════════════════════════════

export interface OpenBot {
  bidderId: string
  cost: number
}

export interface OpenSettings {
  reserve: number
  schedule: readonly DecrementBand[]
  delaySchedule: readonly DelayBand[]
  playerId: string
  /**
   * ⚠⚠ THE PLAYER'S OWN COST — AND THE MACHINE NEEDS IT NOW (Elena, 2026-08-04).
   *
   * Until this change the machine was deliberately NOT told it, and a test said so: "it
   * could not block a below-cost bid if it wanted to." That was correct while §6.2/§8.3
   * case 4 allowed one. **They no longer do.** §4.3 already forbade a BOT from bidding
   * below its own cost; the player could do something no other bidder in the auction
   * can. It is now ONE rule applied uniformly — and it is what makes the closed-form
   * benchmark exact rather than approximate, because the lowest-cost bidder always wins
   * and the price always lands within one step above the second-lowest cost.
   */
  playerCost: number
  bots: readonly OpenBot[]
  /**
   * ⚠⚠ A FRESH STREAM PER DECISION, KEYED BY THE DECISION INDEX — not one stateful `Rng`
   * for the round. The state machine is re-entered from stored state on every callable
   * invocation, so a stateful stream would restart at position 0 every time and every
   * decision in the round would draw the SAME value: under a seed the same bot would win
   * every ordering race, and the cascade would read exactly as mechanical as §4.3's
   * random ordering exists to avoid.
   *
   * The index is `state.decisions`, which is durable, so the draw is a pure function of
   * (seed, participant, round, decision) — reproducible under a seed, genuinely random
   * without one. `procurementOpenAuction.test.ts` pins this with a negative control.
   */
  rngAt: (decision: number) => Rng
  /**
   * ± jitter in ms for the decision at this index (open §3, `delayJitterMs`).
   *
   * ⚠ UX ONLY, NEVER STRATEGIC. It is injected rather than drawn here so this module
   * stays pure, and so it is visible that NOTHING in a bot's decision reads it.
   */
  jitterAt: (decision: number) => number
  /**
   * ⚠ TEST HOOK, AND ONLY THAT. Open §8 forces bot response order to
   * lowest-index-willing "for the test only"; in play it is seeded-random. Defaults to
   * random, so forgetting to set it cannot silently make play deterministic.
   */
  order?: 'random' | 'lowestIndex'
}

/**
 * ⚠⚠ THE INVARIANT THAT LETS THE BID HISTORY STAY FULLY PUBLIC:
 * **A BOT NEVER EMITS ANYTHING BUT A BID.**
 *
 * There is no "bot 3 has stopped" event and no bot drop-out event, and there is no code
 * path that could produce one: `markStopped` records a bot's departure in `state.stopped`
 * and appends NOTHING, and the only `dropOut` event in the system is written by
 * `playerDropOut` with `s.playerId`. So the history is bids and one possible player
 * drop-out — every row of it is an action somebody took, publicly, in a real auction.
 *
 * This is what makes the history safe to show in full while the active-bidder count is
 * not: a bid is an announcement, a departure is silence, and silence stays ambiguous
 * between "priced out" and "still thinking". Pinned by a test; if a "stopped" event is
 * ever added here, that pin fails and the leak analysis in openView.ts stops holding.
 */
export type OpenEvent =
  | { kind: 'bid'; bidderId: string; amount: number; isPlayer: boolean }
  | { kind: 'dropOut'; bidderId: string }
  /** ⚠ THE PLAYER WAS REMOVED because the price fell below their own cost — they can no
   *  longer bid at all (§4.3, now applied to the player). Its own kind rather than a
   *  `dropOut`, because "you left" and "the price left you behind" are different events
   *  and the history should not tell a student they quit when they did not.
   *  ⚠ STILL THE PLAYER'S — the invariant that a BOT emits nothing but a bid is intact. */
  | { kind: 'autoDrop'; bidderId: string }

export type OpenStatus =
  /** A bot will act. The client waits until `nextBotAtMs`, then calls advance(). */
  | 'bot_turn'
  /** The cascade has halted and no bot will act. Bid and Drop Out are live, forever. */
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
  /**
   * Monotonic, incremented by EVERY committed change (open §4.6). `submitBid` declares
   * the sequence it acted on so a collision can be described accurately — it is never
   * itself a reason to reject. See `playerBid`.
   */
  sequence: number
  /**
   * How many bot DECISION POINTS have been reached. The rng/jitter index, and durable so
   * the stream survives the round being re-entered from storage on every call.
   *
   * ⚠ POSITIONAL, NEVER CONDITIONAL (rng.ts's convention): a decision point takes its
   * draw whether or not there was a choice to make, so the stream position after a step
   * never depends on how many bots happened to be willing.
   */
  decisions: number
  /** When the next bot bid becomes due, in epoch ms. Null unless `status` is 'bot_turn'.
   *  ⚠ The SERVER checks this; the client only decides when to ask (open §4.6). */
  nextBotAtMs: number | null
  /**
   * ⚠⚠ THE EXIT PRICE, RECORDED AT THE MOMENT THE PLAYER LEAVES — never read back off the
   * settled state. That readback was the CP4b defect: `playerExit` returned
   * `state.standing` of the RESOLVED state, which for a loser is the FINAL PRICE, so
   * `exit_price === price` in 100% of rounds by construction and the Tier-3 chart was
   * plotting the clearing price against cost.
   *
   * Three cases, complete, and NEVER clamped (Elena, 2026-08-04):
   *   won         → their winning bid            (derived at resolution, not stored here)
   *   dropped out → their last bid, null if none (stored here, at the drop)
   *   auto-dropped→ their COST                   (stored here, at the removal)
   *
   * ⚠ NO `min()`/`max()` ANYWHERE NEAR THIS. An early quitter at 50 with a cost of 34
   * must record 50; clamping would plot them as perfect.
   */
  playerExitPrice: number | null
  playerExitKind: 'dropOut' | 'autoDrop' | null
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

/**
 * Mark every bot whose merit has just failed. Permanent — the price only falls, so a bot
 * that declines once can never profitably act later (open §4.3), and the implementation
 * treats it as terminal rather than re-evaluating a stopped bot on every step.
 *
 * ⚠ RUN AT THE OPENING TOO, NOT ONLY AFTER A BID. Open §4.3 requires the active-bidder
 * count to exclude priced-out bots FROM THE OPENING, "or the player is told five
 * suppliers are bidding when only three can". Two kinds of bot are excluded there: one
 * with `cost > reserve` (absent outright), and — the easily missed one — a bot whose cost
 * sits between the reserve and the first legal bid, e.g. cost 105 under a reserve of 110
 * with a top step of 10. §4.1 records that second case as a known, accepted consequence
 * of a coarse top band; this is where it becomes visible instead of silent.
 */
function markStopped(state: OpenState, s: OpenSettings): OpenState {
  const stopped = new Set(state.stopped)
  let changed = false
  for (const bot of s.bots) {
    if (!stopped.has(bot.bidderId) && !hasMerit(bot, state.standing, s)) {
      stopped.add(bot.bidderId)
      changed = true
    }
  }
  return changed ? { ...state, stopped: [...stopped] } : state
}

/** Bots that could bid RIGHT NOW: not stopped, and not already holding the bid. */
function willingBots(state: OpenState, s: OpenSettings): OpenBot[] {
  const stopped = new Set(state.stopped)
  return s.bots.filter(b => !stopped.has(b.bidderId) && state.holder !== b.bidderId)
}

/**
 * After any commit: who is stopped, is a bot due, or is the round over?
 *
 * ⚠ THE ONLY PLACE `status`, `winnerId`, `price` AND `nextBotAtMs` ARE SET. Every mutator
 * ends here, so those four can never disagree with `standing`/`holder`/`stopped` — the
 * thing a screen reading a half-updated record would show wrongly.
 */
function settle(state: OpenState, s: OpenSettings, nowMs: number): OpenState {
  const marked = markStopped(state, s)

  if (willingBots(marked, s).length > 0) {
    // A bot will act. Schedule it — the delay comes from the SAME band shape as the step
    // (open §3), so pacing follows tension without any phase special-casing.
    const delay = delayAt(marked.standing, s.delaySchedule) + s.jitterAt(marked.decisions)
    return {
      ...marked,
      status: 'bot_turn',
      // A negative jitter must never produce a due time in the past-by-construction.
      nextBotAtMs: nowMs + Math.max(0, delay),
      winnerId: null,
      price: null,
    }
  }

  // ── The cascade has halted. Is the round over, or waiting for the player? ────
  //
  // | Situation                              | Outcome (open §4.4)                     |
  // |---|---|
  // | player holds                           | player wins, paid their own final bid   |
  // | a bot holds, player still in           | **waits — indefinitely, no timeout**    |
  // | a bot holds, player out                | that bot wins at the standing bid       |
  // | nobody ever bid, player out            | no award, everyone earns 0              |
  const terminal = { ...marked, nextBotAtMs: null }

  if (terminal.holder === s.playerId) {
    return { ...terminal, status: 'resolved', winnerId: s.playerId, price: terminal.standing }
  }
  if (!terminal.playerOut) {
    // The resting place. Bid and Drop Out remain live; nothing times out.
    return { ...terminal, status: 'waiting', winnerId: null, price: null }
  }
  // ⚠ AN EDGE THE SPECS DO NOT COVER, IMPLEMENTED CONSERVATIVELY (BUILD_NOTES §5). If the
  // player held the standing bid and then dropped out with no bot able to undercut, this
  // awards NOTHING rather than awarding to a player who has left. Unreachable through the
  // public API — a player action always settles, and a settle in which the player holds
  // and no bot is willing resolves as a player win before any further action is possible.
  // A guard, not a rule. Elena approved keeping it (08-03).
  const holderIsGone = terminal.holder === null || terminal.holder === s.playerId
  return holderIsGone
    ? { ...terminal, status: 'resolved', winnerId: null, price: null }
    : { ...terminal, status: 'resolved', winnerId: terminal.holder, price: terminal.standing }
}

/**
 * Open the auction: the reserve stands, unowned, and NOTHING HAS HAPPENED YET.
 *
 * ⚠ NO CASCADE IS RUN HERE. That is the §4.6 decision in one line: the first bot bid is a
 * commit like every other, taken by `advanceOne` once its delay has elapsed. A player who
 * loads the screen sees the auction at 110, exactly as the server holds it.
 */
export function openAuction(s: OpenSettings, nowMs: number): OpenState {
  const state: OpenState = {
    status: 'waiting',
    standing: s.reserve,
    holder: null,
    stopped: [],
    playerOut: false,
    history: [],
    sequence: 0,
    decisions: 0,
    nextBotAtMs: null,
    playerExitPrice: null,
    playerExitKind: null,
    winnerId: null,
    price: null,
  }
  // `settle` marks the priced-out bots and schedules the first bot bid — so the opening
  // active-bidder count is already honest (§4.3) and the cascade is already ticking.
  return settle(state, s, nowMs)
}

export interface AdvanceResult {
  state: OpenState
  /** Did a bot bid? False for every no-op reason below — the caller writes nothing. */
  committed: boolean
  /** Why nothing happened. Diagnostic; never shown to a student. */
  reason: 'committed' | 'not-due' | 'no-bot-due'
}

/**
 * COMMIT EXACTLY ONE BOT BID, if one is genuinely due (open §4.6).
 *
 * ⚠⚠ THE TIMING CHECK IS HERE, ON THE SERVER (open §8.3 case 11). A client that calls
 * early gets its current state back unchanged and nothing is written. The client's job is
 * only to ask; whether it is time, and what the bot bids, are both decided from stored
 * state.
 *
 * ⚠ A BACKGROUNDED TAB PAUSES THE AUCTION AND THAT IS FINE (open §4.6, §8.3 case 12).
 * There is no timeout and nobody is blocked, so a call after a long gap simply commits
 * the one bid that was due. No forfeit, no state loss, no catch-up burst — the next bid
 * is scheduled from *now*, not from when it would have been due, so a player returning to
 * a tab is not immediately swamped.
 */
export function advanceOne(state: OpenState, s: OpenSettings, nowMs: number): AdvanceResult {
  if (state.status !== 'bot_turn') {
    return { state, committed: false, reason: 'no-bot-due' }
  }
  if (state.nextBotAtMs !== null && nowMs < state.nextBotAtMs) {
    return { state, committed: false, reason: 'not-due' }
  }

  const next = commitOneBotBid(state, s, nowMs)
  if (next === null) {
    // Defensive: `settle` sets 'bot_turn' only when someone is willing, so this is
    // unreachable. Re-settling rather than throwing keeps a corrupted record recoverable.
    return { state: settle(state, s, nowMs), committed: false, reason: 'no-bot-due' }
  }
  return { state: next, committed: true, reason: 'committed' }
}

/**
 * One bot bid, chosen and committed. Returns null when no bot is willing.
 *
 * ⚠ THE TIMING GATE IS *NOT* HERE — it is `advanceOne`'s, so that the one caller allowed
 * to bypass it (a Drop Out settle, open §4.4) does so visibly rather than by passing a
 * fake `now`. Every other path must go through `advanceOne`.
 */
function commitOneBotBid(state: OpenState, s: OpenSettings, nowMs: number): OpenState | null {
  const willing = willingBots(markStopped(state, s), s)
  if (willing.length === 0) return null

  // ⚠ RESPONSE ORDER IS SEEDED-RANDOM (open §4.3). Fixed ordering would make the same bot
  // always jump first, which reads as mechanical. `lowestIndex` exists only so the
  // conformance vector can pin a trace.
  //
  // ⚠ `pick` IS CALLED EVEN WHEN THERE IS ONE CANDIDATE — the positional-draw convention
  // (rng.ts). Here the stream is keyed per decision anyway, so the saving would be
  // invisible; making it conditional would still be the habit that produced a60cf51.
  const chosen = s.order === 'lowestIndex'
    ? willing[0]
    : pick(s.rngAt(state.decisions), willing)

  // ⚠ THE MINIMUM LEGAL MOVE, NEVER A JUMP (open §4.3, the SAA precedent). Whether
  // jumping pays is a question for the humans; the bots do not try to answer it.
  const amount = maxLegalBid(state.standing, s.schedule)

  const next: OpenState = {
    ...state,
    standing: amount,
    holder: chosen.bidderId,
    history: [...state.history, { kind: 'bid', bidderId: chosen.bidderId, amount, isPlayer: false }],
    sequence: state.sequence + 1,
    decisions: state.decisions + 1,
  }

  // ⚠⚠ AUTO-DROP: THE PLAYER HAS NO LEGAL MOVE LEFT, so they are removed.
  //
  // ⚠⚠ THE TEST IS THE PLAYER'S OWN LEGALITY RULE, NOT A PRICE COMPARISON (Elena,
  // 2026-08-11, second revision). `playerBid` accepts an amount iff BOTH
  //
  //     amount >= s.playerCost                          (the cost floor, §4.2)
  //     amount <= maxLegalBid(standing, s.schedule)      (the undercut ceiling, §4.2)
  //
  // so a legal bid exists **iff `maxLegalBid(standing) >= playerCost`**, and the condition
  // below is precisely its negation. That is why it is the right test rather than merely a
  // wider one: it asks the question the rule actually poses.
  //
  // ⚠ IT SUBSUMES BOTH EARLIER VERSIONS, which were price comparisons and each too narrow:
  //   `amount <  playerCost`  — left a player in when a bot bid AT their cost, where every
  //                             undercut is below cost and refused.
  //   `amount <= playerCost`  — closed that, and still left them in for the whole window
  //                             `playerCost < standing < playerCost + step`, where the best
  //                             bid available is `standing − step`, below cost, refused.
  // The second window was NOT hypothetical: the shipped ladder steps by 10, 5 and 2 above a
  // price of 30, so a player whose cost is 39 facing a standing of 40 could bid neither 39
  // (does not clear the ceiling) nor 38 (below the floor). Both versions left somebody
  // priced out in fact but still in the auction until they pressed Drop Out — and the record
  // then called it a VOLUNTARY drop, which is a different event and reports as one.
  //
  // ⚠ THE COMPARISON IS STRICT. `maxLegalBid(standing) == playerCost` means the player may
  // still bid EXACTLY their cost — legal, zero profit, and the endpoint the dominant
  // strategy aims at (KC O4). Firing there would remove a player who still had the one move
  // the game teaches them to consider.
  //
  // ⚠ THE OLD COMMENT HERE JUSTIFIED `<` BY THE ROUND-STEALING CASE — "a player holding at
  // exactly their own cost with every bot stopped is the normal winning path, and firing
  // here would steal a won round". That reasoning was sound about the DANGER and wrong
  // about what prevented it. The comparison was never what protected that case:
  //
  //   `next.holder` CANNOT BE THE PLAYER AT THIS LINE. This branch runs only inside
  //   `commitOneBotBid`, `next.holder` is set to `chosen.bidderId` immediately above, and
  //   `chosen` comes from `willingBots`, which filters `s.bots` — an array the player is
  //   never a member of. So `next.holder !== s.playerId` is invariably true here.
  //
  // The winning path is protected one level up instead, and more strongly: a player who
  // holds at their own cost with every bot stopped produces NO bot bid at all, so
  // `commitOneBotBid` never runs and this check is never reached. The `holder` clause is
  // kept as a belt-and-braces assertion of an invariant, not as a live filter — dropping
  // it should change nothing, and a test asserts exactly that.
  if (!next.playerOut && next.holder !== s.playerId
    && maxLegalBid(next.standing, s.schedule) < s.playerCost) {
    const removed: OpenState = {
      ...next,
      playerOut: true,
      // ⚠ THE EXIT IS THEIR COST, NOT THEIR LAST BID (Elena, 2026-08-04). A passive player
      // who bid 40 and then watched the bots walk to 33 has a last bid of 40, which would
      // read as "quit early, left 6 unclaimed" — but nothing they did says that. What
      // happened is that the auction went below what they were allowed to pay, and their
      // cost is exactly that boundary.
      playerExitPrice: s.playerCost,
      playerExitKind: 'autoDrop',
      history: [...next.history, { kind: 'autoDrop', bidderId: s.playerId }],
      sequence: next.sequence + 1,
    }
    // The player is out, so the remaining bots settle among themselves IMMEDIATELY —
    // the same treatment §4.4 gives a Drop Out, and safe for the same reason: nobody is
    // left who could bid against a price they cannot see.
    return settleRemainingBots(removed, s, nowMs)
  }

  return settle(next, s, nowMs)
}

/**
 * The player has left — by their own hand or by auto-drop — so run the remaining bots to
 * quiescence in this one commit (§4.4's table, in its own words).
 *
 * ⚠ SHARED BY BOTH EXITS ON PURPOSE. They differ in what the exit price RECORDS and in
 * what the history says; they do not differ in what happens to the auction afterwards,
 * and two copies of this loop would eventually disagree about that.
 */
function settleRemainingBots(state: OpenState, s: OpenSettings, nowMs: number): OpenState {
  let cur = settle(state, s, nowMs)
  // A bound, not a policy: every step strictly lowers the standing bid by at least 1 and
  // the price is bounded below by the lowest cost, so this cannot spin. It exists so a
  // schedule that somehow reached a zero step raises loudly instead of hanging a request.
  let guard = 0
  while (cur.status === 'bot_turn') {
    if (++guard > 10_000) {
      throw new Error('[procurement] open cascade did not terminate — is a step size 0?')
    }
    const next = commitOneBotBid(cur, s, nowMs)
    if (next === null) break
    cur = next
  }
  return cur
}

export type BidRejection = { ok: false; reason: string }
export type BidAccepted = { ok: true; state: OpenState }

/**
 * The player bids.
 *
 * ⚠⚠ COLLISIONS ARE RESOLVED GENEROUSLY, AND A STALE `sequence` IS NOT BY ITSELF A
 * REJECTION (open §4.6, §8.3 cases 9 and 10). The bid is re-checked against the *new*
 * standing and accepted if it still clears:
 *
 *     player bids 42 against a standing of 48; a bot commits 46 in between
 *       → 42 still clears the 2-ECU minimum against 46  → ACCEPT
 *     player bids 47 against a standing of 48; a bot commits 46 in between
 *       → 47 does not clear against 46                  → reject, naming the new price
 *
 * `declaredSequence` therefore changes only the WORDING of a rejection, never the
 * decision. Being narrowly beaten to a bid is a real thing that happens in live auctions;
 * surviving it gracefully is what a human competitor would experience, so the forgiving
 * rule is the faithful one as well as the kind one.
 *
 * ⚠ VALIDATION IS A GATE WITH A VISIBLE MESSAGE, NOT A SILENT FILTER (open §8.3 case 3).
 * A rejected bid changes nothing and tells the player why.
 *
 * ⚠⚠ A BID BELOW THE PLAYER'S OWN COST IS REFUSED (open §8.3 case 4, Elena 2026-08-04) —
 * the check is a dozen lines below, and this comment asserted the OPPOSITE until
 * 2026-08-11. It said the bid was "legal and never blocked", that losing money was part of
 * the lesson, and — the line that shows how old it is — that "this function is not even
 * TOLD the player's cost". It is: `s.playerCost`, and that is what the check reads. One
 * rule for every bidder in the auction, in both formats; §4.3's bot floor and this are the
 * same rule.
 *
 * ⚠ THE PLAYER'S BID DOES NOT CASCADE. It commits, and then `settle` schedules the bot's
 * ANSWER for `delay(newStanding)` later — the reply is a separate commit, so the player
 * sees their own bid stand before it is beaten (open §3: an instant reply reads as a
 * machine).
 */
export function playerBid(
  state: OpenState,
  s: OpenSettings,
  amount: number,
  declaredSequence: number | null,
  nowMs: number,
): BidAccepted | BidRejection {
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
  // ⚠⚠ THE HOLDER MAY NOT UNDERCUT THEMSELVES (§4.2) — AND THAT INCLUDES THE PLAYER.
  //
  // The rule is stated for bidders, not for bots, and it is the rule that makes the
  // cascade terminate. It is reachable for the player specifically because §5.1 requires
  // the bid box to stay LIVE while the bots are bidding: after their own bid the player
  // holds the standing price for a second or two with Bid and Bid-minimum still enabled,
  // and two clicks would otherwise walk them down against nobody. A duplicate request —
  // a double click, a retry on a flaky connection — does the same thing without anyone
  // intending it, which is the case that would actually have bitten.
  if (state.holder === s.playerId) {
    return {
      ok: false,
      reason: `You already hold the low bid at ${state.standing} — you cannot outbid yourself. ` +
        'Wait and see whether anyone undercuts you.',
    }
  }
  if (!Number.isInteger(amount)) {
    return { ok: false, reason: 'Bids are whole ECU only.' }
  }
  if (amount < 0) {
    return { ok: false, reason: 'A bid cannot be negative.' }
  }
  // ⚠⚠ NO BID BELOW YOUR OWN COST (Elena, 2026-08-04). §4.3 already bound the bots to
  // this; binding the player too makes it ONE mechanism rule rather than a licence only
  // the human had. It SUPERSEDES §8.3 case 4 ("legal and allowed — below own cost … never
  // blocked"), which is being corrected in the spec.
  if (amount < s.playerCost) {
    return {
      ok: false,
      reason: `Your cost is ${s.playerCost}. A bid of ${amount} would be below it, and no `
        + 'bidder in this auction may bid below their own cost.',
    }
  }

  const ceiling = maxLegalBid(state.standing, s.schedule)
  if (amount > ceiling) {
    const step = stepAt(state.standing, s.schedule)
    // ⚠ The price MOVED while they were bidding — say so, in the spec's own words. The
    // difference between "you misread the rules" and "somebody beat you to it" is the
    // whole difference between a confusing error and a competitive one.
    const moved = declaredSequence !== null && declaredSequence !== state.sequence
    return {
      ok: false,
      reason: moved
        ? `The price moved to ${state.standing} while you were bidding. ` +
          `Minimum next bid is ${ceiling}.`
        : `The current price is ${state.standing}. You must bid at least ${step} lower — ` +
          `${ceiling} or less.`,
    }
  }

  const next: OpenState = {
    ...state,
    standing: amount,
    holder: s.playerId,
    history: [...state.history, { kind: 'bid', bidderId: s.playerId, amount, isPlayer: true }],
    sequence: state.sequence + 1,
  }
  return { ok: true, state: settle(next, s, nowMs) }
}

/**
 * The player drops out.
 *
 * ⚠ A DELIBERATE STRATEGIC ACTION, RECORDED AS PLAY — never a timeout, never an absence
 * (open §4.5). Final for the auction: the price only falls, so re-entry would be
 * incoherent rather than merely inconvenient.
 *
 * ⚠ THE REMAINING BOTS SETTLE **IMMEDIATELY**, IN THIS ONE COMMIT (open §4.4's table, in
 * those words). This is the one place the cascade runs to quiescence inside a single
 * call, and it does NOT reintroduce what §4.6 rejects: the player is out, so there is no
 * longer anyone who could bid against a price they cannot see. They are still shown where
 * it landed, and the whole settling sequence is in the history — watching the price settle
 * after you quit is most of the lesson (§4.5).
 */
export function playerDropOut(state: OpenState, s: OpenSettings, nowMs: number): OpenState {
  if (state.status === 'resolved' || state.playerOut) return state

  // ⚠⚠ THE EXIT IS CAPTURED HERE, BEFORE THE BOTS SETTLE — that is the whole fix. CP4b
  // read it back off the RESOLVED state, where `standing` has already been driven down by
  // the bots the player left behind, so every loser recorded the FINAL PRICE.
  //
  // ⚠ IT IS THEIR LAST BID — the lowest price they actually committed to — and NULL when
  // they never bid at all. Not the standing they declined: a rival who undercuts a player
  // below that player's own cost would otherwise stamp them as "willing to supply below
  // cost", which is the one mistake the chart exists to name and which they did not make.
  return settleRemainingBots({
    ...state,
    playerOut: true,
    playerExitPrice: lastPlayerBid(state, s),
    playerExitKind: 'dropOut',
    history: [...state.history, { kind: 'dropOut', bidderId: s.playerId }],
    sequence: state.sequence + 1,
  }, s, nowMs)
}

// ═══════════════════════════════════════════════════════════════════════════════
// ⚠⚠ THERE IS DELIBERATELY NO `activeBidderCount`. IT WAS DELETED, NOT UNEXPORTED
// (Elena, 2026-08-04) — and deleting the DERIVATION rather than hiding the field is the
// point, because a helper sitting here is an invitation to put it back on a screen.
//
// **A competitor's departure is not announced in a live auction.** The player infers it
// from silence, and silence is ambiguous between "priced out" and "still thinking". An
// explicit count destroys that ambiguity — and it was the last client-side field derived
// from bot COST state, so removing it closes the category rather than one instance.
//
// It supersedes open §4.3's "the active-bidder count must reflect this from the opening"
// and §5.1's "3 of 5 still bidding"; the spec is being updated to match. What survives of
// §4.3 is the mechanism, untouched: a bot with `cost > reserve` is ABSENT from the
// auction, it never bids, and it never appears in the history. That is still asserted —
// by the trace, which is where it was always observable.
//
// ⚠ THE OPENING TOTAL STAYS PUBLIC. "There are 5 bidders in this auction" is stated up
// front in the deck and the player needs `n` to reason at all — it is a parameter, not a
// running commentary. `totalBidderCount` below is that number and never moves.
// ═══════════════════════════════════════════════════════════════════════════════

/** Total bidders in the auction, INCLUDING those the reserve priced out — the player plus
 *  every rival, whether or not any of them can act. ⚠ Constant for the whole round: it is
 *  a parameter of the auction, and nothing about who is still in can be read off it. */
export function totalBidderCount(s: OpenSettings): number {
  return s.bots.length + 1
}

// ⚠⚠ THERE IS NO `replayPerfectPlay` HERE ANY MORE, AND ITS ABSENCE IS THE POINT.
// CP4b computed the perfect-play benchmark by replaying the whole auction with the player
// exiting at their own cost — which inherited the seeded-random bot ORDERING and so
// returned one sample from a distribution BUILD_NOTES §2 measured spanning up to 10 ECU.
//
// Elena replaced it with a closed form (`auction/perfectPlay.ts`, 2026-08-04): the ordering
// noise is a LARGE-INCREMENT phenomenon, and the increments that settle this auction are 2
// and 1. Ordering changes the path, not the destination. Do not reintroduce a replay to
// "check" the closed form — a sampled cross-check of a closed form is the noisier number
// auditing the exact one.
//
// It took a separately-keyed RNG stream with it (`benchmarkSettingsFor`): a hypothetical
// replay had to be prevented from disturbing the real auction's draws, and there is now
// nothing to disturb.

/** The player's own last bid this round, or null if they never bid. */
export function lastPlayerBid(state: OpenState, s: OpenSettings): number | null {
  for (let i = state.history.length - 1; i >= 0; i--) {
    const e = state.history[i]
    if (e.kind === 'bid' && e.bidderId === s.playerId) return e.amount
  }
  return null
}

/** Each bot's last bid, in `s.bots` order. Null = this bot never bid — it was priced out,
 *  or it simply never got the chance (open §4.3: absent, not bidding high). */
export function lastBotBids(state: OpenState, s: OpenSettings): (number | null)[] {
  const last = new Map<string, number>()
  for (const e of state.history) {
    if (e.kind === 'bid' && !e.isPlayer) last.set(e.bidderId, e.amount)
  }
  return s.bots.map(b => last.get(b.bidderId) ?? null)
}

/**
 * The player's EXIT PRICE for the Tier-3 scatter (open §7), and whether it is censored.
 *
 * ⚠⚠ CALLED AT ROUND END AND RECORDED, NEVER RECONSTRUCTED LATER (§7, CP4b). The result
 * is written onto the round record by `resolvedRoundRecord`; nothing downstream re-derives
 * it, and in particular nothing downstream infers `censored` from `won`. They are the same
 * fact today, and the flag is stored anyway — see below.
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
  if (state.winnerId === s.playerId) {
    // WON — their winning bid. Censored: the auction ended before anybody pushed them to
    // their limit, so this is an upper bound on where they would have stopped.
    return { exitPrice: lastPlayerBid(state, s), censored: true }
  }
  // ⚠⚠ READ BACK FROM THE RECORD, NEVER FROM `state.standing`. That readback was the CP4b
  // defect: by the time a round is resolved the standing has been driven to the FINAL
  // PRICE by the bots the player left behind, so `exit_price === price` in every round and
  // the field carried no information at all. It is set once, at the moment of leaving.
  //
  //   dropped out  → their last bid (null if they never bid)
  //   auto-dropped → their cost
  //
  // ⚠ NOT CLAMPED. An early quitter at 50 with a cost of 34 records 50.
  return { exitPrice: state.playerExitPrice, censored: false }
}
