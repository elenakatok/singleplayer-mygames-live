import { describe, it, expect } from 'vitest'
import {
  competitorPrice, gridBestReply, continuousBestReply, priceGrid,
  isPricingStrategy, PRICING_STRATEGIES, STRATEGY_DESCRIPTIONS,
} from '../src/pricing/strategy'
import { computeRound, DEFAULT_MARKET, type PricingMarketConfig } from '../src/pricing/market'

// ═══════════════════════════════════════════════════════════════════════════════
// The competitor strategy library (spec §5).
//
// Two things are being pinned here. First, the SPEC'S OWN WORKED EXAMPLES — the
// competitor undercuts a high price and prices above a low one, exactly as the case's
// payoff table suggests. Second, that the grid argmax IS the continuous best reply
// snapped to the grid, checked across the whole grid rather than at a few points:
// the argmax is the implementation (so an edited market can never disagree with the
// competitor's behaviour), and the algebra is the thing it has to keep agreeing with.
// ═══════════════════════════════════════════════════════════════════════════════

const M = DEFAULT_MARKET
const STANDARD = 'standard-highstart-bestreply'
const PMG = 'pmg-ceiling'

/** The nearest grid point to `x`, ties going to the HIGHER price (spec §5). Written
 *  from the spec, not from the implementation — this is the independent model. */
function snapToGrid(x: number, grid: readonly number[]): number {
  let best = grid[0]
  let bestDistance = Infinity
  for (const g of grid) {
    const d = Math.abs(g - x)
    if (d < bestDistance - 1e-9 || (Math.abs(d - bestDistance) <= 1e-9 && g > best)) {
      bestDistance = d
      best = g
    }
  }
  return best
}

describe('the price grid', () => {
  it('is the price bounds in $100 steps', () => {
    expect(priceGrid(M)).toEqual([900, 1000, 1100, 1200, 1300, 1400, 1500, 1600, 1700, 1800, 1900, 2000])
  })
  it('always includes the ceiling, even when the step does not divide the band', () => {
    const odd: PricingMarketConfig = { ...M, minPrice: 900, maxPrice: 1950 }
    const grid = priceGrid(odd)
    expect(grid[grid.length - 1]).toBe(1950)
    // …and does not double it up when the step DOES divide the band.
    expect(priceGrid(M).filter(p => p === 2000)).toHaveLength(1)
  })
})

describe('standard-highstart-bestreply — the spec’s worked examples (§5)', () => {
  it('round 1 ALWAYS posts the ceiling — every student sees the same opening', () => {
    expect(competitorPrice(STANDARD, [], M, false)).toBe(2000)
  })

  it('UNDERCUTS a high price: student $2,000 → competitor $1,800', () => {
    expect(competitorPrice(STANDARD, [2000], M, false)).toBe(1800)
  })

  it('prices ABOVE a low price: student $900 → competitor $1,200', () => {
    expect(competitorPrice(STANDARD, [900], M, false)).toBe(1200)
  })

  it('student $1,400 → competitor $1,500', () => {
    expect(competitorPrice(STANDARD, [1400], M, false)).toBe(1500)
  })

  it('an exact tie goes to the HIGHER price', () => {
    // Student $1,350 puts the continuous optimum at exactly $1,450 — dead between
    // two grid points, so both are worth the same to the competitor.
    expect(continuousBestReply(1350, M)).toBe(1450)
    const low = computeRound(1350, 1400, M, false).competitorProfit
    const high = computeRound(1350, 1500, M, false).competitorProfit
    expect(low).toBeCloseTo(high, 6)
    expect(competitorPrice(STANDARD, [1350], M, false)).toBe(1500)
  })

  it('reads ONLY the student’s most recent price', () => {
    expect(competitorPrice(STANDARD, [900, 1000, 2000], M, false)).toBe(1800)
    expect(competitorPrice(STANDARD, [2000, 2000, 900], M, false)).toBe(1200)
  })

  it('is pure — same history, same answer, and the history is never mutated', () => {
    const history = Object.freeze([1500, 1700])
    expect(competitorPrice(STANDARD, history, M, false))
      .toBe(competitorPrice(STANDARD, history, M, false))
    expect(history).toEqual([1500, 1700])
  })

  it('play converges toward the interior Nash from above', () => {
    // The pedagogy in one test: a student who simply best-replies back settles near
    // $1,394 / $1,472 rather than at the ceiling.
    let studentHistory: number[] = []
    let rival = competitorPrice(STANDARD, studentHistory, M, false)
    for (let round = 0; round < 12; round++) {
      // The student's own best reply to what the competitor just posted.
      const mine = snapToGrid((M.studentBaseShare * M.slope + M.studentUnitCost + rival) / 2, priceGrid(M))
      studentHistory = [...studentHistory, mine]
      rival = competitorPrice(STANDARD, studentHistory, M, false)
    }
    expect(Math.abs(studentHistory[studentHistory.length - 1] - 1394)).toBeLessThanOrEqual(100)
    expect(Math.abs(rival - 1472)).toBeLessThanOrEqual(100)
    expect(rival).toBeLessThan(2000)
  })
})

