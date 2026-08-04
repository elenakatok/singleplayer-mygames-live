import { describe, it, expect } from 'vitest'
import {
  openAuction, advanceOne, playerBid, playerDropOut,
  totalBidderCount, playerExit, lastPlayerBid, lastBotBids,
  type OpenSettings, type OpenState,
} from '../src/procurement/auction/openAuction'
import { maxLegalBid, isLegalBid } from '../src/procurement/auction/schedule'
import { makeRng } from '../src/procurement/auction/rng'

// ═══════════════════════════════════════════════════════════════════════════════
// THE OPEN CONFORMANCE VECTOR — open spec §8, frozen before implementation.
//
// Defaults throughout. Rival costs 47, 88, 21, 63; player cost 34; reserve 110;
// schedule 10 / 5 / 2 / 1.
//
// ⚠ "Bot response order forced to lowest-index-willing FOR THE TEST ONLY (in play it is
// seeded-random)." That is `order: 'lowestIndex'` below, and it is the only reason the
// step-by-step trace is assertable at all.
//
// ⚠⚠ BLANK SEED THROUGHOUT, FROM THE START — `rngAt` below is the `seed = null` path,
// which is what every classroom instance runs. Bot response ORDERING is a NEW RNG
// CONSUMER, and this is the THIRD instance of the pattern that produced the CP3
// stored-cost blocker (a60cf51) and forecast's `demandDraw: 'common'` no-op: `makeRng`
// with a null seed returns `Math.random` and IGNORES ITS KEY, so anything whose
// correctness rests on the key being honoured is silently untested under a seed. Every
// case below runs unseeded; the seeded path is exercised separately at the bottom,
// where the seed is the thing under test rather than the scaffolding.
//
// ⚠ TIME IS INJECTED, NEVER READ. `nowMs` is a parameter of every mutator, so the pacing
// and the paused-tab case are assertable without a fake clock.
// ═══════════════════════════════════════════════════════════════════════════════

const SCHEDULE = [
  { above: 80, step: 10 },
  { above: 50, step: 5 },
  { above: 30, step: 2 },
  { above: 0, step: 1 },
]

const DELAYS = [
  { above: 80, delayMs: 800 },
  { above: 50, delayMs: 1200 },
  { above: 30, delayMs: 2500 },
  { above: 0, delayMs: 3000 },
]

const BOTS = [
  { bidderId: 'bot1', cost: 47 },
  { bidderId: 'bot2', cost: 88 },
  { bidderId: 'bot3', cost: 21 },
  { bidderId: 'bot4', cost: 63 },
]

/** ⚠ THE CLASSROOM SHAPE: no seed. `makeRng(null, …)` is `Math.random`, key ignored. */
const blankSeedRng = (decision: number) => makeRng(null, `unseeded:${decision}`)

const base = (over: Partial<OpenSettings> = {}): OpenSettings => ({
  reserve: 110,
  schedule: SCHEDULE,
  delaySchedule: DELAYS,
  playerId: 'player',
  bots: BOTS,
  rngAt: blankSeedRng,
  // Deterministic pacing in the vector: jitter is UX, and a random one would make the
  // due-time assertions flaky for a reason that has nothing to do with the mechanism.
  jitterAt: () => 0,
  order: 'lowestIndex',
  ...over,
})

/** Just the bids, in order — what the spec's trace tables list. */
const trace = (s: OpenState) =>
  s.history.filter(e => e.kind === 'bid').map(e => [e.bidderId, (e as { amount: number }).amount])

/**
 * Drive the bot cascade the way the CLIENT does: wait until `nextBotAtMs`, call
 * `advanceOne`, repeat. One commit per call — never a precomputed cascade (§4.6).
 *
 * Returns the state and how many commits it took, so a test can assert that the number of
 * server round-trips is what §4.6's "~16 callable invocations per round" predicts.
 */
function runCascade(state: OpenState, s: OpenSettings): { state: OpenState; commits: number } {
  let cur = state
  let commits = 0
  for (let i = 0; i < 500; i++) {
    // "Now" is always exactly when the next bid is due — the impatient-but-honest client.
    const now = cur.nextBotAtMs ?? 0
    const r = advanceOne(cur, s, now)
    if (!r.committed) return { state: r.state, commits }
    cur = r.state
    commits++
  }
  throw new Error('cascade did not settle in 500 commits')
}

