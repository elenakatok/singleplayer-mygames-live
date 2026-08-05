import { describe, it, expect } from 'vitest'
import {
  openAuction, advanceOne, playerBid, playerDropOut, playerExit,
  type OpenSettings, type OpenState,
} from '../src/procurement/auction/openAuction'
import { perfectPlayProfit } from '../src/procurement/auction/perfectPlay'
import { maxLegalBid } from '../src/procurement/auction/schedule'
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

describe('§7 a LOSER\'s exit price is their revealed stopping point', () => {
  it('the §8.2 duel: the player stops at 38, the price settles at 36, exit is 36', () => {
    const s = base()
    let st = run(openAuction(s, 0), s)
    for (const amount of [46, 42, 38]) st = bid(st, s, amount)
    const done = playerDropOut(st, s, 0)

    const exit = playerExit(done, s)
    // ⚠ THE STANDING THEY DECLINED TO BEAT — not their own last bid of 38. They were
    // looking at 36 and walked away; 36 is what was observed about their limit.
    expect(done.price).toBe(36)
    expect(exit.exitPrice).toBe(36)
    expect(exit.censored).toBe(false)
  })

  it('a player who never bids at all still has one — the price they walked away from', () => {
    const s = base()
    const halted = run(openAuction(s, 0), s)
    const done = playerDropOut(halted, s, 0)
    const exit = playerExit(done, s)
    expect(done.history.some(e => e.kind === 'bid' && e.isPlayer)).toBe(false)
    expect(exit.exitPrice).toBe(48)
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
      const s = base({ order: 'random', rngAt: () => Math.random })
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
    for (let i = 0; i < 300; i++) {
      const playerCost = 10 + (i % 45)
      const botCosts = [17 + (i * 7) % 80, 23 + (i * 13) % 70, 11 + (i * 29) % 90, 31 + (i * 3) % 60]
      const s = base({ bots: botCosts.map((cost, k) => ({ bidderId: `rival${k + 1}`, cost })),
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
      if (actual > benchmark) {
        beat++
        worstExcess = Math.max(worstExcess, actual - benchmark)
      }
    }
    expect(wins, 'the sweep must actually contain wins').toBeGreaterThan(20)

    // ⚠ THE BOUND. The largest step in the shipped schedule is 10, so an excess can never
    // reach it; in practice the rounds that settle in the fine bands cap it far lower.
    // If this ever fails, the closed form and the mechanism have parted company by more
    // than discretization explains, and that IS a defect rather than a rounding artifact.
    expect(worstExcess).toBeLessThan(10)

    // Recorded for the record rather than asserted tightly: the frequency is what tells
    // Elena whether "perfect play" reads as beatable on a student's screen.
    // eslint-disable-next-line no-console
    console.log(`      [measured] ${beat}/${wins} winning rounds beat the closed form; `
      + `worst excess ${worstExcess} ECU`)
  })
})
