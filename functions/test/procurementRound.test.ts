import { describe, it, expect } from 'vitest'
import {
  drawPlayerCost, resolveRound, validateBid, equilibriumSettingsFor, PLAYER_ID, rivalId,
} from '../src/procurement/round'
import { equilibriumBid } from '../src/procurement/auction/equilibrium'
import { DEFAULT_CONFIG, type ProcurementConfig } from '../src/procurement/config'

// ═══════════════════════════════════════════════════════════════════════════════
// round.ts — ONE SEALED ROUND as a pure function.
//
// ⚠ §7.1's conformance vector is asserted at the RESOLVER level in
// procurementResolve.test.ts, where the rival bids can be handed in directly. This file
// tests what round.ts ADDS on top of it: the two separately-keyed draws, β applied to the
// drawn rival costs, the §8 counterfactual and its branches, and `tiedAndLost`.
//
// ⚠ THE VECTOR'S SEMANTICS ARE RE-EXPRESSED HERE THROUGH DEGENERATE COST RANGES
// (min === max), which is the only way to pin exact rival bids through a seeded draw
// without pinning a seed — and a pinned seed would be testing the RNG, not the round.
// ═══════════════════════════════════════════════════════════════════════════════

const cfg = (over: Partial<ProcurementConfig> = {}): ProcurementConfig => ({
  ...DEFAULT_CONFIG, ...over,
})

/**
 * ⚠ THERE IS NO "FORCE THE RIVAL COSTS" HELPER, AND THE FIRST ATTEMPT AT ONE WAS WRONG.
 * Collapsing `rivalCostDist` to min === max does pin the draws — and it also pins θmax,
 * because `equilibriumSettingsFor` takes θmax FROM THAT RANGE (§5.2). Every rival then
 * bid β(c) with θmax = c, which returns c: the test measured a degenerate equilibrium
 * and called it the conformance vector.
 *
 * So the vector's SEMANTICS are asserted against the costs actually drawn: the player's
 * bid is placed relative to the round's own lowest rival bid. That is seed-independent,
 * it exercises the real β, and it cannot be satisfied by a degenerate one.
 */
const lowestRivalBid = (bids: readonly (number | null)[]): number =>
  Math.min(...bids.filter((b): b is number => b !== null))

// ── The two draws ──────────────────────────────────────────────────────────────

describe('§4 the player\'s cost is drawn on its own stream, at round start', () => {
  it('is a pure function of (seed, participant, round) — no stored flag needed', () => {
    const c = cfg()
    const a = drawPlayerCost('s', 'p1', 3, c)
    expect(drawPlayerCost('s', 'p1', 3, c)).toBe(a)
    // ⚠ A reload must not re-roll into a friendlier cost. That property is THIS.
    expect(drawPlayerCost('s', 'p1', 3, c)).toBe(a)
  })

  it('differs by participant and by round', () => {
    const c = cfg()
    const mine = Array.from({ length: 8 }, (_, i) => drawPlayerCost('s', 'p1', i + 1, c))
    const theirs = Array.from({ length: 8 }, (_, i) => drawPlayerCost('s', 'p2', i + 1, c))
    expect(new Set(mine).size).toBeGreaterThan(1)
    expect(mine.join()).not.toBe(theirs.join())
  })

  it('⚠ comes from the PLAYER range, which is narrower than the rivals\' (§5.2)', () => {
    const c = cfg()
    for (let r = 1; r <= 200; r++) {
      const v = drawPlayerCost('s', `p${r}`, r, c)
      expect(v).toBeGreaterThanOrEqual(c.playerCostDist.min)
      expect(v).toBeLessThanOrEqual(c.playerCostDist.max)
    }
    // The asymmetry is the design, not a bug: U[10,60] vs U[10,110].
    expect(c.playerCostDist.max).toBeLessThan(c.rivalCostDist.max)
  })

  it('⚠ the rival stream is INDEPENDENT of the player stream', () => {
    // Two instances differing ONLY in the player's range must draw the SAME rivals.
    // A shared stream would mean reaching the player's cost consumed the rivals' draws —
    // the "exists before the bid" state §4 forbids.
    const wide = cfg({ playerCostDist: { distribution: 'uniform', min: 10, max: 60, integer: true } })
    const narrow = cfg({ playerCostDist: { distribution: 'uniform', min: 10, max: 11, integer: true } })
    const a = resolveRound('s', 'p', 1, wide, 30, 50)
    const b = resolveRound('s', 'p', 1, narrow, 30, 50)
    expect(b.rivalCosts).toEqual(a.rivalCosts)
  })
})