const bid = (st: OpenState, s: OpenSettings, amount: number): OpenState => {
  const r = playerBid(st, s, amount, st.sequence, st.nextBotAtMs ?? 0)
  if (!r.ok) throw new Error(`bid ${amount} rejected: ${r.reason}`)
  return r.state
}

// ── §4.6 the execution model: the thing most likely to go wrong ───────────────

describe('§4.6 one bot bid, one commit — the cascade is NOT precomputed', () => {
  it('opening the auction commits NOTHING: the price is the reserve and nobody holds it', () => {
    const opened = openAuction(base(), 0)
    expect(opened.standing).toBe(110)
    expect(opened.holder).toBeNull()
    expect(opened.history).toEqual([])
    expect(opened.sequence).toBe(0)
    // ⚠ THE INVARIANT: the committed standing IS what the screen shows. At the opening
    // there is no bid anywhere in the record, so there is no price the server holds and
    // the screen has not reached. This is the assertion the CP3 blocker would have failed.
    expect(opened.status).toBe('bot_turn')
  })

  it('each advance commits EXACTLY ONE bid, and the ten steps take ten calls', () => {
    const s = base()
    let cur = openAuction(s, 0)
    const seen: number[] = []
    for (let i = 0; i < 10; i++) {
      const r = advanceOne(cur, s, cur.nextBotAtMs ?? 0)
      expect(r.committed, `call ${i + 1}`).toBe(true)
      // One bid appended per call — never two, never a batch.
      expect(r.state.history.length).toBe(i + 1)
      expect(r.state.sequence).toBe(i + 1)
      cur = r.state
      seen.push(cur.standing)
    }
    expect(seen).toEqual([100, 90, 80, 75, 70, 65, 60, 55, 50, 48])
    // And the eleventh call commits nothing — the cascade has halted on its own.
    expect(advanceOne(cur, s, 1e12).committed).toBe(false)
  })

  it('the delay between commits comes from the SCHEDULE, evaluated at the new price', () => {
    const s = base()
    let cur = openAuction(s, 1_000)
    // At the opening the price is 110 → the 800ms band.
    expect(cur.nextBotAtMs).toBe(1_800)
    cur = advanceOne(cur, s, 1_800).state       // → 100, still the 800ms band
    expect(cur.nextBotAtMs).toBe(2_600)
    cur = advanceOne(cur, s, 2_600).state       // → 90
    cur = advanceOne(cur, s, cur.nextBotAtMs!).state  // → 80, crosses into 1200ms
    expect(cur.standing).toBe(80)
    expect(cur.nextBotAtMs! - 2_600 - 800).toBe(1_200)
  })
})

// ── §8.1 Phase 1 ──────────────────────────────────────────────────────────────

describe('§8.1 Phase 1 — player passive, bots cascade', () => {
  const s = base()
  const { state: opened, commits } = runCascade(openAuction(s, 0), s)

  it('reproduces the ten-step trace exactly', () => {
    expect(trace(opened)).toEqual([
      ['bot1', 100],
      ['bot2', 90],
      ['bot1', 80],
      ['bot3', 75],
      ['bot1', 70],
      ['bot3', 65],
      ['bot1', 60],
      ['bot3', 55],
      ['bot1', 50],
      ['bot3', 48],
    ])
  })

  it('in ten server commits — one per bot bid (§4.6)', () => {
    expect(commits).toBe(10)
  })

  it('the cascade halts at 48, held by bot 3', () => {
    expect(opened.standing).toBe(48)
    expect(opened.holder).toBe('bot3')
    expect(opened.status).toBe('waiting')
  })

  it('bot 1 (cost 47) does not bid 46 — it cannot', () => {
    expect(opened.stopped).toContain('bot1')
    expect(trace(opened).length).toBe(10)
    expect(trace(opened).some(([, amt]) => amt === 46)).toBe(false)
  })

  it('bot 2 (cost 88) stops after step 3', () => {
    expect(opened.stopped).toContain('bot2')
    expect(trace(opened).filter(([id]) => id === 'bot2')).toEqual([['bot2', 90]])
  })

  it('no bot ever undercuts itself', () => {
    const bids = opened.history.filter(e => e.kind === 'bid')
    expect(bids.length).toBe(10)
    for (let i = 1; i < bids.length; i++) {
      expect(bids[i].bidderId).not.toBe(bids[i - 1].bidderId)
    }
  })

  it('⚠ the halt is not a stall — it waits for the player, with no timeout (§4.4)', () => {
    expect(opened.status).toBe('waiting')
    expect(opened.winnerId).toBeNull()
    // ⚠ And nothing is scheduled: a waiting round has no due time to expire.
    expect(opened.nextBotAtMs).toBeNull()
  })
})

