import { describe, it, expect } from 'vitest'
import {
  pointMetrics, runningMetrics, runningSeries, mseByYear, yearComparison, bonusFor,
  type ForecastPoint,
} from '../src/forecast/metrics'
import { BONUS_AT_PERFECT } from '../src/forecast/config'

// ═══════════════════════════════════════════════════════════════════════════════
// Forecasting — the scorecard (spec §4, §5, §5a), checked against INDEPENDENT
// recomputation (spec §12: "Asserts round math against an independent recomputation").
//
// The recomputations below are written longhand from the definitions in the student
// instructions, not by calling back into metrics.ts. Where a figure has a published
// worked example — the instructions PDF's "forecast 900, demand 950" row — that exact
// case is asserted, so the numbers a student is TOLD they will see are the numbers the
// server actually computes.
// ═══════════════════════════════════════════════════════════════════════════════

/** Longhand recomputation, straight from the definitions. Deliberately not DRY. */
function recompute(points: readonly ForecastPoint[]) {
  const errors = points.map(p => p.actual - p.forecast)
  const abs = errors.map(Math.abs)
  const sq = errors.map(e => e * e)
  const apes: number[] = []
  points.forEach((p, i) => { if (p.actual !== 0) apes.push(abs[i] / p.actual) })
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0)
  const n = points.length
  const mse = n === 0 ? 0 : sum(sq) / n
  const mape = apes.length === 0 ? null : sum(apes) / apes.length
  return {
    mae: n === 0 ? 0 : sum(abs) / n,
    mse,
    standardError: Math.sqrt(mse),
    mape,
    accuracy: mape === null ? null : 1 - mape,
    bonus: mape === null ? null : Math.max(0, 10000 * (1 - mape)),
    meanError: n === 0 ? 0 : sum(errors) / n,
  }
}

const pt = (period: number, forecast: number, actual: number): ForecastPoint =>
  ({ period, forecast, actual })

describe('pointMetrics — one month (spec §4)', () => {
  it('matches the worked example in the student instructions', () => {
    // "Example: forecast 900, demand 950" → Error +50, AE 50, Squared 2,500.
    const m = pointMetrics(pt(61, 900, 950))
    expect(m.error).toBe(50)
    expect(m.absoluteError).toBe(50)
    expect(m.squaredError).toBe(2500)
    expect(m.absolutePercentageError).toBeCloseTo(50 / 950, 12)
  })

  it('keeps the sign — error is actual MINUS forecast (spec §4: bias is the lesson)', () => {
    // Over-forecasting gives a NEGATIVE error. Getting this backwards would invert the
    // bias column and teach the opposite lesson about under-forecasting a rising trend.
    expect(pointMetrics(pt(61, 1000, 950)).error).toBe(-50)
    expect(pointMetrics(pt(61, 900, 950)).error).toBe(50)
  })

  it('APE is null on a zero-demand month, never Infinity', () => {
    const m = pointMetrics(pt(61, 400, 0))
    expect(m.absolutePercentageError).toBeNull()
    // …while the squared error is perfectly well defined and still counts.
    expect(m.squaredError).toBe(160000)
  })

  it('a perfect forecast scores zero on everything', () => {
    const m = pointMetrics(pt(61, 812, 812))
    expect(m.error).toBe(0)
    expect(m.absoluteError).toBe(0)
    expect(m.squaredError).toBe(0)
    expect(m.absolutePercentageError).toBe(0)
  })
})