describe('equilibriumSettingsFor', () => {
  it('⚠ takes θmax from the RIVAL range, never the player\'s (§5.2)', () => {
    const s = equilibriumSettingsFor(cfg())
    expect(s.rivalCostMax).toBe(110)
    expect(s.rivalCostMax).not.toBe(DEFAULT_CONFIG.playerCostDist.max)
  })

  it('n is rivals + 1', () => {
    expect(equilibriumSettingsFor(cfg({ rivalCount: 7 })).totalBidders).toBe(8)
  })
})

// ── The rivals bid β, always ───────────────────────────────────────────────────

describe('§5.1 every rival bids β at its own drawn cost', () => {
  it('holds for every rival in every round, across many seeds', () => {
    const c = cfg()
    const eq = equilibriumSettingsFor(c)
    for (let s = 0; s < 40; s++) {
      const r = resolveRound(`seed${s}`, 'p', (s % 8) + 1, c, 30, 45)
      expect(r.rivalBids).toHaveLength(c.rivalCount)
      r.rivalBids.forEach((bid, i) => {
        expect(bid).toBe(equilibriumBid(r.rivalCosts[i], eq))
      })
    }
  })

  it('a rival above the reserve makes NO bid — absent, not bidding high (§3.1)', () => {
    // A reserve BELOW the bottom of the rival range prices every rival out. The range
    // itself is untouched, so θmax is still the real 110 and β is still the real β.
    const priced = cfg({ reserve: 9 })
    const r = resolveRound('s', 'p', 1, priced, 8, 5)
    expect(r.rivalBids).toEqual([null, null, null, null])
    // The player alone is admissible, so they win at their own bid.
    expect(r.playerWon).toBe(true)
    expect(r.price).toBe(5)
  })

  it('§7 step 6 — nobody admissible means no award and no profit', () => {
    // Every rival priced out AND the player's own bid above the reserve. Reachable in
    // play only through an instructor's lowered reserve; validateBid refuses the bid at
    // submit, so this asserts the resolver's own step 6 rather than a live path.
    const r = resolveRound('s', 'p', 1, cfg({ reserve: 9 }), 40, 50)
    expect(r.winnerId).toBeNull()
    expect(r.price).toBeNull()
    expect(r.playerWon).toBe(false)
    expect(r.playerProfit).toBe(0)
  })
})

// ── The vector's semantics, at the round level ─────────────────────────────────