// ── §8.2 Phase 2 ──────────────────────────────────────────────────────────────

describe('§8.2 Phase 2 — player engages', () => {
  const duel = () => {
    const s = base()
    let st = runCascade(openAuction(s, 0), s).state
    for (const amount of [46, 42, 38]) {
      st = bid(st, s, amount)
      // ⚠ THE PLAYER'S BID DOES NOT CASCADE. It stands until the bot's ANSWER is due —
      // one commit later, after the scheduled delay.
      expect(st.holder).toBe('player')
      expect(st.status).toBe('bot_turn')
      st = runCascade(st, s).state
    }
    return { s, st }
  }

  it('reproduces the duel and ends with bot 3 winning at 36', () => {
    const { st } = duel()
    expect(trace(st).slice(10)).toEqual([
      ['player', 46],
      ['bot3', 44],
      ['player', 42],
      ['bot3', 40],
      ['player', 38],
      ['bot3', 36],
    ])
    expect(st.standing).toBe(36)
    expect(st.holder).toBe('bot3')
    // At 36 the player's next legal bid is 34 — exactly their cost, zero profit. A
    // rational player stops, and the round simply waits (no clock).
    expect(maxLegalBid(36, SCHEDULE)).toBe(34)
    expect(st.status).toBe('waiting')
  })

  it('§8.3 case 1 — the full trace: bot 3 wins at 36, player profit 0', () => {
    const { s, st } = duel()
    // The player stops; the round is idle, so it ends by Drop Out (§4.4's second row is a
    // wait, not a resolution — a played round needs the player to act).
    const done = playerDropOut(st, s, 0)
    expect(done.status).toBe('resolved')
    expect(done.winnerId).toBe('bot3')
    expect(done.price).toBe(36)
    // Profit is the caller's arithmetic — `price − cost` only if the player won, else 0.
    expect(done.winnerId === 'player').toBe(false)
    expect(lastPlayerBid(done, s)).toBe(38)
  })

  it('the player\'s exit price is 36 and is NOT censored — they lost (§7)', () => {
    const { s, st } = duel()
    const done = playerDropOut(st, s, 0)
    const exit = playerExit(done, s)
    expect(exit.exitPrice).toBe(36)
    expect(exit.censored).toBe(false)
  })
})

// ── §8.3 the required cases ───────────────────────────────────────────────────

