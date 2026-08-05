import { describe, it, expect } from 'vitest'
import {
  openAuction, advanceOne, playerBid, playerDropOut, playerExit, replayPerfectPlay,
  type OpenSettings, type OpenState,
} from '../src/procurement/auction/openAuction'
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

// ── the perfect-play benchmark ────────────────────────────────────────────────

describe('§7 perfect play — replayed against the same bots at the same costs', () => {
  it('⚠ the trigger is MINIMUM NEXT BID, not the standing price', () => {
    // The trap the prompt names, in the benchmark rather than the robot. A player whose
    // cost is 47 facing a standing of 48 is looking at a price ABOVE their cost — but the
    // next legal bid is 46, already a loss. A benchmark comparing the standing would bid
    // into it and overstate what perfect play earns.
    const s = base({ bots: [{ bidderId: 'rival3', cost: 21 }] })
    const perfect = replayPerfectPlay(s, 47)
    expect(perfect.status).toBe('resolved')
    // rival3 can go all the way to 21, so perfect play at cost 47 never wins here.
    expect(perfect.winnerId).toBe('rival3')
    // And it never bid below its own cost on the way out.
    const mine = perfect.history.filter(e => e.kind === 'bid' && e.isPlayer)
    expect(mine.every(e => (e as { amount: number }).amount >= 47)).toBe(true)
  })

  it('perfect play wins when it is the cheapest bidder, and never bids below cost', () => {
    // Cost 15 is below every bot (cheapest is 21), so perfect play takes the contract.
    const s = base()
    const perfect = replayPerfectPlay(s, 15)
    expect(perfect.winnerId).toBe('player')
    expect(perfect.price!).toBeGreaterThanOrEqual(15)
    expect(perfect.price!).toBeLessThan(21)
    const mine = perfect.history.filter(e => e.kind === 'bid' && e.isPlayer)
    expect(mine.length).toBeGreaterThan(0)
    expect(mine.every(e => (e as { amount: number }).amount >= 15)).toBe(true)
  })

  it('⚠ it always terminates, over a wide sweep of costs and fields', () => {
    // The policy loop is the one place a "wait for the price to fall below my cost" bug
    // would hang forever rather than fail — the same shape as the robot trap. Asserted
    // over costs that sit above, between and below the bots'.
    let resolved = 0
    for (let cost = 5; cost <= 120; cost += 5) {
      for (const reserve of [110, 60]) {
        const s = base({ reserve, order: 'random', rngAt: () => Math.random })
        const perfect = replayPerfectPlay(s, cost)
        expect(perfect.status, `cost ${cost}, reserve ${reserve}`).toBe('resolved')
        resolved++
      }
    }
    expect(resolved).toBe(48)
  })

  it('perfect play never earns less than zero, and beats a quitter', () => {
    const s = base()
    // A player who quits at 60 leaves the contract to bot3 and earns nothing; perfect play
    // at the same cost wins it. Two routes to "the benchmark is worth something".
    const perfect = replayPerfectPlay(s, 18)
    const perfectProfit = perfect.winnerId === 'player' && perfect.price !== null
      ? perfect.price - 18
      : 0
    expect(perfectProfit).toBeGreaterThan(0)

    const quitter = playerDropOut(run(openAuction(s, 0), s), s, 0)
    expect(quitter.winnerId).not.toBe('player')
  })

  it('⚠ RECORDED, NOT EXACT — the halt price is order-dependent, so this is one sample', () => {
    // ⚠ CORRECTING THE PROMPT'S PREMISE, and worth a failing-loudly test rather than a
    // comment. "Bot behaviour is deterministic given bot costs" is true of each bot's
    // RULE but not of the auction: response ORDERING is seeded-random (§4.3), and
    // BUILD_NOTES §2 measured that moving the halt price by up to 10 ECU. So the benchmark
    // varies across orderings for identical costs.
    //
    // ⚠ TRIAL COUNT AND FAILURE PROBABILITY: 80 unseeded replays at a cost chosen to sit
    // inside the contested band. Under the correct implementation the ordering race at the
    // 50-standing step is a coin flip, so P(all 80 land identically) < 2^-79. If this ever
    // goes green with a single value, ordering has been made deterministic somewhere and
    // BUILD_NOTES §2's finding has been silently undone.
    const prices = new Set<number>()
    for (let i = 0; i < 80; i++) {
      const s = base({ order: 'random', rngAt: () => Math.random })
      const perfect = replayPerfectPlay(s, 22)
      prices.add(perfect.price ?? -1)
    }
    expect(prices.size).toBeGreaterThan(1)
    // The spread is small and bounded below by the cheapest bot's cost — it is noise
    // around a benchmark, not a different benchmark.
    for (const p of prices) expect(p).toBeGreaterThanOrEqual(21)
  })

  it('the replay does not disturb the real auction — it is a separate object entirely', () => {
    // Belt and braces on the call site's separate keying: the replay must not mutate the
    // settings or the state it was derived from.
    const s = base()
    const live = run(openAuction(s, 0), s)
    const before = JSON.stringify(live)
    replayPerfectPlay(s, 30)
    expect(JSON.stringify(live)).toBe(before)
  })
})

// ── the seeded path, for reproducibility ──────────────────────────────────────

describe('under a seed the benchmark reproduces exactly', () => {
  it('the same key gives the same replay', () => {
    const mk = () => {
      const s = base({ order: 'random', rngAt: (d: number) => makeRng('bench', `b:${d}`) })
      return replayPerfectPlay(s, 30).price
    }
    expect(mk()).toBe(mk())
  })

  it('⚠ and it varies WITHIN the replay — the decision index is in the key', () => {
    // The same trap as the live ordering stream (procurementOpenAuction.test.ts's negative
    // control): a stream keyed only by round would draw the same value at every decision.
    const asked: number[] = []
    const s = base({
      bots: [
        { bidderId: 'rival1', cost: 12 }, { bidderId: 'rival2', cost: 13 },
        { bidderId: 'rival3', cost: 14 }, { bidderId: 'rival4', cost: 15 },
      ],
      order: 'random',
      rngAt: (d: number) => { asked.push(d); return makeRng('bench', `b:${d}`) },
    })
    replayPerfectPlay(s, 11)
    expect(asked.length).toBeGreaterThan(5)
    expect(asked).toEqual(asked.map((_, i) => i))
  })
})
