import { describe, it, expect } from 'vitest'
import {
  pricesByRound, averagePrice, averageProfitPerRound, totalProfit,
  classAveragePrice, classAverageEffectivePrice, equilibriumReference,
  type PricingGameRow,
} from '../src/pricing/reportStats'
import { DEFAULT_MARKET, nashEquilibrium, type PricingMarketConfig } from '../src/pricing/market'

// ═══════════════════════════════════════════════════════════════════════════════
// The report aggregations (spec §10).
//
// The tests that matter are the PARTIAL-DATA ones. Elena opens these reports
// mid-week, with the class spread across the assignment — some finished, some three
// rounds in, some not started. Anything that only worked on a complete class would be
// broken exactly when it is being used.
// ═══════════════════════════════════════════════════════════════════════════════

const M = DEFAULT_MARKET

function game(id: string, prices: number[], over: Partial<PricingGameRow> = {}): PricingGameRow {
  return {
    participant_id: id,
    prices,
    competitorPrices: prices.map(() => 2000),
    effectivePrices: prices.map(() => null),
    profits: prices.map(p => p * 100),
    ...over,
  }
}

describe('pricesByRound — the Tier-3 chart, mid-week (spec §10)', () => {
  it('averages BOTH sides per round, over the students who played that round', () => {
    const rows = [
      game('a', [1000, 1200], { competitorPrices: [2000, 1800] }),
      game('b', [1400, 1600], { competitorPrices: [2000, 1600] }),
    ]
    expect(pricesByRound(rows, 2)).toEqual([
      { round: 1, student: 1200, competitor: 2000, n: 2 },
      { round: 2, student: 1400, competitor: 1700, n: 2 },
    ])
  })

  it('⚠ the denominator SHRINKS down the chart, and every point says by how much', () => {
    // The composition problem: with per-student horizons and async play, round 3 is
    // averaged over one student. Without `n`, that point reads as the class changing its
    // mind rather than the class thinning out.
    const rows = [game('a', [1000, 1000, 1000]), game('b', [2000, 2000]), game('c', [1500])]
    const pts = pricesByRound(rows, 3)
    expect(pts.map(p => p.n)).toEqual([3, 2, 1])
    expect(pts[0].student).toBe(1500)   // (1000 + 2000 + 1500) / 3
    expect(pts[1].student).toBe(1500)   // (1000 + 2000) / 2
    expect(pts[2].student).toBe(1000)   // just a
  })

  it('⚠ a round NOBODY played is omitted, never divided by zero', () => {
    const rows = [game('a', [1000])]
    const pts = pricesByRound(rows, 5)
    expect(pts).toHaveLength(1)
    expect(pts.every(p => Number.isFinite(p.student) && Number.isFinite(p.competitor))).toBe(true)
    expect(pts.every(p => p.n > 0)).toBe(true)
  })

  it('a class where NOBODY has played is an empty chart, not a crash', () => {
    expect(pricesByRound([], 0)).toEqual([])
    expect(pricesByRound([game('a', []), game('b', [])], 0)).toEqual([])
    // …and even if a stale roundCount is passed in.
    expect(pricesByRound([game('a', [])], 12)).toEqual([])
  })

  it('students who never launched contribute to no round at all', () => {
    const rows = [game('played', [1000, 1000]), game('never', [])]
    const pts = pricesByRound(rows, 2)
    expect(pts.map(p => p.n)).toEqual([1, 1])
    expect(pts[0].student).toBe(1000)   // NOT (1000 + 0) / 2
  })
})