describe('§7.1 the conformance cases, re-expressed through the round', () => {
  const C = cfg()
  const COST = 34

  /** This seed's own lowest rival bid — the number every case below is placed against. */
  const floorFor = (seed: string) =>
    lowestRivalBid(resolveRound(seed, 'p', 1, C, COST, 110).rivalBids)

  it('case 1 — bidding ABOVE the lowest rival loses, and a loser earns exactly 0', () => {
    for (let s = 0; s < 30; s++) {
      const seed = `seed${s}`
      const floor = floorFor(seed)
      const r = resolveRound(seed, 'p', 1, C, COST, floor + 1)
      expect(r.price).toBe(floor)
      expect(r.playerWon).toBe(false)
      expect(r.playerProfit).toBe(0)
      expect(r.winnerId).not.toBe(PLAYER_ID)
    }
  })

  it('case 2 — bidding BELOW the lowest rival wins at your own bid (first price)', () => {
    for (let s = 0; s < 30; s++) {
      const seed = `seed${s}`
      const floor = floorFor(seed)
      const bid = floor - 1
      const r = resolveRound(seed, 'p', 1, C, COST, bid)
      expect(r.playerWon).toBe(true)
      expect(r.price).toBe(bid)
      expect(r.playerProfit).toBe(bid - COST)
    }
  })

  it('case 3 — MATCHING the lowest rival ties, and the player wins under EVERY seed', () => {
    // ⚠ Deterministic by nomination, not by luck. 60 seeds, because a tie broken by a
    // desynced stream still picks the player about half the time by chance — the exact
    // trap BUILD_NOTES §3 records. One seed here would be a coin flip wearing a test's
    // clothes.
    let ties = 0
    for (let s = 0; s < 60; s++) {
      const seed = `seed${s}`
      const floor = floorFor(seed)
      const r = resolveRound(seed, 'p', 1, C, COST, floor)
      expect(r.tie).toBe(true)
      expect(r.playerWon).toBe(true)
      expect(r.playerProfit).toBe(floor - COST)
      expect(r.tiedAndLost).toBe(false)
      ties++
    }
    // The scenario must actually CONTAIN the condition it claims to test.
    expect(ties).toBe(60)
  })

  it('case 4 — bidding below your own cost wins and LOSES MONEY', () => {
    // ⚠ Deliberately allowed (§6.2). Only counted on seeds where such a bid actually
    // wins — otherwise the assertion would be about a round that never happened.
    let checked = 0
    for (let s = 0; s < 40; s++) {
      const seed = `seed${s}`
      const floor = floorFor(seed)
      const bid = COST - 4
      if (bid >= floor) continue
      const r = resolveRound(seed, 'p', 1, C, COST, bid)
      expect(r.playerWon).toBe(true)
      expect(r.playerProfit).toBe(-4)
      checked++
    }
    expect(checked).toBeGreaterThan(0)
  })

  it('case 7 — a BOT-vs-BOT tie is broken by the seeded stream, and the player is not in it', () => {
    // Rivals drawn from a ONE-POINT range so they collide — and the reserve/θmax are
    // left at the instance's real values, so β is the real β.
    const W = cfg({ rivalCostDist: { distribution: 'uniform', min: 30, max: 30, integer: true } })
    // ⚠ θmax now comes from that range, so assert what β actually is rather than
    // assuming 46 — the mistake this file's helper note records.
    const first = resolveRound('t0', 'p', 1, W, 55, 110)
    const botBid = lowestRivalBid(first.rivalBids)
    const winners = new Set<string | null>()
    for (let s = 0; s < 60; s++) {
      const r = resolveRound(`t${s}`, 'p', 1, W, 55, botBid + 20)
      expect(r.tie).toBe(true)
      expect(r.playerWon).toBe(false)
      expect(r.playerProfit).toBe(0)
      // ⚠ NOT tiedAndLost: the player was not IN the tie, they were simply outbid.
      expect(r.tiedAndLost).toBe(false)
      winners.add(r.winnerId)
    }
    expect(winners.size).toBeGreaterThan(1)
    expect([...winners].every(w => w !== PLAYER_ID)).toBe(true)
  })

  it('case 8 — the EQUILIBRIUM bid still loses when a rival draws a low cost', () => {
    // The round §8's counterfactual message exists for: the student did nothing wrong
    // and still lost. Counted, so the test cannot pass on a set containing no such round.
    const eq = equilibriumSettingsFor(C)
    const beta = equilibriumBid(COST, eq)!
    let losses = 0
    for (let s = 0; s < 40; s++) {
      const seed = `seed${s}`
      const floor = floorFor(seed)
      if (floor >= beta) continue
      const r = resolveRound(seed, 'p', 1, C, COST, beta)
      expect(r.equilibriumBid).toBe(beta)
      expect(r.playerWon).toBe(false)
      expect(r.equilibriumWouldHaveWon).toBe(false)
      expect(r.equilibriumProfit).toBe(0)
      losses++
    }
    expect(losses).toBeGreaterThan(0)
  })
})