describe('runningMetrics — the scorecard (spec §4, §5, §5a)', () => {
  const game: ForecastPoint[] = [
    pt(61, 800, 812), pt(62, 810, 795), pt(63, 820, 844), pt(64, 830, 828),
    pt(65, 840, 861), pt(66, 850, 833), pt(67, 860, 879), pt(68, 870, 858),
    pt(69, 880, 903), pt(70, 890, 884), pt(71, 1100, 1121), pt(72, 1110, 1098),
  ]

  it('agrees with an independent recomputation on every figure', () => {
    const got = runningMetrics(game)
    const want = recompute(game)
    expect(got.n).toBe(game.length)
    expect(got.mae).toBeCloseTo(want.mae, 10)
    expect(got.mse).toBeCloseTo(want.mse, 10)
    expect(got.standardError).toBeCloseTo(want.standardError, 10)
    expect(got.mape!).toBeCloseTo(want.mape!, 12)
    expect(got.accuracy!).toBeCloseTo(want.accuracy!, 12)
    expect(got.bonus!).toBeCloseTo(want.bonus!, 8)
    expect(got.meanError).toBeCloseTo(want.meanError, 10)
  })

  it('Standard Error is √MSE — the lecture label, not RMSE (spec §0, §5)', () => {
    const r = runningMetrics(game)
    expect(r.standardError).toBeCloseTo(Math.sqrt(r.mse), 12)
  })

  it('MAE and MSE follow the instructions PDF worked example', () => {
    // "AE of 50 and 30 → MAE = 40" and "2,500 and 900 → MSE = 1,700".
    const r = runningMetrics([pt(61, 900, 950), pt(62, 900, 870)])
    expect(r.mae).toBe(40)
    expect(r.mse).toBe(1700)
  })

  it('MSE punishes one big miss more than many small ones (spec §8 Q3)', () => {
    // The KC's own claim, asserted on the engine that will score it: A is off by 20
    // every month; B is perfect three months in four then misses by 80.
    const A = [pt(61, 100, 120), pt(62, 100, 120), pt(63, 100, 120), pt(64, 100, 120)]
    const B = [pt(61, 100, 100), pt(62, 100, 100), pt(63, 100, 100), pt(64, 100, 180)]
    expect(runningMetrics(A).mse).toBe(400)
    expect(runningMetrics(B).mse).toBe(1600)
    // …while their MAE is identical, which is exactly why MSE is the objective.
    expect(runningMetrics(A).mae).toBe(20)
    expect(runningMetrics(B).mae).toBe(20)
  })

  it('excludes zero-demand months from MAPE and says how many it used', () => {
    const pts = [pt(61, 100, 200), pt(62, 100, 0), pt(63, 100, 50)]
    const r = runningMetrics(pts)
    expect(r.n).toBe(3)
    expect(r.mapeN).toBe(2)                                   // the zero month is out
    expect(r.mape!).toBeCloseTo((100 / 200 + 50 / 50) / 2, 12)
    // …but MSE still counts all three.
    expect(r.mse).toBeCloseTo((100 ** 2 + 100 ** 2 + 50 ** 2) / 3, 10)
  })

  it('MAPE is null (not NaN) when EVERY month had zero demand', () => {
    const r = runningMetrics([pt(61, 100, 0), pt(62, 100, 0)])
    expect(r.mape).toBeNull()
    expect(r.accuracy).toBeNull()
    expect(r.bonus).toBeNull()
    expect(Number.isNaN(r.mse)).toBe(false)
  })

  it('an empty game is zeroed, never NaN', () => {
    const r = runningMetrics([])
    expect(r).toEqual({
      n: 0, mae: 0, mse: 0, standardError: 0,
      mape: null, mapeN: 0, accuracy: null, bonus: null, meanError: 0,
    })
  })

  it('mean signed error surfaces bias that absolute errors hide (spec §4)', () => {
    // Chronic under-forecasting of a rising series: every error positive.
    const under = [pt(61, 700, 800), pt(62, 710, 820), pt(63, 720, 830)]
    const r = runningMetrics(under)
    expect(r.meanError).toBeGreaterThan(0)
    expect(r.meanError).toBeCloseTo((100 + 110 + 110) / 3, 10)
    // A student who misses symmetrically has the SAME MAE (|e| = 160, 160, 0 ⇒ 320/3,
    // matching the 100/110/110 above) but a mean signed error of exactly zero.
    const symmetric = [pt(61, 700, 860), pt(62, 980, 820), pt(63, 830, 830)]
    expect(runningMetrics(symmetric).mae).toBeCloseTo(r.mae, 10)
    expect(Math.abs(runningMetrics(symmetric).meanError)).toBeLessThan(Math.abs(r.meanError))
  })
})