describe('per-student aggregates, on partial games', () => {
  it('average price and average profit are over rounds PLAYED', () => {
    const r = game('a', [1000, 2000], { profits: [10, 30] })
    expect(averagePrice(r)).toBe(1500)
    expect(averageProfitPerRound(r)).toBe(20)
    expect(totalProfit(r)).toBe(40)
  })

  it('⚠ average profit is PER ROUND, so a mid-game student is not ranked by progress', () => {
    // Same behaviour, different amounts of it: the per-round figures match, the
    // totals do not. A cumulative column would make the finisher look better at
    // pricing when they have only played longer.
    const finisher = game('fin', [1500, 1500, 1500], { profits: [10, 10, 10] })
    const midGame = game('mid', [1500], { profits: [10] })
    expect(averageProfitPerRound(finisher)).toBe(averageProfitPerRound(midGame))
    expect(totalProfit(finisher)).not.toBe(totalProfit(midGame))
  })

  it('a student who played nothing has NULL averages, not zeros', () => {
    const r = game('never', [])
    expect(averagePrice(r)).toBeNull()
    expect(averageProfitPerRound(r)).toBeNull()
    // …but their total genuinely IS zero, which is a fact rather than a gap.
    expect(totalProfit(r)).toBe(0)
  })

  it('a loss averages negative rather than being floored', () => {
    const r = game('loser', [900, 900], { profits: [-1000, -3000] })
    expect(averageProfitPerRound(r)).toBe(-2000)
    expect(totalProfit(r)).toBe(-4000)
  })
})

describe('the summary-stat box (spec §10)', () => {
  it('class average posted price is over every round every student played', () => {
    const rows = [game('a', [1000, 2000]), game('b', [3000])]
    expect(classAveragePrice(rows)).toBe(2000)      // (1000+2000+3000)/3, not a mean of means
  })

  it('is NULL before anybody has played', () => {
    expect(classAveragePrice([])).toBeNull()
    expect(classAveragePrice([game('a', [])])).toBeNull()
  })

  it('average EFFECTIVE price exists only where effective prices do (PMG)', () => {
    const standard = [game('a', [1000, 2000])]                       // all null
    expect(classAverageEffectivePrice(standard)).toBeNull()
    const pmg = [game('a', [1600, 1800], { effectivePrices: [1600, 1700] })]
    expect(classAverageEffectivePrice(pmg)).toBe(1650)
  })

  it('and ignores null entries rather than counting them as zero', () => {
    const mixed = [game('a', [1, 2, 3], { effectivePrices: [1000, null, 2000] })]
    expect(classAverageEffectivePrice(mixed)).toBe(1500)
  })
})

describe('the equilibrium reference — AUTO-DERIVED, never hand-entered (spec §2/§10)', () => {
  it('Standard draws two lines, at the interior Nash', () => {
    const ref = equilibriumReference(M, false)
    const eq = nashEquilibrium(M)
    expect(ref.student).toBe(eq.studentPrice)
    expect(ref.competitor).toBe(eq.competitorPrice)
    expect(ref.singleLine).toBe(false)
    expect(ref.student).toBeCloseTo(1394, 9)
    expect(ref.competitor).toBeCloseTo(1472, 9)
  })

  it('⚠ and it MOVES when the market is edited — it cannot go stale on a chart', () => {
    const edited: PricingMarketConfig = { ...M, studentUnitCost: 1200 }
    expect(equilibriumReference(edited, false).student)
      .not.toBeCloseTo(equilibriumReference(M, false).student, 6)
  })

  it('PMG draws ONE line, at the ceiling, and says what it is', () => {
    const ref = equilibriumReference(M, true)
    expect(ref.singleLine).toBe(true)
    expect(ref.student).toBe(M.maxPrice)
    expect(ref.competitor).toBe(M.maxPrice)
    expect(ref.label).toBe('PMG equilibrium (any equal price; ceiling shown)')
  })

  it('…and the PMG line follows an edited ceiling', () => {
    expect(equilibriumReference({ ...M, maxPrice: 1750 }, true).student).toBe(1750)
  })

  it('the PMG label does NOT imply the ceiling is uniquely optimal', () => {
    // Any equal price is an equilibrium under PMG; a label reading just "equilibrium"
    // would teach the opposite of the lesson.
    expect(equilibriumReference(M, true).label).toContain('any equal price')
  })
})