// ── tiedAndLost ────────────────────────────────────────────────────────────────

describe('tiedAndLost — the line the round result owes the student', () => {
  const C = cfg()
  const COST = 34
  const floorFor = (seed: string) =>
    lowestRivalBid(resolveRound(seed, 'p', 1, C, COST, 110).rivalBids)

  it('⚠ CANNOT fire today, and that is the nominated-preference rule working', () => {
    // The player is nominated, so a player-vs-bot tie always goes to the player. This
    // asserts the CONSEQUENCE rather than the mechanism: across 60 constructed ties the
    // player never loses one. Each iteration really does contain a tie — asserted, not
    // assumed, because a tie-handling test over tie-free rounds is BUILD_NOTES §3's
    // first specimen.
    for (let s = 0; s < 60; s++) {
      const seed = `seed${s}`
      const r = resolveRound(seed, 'p', 1, C, COST, floorFor(seed))
      expect(r.tie).toBe(true)
      expect(r.tiedAndLost).toBe(false)
    }
  })

  it('is false when the player loses WITHOUT tying — the common case', () => {
    const seed = 'seed1'
    const r = resolveRound(seed, 'p', 1, C, COST, floorFor(seed) + 3)
    expect(r.tie).toBe(false)
    expect(r.tiedAndLost).toBe(false)
  })

  it('the field is a real boolean on every round, not sometimes undefined', () => {
    // It feeds a screen conditional; `undefined` would silently render nothing rather
    // than failing, so the shape matters as much as the value.
    const floor = floorFor('seed2')
    for (const bid of [floor - 5, floor - 1, floor, floor + 1, floor + 9]) {
      expect(typeof resolveRound('seed2', 'p', 1, C, COST, bid).tiedAndLost).toBe('boolean')
    }
  })
})

// ── The §8 counterfactual ──────────────────────────────────────────────────────

describe('§8 the counterfactual', () => {
  const C = cfg()
  const COST = 34
  const BETA = equilibriumBid(COST, equilibriumSettingsFor(C))!
  const floorFor = (seed: string) =>
    lowestRivalBid(resolveRound(seed, 'p', 1, C, COST, 110).rivalBids)

  it('is β at the player\'s OWN cost, whatever they actually bid', () => {
    const floor = floorFor('seed3')
    for (const bid of [floor - 4, floor, floor + 6, 110]) {
      expect(resolveRound('seed3', 'p', 1, C, COST, bid).equilibriumBid).toBe(BETA)
    }
  })

  it('WOULD HAVE WON: the profit is β − cost, on the seeds where β clears the field', () => {
    let checked = 0
    for (let s = 0; s < 40; s++) {
      const seed = `seed${s}`
      if (floorFor(seed) <= BETA) continue
      // Their ACTUAL bid loses; β would have won. The two are independent, which is the
      // whole point of showing the counterfactual on a losing round.
      const r = resolveRound(seed, 'p', 1, C, COST, 110)
      expect(r.playerWon).toBe(false)
      expect(r.equilibriumWouldHaveWon).toBe(true)
      expect(r.equilibriumProfit).toBe(BETA - COST)
      checked++
    }
    expect(checked).toBeGreaterThan(0)
  })

  it('WOULD HAVE LOST: the profit is zero, never a negative', () => {
    let checked = 0
    for (let s = 0; s < 40; s++) {
      const seed = `seed${s}`
      if (floorFor(seed) >= BETA) continue
      const r = resolveRound(seed, 'p', 1, C, COST, 110)
      expect(r.equilibriumWouldHaveWon).toBe(false)
      expect(r.equilibriumProfit).toBe(0)
      checked++
    }
    expect(checked).toBeGreaterThan(0)
  })

  it('⚠ is null when the player\'s cost is above the reserve — no bid worth making', () => {
    const r = resolveRound('s', 'p', 1, cfg({ reserve: 30 }), 96, 25)
    expect(r.equilibriumBid).toBeNull()
    expect(r.equilibriumWouldHaveWon).toBe(false)
    expect(r.equilibriumProfit).toBe(0)
  })

  it('the whole resolution is PURE — same inputs, byte-identical output', () => {
    // ⚠ THIS REPLACED A VACUOUS TEST. The previous version claimed to prove the
    // counterfactual runs on its own tie stream, and did it by calling resolveRound
    // twice and comparing — which is deterministic by construction and would have passed
    // no matter which stream the counterfactual used. The separate keying is real (see
    // round.ts) but it is NOT externally observable from a single call site, so no
    // honest test here can assert it; the harness's cross-round stream checks are where
    // that property is actually defended. What IS observable, and worth pinning, is
    // purity — which is what lets the conformance vector and the harness call this
    // directly.
    for (let s = 0; s < 20; s++) {
      const seed = `pure${s}`
      const a = resolveRound(seed, 'p', 2, C, COST, 55)
      const b = resolveRound(seed, 'p', 2, C, COST, 55)
      expect(JSON.stringify(b)).toBe(JSON.stringify(a))
    }
  })

  it('β is the benchmark the scatter draws, so it matches equilibriumBid exactly', () => {
    const c = cfg()
    const eq = equilibriumSettingsFor(c)
    for (let s = 0; s < 30; s++) {
      const cost = drawPlayerCost(`s${s}`, 'p', 1, c)
      const r = resolveRound(`s${s}`, 'p', 1, c, cost, Math.min(110, cost + 10))
      expect(r.equilibriumBid).toBe(equilibriumBid(cost, eq))
    }
  })
})