describe('§8.3 required cases', () => {
  it('case 2 — player jump-bids 36 at standing 48; bot 3 answers 34 AT ITS OWN COST', () => {
    // ⚠ "The one most likely to be got wrong": `standing − step >= botCost` is satisfied
    // AT EQUALITY, so a bot bids down to exactly its own cost. Strict `>` would stop bot
    // 3 one step early and hand the player the win.
    const s = base()
    let st = runCascade(openAuction(s, 0), s).state
    st = bid(st, s, 36)
    st = runCascade(st, s).state

    expect(trace(st).slice(10)).toEqual([['player', 36], ['bot3', 34]])
    expect(st.standing).toBe(34)
    expect(st.holder).toBe('bot3')
  })

  it('case 3 — player bids 47 at standing 48: REJECTED, with a visible message', () => {
    const s = base()
    const st = runCascade(openAuction(s, 0), s).state
    const r = playerBid(st, s, 47, st.sequence, 0)
    expect(r.ok).toBe(false)
    expect((r as { reason: string }).reason).toMatch(/46 or less/)
    // A rejected bid changes nothing.
    expect(st.standing).toBe(48)
    expect(st.sequence).toBe(10)
  })

  it('case 4 — a bid below the player\'s own cost is LEGAL and never blocked', () => {
    // 33 against a standing of 38, with a player cost of 34. The machine is not even TOLD
    // the player's cost, so it could not block one if it wanted to.
    expect(isLegalBid(33, 38, SCHEDULE)).toBe(true)

    // End to end: a below-cost bid that WINS. One bot, cost 21; the player bids 20.
    const s = base({ bots: [{ bidderId: 'bot3', cost: 21 }] })
    let st = runCascade(openAuction(s, 0), s).state
    st = bid(st, s, 20)                 // 20 < bot3's cost of 21 → bot3 cannot answer
    st = runCascade(st, s).state
    expect(st.status).toBe('resolved')
    expect(st.winnerId).toBe('player')
    expect(st.price).toBe(20)
    // With a cost of 34 that is a profit of −14. Nothing warned them, deliberately.
    expect(st.price! - 34).toBe(-14)
  })

  it('case 5 — player drops out at standing 48: bot 3 wins at 48, price still shown', () => {
    const s = base()
    const halted = runCascade(openAuction(s, 0), s).state
    const st = playerDropOut(halted, s, 0)
    expect(st.status).toBe('resolved')
    expect(st.winnerId).toBe('bot3')
    expect(st.price).toBe(48)
    // ⚠ The player still sees where it landed — most of the lesson (§4.5).
    expect(playerExit(st, s).exitPrice).toBe(48)
    expect(playerExit(st, s).censored).toBe(false)
    // Recorded as PLAY, never as an absence.
    expect(st.history.some(e => e.kind === 'dropOut' && e.bidderId === 'player')).toBe(true)
  })

  it('case 6 — player cost 15 (below every bot): the duel runs past 36 to bot 3\'s floor', () => {
    const s = base()
    let st = runCascade(openAuction(s, 0), s).state
    // Play the minimum legal move each time, as a patient player with a cost of 15 would.
    for (let i = 0; i < 40 && st.status === 'waiting'; i++) {
      const next = maxLegalBid(st.standing, SCHEDULE)
      if (next < 15) break                     // never below our own cost
      st = runCascade(bid(st, s, next), s).state
    }
    expect(st.status).toBe('resolved')
    expect(st.winnerId).toBe('player')
    // bot3's cost is 21, so the player wins just under it.
    expect(st.price!).toBeLessThan(21)
    expect(st.price!).toBeGreaterThanOrEqual(15)
    // ⚠ A winner's exit price is CENSORED — the auction stopped before their limit.
    expect(playerExit(st, s).censored).toBe(true)
  })

  it('case 7 — all rival costs > 100: no bot ever bids; player wins unopposed at 100', () => {
    const s = base({
      bots: [
        { bidderId: 'bot1', cost: 101 },
        { bidderId: 'bot2', cost: 105 },
        { bidderId: 'bot3', cost: 108 },
        { bidderId: 'bot4', cost: 110 },
      ],
    })
    const opened = openAuction(s, 0)
    // ⚠ NOT ONE OF THEM IS "ABSENT BECAUSE cost > reserve" — every cost here is at or
    // under the reserve of 110. They are out because the FIRST LEGAL BID is 100 and none
    // can reach it. §4.1 records this as a known, accepted consequence of a coarse top
    // band.
    expect(opened.status).toBe('waiting')
    expect(opened.stopped.length).toBe(4)   // server-side truth; it reaches no client
    // ⚠ THE TOTAL IS UNCHANGED AT 5 — the auction's parameter, not a report on who is
    // left. There is no longer any count that reports that; see openView.ts.
    expect(totalBidderCount(s)).toBe(5)

    const { state: settled, commits } = runCascade(opened, s)
    expect(commits).toBe(0)
    expect(trace(settled)).toEqual([])
    expect(settled.standing).toBe(110)
    expect(settled.holder).toBeNull()

    const st = runCascade(bid(settled, s, 100), s).state
    expect(st.status).toBe('resolved')
    expect(st.winnerId).toBe('player')
    expect(st.price).toBe(100)
    expect(playerExit(st, s).censored).toBe(true)
  })

  it('case 8 — player idle after the cascade halts: the round does NOT resolve', () => {
    const s = base()
    const st = runCascade(openAuction(s, 0), s).state
    expect(st.status).toBe('waiting')
    expect(st.winnerId).toBeNull()
    expect(st.price).toBeNull()
    // No timeout, no clock, no resolution — however long the client keeps calling.
    for (const now of [1e6, 1e9, 1e12]) {
      const r = advanceOne(st, s, now)
      expect(r.committed).toBe(false)
      expect(r.state.status).toBe('waiting')
      expect(r.state.standing).toBe(48)
    }
    // Bid and Drop Out remain the only exits, and both still work.
    expect(playerBid(st, s, 46, st.sequence, 0).ok).toBe(true)
    expect(playerDropOut(st, s, 0).status).toBe('resolved')
  })

  // ── cases 9 + 10: the collision, in both directions ────────────────────────
  //
  // ⚠ THE SCENARIO HAS TO CONTAIN THE CONDITION (BUILD_NOTES §3). A collision needs a
  // MID-CASCADE state — a standing of 48 with a bot still able to answer — which the
  // reference field never produces, because there it halts at 48 precisely BECAUSE no
  // other bot can reach 46. Two cheap bots keep the cascade running through the prices
  // the spec's two cases name.
  const collisionSettings = () => base({
    bots: [{ bidderId: 'bot1', cost: 21 }, { bidderId: 'bot2', cost: 40 }],
  })

  /** The state the player was LOOKING AT: mid-cascade, standing 48, a bot still due. */
  const seenAt48 = (s: OpenSettings): OpenState => {
    let cur = openAuction(s, 0)
    for (let i = 0; i < 50; i++) {
      if (cur.standing === 48) return cur
      const r = advanceOne(cur, s, cur.nextBotAtMs ?? 0)
      if (!r.committed) break
      cur = r.state
    }
    throw new Error('never reached a standing of 48')
  }

  it('⚠ case 9 — a STALE SEQUENCE ALONE NEVER REJECTS: 42 still clears against 46', () => {
    // The case the prompt singles out. The player is looking at a standing of 48 and
    // decides on 42. A bot commits 46 before their click lands. 42 still clears the 2-ECU
    // minimum against 46, so it is ACCEPTED — being narrowly beaten to a bid is a real
    // thing that happens in live auctions, and surviving it gracefully is faithful as
    // well as kind (§4.6).
    const s = collisionSettings()
    const seen = seenAt48(s)
    const staleSequence = seen.sequence

    const moved = advanceOne(seen, s, seen.nextBotAtMs!).state
    expect(moved.standing).toBe(46)
    expect(moved.sequence).not.toBe(staleSequence)

    // Now the player's 42, declaring the OLD sequence.
    const r = playerBid(moved, s, 42, staleSequence, 0)
    expect(r.ok, 'a stale sequence alone must never reject').toBe(true)
    expect((r as { state: OpenState }).state.standing).toBe(42)
    expect((r as { state: OpenState }).state.holder).toBe('player')
  })

  it('case 10 — 47 against a moved standing of 46: rejected, and the new price is NAMED', () => {
    const s = collisionSettings()
    const seen = seenAt48(s)
    const staleSequence = seen.sequence
    const moved = advanceOne(seen, s, seen.nextBotAtMs!).state
    expect(moved.standing).toBe(46)

    const r = playerBid(moved, s, 47, staleSequence, 0)
    expect(r.ok).toBe(false)
    // The spec's own wording: the price moved, and here is the new minimum.
    expect((r as { reason: string }).reason)
      .toBe('The price moved to 46 while you were bidding. Minimum next bid is 44.')
    // And nothing changed.
    expect(moved.standing).toBe(46)
  })

  it('⚠ §4.2 THE PLAYER MAY NOT UNDERCUT THEMSELVES EITHER', () => {
    // The rule is stated for bidders, not for bots, and it is what makes the cascade
    // terminate. It is reachable for the player because §5.1 keeps the bid box live while
    // the bots are bidding: after their own bid they hold the price for a second or two
    // with Bid still enabled. Two clicks — or one duplicated request — would otherwise
    // walk them down against nobody at all.
    const s = base()
    const halted = runCascade(openAuction(s, 0), s).state
    const mine = bid(halted, s, 46)
    expect(mine.holder).toBe('player')
    expect(mine.status).toBe('bot_turn')      // the box is live here, by §5.1

    const again = playerBid(mine, s, 44, mine.sequence, 0)
    expect(again.ok).toBe(false)
    expect((again as { reason: string }).reason).toMatch(/cannot outbid yourself/i)
    expect(mine.standing).toBe(46)

    // ⚠ AND ONCE A BOT ANSWERS, THEY MAY BID AGAIN — the holder clause is about the
    // CURRENT holder, not a lock on the player. Getting this wrong would end the duel
    // after one exchange.
    const answered = runCascade(mine, s).state
    expect(answered.holder).toBe('bot3')
    expect(playerBid(answered, s, 42, answered.sequence, 0).ok).toBe(true)
  })

  it('⚠ the two rejections read DIFFERENTLY — "the price moved" only when it did', () => {
    // Without this the forgiving rule is invisible: 47 against a standing of 48 the
    // player is genuinely looking at is their own misreading of the step, and telling
    // them somebody beat them to it would be a lie.
    const s = collisionSettings()
    const seen = seenAt48(s)
    const r = playerBid(seen, s, 47, seen.sequence, 0)
    expect(r.ok).toBe(false)
    expect((r as { reason: string }).reason).toBe(
      'The current price is 48. You must bid at least 2 lower — 46 or less.')
  })

  it('case 11 — advance() before nextBotAt commits NOTHING; timing is server-checked', () => {
    const s = base()
    const opened = openAuction(s, 1_000)
    expect(opened.nextBotAtMs).toBe(1_800)

    for (const early of [0, 1_000, 1_799]) {
      const r = advanceOne(opened, s, early)
      expect(r.committed, `now=${early}`).toBe(false)
      expect(r.reason).toBe('not-due')
      // ⚠ The state comes back UNCHANGED — not re-settled, not re-scheduled. A client
      // that hammers advance() cannot push its own next bid further away, and cannot
      // pull it closer either.
      expect(r.state).toBe(opened)
    }
    // At the due time exactly, it commits.
    const r = advanceOne(opened, s, 1_800)
    expect(r.committed).toBe(true)
    expect(r.state.standing).toBe(100)
  })

  it('case 12 — a backgrounded tab PAUSES the auction and loses nothing', () => {
    const s = base()
    let cur = openAuction(s, 1_000)
    cur = advanceOne(cur, s, cur.nextBotAtMs!).state
    cur = advanceOne(cur, s, cur.nextBotAtMs!).state
    const parked = cur
    expect(parked.standing).toBe(90)
    expect(parked.history.length).toBe(2)

    // …two hours of nothing. No timeout, no forfeit, no state loss.
    const resumedAt = parked.nextBotAtMs! + 7_200_000
    const r = advanceOne(parked, s, resumedAt)
    expect(r.committed).toBe(true)
    expect(r.state.standing).toBe(80)
    expect(r.state.history.length).toBe(3)

    // ⚠ AND NO CATCH-UP BURST: the next bid is scheduled from NOW, not from when it would
    // have been due, so a player returning to a tab is not immediately swamped.
    expect(r.state.nextBotAtMs).toBe(resumedAt + 1_200)

    // The round still finishes exactly where it would have.
    expect(runCascade(r.state, s).state.standing).toBe(48)
  })
})

