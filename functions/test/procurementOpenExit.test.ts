import { describe, it, expect } from 'vitest'
import {
  openAuction, advanceOne, playerBid, playerDropOut, playerExit,
  type OpenSettings, type OpenState,
} from '../src/procurement/auction/openAuction'
import { perfectPlayProfit } from '../src/procurement/auction/perfectPlay'
import { maxLegalBid, stepAt } from '../src/procurement/auction/schedule'
import { makeRng } from '../src/procurement/auction/rng'

// ═══════════════════════════════════════════════════════════════════════════════
// CP4b ITEM 1 — EXIT-PRICE CAPTURE and the PERFECT-PLAY BENCHMARK (open §7).
//
// ⚠⚠ THE CENSORING DISTINCTION IS THE POINT, and it is a statistical claim, not a
// presentation choice:
//
//   • A LOSER's exit price is their REVEALED stopping point. They were standing at that
//     price and declined to beat it. Directly observed.
//   • A WINNER's final bid is NOT a stopping point. The auction ended before anybody
//     pushed them to their limit, so all that is known is that their limit was AT OR
//     BELOW it. The datum is CENSORED.
//
// The consequence the chart must not hide: **a winner sits ABOVE the 45° line even when
// playing perfectly**, because they stopped being pushed, not because they quit early.
// Pooling winners and losers makes a class of good players look like quitters.
//
// ⚠ BLANK SEED THROUGHOUT (`rngAt: () => Math.random`) — the classroom shape, from the
// start. See procurementOpenAuction.test.ts's header for why that matters here.
// ═══════════════════════════════════════════════════════════════════════════════

const SCHEDULE = [
  { above: 80, step: 10 }, { above: 50, step: 5 },
  { above: 30, step: 2 }, { above: 0, step: 1 },
]
const DELAYS = [
  { above: 80, delayMs: 800 }, { above: 50, delayMs: 1200 },
  { above: 30, delayMs: 2500 }, { above: 0, delayMs: 3000 },
]
const BOTS = [
  { bidderId: 'rival1', cost: 47 },
  { bidderId: 'rival2', cost: 88 },
  { bidderId: 'rival3', cost: 21 },
  { bidderId: 'rival4', cost: 63 },
]

const base = (over: Partial<OpenSettings> = {}): OpenSettings => ({
  reserve: 110,
  schedule: SCHEDULE,
  delaySchedule: DELAYS,
  playerId: 'player',
  // ⚠ THE MACHINE IS TOLD THE COST NOW — no bidder may bid below their own (2026-08-04).
  playerCost: 34,
  bots: BOTS,
  rngAt: () => Math.random,
  jitterAt: () => 0,
  order: 'lowestIndex',
  ...over,
})

const run = (st: OpenState, s: OpenSettings): OpenState => {
  let cur = st
  for (let i = 0; i < 300; i++) {
    const r = advanceOne(cur, s, cur.nextBotAtMs ?? 0)
    if (!r.committed) return r.state
    cur = r.state
  }
  throw new Error('did not settle')
}

const bid = (st: OpenState, s: OpenSettings, amount: number): OpenState => {
  const r = playerBid(st, s, amount, st.sequence, st.nextBotAtMs ?? 0)
  if (!r.ok) throw new Error(`bid ${amount} rejected: ${r.reason}`)
  return run(r.state, s)
}

// ── the two kinds of exit ─────────────────────────────────────────────────────

