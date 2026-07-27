import { describe, it, expect } from 'vitest'
import {
  computeRound, nashEquilibrium, isValidPrice, parseMarket, DEFAULT_MARKET,
  type PricingMarketConfig,
} from '../src/pricing/market'

// ═══════════════════════════════════════════════════════════════════════════════
// The market model (spec §2 Standard, §6 PMG).
//
// The load-bearing tests are the FIRST block: the numbers below are not derived
// from this code, they are read off the Cheyenne Shipping case table the students
// study. If the implementation and the case ever disagree, the game is teaching
// something the reading does not — so these are pinned to the published figures,
// not to whatever the code happens to produce.
// ═══════════════════════════════════════════════════════════════════════════════

const M = DEFAULT_MARKET

/** Dollars, to the nearest cent — profits are ~10^8, so exact equality on a product
 *  of doubles is the wrong assertion. */
const money = (v: number) => Math.round(v * 100) / 100

describe('Standard mode against the published case numbers (spec §2)', () => {
  // The case's own row: CSC posts $1,800, WNS posts $2,000.
  const out = computeRound(1800, 2000, M, false)

  it('CSC share is 55% — base 35% plus the $200 gap over the $1,000 slope', () => {
    expect(out.studentShare).toBeCloseTo(0.55, 12)
  })
  it('WNS share is 45%', () => {
    expect(out.competitorShare).toBeCloseTo(0.45, 12)
  })
  it('the two shares still sum to exactly 1', () => {
    expect(out.studentShare + out.competitorShare).toBeCloseTo(1, 12)
  })
  it('CSC profit is $87.15M', () => {
    expect(money(out.studentProfit)).toBe(87_153_000)
  })
  it('WNS profit is $94.05M', () => {
    expect(money(out.competitorProfit)).toBe(94_050_000)
  })
  it('demands are M × share, in containers', () => {
    expect(out.studentDemand).toBeCloseTo(190_000 * 0.55, 6)
    expect(out.competitorDemand).toBeCloseTo(190_000 * 0.45, 6)
  })
  it('there is no effective price under Standard — each firm’s customers pay its own', () => {
    expect(out.effectivePrice).toBeNull()
  })
})

describe('Standard mode — equal prices, and the clamp', () => {
  it('equal prices give the base shares (the KC Q1 fact)', () => {
    const out = computeRound(1500, 1500, M, false)
    expect(out.studentShare).toBeCloseTo(0.35, 12)
    expect(out.competitorShare).toBeCloseTo(0.65, 12)
  })

  it('a $1,100 undercut CLAMPS the share at 100% / 0% instead of overshooting', () => {
    // raw shares would be 1.45 and −0.45: the linear model has run off both ends.
    const out = computeRound(900, 2000, M, false)
    expect(out.studentShare).toBe(1)
    expect(out.competitorShare).toBe(0)
    expect(out.studentShare + out.competitorShare).toBe(1)
  })

  it('and winning the WHOLE market below cost still LOSES money (spec §2, KC Q4)', () => {
    const out = computeRound(900, 2000, M, false)
    // 190,000 containers at $900 against a $966 unit cost.
    expect(money(out.studentProfit)).toBe(-12_540_000)
    expect(out.studentProfit).toBeLessThan(0)
    // A firm with zero share earns nothing, whatever it posted.
    expect(out.competitorProfit).toBe(0)
  })

  it('base shares that oversell the market are scaled back to sum to 1', () => {
    // Only reachable by an instructor edit; without the cap the market would sell
    // 1.6 × M containers.
    const oversold: PricingMarketConfig = { ...M, studentBaseShare: 0.8, competitorBaseShare: 0.8 }
    const out = computeRound(1500, 1500, oversold, false)
    expect(out.studentShare).toBeCloseTo(0.5, 12)
    expect(out.competitorShare).toBeCloseTo(0.5, 12)
    // Proportions preserved: 0.8/0.8 was an even split and stays one.
    expect(out.studentShare).toBeCloseTo(out.competitorShare, 12)
  })
})

describe('PMG mode (spec §6.1)', () => {
  it('customers pay the LOWER posted price, whoever posted it', () => {
    expect(computeRound(1600, 1500, M, true).effectivePrice).toBe(1500)
    expect(computeRound(1200, 1900, M, true).effectivePrice).toBe(1200)
    expect(computeRound(1500, 1500, M, true).effectivePrice).toBe(1500)
  })

  it('shares are FROZEN at base — a $700 undercut moves nothing (KC Q2/Q3)', () => {
    const out = computeRound(1200, 1900, M, true)
    expect(out.studentShare).toBe(0.35)
    expect(out.competitorShare).toBe(0.65)
    // The Standard formula would have said 1.05 here — the diagnostic distractor.
    expect(out.studentShare).not.toBeCloseTo(1.05, 6)
  })

  it('profit is M × base share × (effective price − unit cost)', () => {
    const out = computeRound(1600, 1500, M, true)
    expect(money(out.studentProfit)).toBe(35_511_000)   // 66,500 × $534
    expect(money(out.competitorProfit)).toBe(74_100_000) // 123,500 × $600
  })

  it('the student’s own price sets what EVERYONE pays when they post lower', () => {
    // The discovery the mode exists for: raising your price raises your profit with
    // zero share loss, until you stop being the lower of the two.
    const low = computeRound(1400, 2000, M, true)
    const high = computeRound(1900, 2000, M, true)
    expect(low.studentShare).toBe(high.studentShare)
    expect(high.studentProfit).toBeGreaterThan(low.studentProfit)
    expect(money(high.studentProfit - low.studentProfit)).toBe(66_500 * 500)
  })

  it('pricing below cost loses money here too', () => {
    const out = computeRound(900, 2000, M, true)
    expect(money(out.studentProfit)).toBe(-4_389_000)   // 66,500 × −$66
  })
})

