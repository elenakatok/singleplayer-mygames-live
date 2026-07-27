import { describe, it, expect } from 'vitest'
import {
  pricesByRound, profitsByRound, averagePrice, averageProfitPerRound, totalProfit,
  classAveragePrice, classAverageEffectivePrice, classAverageProfit,
  equilibriumReference, equilibriumProfitReference,
  type PricingGameRow,
} from '../src/pricing/reportStats'
import { DEFAULT_MARKET, computeRound, nashEquilibrium, type PricingMarketConfig } from '../src/pricing/market'

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
    competitorProfits: prices.map(p => p * 50),
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

describe('profitsByRound — the second Tier-3 chart, mid-week (spec §10)', () => {
  it('averages BOTH firms per round, over the students who played that round', () => {
    const rows = [
      game('a', [1, 2], { profits: [10, 30], competitorProfits: [100, 300] }),
      game('b', [1, 2], { profits: [20, 50], competitorProfits: [200, 500] }),
    ]
    expect(profitsByRound(rows, 2)).toEqual([
      { round: 1, student: 15, competitor: 150, n: 2 },
      { round: 2, student: 40, competitor: 400, n: 2 },
    ])
  })

  it('⚠ carries NEGATIVE averages rather than flooring them', () => {
    // A class that undercuts into losses has to be visible as losses — the chart's
    // y-axis holds negatives precisely so this number can be true.
    const rows = [
      game('a', [1], { profits: [-12_540_000], competitorProfits: [0] }),
      game('b', [1], { profits: [-4_000_000], competitorProfits: [0] }),
    ]
    const pts = profitsByRound(rows, 1)
    expect(pts[0].student).toBe(-8_270_000)
    expect(pts[0].competitor).toBe(0)
  })

  it('its denominators match the PRICE chart’s, round for round', () => {
    // The two charts must always average over the same students, or reading them
    // together would compare different populations.
    const rows = [game('a', [1, 2, 3]), game('b', [1, 2]), game('c', [1])]
    expect(profitsByRound(rows, 3).map(p => p.n)).toEqual(pricesByRound(rows, 3).map(p => p.n))
  })

  it('a round nobody played is omitted, never divided by zero', () => {
    const pts = profitsByRound([game('a', [1])], 5)
    expect(pts).toHaveLength(1)
    expect(pts.every(p => Number.isFinite(p.student) && Number.isFinite(p.competitor))).toBe(true)
  })

  it('an empty class is an empty chart, not a crash', () => {
    expect(profitsByRound([], 0)).toEqual([])
    expect(profitsByRound([game('a', [])], 12)).toEqual([])
  })
})

describe('classAverageProfit — the profit summary box', () => {
  it('averages both firms over every round played', () => {
    const rows = [
      game('a', [1, 2], { profits: [10, 20], competitorProfits: [100, 200] }),
      game('b', [1], { profits: [60], competitorProfits: [600] }),
    ]
    expect(classAverageProfit(rows)).toEqual({ student: 30, competitor: 300 })
  })

  it('is NULL before anybody has played — never 0, which would read as breaking even', () => {
    expect(classAverageProfit([])).toEqual({ student: null, competitor: null })
    expect(classAverageProfit([game('a', [])])).toEqual({ student: null, competitor: null })
  })
})

describe('the PROFIT equilibrium reference — computed through the market model', () => {
  it('Standard: the profits at the interior Nash prices', () => {
    const ref = equilibriumProfitReference(M, false)
    // Not recomputed by hand: asked of the same function that scores every round.
    const eq = nashEquilibrium(M)
    const at = computeRound(eq.studentPrice, eq.competitorPrice, M, false)
    expect(ref.student).toBe(at.studentProfit)
    expect(ref.competitor).toBe(at.competitorProfit)
    // At the case market that is $34.80M / $62.16M.
    expect(ref.student / 1e6).toBeCloseTo(34.80, 2)
    expect(ref.competitor / 1e6).toBeCloseTo(62.16, 2)
  })

  it('PMG: the profits when BOTH firms post the ceiling', () => {
    const ref = equilibriumProfitReference(M, true)
    expect(ref.student).toBe(M.marketSize * M.studentBaseShare * (M.maxPrice - M.studentUnitCost))
    expect(ref.competitor).toBe(M.marketSize * M.competitorBaseShare * (M.maxPrice - M.competitorUnitCost))
    expect(ref.student / 1e6).toBeCloseTo(68.76, 2)
    expect(ref.competitor / 1e6).toBeCloseTo(135.85, 2)
  })

  it('⚠ the two firms DIFFER even under PMG — same price, different costs and shares', () => {
    const ref = equilibriumProfitReference(M, true)
    expect(ref.student).not.toBe(ref.competitor)
  })

  it('keeps the price chart’s "ceiling shown" convention in its label', () => {
    expect(equilibriumProfitReference(M, true).label).toContain('ceiling shown')
    expect(equilibriumProfitReference(M, true).label).toContain('any equal price')
  })

  it('⚠ and BOTH modes move when the market is edited', () => {
    const edited: PricingMarketConfig = { ...M, studentUnitCost: 1200, maxPrice: 2400 }
    expect(equilibriumProfitReference(edited, false).student)
      .not.toBeCloseTo(equilibriumProfitReference(M, false).student, 2)
    expect(equilibriumProfitReference(edited, true).student)
      .not.toBeCloseTo(equilibriumProfitReference(M, true).student, 2)
  })

  it('applies NO floor of its own — it is exactly what the market model returns', () => {
    // A cost disadvantage big enough to price the student out gives them a zero
    // equilibrium profit, because their SHARE clamps to zero before their margin goes
    // negative — a property of the model, not of this function. What matters here is
    // that the reference reports whatever computeRound says rather than substituting
    // a floor of its own, so the dashed line always means the same thing.
    const disadvantaged: PricingMarketConfig = { ...M, studentUnitCost: 2300 }
    const eq = nashEquilibrium(disadvantaged)
    const at = computeRound(eq.studentPrice, eq.competitorPrice, disadvantaged, false)
    expect(equilibriumProfitReference(disadvantaged, false).student).toBe(at.studentProfit)
    expect(at.studentShare).toBe(0)                    // priced out entirely
    // Worth stating exactly: zero share times a NEGATIVE margin is -0 in IEEE-754, so
    // this is `Object.is(-0)`, not 0. It reaches the chart and the summary box, where
    // formatProfitM renders it "$0.00M" rather than "−$0.00M" (asserted there).
    const priced = equilibriumProfitReference(disadvantaged, false).student
    expect(Math.abs(priced)).toBe(0)
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