describe("§7 a LOSER's exit price is what they COMMITTED to, not where it ended", () => {
  it('the §8.2 duel: they stop at 38, the bots settle to 36, exit is 38', () => {
    // ⚠⚠ THIS ASSERTION IS INVERTED FROM CP4b's, AND THE OLD ONE WAS THE BUG. It read
    // `exitPrice === 36` — the standing they DECLINED, taken off the settled state — and
    // 36 also happened to be the final price, so it looked right. Exit is now their LAST
    // BID: 38 is the lowest price they actually committed to.
    const s = base()
    let st = run(openAuction(s, 0), s)
    for (const amount of [46, 42, 38]) st = bid(st, s, amount)
    const done = playerDropOut(st, s, 0)

    const exit = playerExit(done, s)
    expect(done.price).toBe(36)
    expect(exit.exitPrice).toBe(38)
    expect(exit.censored).toBe(false)
  })

  it('⚠⚠ THE REGRESSION PIN: when the settle moves the price, exit !== price', () => {
    // ⚠⚠ THE FIXTURE IS THE POINT AND IT IS BUILT DELIBERATELY. Every CP4b test used the
    // reference field 47/88/21/63, where after the player leaves the CHEAPEST bot already
    // holds and cannot undercut itself — the settle is a NO-OP, the price does not move,
    // and exit legitimately equals final. That is why `exit_price === price` in 100% of
    // rounds went unnoticed through two checkpoints.
    //
    // TWO CHEAP BOTS is what the live case had (cost 46, exit reported as 17): they duel
    // each other all the way down after the student is gone, so the final price ends far
    // below anything the student ever saw.
    const s = base({
      playerCost: 46,
      bots: [
        { bidderId: 'rival1', cost: 12 },
        { bidderId: 'rival2', cost: 14 },
        { bidderId: 'rival3', cost: 88 },
        { bidderId: 'rival4', cost: 63 },
      ],
    })

    // Advance to a standing where 50 is still a legal bid for this player, then bid and
    // leave — a student who quits while there is still room, which is the case the chart
    // is meant to catch.
    let st = openAuction(s, 0)
    for (let i = 0; i < 60 && maxLegalBid(st.standing, SCHEDULE) > 50; i++) {
      const r = advanceOne(st, s, st.nextBotAtMs ?? 0)
      if (!r.committed) break
      st = r.state
    }
    const r = playerBid(st, s, 50, st.sequence, 0)
    expect(r.ok, 'the fixture must let the player bid before the price passes their cost').toBe(true)
    const done = playerDropOut((r as { state: OpenState }).state, s, 0)

    // The settle really did move the price — the scenario contains the condition.
    expect(done.winnerId).not.toBe('player')
    expect(done.price!).toBeLessThan(20)

    const exit = playerExit(done, s)
    expect(exit.exitPrice).toBe(50)
    // ⚠ THE ASSERTION NOTHING MADE BEFORE. Under the old code this was `17 === 17`.
    expect(exit.exitPrice).not.toBe(done.price)
    expect(exit.exitPrice!).toBeGreaterThan(done.price!)
  })

  it('a player who never bids has NO exit price — null, not the price they walked from', () => {
    // They committed to nothing, so there is no revealed stopping point to record. Null
    // is omitted from the charts and counted separately; inventing a number here would
    // assert something never observed.
    const s = base()
    const halted = run(openAuction(s, 0), s)
    const done = playerDropOut(halted, s, 0)
    const exit = playerExit(done, s)
    expect(done.history.some(e => e.kind === 'bid' && e.isPlayer)).toBe(false)
    expect(exit.exitPrice).toBeNull()
    expect(exit.censored).toBe(false)
  })
})