// ── the reserve as an entry gate (§4.1, §4.3) ─────────────────────────────────

describe('a lowered reserve prices bots out of the auction entirely', () => {
  it('⚠ they are out FROM THE OPENING, before anyone has acted', () => {
    // ⚠ WHAT SURVIVES OF §4.3'S REQUIREMENT. The clause that said "the active-bidder count
    // must reflect this from the opening" is superseded — there is no count (Elena,
    // 2026-08-04, openView.ts). The MECHANISM it was guarding is untouched and is what is
    // asserted here: a bot the reserve prices out is ABSENT from the auction from the
    // first moment, not a bidder who bids high.
    const s = base({ reserve: 60 })
    const opened = openAuction(s, 0)
    expect(opened.history).toEqual([])
    expect(opened.stopped).toContain('bot2')  // cost 88 > 60
    expect(opened.stopped).toContain('bot4')  // cost 63 > 60
    // bot1 (47) and bot3 (21) are under the reserve; the player is in.
    expect(opened.stopped).not.toContain('bot1')
    expect(opened.stopped).not.toContain('bot3')
    // ⚠ AND THE ONE NUMBER THE PLAYER IS TOLD DOES NOT MOVE. "There are 5 bidders in this
    // auction" is the opening parameter; it says nothing about who can still act.
    expect(totalBidderCount(s)).toBe(5)
  })

  it('a bot priced out never appears in the trace', () => {
    const s = base({ reserve: 60 })
    const opened = runCascade(openAuction(s, 0), s).state
    const ids = new Set(trace(opened).map(([id]) => id))
    expect(trace(opened).length).toBeGreaterThan(0)
    expect(ids.has('bot2')).toBe(false)
    expect(ids.has('bot4')).toBe(false)
  })

  it('lastBotBids reports a bot that never bid as null, not as zero', () => {
    const s = base({ reserve: 60 })
    const opened = runCascade(openAuction(s, 0), s).state
    const bids = lastBotBids(opened, s)
    expect(bids.length).toBe(4)
    expect(bids[1]).toBeNull()   // bot2, priced out
    expect(bids[3]).toBeNull()   // bot4, priced out
  })
})

