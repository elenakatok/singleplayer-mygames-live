import { describe, it, expect } from 'vitest'
import {
  equilibriumBid, simpleEquilibriumBid, type EquilibriumSettings,
} from '../src/procurement/auction/equilibrium'

// ═══════════════════════════════════════════════════════════════════════════════
// β(c) — the conformance requirement from sealed spec §5.1, stated there in two parts:
//
//   1. "assert that at r = θmax the general form returns exactly the simple form's
//      values for the full cost range"
//   2. "and separately that at r < θmax bots with cost > r return no bid"
//
// ⚠ THE ORACLE IS WRITTEN FROM THE SPEC, NOT FROM THE IMPLEMENTATION.
// `simpleEquilibriumBid` is the lecture's formula — `c + (θmax − c)/n` — transcribed
// independently. Checking the general form against it is a real cross-check precisely
// because the two are different expressions that must agree at one setting and are free
// to disagree everywhere else.
// ═══════════════════════════════════════════════════════════════════════════════

/** Defaults: θmax = 110, r = 110, n = 5 → β(c) = 0.8c + 22. */
const DEFAULTS: EquilibriumSettings = { rivalCostMax: 110, reserve: 110, totalBidders: 5 }

describe('β — the spec\'s worked numbers (§5.1, §7.1)', () => {
  it('the four reference rival costs give the reference bids', () => {
    // §7.1: rival costs 47, 88, 21, 63 → bot bids 60, 92, 39, 72.
    expect(equilibriumBid(47, DEFAULTS)).toBe(60)
    expect(equilibriumBid(88, DEFAULTS)).toBe(92)
    expect(equilibriumBid(21, DEFAULTS)).toBe(39)
    expect(equilibriumBid(63, DEFAULTS)).toBe(72)
  })

  it('the player\'s equilibrium bid at cost 34 is 49', () => {
    // §7.1: "The player's equilibrium bid at cost 34 is 22 + 0.8(34) = 49.2 → 49."
    // The SAME function the bots play — §5.2 is the whole reason the scatter's optimal
    // line is a benchmark rather than an assertion.
    expect(equilibriumBid(34, DEFAULTS)).toBe(49)
  })

  it('β(θmax) = θmax — the degenerate point §7 step 2 relies on', () => {
    // "Bot bids never exceed the reserve: β(110) = 110." Both numerator and denominator
    // are zero here; a NaN would silently delete the highest-cost bot from the auction.
    expect(equilibriumBid(110, DEFAULTS)).toBe(110)
  })

  it('bot bids span 30–110 under defaults (§5.1)', () => {
    expect(equilibriumBid(10, DEFAULTS)).toBe(30)
    expect(equilibriumBid(110, DEFAULTS)).toBe(110)
  })
})

describe('β — conformance part 1: at r = θmax the general form IS the simple form', () => {
  it('agrees across the full rival cost range, every integer', () => {
    for (let c = 10; c <= 110; c++) {
      expect(equilibriumBid(c, DEFAULTS), `cost ${c}`)
        .toBe(simpleEquilibriumBid(c, 110, 5))
    }
  })

  it('agrees for other bidder counts too, so the collapse is not an n=5 coincidence', () => {
    for (const n of [2, 3, 4, 6, 9]) {
      const s: EquilibriumSettings = { rivalCostMax: 110, reserve: 110, totalBidders: n }
      for (let c = 10; c <= 110; c += 7) {
        expect(equilibriumBid(c, s), `n=${n} cost ${c}`).toBe(simpleEquilibriumBid(c, 110, n))
      }
    }
  })

  it('agrees for a different θmax', () => {
    const s: EquilibriumSettings = { rivalCostMax: 200, reserve: 200, totalBidders: 5 }
    for (let c = 0; c <= 200; c += 13) {
      expect(equilibriumBid(c, s), `cost ${c}`).toBe(simpleEquilibriumBid(c, 200, 5))
    }
  })
})

describe('β — conformance part 2: at r < θmax, a bot above the reserve does not bid', () => {
  const LOWERED: EquilibriumSettings = { rivalCostMax: 110, reserve: 90, totalBidders: 5 }

  it('returns null — ABSENT from the auction, not a bidder who bids high (§3.1)', () => {
    expect(equilibriumBid(91, LOWERED)).toBeNull()
    expect(equilibriumBid(110, LOWERED)).toBeNull()
  })

  it('a bot exactly at the reserve still bids, and bids exactly the reserve', () => {
    // β(r) = r + [(θmax−r)ⁿ − (θmax−r)ⁿ] / … = r. This is what guarantees no bot bid
    // ever exceeds the reserve, which §7 step 2 assumes.
    expect(equilibriumBid(90, LOWERED)).toBe(90)
  })

  it('no admissible cost produces a bid above the reserve — §7 step 2\'s assumption', () => {
    for (const reserve of [110, 100, 90, 75, 60, 40]) {
      const s: EquilibriumSettings = { rivalCostMax: 110, reserve, totalBidders: 5 }
      for (let c = 10; c <= reserve; c++) {
        const b = equilibriumBid(c, s)
        expect(b, `reserve ${reserve} cost ${c}`).not.toBeNull()
        expect(b!, `reserve ${reserve} cost ${c}`).toBeLessThanOrEqual(reserve)
      }
    }
  })

  // ══════════════════════════════════════════════════════════════════════════════
  // ⚠⚠ LOAD-BEARING — DO NOT DELETE, DO NOT WEAKEN, DO NOT MERGE INTO PART 1.
  //
  // This single assertion is the only thing standing between a plausible "harmless
  // cleanup" and a silently falsified benchmark, and the reason is precise:
  //
  //   • Part 1 above checks the general form against the lecture formula across the
  //     FULL cost range, every integer, several bidder counts and two values of θmax.
  //     It is a thorough test. It exercises ONLY r = θmax.
  //   • At r = θmax the two forms are mathematically identical. So if someone replaces
  //     `equilibriumBid` with `c + (θmax − c)/n` — a change that looks like removing
  //     dead arithmetic — EVERY TEST IN PART 1 STILL PASSES.
  //   • Only this assertion fails.
  //
  // What breaks if it is gone: the bots stop playing the equilibrium the moment an
  // instructor lowers the reserve, and the "Optimal" line on the §9 scatter — the one
  // thing that plot exists to assert — becomes a line the bots are visibly not on,
  // with nothing in the suite saying so. Verified by mutation on 2026-08-03: the
  // simplification is caught here and nowhere else.
  // ══════════════════════════════════════════════════════════════════════════════
  it('⚠ LOAD-BEARING: the general form diverges from the simple one once the reserve moves', () => {
    const LOW: EquilibriumSettings = { rivalCostMax: 110, reserve: 60, totalBidders: 5 }
    const general = equilibriumBid(40, LOW)
    const simple = simpleEquilibriumBid(40, 110, 5)
    expect(general).not.toBe(simple)
    // And the general form is the LOWER of the two: a binding reserve compresses the
    // markup, because the incumbent's price caps what anyone can hope to be paid.
    expect(general!).toBeLessThan(simple)
  })

  it('β is monotone in cost at a lowered reserve — no fold-back', () => {
    const LOW: EquilibriumSettings = { rivalCostMax: 110, reserve: 60, totalBidders: 5 }
    let prev = -Infinity
    for (let c = 10; c <= 60; c++) {
      const b = equilibriumBid(c, LOW)!
      expect(b, `cost ${c}`).toBeGreaterThanOrEqual(prev)
      // A bid is never below its own cost — the bots' floor.
      expect(b, `cost ${c}`).toBeGreaterThanOrEqual(c)
      prev = b
    }
  })
})