describe('⚠⚠ §7 a WINNER\'s exit price is CENSORED', () => {
  it('a win against a field that cannot answer is censored at the winning bid', () => {
    // Every rival above the first legal bid of 100, so the player wins unopposed at 100 —
    // and nobody ever pushed them anywhere near their cost of 34.
    const s = base({
      bots: [
        { bidderId: 'rival1', cost: 101 }, { bidderId: 'rival2', cost: 105 },
        { bidderId: 'rival3', cost: 108 }, { bidderId: 'rival4', cost: 110 },
      ],
    })
    const st = bid(run(openAuction(s, 0), s), s, 100)
    expect(st.winnerId).toBe('player')

    const exit = playerExit(st, s)
    expect(exit.exitPrice).toBe(100)
    expect(exit.censored).toBe(true)

    // ⚠ THE CONSEQUENCE THE CHART MUST NOT HIDE. With a cost of 34 this player looks, on
    // a pooled scatter, like someone who quit 66 ECU early. They did not: they won. That
    // is why winners are a separate series, and why the flag is stored rather than
    // inferred from where the point happens to fall.
    const playerCost = 34
    expect(exit.exitPrice! - playerCost).toBe(66)
  })

  it('censored is TRUE for every winner and FALSE for every loser, across many draws', () => {
    // ⚠ TRIAL COUNT AND FAILURE PROBABILITY, STATED. 200 unseeded rounds over a range of
    // player costs chosen to straddle the bots' — cheap enough to win often, dear enough
    // to lose often. Both outcomes must actually OCCUR or the sweep proves nothing, which
    // is asserted below rather than assumed (BUILD_NOTES §3). With costs spanning 12..60
    // against rival costs 21..88, P(no win in 200) and P(no loss in 200) are each far
    // below 1e-6.
    let wins = 0, losses = 0
    for (let i = 0; i < 200; i++) {
      const playerCost = 12 + (i % 49)
      const s = base({ playerCost, order: 'random', rngAt: () => Math.random })
      let st = run(openAuction(s, 0), s)
      for (let k = 0; k < 60 && st.status === 'waiting'; k++) {
        const next = maxLegalBid(st.standing, SCHEDULE)
        if (next < playerCost) break
        st = bid(st, s, next)
      }
      if (st.status !== 'resolved') st = playerDropOut(st, s, 0)

      const exit = playerExit(st, s)
      const won = st.winnerId === 'player'
      // ⚠ DERIVED FROM A DIFFERENT SOURCE THAN ACTUAL: `won` is read off the resolved
      // state's winner id; `censored` comes out of `playerExit`. They must agree.
      expect(exit.censored, `round ${i}`).toBe(won)
      if (won) wins++; else losses++
    }
    expect(wins, 'the sweep must actually contain wins').toBeGreaterThan(10)
    expect(losses, 'and losses').toBeGreaterThan(10)
  })
})

// ── the perfect-play benchmark: THE CLOSED FORM ──────────────────────────────
//
// ⚠⚠ profit = (second-lowest cost among all bidders, including the player) − player cost,
// when the player is the cheapest; 0 otherwise. It replaced a sampled replay whose bot
// ORDERING made the number wobble by up to 10 ECU (BUILD_NOTES §2). Elena: the ordering
// noise is a LARGE-INCREMENT phenomenon, the endgame increments here are 2 and 1, and
// ordering changes the path, not the destination.
//
// ⚠ THE TEST THAT ASSERTED ORDERING VARIATION EXISTS IS GONE WITH IT. It was guarding the
// sampled implementation — that the replay really did sample — and not a property of the
// game. Keeping it would have pinned noise the benchmark no longer has.