// ── response ordering (§4.3) — the NEW RNG CONSUMER ───────────────────────────

describe('§4.3 response ordering among willing bots', () => {
  it('⚠ UNDER A BLANK SEED it is genuinely random — orderings differ across runs', () => {
    // The classroom shape. `makeRng(null, …)` is `Math.random`, so this is testing that
    // the machine actually consults the source rather than falling into a fixed order.
    const traces = new Set<string>()
    for (let i = 0; i < 40; i++) {
      const s = base({ order: 'random', rngAt: blankSeedRng })
      traces.add(JSON.stringify(trace(runCascade(openAuction(s, 0), s).state)))
    }
    expect(traces.size).toBeGreaterThan(1)
  })

  // ⚠⚠ THE TWO TESTS BELOW ARE THE NEGATIVE CONTROL, and the trap the prompt names.
  //
  // The state machine is re-entered from STORED state on every callable invocation, so a
  // stream keyed only by (participant, round) would be recreated at position 0 on every
  // decision and every decision in the round would draw the SAME value. Keying by
  // `state.decisions` — which is durable — is what prevents it.
  //
  // ⚠ MY FIRST VERSION OF THIS CONTROL PASSED UNDER THE MUTATION, which is BUILD_NOTES
  // §3's specimen collection gaining a fifth entry. It asserted only "more than one
  // distinct bidder appears". Under the mutation the draw is constant, so `pick` selects a
  // constant INDEX of the willing list — but the willing list's membership still changes
  // as the holder changes, so the bidder still alternates and the test still passed. It
  // asserted a property of the stream using a measurement that cannot see the stream.

  it('⚠ NEGATIVE CONTROL (a) — the draw is taken at 0, 1, 2, … : one per decision, no '
    + 'repeats and no gaps', () => {
    // The precise, deterministic form: watch which decision index each draw is keyed to.
    // A stream that restarts asks for index 0 every time; the positional convention
    // (rng.ts) also requires exactly one draw per decision point, with no gaps.
    const asked: number[] = []
    const s = base({
      bots: [
        { bidderId: 'bot1', cost: 12 },
        { bidderId: 'bot2', cost: 13 },
        { bidderId: 'bot3', cost: 14 },
        { bidderId: 'bot4', cost: 15 },
      ],
      order: 'random',
      rngAt: (d: number) => { asked.push(d); return makeRng('vector', `open:${d}`) },
    })
    const st = runCascade(openAuction(s, 0), s).state
    expect(trace(st).length).toBeGreaterThan(10)
    expect(asked.length).toBe(trace(st).length)
    expect(asked).toEqual(asked.map((_, i) => i))
  })

  it('⚠ NEGATIVE CONTROL (b) — and it SHOWS: over a long cascade every bot gets a turn', () => {
    // The behavioural form, which is what a reader actually cares about. Under a constant
    // draw the choice is `willing[k]` for a fixed k, and since the willing list is just
    // "everyone but the holder" that cycles between exactly TWO bidders forever — the
    // other two never bid at all. That is the "reads as mechanical" failure §4.3's random
    // ordering exists to prevent, and it is visible on screen.
    //
    // ⚠ TRIAL COUNT AND FAILURE PROBABILITY, STATED. 30 seeds; each cascade is ~30
    // decisions picking uniformly from 3 willing bots, so P(a given bot never bids in one
    // cascade) ≈ (2/3)^30 ≈ 5e-6 and P(a seed is short of all four) ≈ 2e-5. Requiring 28
    // of 30 fails by chance with probability ~1e-13. Under the mutation it is 0 of 30. A
    // test that flakes trains people to ignore red, so this one cannot.
    const bots = [
      { bidderId: 'bot1', cost: 12 },
      { bidderId: 'bot2', cost: 13 },
      { bidderId: 'bot3', cost: 14 },
      { bidderId: 'bot4', cost: 15 },
    ]
    let allFour = 0
    for (let i = 0; i < 30; i++) {
      const s = base({
        bots,
        order: 'random',
        rngAt: (d: number) => makeRng('vector', `open:${i}:${d}`),
      })
      const st = runCascade(openAuction(s, 0), s).state
      expect(trace(st).length).toBeGreaterThan(20)
      if (new Set(trace(st).map(([id]) => id)).size === 4) allFour++
    }
    expect(allFour).toBeGreaterThanOrEqual(28)
  })

  it('a seeded run reproduces exactly — the same decision index gives the same choice', () => {
    const mk = () => {
      const s = base({ order: 'random', rngAt: (d: number) => makeRng('same', `o:${d}`) })
      return trace(runCascade(openAuction(s, 0), s).state)
    }
    expect(mk().length).toBeGreaterThan(0)
    expect(mk()).toEqual(mk())
  })

  it('⚠ THE HALT PRICE IS ORDER-DEPENDENT — 48 or 46, not always 48', () => {
    // ⚠ A GENUINE FINDING, not a bug, and pinned so nobody "fixes" it later (BUILD_NOTES
    // §2). At a standing bid of 50 the ceiling is 48 and two bots have merit — bot1
    // (cost 47) and bot3 (cost 21):
    //
    //   • if bot3 takes 48, bot1 cannot answer (46 < 47) and the cascade HALTS AT 48;
    //   • if bot1 takes 48, bot3 CAN answer 46, and it halts one step lower AT 46.
    //
    // ⚠ TRIAL COUNT: 60 unseeded runs. Each halt price arises from one coin flip at the
    // 50-standing race, so P(all 60 land on the same side) = 2^-59. The set below cannot
    // come up short by chance.
    const prices = new Set<number>()
    for (let i = 0; i < 60; i++) {
      const s = base({ order: 'random', rngAt: blankSeedRng })
      prices.add(runCascade(openAuction(s, 0), s).state.standing)
    }
    expect(prices).toEqual(new Set([46, 48]))
  })

  it('the halt price never drops below the lowest bot cost, whatever the order', () => {
    // The property that IS guaranteed: bots never bid below cost, so the price cannot
    // fall past the cheapest supplier. This is the invariant the scatter's 45° benchmark
    // actually rests on.
    for (let i = 0; i < 60; i++) {
      const s = base({ order: 'random', rngAt: blankSeedRng })
      expect(runCascade(openAuction(s, 0), s).state.standing).toBeGreaterThanOrEqual(21)
    }
  })
})