describe('the bonus (spec §5a)', () => {
  it('is the PLAIN mapping: $10,000 × (1 − MAPE)', () => {
    expect(bonusFor(0)).toBe(BONUS_AT_PERFECT)
    expect(bonusFor(0.0274)).toBeCloseTo(9726, 0)     // spec §5a: the lecture model
    expect(bonusFor(0.1764)).toBeCloseTo(8236, 0)     // spec §5a: flat at the mean
    expect(bonusFor(0.0718)).toBeCloseTo(9282, 0)     // spec §5a: repeat last month
    expect(bonusFor(0.0606)).toBeCloseTo(9394, 0)     // spec §5a: same month last year
  })

  it('reproduces spec §5a\'s compression — accepted, not a bug', () => {
    // The analyst beats the do-nothing forecaster 11× on MSE and by under 5% on the
    // bonus. This asserts the KNOWN behaviour so nobody later "fixes" the mapping.
    const analyst = bonusFor(0.0274)
    const naive = bonusFor(0.0718)
    expect(analyst - naive).toBeCloseTo(444, 0)
    expect((analyst - naive) / naive).toBeLessThan(0.05)
  })

  it('floors at zero rather than going negative', () => {
    // MAPE above 1 is reachable: forecast 2,000 against an actual of 600.
    const m = pointMetrics(pt(61, 2000, 600))
    expect(m.absolutePercentageError!).toBeGreaterThan(1)
    expect(bonusFor(2.33)).toBe(0)
    expect(runningMetrics([pt(61, 2000, 600)]).bonus).toBe(0)
  })

  it('accuracy is 1 − MAPE and can go negative even though the bonus cannot', () => {
    // Accuracy is a metric and stays honest; only the DISPLAYED bonus is floored.
    const r = runningMetrics([pt(61, 2000, 600)])
    expect(r.accuracy!).toBeLessThan(0)
    expect(r.bonus).toBe(0)
  })
})

describe('the year split (spec §5, §10)', () => {
  const twoYears: ForecastPoint[] = [
    ...Array.from({ length: 12 }, (_, i) => pt(61 + i, 800, 800 + (i % 2 ? 40 : -40))),  // Y6, |e|=40
    ...Array.from({ length: 12 }, (_, i) => pt(73 + i, 900, 900 + (i % 2 ? 10 : -10))),  // Y7, |e|=10
  ]

  it('groups by calendar year and gets Y6 / Y7 at the shipped config', () => {
    const years = mseByYear(twoYears)
    expect(years.map(y => y.year)).toEqual([6, 7])
    expect(years[0].n).toBe(12)
    expect(years[1].n).toBe(12)
    expect(years[0].mse).toBe(1600)
    expect(years[1].mse).toBe(100)
  })

  it('reports improvement when the second year is better', () => {
    const c = yearComparison(twoYears)
    expect(c.first!.year).toBe(6)
    expect(c.second!.year).toBe(7)
    expect(c.improved).toBe(true)
  })

  it('improved is NULL until the second year has a month in it', () => {
    // A student twelve months in has nothing to compare, and "improved: false" there
    // would tell them they got worse at a game they are halfway through.
    const halfway = twoYears.slice(0, 12)
    const c = yearComparison(halfway)
    expect(c.first!.year).toBe(6)
    expect(c.second).toBeNull()
    expect(c.improved).toBeNull()
  })

  it('an empty game has no years and no verdict', () => {
    const c = yearComparison([])
    expect(c.first).toBeNull()
    expect(c.second).toBeNull()
    expect(c.improved).toBeNull()
  })

  it('a partial second year keeps its own n rather than being averaged against a full one', () => {
    const partial = [...twoYears.slice(0, 12), pt(73, 900, 950)]
    const years = mseByYear(partial)
    expect(years[1].n).toBe(1)
    expect(years[1].mse).toBe(2500)
  })

  it('groups by the REAL year, so a non-default rounds count still labels honestly', () => {
    // 18 played months from a 60-month history: Y6 full, Y7 half. Splitting
    // "first half / last half" would put the wrong year on the screen.
    const eighteen = Array.from({ length: 18 }, (_, i) => pt(61 + i, 800, 810))
    const years = mseByYear(eighteen)
    expect(years.map(y => [y.year, y.n])).toEqual([[6, 12], [7, 6]])
  })
})

describe('runningSeries — the "to date" columns (spec §4)', () => {
  const game = [pt(61, 900, 950), pt(62, 900, 870), pt(63, 900, 900)]

  it('is the running metric after each month, in order', () => {
    const series = runningSeries(game)
    expect(series).toHaveLength(3)
    expect(series[0].mse).toBe(2500)
    expect(series[1].mse).toBe(1700)
    expect(series[2].mse).toBeCloseTo((2500 + 900 + 0) / 3, 10)
    expect(series[2].n).toBe(3)
  })

  it('each prefix agrees exactly with scoring that prefix on its own', () => {
    // The property that makes a re-scored history match a freshly-scored one — the
    // reason metrics are recomputed rather than accumulated (metrics.ts).
    const series = runningSeries(game)
    game.forEach((_, i) => {
      const direct = runningMetrics(game.slice(0, i + 1))
      expect(series[i].mse).toBeCloseTo(direct.mse, 12)
      expect(series[i].mae).toBeCloseTo(direct.mae, 12)
      expect(series[i].meanError).toBeCloseTo(direct.meanError, 12)
    })
  })
})