describe('§7 perfect-play profit — the closed form', () => {
  it('the cheapest bidder wins the gap to the SECOND-lowest cost', () => {
    // Bots 47/88/21/63, player 15 → player is cheapest, second-lowest is 21.
    // ⚠ EXPECTED DERIVED BY HAND FROM THE SPEC'S OWN NUMBERS, not by re-running the helper.
    expect(perfectPlayProfit(15, [47, 88, 21, 63], 110, SCHEDULE))
      .toEqual({ won: true, price: 21, profit: 6 })
  })

  it('and earns NOTHING when somebody else is cheaper', () => {
    // Player 34 against a bot at 21: the bot can hold the price below anything the player
    // can profitably take, so perfect play wins nothing rather than winning at a loss.
    expect(perfectPlayProfit(34, [47, 88, 21, 63], 110, SCHEDULE))
      .toEqual({ won: false, price: null, profit: 0 })
  })

  it('⚠ a TIE at the lowest cost earns zero, not a negative or a win', () => {
    // There is nothing above cost left to take.
    expect(perfectPlayProfit(21, [47, 88, 21, 63], 110, SCHEDULE))
      .toEqual({ won: false, price: null, profit: 0 })
  })

  it('⚠⚠ an EMPTY field pays the first legal bid, not the reserve (§8.3 case 7)', () => {
    // Every rival above the ceiling of 100: the player wins unopposed AT 100. A closed
    // form without the ceiling cap would report a benchmark of 110 − cost and overstate
    // what was winnable by the whole top step.
    expect(perfectPlayProfit(34, [101, 105, 108, 110], 110, SCHEDULE))
      .toEqual({ won: true, price: 100, profit: 66 })
    expect(perfectPlayProfit(34, [], 110, SCHEDULE))
      .toEqual({ won: true, price: 100, profit: 66 })
  })

  it('⚠ §4.1\'s artifact falls out of the ceiling cap', () => {
    // A supplier costing 105 is under the reserve but can never bid — the first legal bid
    // is 100. The benchmark must not price the round as though it could.
    expect(perfectPlayProfit(20, [105], 110, SCHEDULE))
      .toEqual({ won: true, price: 100, profit: 80 })
  })

  it('a supplier above the reserve is ABSENT, and so is a player above it (§4.3)', () => {
    // reserve 60: bots at 88 and 63 are out of the auction entirely.
    expect(perfectPlayProfit(20, [88, 63, 47], 60, SCHEDULE))
      .toEqual({ won: true, price: 47, profit: 27 })
    // The student's own cost above the reserve leaves no bid worth making.
    expect(perfectPlayProfit(70, [88, 63, 47], 60, SCHEDULE))
      .toEqual({ won: false, price: null, profit: 0 })
  })

  it('⚠ never negative, over a wide sweep of costs and fields', () => {
    let checked = 0
    for (let cost = 1; cost <= 120; cost += 3) {
      for (const reserve of [110, 60]) {
        for (const bots of [[47, 88, 21, 63], [105], [], [10, 10, 10, 10]]) {
          const r = perfectPlayProfit(cost, bots, reserve, SCHEDULE)
          expect(r.profit, `cost ${cost}, reserve ${reserve}`).toBeGreaterThanOrEqual(0)
          expect(r.won === (r.price !== null)).toBe(true)
          if (r.won) expect(r.price!).toBeGreaterThanOrEqual(cost)
          checked++
        }
      }
    }
    expect(checked).toBe(320)
  })

  it('is a pure function of the costs — no RNG, no ordering, no seed', () => {
    // The property the closed form exists to have. Same inputs, same answer, always —
    // and the bots\' ORDER in the array cannot matter either.
    const a = perfectPlayProfit(15, [47, 88, 21, 63], 110, SCHEDULE)
    const b = perfectPlayProfit(15, [63, 21, 88, 47], 110, SCHEDULE)
    expect(a).toEqual(b)
    for (let i = 0; i < 20; i++) {
      expect(perfectPlayProfit(15, [47, 88, 21, 63], 110, SCHEDULE)).toEqual(a)
    }
  })
})

// ── ⚠⚠ THE DISCRETIZATION GAP, MEASURED AND REPORTED ─────────────────────────