describe('the grid argmax IS the continuous best reply, snapped — across the WHOLE grid', () => {
  it('agrees at every grid price a student could have posted', () => {
    for (const studentPrice of priceGrid(M)) {
      const expected = snapToGrid(continuousBestReply(studentPrice, M), priceGrid(M))
      expect(gridBestReply(studentPrice, M, false)).toBe(expected)
    }
  })

  it('agrees at every WHOLE-DOLLAR price a student could have posted', () => {
    // Student entry is continuous within the bounds, not grid-snapped (spec §3), so
    // the rule has to hold off-grid too — all 1,101 of them.
    for (let studentPrice = M.minPrice; studentPrice <= M.maxPrice; studentPrice++) {
      const expected = snapToGrid(continuousBestReply(studentPrice, M), priceGrid(M))
      expect(gridBestReply(studentPrice, M, false)).toBe(expected)
    }
  })

  it('and it really is an argmax: no grid price beats the one chosen', () => {
    for (const studentPrice of [900, 1234, 1400, 1777, 2000]) {
      const chosen = gridBestReply(studentPrice, M, false)
      const chosenProfit = computeRound(studentPrice, chosen, M, false).competitorProfit
      for (const p of priceGrid(M)) {
        expect(computeRound(studentPrice, p, M, false).competitorProfit)
          .toBeLessThanOrEqual(chosenProfit + 1e-6)
      }
    }
  })

  it('follows an EDITED market rather than the shipped numbers', () => {
    // The reason the argmax is the implementation: change the competitor's cost and
    // its behaviour has to move with it, with no formula left behind to go stale.
    const edited: PricingMarketConfig = { ...M, competitorUnitCost: 1400 }
    for (const studentPrice of priceGrid(edited)) {
      expect(gridBestReply(studentPrice, edited, false))
        .toBe(snapToGrid(continuousBestReply(studentPrice, edited), priceGrid(edited)))
    }
    // …and it is genuinely a different rule now.
    expect(gridBestReply(2000, edited, false)).not.toBe(gridBestReply(2000, M, false))
  })

  it('stays inside the price bounds everywhere', () => {
    for (let studentPrice = M.minPrice; studentPrice <= M.maxPrice; studentPrice += 7) {
      const p = gridBestReply(studentPrice, M, false)
      expect(p).toBeGreaterThanOrEqual(M.minPrice)
      expect(p).toBeLessThanOrEqual(M.maxPrice)
    }
  })
})

describe('pmg-ceiling (spec §5)', () => {
  it('posts the ceiling every round, whatever the student has done', () => {
    expect(competitorPrice(PMG, [], M, true)).toBe(2000)
    expect(competitorPrice(PMG, [900], M, true)).toBe(2000)
    expect(competitorPrice(PMG, [2000, 900, 1500, 1000], M, true)).toBe(2000)
  })

  it('follows an edited ceiling', () => {
    const edited: PricingMarketConfig = { ...M, maxPrice: 1800 }
    expect(competitorPrice(PMG, [1000], edited, true)).toBe(1800)
  })

  it('and posting the ceiling IS its best play under PMG', () => {
    // Shares are frozen, so the competitor's profit depends only on min(p_c, p_w) —
    // it can never lose by posting high, and gains whenever the student posts higher.
    const atCeiling = computeRound(1900, 2000, M, true).competitorProfit
    for (const p of priceGrid(M)) {
      expect(computeRound(1900, p, M, true).competitorProfit).toBeLessThanOrEqual(atCeiling + 1e-6)
    }
  })
})

describe('the library itself', () => {
  it('recognises exactly the two shipped rule ids', () => {
    expect(PRICING_STRATEGIES).toEqual([STANDARD, PMG])
    expect(isPricingStrategy(STANDARD)).toBe(true)
    expect(isPricingStrategy(PMG)).toBe(true)
  })

  it('rejects anything else — an unknown id must not reach the compute step', () => {
    for (const v of ['tft', 'grim', '', null, undefined, 7, {}]) {
      expect(isPricingStrategy(v)).toBe(false)
    }
  })

  it('carries a human description of every rule, for the debrief reveal (§9)', () => {
    for (const s of PRICING_STRATEGIES) {
      expect(STRATEGY_DESCRIPTIONS[s]).toBeTruthy()
      // Spec §1's content rule holds even in text students only meet at the end.
      expect(STRATEGY_DESCRIPTIONS[s].toLowerCase()).not.toContain('the bot')
    }
  })
})