// ── Bidder identity ────────────────────────────────────────────────────────────

describe('bidder ids', () => {
  it('rivals are 1-based in the id, 0-based in the array', () => {
    expect(rivalId(0)).toBe('rival1')
    expect(rivalId(3)).toBe('rival4')
  })

  it('the winner is either the player or one of this round\'s rivals', () => {
    const c = cfg()
    for (let s = 0; s < 30; s++) {
      const r = resolveRound(`s${s}`, 'p', 1, c, 30, 45)
      if (r.winnerId === null) continue
      expect([PLAYER_ID, ...r.rivalCosts.map((_, i) => rivalId(i))]).toContain(r.winnerId)
    }
  })
})

// ── validateBid ────────────────────────────────────────────────────────────────

describe('§6.2 validateBid — a VISIBLE gate, not a silent filter', () => {
  const c = cfg({ reserve: 90 })

  it('accepts a whole number at or below the reserve', () => {
    expect(validateBid(50, c)).toEqual({ ok: true, bid: 50 })
    expect(validateBid(90, c)).toEqual({ ok: true, bid: 90 })
    expect(validateBid(0, c)).toEqual({ ok: true, bid: 0 })
  })

  it('refuses above the reserve, in the spec\'s own words, naming the number', () => {
    const r = validateBid(91, c)
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.reason).toBe(
      'Bids above the reserve price of 90 will not be accepted.')
  })

  it('refuses decimals and non-numbers with a reason a student can act on', () => {
    expect(validateBid(45.5, c).ok).toBe(false)
    expect(validateBid('45', c).ok).toBe(false)
    expect(validateBid(null, c).ok).toBe(false)
    expect(validateBid(NaN, c).ok).toBe(false)
    expect(validateBid(Infinity, c).ok).toBe(false)
  })

  it('refuses a negative bid', () => {
    expect(validateBid(-1, c).ok).toBe(false)
  })

  it('⚠ ACCEPTS a bid below the player\'s own cost — §6.2, not an oversight', () => {
    // Losing money is a legitimate mistake and part of the lesson. There is no cost
    // parameter on this function at all, so a floor cannot be added without changing the
    // signature — which is the point.
    expect(validateBid(5, c)).toEqual({ ok: true, bid: 5 })
  })
})