describe('⚠⚠ a real player CAN exceed the closed form, by less than one endgame step', () => {
  // ⚠⚠ REPORTED, NOT SMOOTHED OVER. The closed form prices the contract at exactly the
  // second-lowest cost. The MECHANISM cannot: a bot stops when `standing − step < its
  // cost`, so a player holding the low bid wins at up to `secondLowest + step − 1`. The
  // benchmark is therefore beatable by at most one step minus one ECU — 1 in the fine
  // band, and only in a round that settles in a coarser one is it more.
  //
  // This is exactly the "≥ what the player earned" property Elena asked me to confirm, and
  // it is NOT guaranteed. It is bounded, and the bound is asserted rather than the
  // property being relaxed to "usually".

  it('measures the excess: bounded by the step in force where the round settled', () => {
    // ⚠ TRIAL COUNT AND FAILURE PROBABILITY: 300 unseeded rounds, player playing the
    // dominant strategy against random-ordered bots. The search is for rounds the player
    // WINS, which happens whenever their cost is lowest — roughly 39% of draws — so
    // P(fewer than 20 wins in 300) is far below 1e-6, and the sweep asserts it found some.
    let wins = 0
    let beat = 0
    let worstExcess = 0
    let worstBound = 0
    for (let i = 0; i < 300; i++) {
      const playerCost = 10 + (i % 45)
      const botCosts = [17 + (i * 7) % 80, 23 + (i * 13) % 70, 11 + (i * 29) % 90, 31 + (i * 3) % 60]
      const s = base({ playerCost, bots: botCosts.map((cost, k) => ({ bidderId: `rival${k + 1}`, cost })),
        order: 'random', rngAt: () => Math.random })

      let st = run(openAuction(s, 0), s)
      for (let k = 0; k < 200 && st.status === 'waiting'; k++) {
        const next = maxLegalBid(st.standing, SCHEDULE)
        if (next < playerCost) break
        st = bid(st, s, next)
      }
      if (st.status !== 'resolved') st = playerDropOut(st, s, 0)

      const actual = st.winnerId === 'player' && st.price !== null ? st.price - playerCost : 0
      const benchmark = perfectPlayProfit(playerCost, botCosts, 110, SCHEDULE).profit
      if (st.winnerId === 'player') wins++

      // ⚠⚠ THE BOUND IS BAND-DERIVED, NOT A CONSTANT (Elena, 2026-08-04). The runner-up
      // stops when `standing − step(standing) < its cost`, so the winner can hold at up to
      // `secondLowest + step(P) − 1` where P is the price the round ACTUALLY settled at.
      // That is 1 in the step-2 band and 4 in the step-5 band — so a constant is either
      // wrong or useless. The first version asserted `< 10`, the schedule's largest step:
      // never red, and blind to an excess of 6 in a band whose true bound is 1.
      const bound = st.price !== null ? stepAt(st.price, SCHEDULE) - 1 : 0
      if (actual > benchmark) {
        beat++
        worstExcess = Math.max(worstExcess, actual - benchmark)
        worstBound = Math.max(worstBound, bound)
        expect(
          actual - benchmark,
          `round ${i}: settled at ${st.price} (step ${stepAt(st.price!, SCHEDULE)}), `
          + `excess ${actual - benchmark} must not exceed ${bound}`,
        ).toBeLessThanOrEqual(bound)
      }
    }
    expect(wins, 'the sweep must actually contain wins').toBeGreaterThan(20)
    expect(beat, 'and the gap this documents must actually occur').toBeGreaterThan(0)

    // Recorded for the record rather than asserted tightly: the frequency is what tells
    // Elena whether "perfect play" reads as beatable on a student's screen.
    // eslint-disable-next-line no-console
    console.log(`      [measured] ${beat}/${wins} winning rounds beat the closed form; `
      + `worst excess ${worstExcess} ECU (band bound there: ${worstBound})`)
  })
})

// ── PART 1/2 — THE COST FLOOR AND AUTO-DROP ──────────────────────────────────
//
// ⚠⚠ NO BIDDER MAY BID BELOW THEIR OWN COST (Elena, 2026-08-04). §4.3 already bound the
// bots; the player was the only bidder in the auction allowed to do what none of the
// others could. It SUPERSEDES §8.3 case 4 ("legal and allowed … never blocked").

describe('§4.3 (extended) the player may not bid below their own cost', () => {
  it('a below-cost bid is REFUSED, with both numbers named', () => {
    const s = base({ playerCost: 34 })
    const st = run(openAuction(s, 0), s)
    const r = playerBid(st, s, 33, st.sequence, 0)
    expect(r.ok).toBe(false)
    expect((r as { reason: string }).reason).toBe(
      'Your cost is 34. A bid of 33 would be below it, and no bidder in this auction may '
      + 'bid below their own cost.')
    // A refused bid changes nothing.
    expect(st.standing).toBe(48)
  })

  it('a bid exactly AT cost is allowed — the rule is `>=`, as it is for the bots', () => {
    // §4.3's `>=` for bots read inclusively: a bot bids at cost for zero profit. The
    // player is bound by the same character, not a stricter one.
    const s = base({ playerCost: 46 })
    const st = run(openAuction(s, 0), s)
    expect(playerBid(st, s, 46, st.sequence, 0).ok).toBe(true)
  })
})