describe('the auto-derived equilibrium (spec §2)', () => {
  it('is $1,394 / $1,472 at the case defaults', () => {
    const eq = nashEquilibrium(M)
    expect(eq.studentPrice).toBeCloseTo(1394, 9)
    expect(eq.competitorPrice).toBeCloseTo(1472, 9)
  })

  it('MOVES when the market is edited — it can never go stale on a chart', () => {
    const edited: PricingMarketConfig = { ...M, studentUnitCost: 1200 }
    const eq = nashEquilibrium(edited)
    expect(eq.studentPrice).not.toBeCloseTo(1394, 6)
    // p_c* = (2(350 + 1200) + 1550)/3
    expect(eq.studentPrice).toBeCloseTo((2 * (350 + 1200) + 1550) / 3, 9)
  })

  it('is a genuine fixed point: neither firm gains by moving alone', () => {
    const eq = nashEquilibrium(M)
    const at = computeRound(eq.studentPrice, eq.competitorPrice, M, false)
    for (const delta of [-50, -1, 1, 50]) {
      const deviate = computeRound(eq.studentPrice + delta, eq.competitorPrice, M, false)
      expect(deviate.studentProfit).toBeLessThan(at.studentProfit)
    }
  })
})

describe('price validation (spec §3 — integer dollars, continuous within bounds)', () => {
  it('accepts any whole dollar inside the band, including both ends', () => {
    for (const p of [900, 901, 1387, 1999, 2000]) expect(isValidPrice(p, M)).toBe(true)
  })
  it('rejects outside the band', () => {
    for (const p of [899, 2001, 0, -1500]) expect(isValidPrice(p, M)).toBe(false)
  })
  it('rejects non-integers — entry is whole dollars', () => {
    expect(isValidPrice(1400.5, M)).toBe(false)
  })
  it('does NOT require the $100 grid — that binds the competitor only', () => {
    expect(isValidPrice(1437, M)).toBe(true)
  })
  it('rejects anything that is not a finite number', () => {
    for (const p of ['1400', null, undefined, NaN, Infinity, {}]) {
      expect(isValidPrice(p, M)).toBe(false)
    }
  })
})

describe('parseMarket — a half-written config can never make a round uncomputable', () => {
  it('an empty/absent map is the shipped case defaults', () => {
    expect(parseMarket(undefined)).toEqual(DEFAULT_MARKET)
    expect(parseMarket({})).toEqual(DEFAULT_MARKET)
    expect(parseMarket('nonsense')).toEqual(DEFAULT_MARKET)
  })

  it('reads stored snake_case fields', () => {
    const m = parseMarket({
      market_size: 250_000, student_base_share: 0.4, competitor_base_share: 0.6,
      student_unit_cost: 1000, competitor_unit_cost: 950, slope: 800,
      min_price: 1000, max_price: 2500, grid_step: 50,
    })
    expect(m).toEqual({
      marketSize: 250_000, studentBaseShare: 0.4, competitorBaseShare: 0.6,
      studentUnitCost: 1000, competitorUnitCost: 950, slope: 800,
      minPrice: 1000, maxPrice: 2500, gridStep: 50,
    })
  })

  it('falls back per field, keeping the good values around a bad one', () => {
    const m = parseMarket({ market_size: 250_000, slope: 'wide' })
    expect(m.marketSize).toBe(250_000)
    expect(m.slope).toBe(DEFAULT_MARKET.slope)
  })

  it('refuses a zero slope (it would divide by zero) and a zero market', () => {
    expect(parseMarket({ slope: 0 }).slope).toBe(DEFAULT_MARKET.slope)
    expect(parseMarket({ slope: -1000 }).slope).toBe(DEFAULT_MARKET.slope)
    expect(parseMarket({ market_size: 0 }).marketSize).toBe(DEFAULT_MARKET.marketSize)
  })

  it('refuses an out-of-range share', () => {
    expect(parseMarket({ student_base_share: 1.4 }).studentBaseShare).toBe(DEFAULT_MARKET.studentBaseShare)
    expect(parseMarket({ student_base_share: -0.1 }).studentBaseShare).toBe(DEFAULT_MARKET.studentBaseShare)
  })

  it('restores BOTH bounds when the band is inverted or empty', () => {
    // Half-honouring an inverted band would leave every price invalid.
    const inverted = parseMarket({ min_price: 2000, max_price: 900 })
    expect(inverted.minPrice).toBe(DEFAULT_MARKET.minPrice)
    expect(inverted.maxPrice).toBe(DEFAULT_MARKET.maxPrice)
    const empty = parseMarket({ min_price: 1500, max_price: 1500 })
    expect(empty.minPrice).toBe(DEFAULT_MARKET.minPrice)
  })

  it('allows a NEGATIVE unit cost only insofar as it is a finite number (not a crash)', () => {
    // Not a sensible market, but parse must not throw — the game stays playable and
    // the instructor sees the consequence on their own dashboard.
    expect(parseMarket({ student_unit_cost: -50 }).studentUnitCost).toBe(-50)
  })
})