// ── drop out (§4.5) ───────────────────────────────────────────────────────────

describe('§4.5 Drop Out', () => {
  it('is final — a bid after dropping out is refused, in those words', () => {
    const s = base()
    const st = playerDropOut(runCascade(openAuction(s, 0), s).state, s, 0)
    const r = playerBid(st, s, 40, st.sequence, 0)
    expect(r.ok).toBe(false)
    expect((r as { reason: string }).reason).toMatch(/dropped out/i)
  })

  it('the remaining bots settle IMMEDIATELY, in one commit, and the whole settling shows '
    + 'in the history (§4.4)', () => {
    // Drop out while the player HOLDS the low bid and bots can still answer: the bots
    // must walk the price down among themselves without the player calling advance().
    const s = base()
    let st = runCascade(openAuction(s, 0), s).state
    st = bid(st, s, 46)                          // player holds at 46; bot3 can answer
    expect(st.holder).toBe('player')
    const beforeLength = st.history.length

    const done = playerDropOut(st, s, 0)
    expect(done.status).toBe('resolved')
    expect(done.winnerId).toBe('bot3')
    // bot3 answers 44 and then cannot be undercut — it is the only bot left with merit.
    expect(done.price).toBe(44)
    // dropOut event + at least one bot bid, all in this one call.
    expect(done.history.length).toBeGreaterThan(beforeLength + 1)
    expect(done.nextBotAtMs).toBeNull()
  })

  it('dropping out twice is a no-op, not a second event', () => {
    const s = base()
    const once = playerDropOut(runCascade(openAuction(s, 0), s).state, s, 0)
    const twice = playerDropOut(once, s, 0)
    expect(twice).toBe(once)
  })
})