describe('⚠⚠ AUTO-DROP — the price passes the player, and it must never steal a win', () => {
  it('fires when a BOT bid lands below the cost, and the exit is the COST', () => {
    // ⚠ THE EXIT IS COST, NOT THE LAST BID. A passive player who bid 50 and then watched
    // the bots walk past them has a last bid of 50, which would read as "quit early, left
    // 4 unclaimed". Nothing they did says that: the auction went below what they were
    // allowed to pay, and their cost is exactly that boundary.
    const s = base({
      playerCost: 46,
      bots: [
        { bidderId: 'rival1', cost: 12 },
        { bidderId: 'rival2', cost: 14 },
        { bidderId: 'rival3', cost: 88 },
        { bidderId: 'rival4', cost: 63 },
      ],
    })
    let st = openAuction(s, 0)
    for (let i = 0; i < 60 && maxLegalBid(st.standing, SCHEDULE) > 50; i++) {
      st = advanceOne(st, s, st.nextBotAtMs ?? 0).state
    }
    st = (playerBid(st, s, 50, st.sequence, 0) as { state: OpenState }).state
    expect(st.playerOut).toBe(false)

    // Let the bots run. The first one to land below 46 removes the player.
    const done = run(st, s)
    expect(done.playerOut).toBe(true)
    expect(done.playerExitKind).toBe('autoDrop')
    expect(done.playerExitPrice).toBe(46)
    expect(playerExit(done, s).exitPrice).toBe(46)
    // ⚠ NOT CLAMPED to the last bid of 50, and not left AS the last bid either.
    expect(playerExit(done, s).exitPrice).not.toBe(50)
    // And the history says what happened, in its own kind.
    expect(done.history.some(e => e.kind === 'autoDrop')).toBe(true)
    expect(done.history.some(e => e.kind === 'dropOut')).toBe(false)
  })

  it('⚠⚠ FIRES AT THE COST EXACTLY, not only below it (Elena, 2026-08-11)', () => {
    // MUTANT: revert the guard to `amount < s.playerCost`. → fails.
    // WHY THE BOUNDARY MOVED: at the moment a bot holds AT the player's cost, every bid
    // the player could make must undercut it by at least the step, so every one of them is
    // below their own cost and refused. They are priced out in fact; under `<` they stayed
    // in the auction until they pressed Drop Out, and the record then called it a
    // voluntary drop.
    //
    // ⚠ CONSTRUCTED SO A BOT BID LANDS ON THE COST EXACTLY. The ladder from the reserve is
    // 110 → 100 → 90 → 80 → 75 → … → 50 → 48 → 46 → 44 → 42 → 40 → …, so 40 is a rung.
    // ⚠ TWO BOTS, NOT ONE: a bot may not undercut itself (§4.2), so a lone bot bids once
    // and the cascade halts. Two low-cost bots alternate all the way down.
    const s = base({
      playerCost: 40,
      bots: [{ bidderId: 'rival3', cost: 21 }, { bidderId: 'rival5', cost: 22 }],
    })

    // ⚠⚠ STEP THE CASCADE ONE BID AT A TIME AND STOP THE INSTANT THE STANDING IS 40.
    // Running it to completion does NOT discriminate: under the old `<` the bots simply
    // carry on to 38, which IS below the cost, so the player ends up auto-dropped either
    // way and every end-state assertion passes under both. The claim is about WHEN it
    // fires, so the test has to look at the moment it fires. (First version of this test
    // ran to completion and the reverted-to-`<` mutant SURVIVED.)
    // Walk to 42 — the rung above the cost — leaving the NEXT bot bid to land on 40 exactly.
    let st = openAuction(s, 0)
    for (let i = 0; i < 60 && st.standing > 42; i++) {
      st = advanceOne(st, s, st.nextBotAtMs ?? 0).state
    }
    expect(st.standing).toBe(42)
    expect(st.playerOut).toBe(false)          // still in, one rung above their cost

    // ⚠⚠ ONE MORE BOT BID — it lands on 40, the cost exactly. THAT is what must remove them.
    // Under the old `<` this call left `playerOut` false and the player sat in an auction
    // they could no longer act in. Running the cascade to COMPLETION does not discriminate:
    // the bots carry on to 38 either way, so every end-state assertion passes under both
    // comparisons. (The first version of this test did exactly that and the mutant SURVIVED.)
    st = advanceOne(st, s, st.nextBotAtMs ?? 0).state

    expect(st.history.some(e => e.kind === 'bid' && e.amount === 40)).toBe(true)
    expect(st.playerOut).toBe(true)
    expect(st.playerExitKind).toBe('autoDrop')
    expect(st.playerExitPrice).toBe(40)
    // ⚠ THE AUTO-DROP LANDS BEFORE ANY BID BELOW THE COST. The player's removal is a
    // response to the bid AT 40, not to a later one at 38 — which is the whole distinction
    // between `<=` and `<`.
    const hist = st.history
    const at40 = hist.findIndex(e => e.kind === 'bid' && e.amount === 40)
    const dropAt = hist.findIndex(e => e.kind === 'autoDrop')
    const firstBelow = hist.findIndex(e => e.kind === 'bid' && (e.amount ?? 99) < 40)
    expect(dropAt).toBe(at40 + 1)
    expect(firstBelow === -1 || dropAt < firstBelow).toBe(true)
  })

  it('⚠ the recorded exit price is the COST, not the bot bid that triggered it', () => {
    // MUTANT: record `amount` instead of `s.playerCost`. → fails on the strict-below case,
    // where the two differ. (At the boundary they are equal, which is exactly why the
    // strict-below case is the one that discriminates.)
    // ⚠ 46 is a rung on the ladder, so the trigger and the cost would coincide — which is
    // the case that does NOT discriminate. Cost 45 is NOT a rung: the cascade steps 46 → 44,
    // so the triggering bid is 44 and the recorded exit must still be 45.
    const s = base({
      playerCost: 45,
      bots: [{ bidderId: 'rival3', cost: 21 }, { bidderId: 'rival5', cost: 22 }],
    })
    const done = run(openAuction(s, 0), s)
    expect(done.playerExitKind).toBe('autoDrop')
    expect(done.playerExitPrice).toBe(45)
    expect(playerExit(done, s).exitPrice).toBe(45)
    expect(done.playerExitPrice).not.toBe(44)   // ⚠ not the bid that triggered it
  })

  it('⚠ a bot bid one ABOVE the cost does NOT auto-drop — the boundary is `<=`, not `<= +1`', () => {
    // MUTANT: widen to `amount <= s.playerCost + 1`. → fails. Both bots floor at 40, so the
    // lowest bid either will make is 40 — one above the player's cost of 39, and the player
    // must still be IN.
    const s = base({
      playerCost: 39,
      bots: [{ bidderId: 'rival3', cost: 40 }, { bidderId: 'rival5', cost: 40 }],
    })
    const done = run(openAuction(s, 0), s)
    expect(done.standing).toBe(40)
    expect(done.playerOut).toBe(false)
    expect(done.playerExitKind).toBeNull()

    // ⚠⚠ AND HERE IS THE RESIDUAL GAP, PINNED RATHER THAN FIXED. The player is still in the
    // auction and has NO legal move: the standing is 40, the step at 40 is 2, so the best
    // they may bid is 38 — below their cost of 39 and refused — while 39 itself does not
    // clear the minimum. Item 1 closed the boundary AT the cost; it does not close the
    // window `cost < standing < cost + step`, which is non-empty wherever the step exceeds
    // 1 (the shipped ladder uses steps of 10, 5 and 2 above a price of 30). Elena's stated
    // reason for the change — "at that point the player has no legal move" — applies here
    // too. REPORTED, NOT CHANGED: widening further is her call, not a test's.
    expect(maxLegalBid(done.standing, SCHEDULE)).toBe(38)
    expect(playerBid(done, s, 39, done.sequence, 0).ok).toBe(false)
    expect(playerBid(done, s, 38, done.sequence, 0).ok).toBe(false)
  })

  it('⚠⚠ THE HOLDER CLAUSE IS AN INVARIANT, NOT A LIVE FILTER — dropping it changes nothing', () => {
    // MUTANT: delete `next.holder !== s.playerId` from the guard. → this test still passes,
    // and that is the POINT: the clause cannot fire, because the check runs only inside
    // `commitOneBotBid`, where `next.holder` was just set to a bot's id from `willingBots`
    // (which filters `s.bots`, an array the player is never in).
    //
    // ⚠ THE ROUND-STEALING CASE IS PREVENTED ONE LEVEL UP, and this asserts that directly:
    // a player holding at their own cost with every bot stopped produces NO bot bid at all,
    // so the auto-drop check is never reached. The mutant that WOULD break it is one that
    // let this run on a player bid — which is why the assertion is about the winning path
    // rather than about the clause.
    const s = base({ playerCost: 34, bots: [{ bidderId: 'rival1', cost: 47 }, { bidderId: 'rival2', cost: 63 }] })
    let st = run(openAuction(s, 0), s)
    for (let k = 0; k < 60 && st.status === 'waiting'; k++) {
      const next = maxLegalBid(st.standing, SCHEDULE)
      if (next < 34) break
      st = bid(st, s, next)
    }
    expect(st.winnerId).toBe('player')
    expect(st.playerOut).toBe(false)
    expect(st.history.some(e => e.kind === 'autoDrop')).toBe(false)
  })

  it('⚠⚠ NEVER fires on a player holding at their own cost with every bot stopped — '
    + 'that is the normal WINNING path', () => {
    // The case Elena singled out. The player holds the low bid AT their cost; no bot can
    // beat it; nobody bids; the player WINS. Auto-drop firing here would steal the round.
    //
    // ⚠ IT IS STRUCTURAL, not a guard somebody has to remember: auto-drop runs only on a
    // BOT bid, so the holder is that bot — and a player who holds is standing at their own
    // bid, which cannot be below their own cost. Asserted anyway, because "cannot happen"
    // is what every stolen round is made of.
    const s = base({
      playerCost: 34,
      bots: [{ bidderId: 'rival1', cost: 47 }, { bidderId: 'rival2', cost: 63 }],
    })
    let st = run(openAuction(s, 0), s)
    // Walk down to exactly 34 — the dominant strategy, bidding at cost for zero margin.
    for (let k = 0; k < 60 && st.status === 'waiting'; k++) {
      const next = maxLegalBid(st.standing, SCHEDULE)
      if (next < 34) break
      st = bid(st, s, next)
    }
    expect(st.status).toBe('resolved')
    expect(st.winnerId).toBe('player')
    expect(st.playerOut).toBe(false)
    expect(st.playerExitKind).toBeNull()
    // The win is theirs and it is CENSORED — nobody pushed them lower.
    const exit = playerExit(st, s)
    expect(exit.censored).toBe(true)
    expect(exit.exitPrice).toBe(st.price)
    expect(st.history.some(e => e.kind === 'autoDrop')).toBe(false)
  })

  it('⚠ and never fires across a wide sweep whenever the player is the winner', () => {
    // ⚠ TRIAL COUNT: 150 unseeded rounds with the player playing the dominant strategy.
    // A win happens whenever their cost is lowest — roughly 39% of draws — so the sweep
    // contains plenty, asserted below rather than assumed.
    let wins = 0
    for (let i = 0; i < 150; i++) {
      const playerCost = 10 + (i % 50)
      const s = base({ playerCost, order: 'random', rngAt: () => Math.random })
      let st = run(openAuction(s, 0), s)
      for (let k = 0; k < 80 && st.status === 'waiting'; k++) {
        const next = maxLegalBid(st.standing, SCHEDULE)
        if (next < playerCost) break
        st = bid(st, s, next)
      }
      if (st.status !== 'resolved') st = playerDropOut(st, s, 0)
      if (st.winnerId === 'player') {
        wins++
        expect(st.playerExitKind, `round ${i}: a winner must not be auto-dropped`).toBeNull()
        expect(st.playerOut, `round ${i}`).toBe(false)
      }
    }
    expect(wins, 'the sweep must actually contain wins').toBeGreaterThan(15)
  })
})
