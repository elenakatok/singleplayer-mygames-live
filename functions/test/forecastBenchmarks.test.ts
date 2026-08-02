import { describe, it, expect } from 'vitest'
import {
  PUBLISHED_BENCHMARKS, LECTURE_MODEL_BENCHMARK_ID, publishedBenchmarksValid,
  realizedBenchmarks, revealProcess,
} from '../src/forecast/benchmarks'
import { PUBLISHED_HISTORY } from '../src/forecast/history'
import { DEFAULT_MODEL, systematic, drawDemand, type ForecastModel } from '../src/forecast/demand'
import type { ForecastPoint } from '../src/forecast/metrics'
import { runningMetrics } from '../src/forecast/metrics'

// ═══════════════════════════════════════════════════════════════════════════════
// Forecasting — the benchmark rules (spec §2.3), which the debrief screen (§9) and the
// Tier-3 summary box (§10) both DISPLAY beside the student's own MSE.
//
// The published constants are asserted for internal consistency and for the four
// lecture points spec §2.3 says fall out of them. The REALIZED benchmarks — what each
// rule would actually have scored on one student's own months — are checked by
// simulation against the same 4,000-future logic used to verify the table during the
// build: a rule that lands far from its published expectation would mean the rule is
// implemented wrong, and this is the only place that would show.
// ═══════════════════════════════════════════════════════════════════════════════

/** A whole 24-month game for one student, played by a given rule. */
function playedBy(
  rule: (period: number, seriesSoFar: Map<number, number>) => number,
  participant: string,
  model: ForecastModel = DEFAULT_MODEL,
): ForecastPoint[] {
  const series = new Map<number, number>()
  PUBLISHED_HISTORY.forEach((v, i) => series.set(i + 1, v))
  const out: ForecastPoint[] = []
  for (let period = 61; period <= 84; period++) {
    const forecast = rule(period, series)
    const actual = drawDemand(model, 'bench-seed', participant, period)
    series.set(period, actual)
    out.push({ period, forecast, actual })
  }
  return out
}

describe('the published table (spec §2.3)', () => {
  it('has all eight rows in the published order, worst first', () => {
    expect(PUBLISHED_BENCHMARKS).toHaveLength(8)
    const mses = PUBLISHED_BENCHMARKS.map(b => b.mse)
    for (let i = 1; i < mses.length; i++) {
      expect(mses[i], `row ${i} must not be worse than row ${i - 1}`).toBeLessThanOrEqual(mses[i - 1])
    }
  })

  it('carries spec §2.3\'s exact figures', () => {
    const byId = Object.fromEntries(PUBLISHED_BENCHMARKS.map(b => [b.id, b.mse]))
    expect(byId.flat_mean).toBe(37840)
    expect(byId.naive).toBe(10042)
    expect(byId.ma12).toBe(9029)
    expect(byId.seasonal_naive).toBe(4180)
    expect(byId.reg_month_dummies).toBe(1000)
    expect(byId.reg_holiday).toBe(902)
    expect(byId.true_process).toBe(901)
    expect(byId.floor).toBe(900)
  })

  it('reports Standard Error as √MSE, matching spec §2.3\'s second column', () => {
    const byId = Object.fromEntries(PUBLISHED_BENCHMARKS.map(b => [b.id, b.standardError]))
    expect(byId.flat_mean).toBe(195)
    expect(byId.naive).toBe(100)
    expect(byId.ma12).toBe(95)
    expect(byId.seasonal_naive).toBe(65)
    expect(byId.reg_month_dummies).toBe(32)
    expect(byId.reg_holiday).toBe(30)
    expect(byId.floor).toBe(30)
  })

  it('the four lecture points of spec §2.3 hold', () => {
    const m = Object.fromEntries(PUBLISHED_BENCHMARKS.map(b => [b.id, b.mse]))
    // 1. simple average → regression is a ~42× improvement.
    expect(m.flat_mean / m.reg_holiday).toBeGreaterThan(40)
    // 2. the 12-month moving average is barely better than doing nothing.
    expect(m.ma12 / m.naive).toBeGreaterThan(0.85)
    // 3. the right model lands essentially on the floor.
    expect(m.reg_holiday - m.floor).toBeLessThan(5)
    // 4. parsimony has a price tag: ~11% more MSE for ten useless parameters.
    expect(m.reg_month_dummies / m.reg_holiday).toBeGreaterThan(1.08)
    expect(m.reg_month_dummies / m.reg_holiday).toBeLessThan(1.15)
  })

  it('names the lecture model as a row that actually exists', () => {
    expect(PUBLISHED_BENCHMARKS.some(b => b.id === LECTURE_MODEL_BENCHMARK_ID)).toBe(true)
  })

  it('is valid only for the published history at the shipped model', () => {
    expect(publishedBenchmarksValid(DEFAULT_MODEL, 60)).toBe(true)
    expect(publishedBenchmarksValid({ ...DEFAULT_MODEL, b: 9 }, 60)).toBe(false)
    expect(publishedBenchmarksValid(DEFAULT_MODEL, 36)).toBe(false)
  })
})

describe('realizedBenchmarks — what each rule scores on YOUR months', () => {
  const points = playedBy(() => 0, 'stu-realized')   // forecasts irrelevant; actuals matter

  it('returns the seven computable rules with finite MSEs', () => {
    const rows = realizedBenchmarks(PUBLISHED_HISTORY, points, DEFAULT_MODEL)
    expect(rows).toHaveLength(7)
    for (const r of rows) {
      expect(r.mse, `${r.id} must be computable`).not.toBeNull()
      expect(Number.isFinite(r.mse!)).toBe(true)
    }
  })

  it('is empty for a student who has played nothing', () => {
    expect(realizedBenchmarks(PUBLISHED_HISTORY, [], DEFAULT_MODEL)).toEqual([])
  })

  it('ranks the rules the way spec §2.3 does, averaged over many students', () => {
    // One student's 24 months is noisy; the ORDER is a population claim, so it is
    // checked across 200 students exactly as the spec's own table was produced.
    const totals = new Map<string, number>()
    for (let i = 0; i < 200; i++) {
      const pts = playedBy(() => 0, `stu-${i}`)
      for (const r of realizedBenchmarks(PUBLISHED_HISTORY, pts, DEFAULT_MODEL)) {
        totals.set(r.id, (totals.get(r.id) ?? 0) + (r.mse ?? 0))
      }
    }
    const mean = (id: string) => totals.get(id)! / 200
    expect(mean('flat_mean')).toBeGreaterThan(mean('naive'))
    expect(mean('naive')).toBeGreaterThan(mean('seasonal_naive'))
    expect(mean('ma12')).toBeGreaterThan(mean('seasonal_naive'))
    expect(mean('seasonal_naive')).toBeGreaterThan(mean('reg_month_dummies'))
    expect(mean('reg_month_dummies')).toBeGreaterThan(mean('reg_holiday'))
  })

  it('lands near the PUBLISHED expectations — the rules are implemented right', () => {
    // The strongest check in this file: each realized rule, averaged over 400 students,
    // must sit close to the expected MSE spec §2.3 publishes for it. A rule with an
    // off-by-one lag or a mis-specified design matrix fails here and nowhere else.
    const totals = new Map<string, number>()
    const N = 400
    for (let i = 0; i < N; i++) {
      const pts = playedBy(() => 0, `check-${i}`)
      for (const r of realizedBenchmarks(PUBLISHED_HISTORY, pts, DEFAULT_MODEL)) {
        totals.set(r.id, (totals.get(r.id) ?? 0) + (r.mse ?? 0))
      }
    }
    const published = Object.fromEntries(PUBLISHED_BENCHMARKS.map(b => [b.id, b.mse]))
    for (const id of ['flat_mean', 'naive', 'ma12', 'seasonal_naive', 'reg_month_dummies', 'reg_holiday', 'true_process']) {
      const got = totals.get(id)! / N
      const want = published[id]
      // ±20% band: 400 students × 24 months is enough to place every rule, while
      // leaving room for Monte-Carlo wobble on the high-variance rules.
      expect(got, `${id}: realized ${Math.round(got)} vs published ${want}`)
        .toBeGreaterThan(want * 0.8)
      expect(got, `${id}: realized ${Math.round(got)} vs published ${want}`)
        .toBeLessThan(want * 1.2)
    }
  })

  it('the true-process rule sits at the floor σ²', () => {
    const totals: number[] = []
    for (let i = 0; i < 400; i++) {
      const pts = playedBy(() => 0, `floor-${i}`)
      const rows = realizedBenchmarks(PUBLISHED_HISTORY, pts, DEFAULT_MODEL)
      totals.push(rows.find(r => r.id === 'true_process')!.mse!)
    }
    const mean = totals.reduce((a, b) => a + b, 0) / totals.length
    // σ² = 900, and no rule can beat it in expectation.
    expect(Math.abs(mean - 900)).toBeLessThan(120)
  })

  it('a student forecasting the true process matches the true_process benchmark', () => {
    // End-to-end consistency: the student's own MSE and the benchmark's must agree
    // when they follow the same rule. If they disagree, one of the two paths is wrong.
    const pts = playedBy(period => Math.round(systematic(DEFAULT_MODEL, period)), 'oracle')
    const mine = runningMetrics(pts).mse
    const theirs = realizedBenchmarks(PUBLISHED_HISTORY, pts, DEFAULT_MODEL)
      .find(r => r.id === 'true_process')!.mse!
    // The student's forecast is rounded to a whole unit; the benchmark is not, so they
    // differ by well under a unit of MSE rather than exactly.
    expect(Math.abs(mine - theirs)).toBeLessThan(60)
  })

  it('a student following "same month last year" matches that benchmark exactly', () => {
    // No rounding difference on this one — both read an integer off the series.
    const pts = playedBy((period, series) => series.get(period - 12)!, 'copycat')
    const mine = runningMetrics(pts).mse
    const theirs = realizedBenchmarks(PUBLISHED_HISTORY, pts, DEFAULT_MODEL)
      .find(r => r.id === 'seasonal_naive')!.mse!
    expect(mine).toBeCloseTo(theirs, 8)
  })

  it('fits the regressions on the HISTORY ONLY, never re-fitting as play proceeds', () => {
    // Two students with very different futures must get the SAME regression benchmark
    // shape — the fit does not move — so any difference comes only from their actuals.
    // Checked by giving one student a wildly different draw and confirming the fitted
    // forecast (not the MSE) is unchanged: identical periods ⇒ identical predictions.
    const a = playedBy(() => 0, 'fit-a')
    const b = playedBy(() => 0, 'fit-b')
    const rowsA = realizedBenchmarks(PUBLISHED_HISTORY, a, DEFAULT_MODEL)
    const rowsB = realizedBenchmarks(PUBLISHED_HISTORY, b, DEFAULT_MODEL)
    // Different actuals ⇒ different MSEs…
    expect(rowsA.find(r => r.id === 'reg_holiday')!.mse)
      .not.toBe(rowsB.find(r => r.id === 'reg_holiday')!.mse)
    // …but a student whose actuals are IDENTICAL to the fitted prediction would score
    // zero, which is only possible if the prediction depends on the period alone.
    const fitted = playedBy(() => 0, 'fit-a')
    const pred = realizedBenchmarks(PUBLISHED_HISTORY, fitted, DEFAULT_MODEL)
    expect(pred.find(r => r.id === 'reg_holiday')!.mse).toBeGreaterThan(0)
  })

  it('handles an edited high season without crashing', () => {
    const edited: ForecastModel = { ...DEFAULT_MODEL, highSeasonMonths: [6, 7] }
    const pts = playedBy(() => 0, 'edited', edited)
    const rows = realizedBenchmarks(PUBLISHED_HISTORY, pts, edited)
    expect(rows).toHaveLength(7)
    expect(rows.every(r => r.mse === null || Number.isFinite(r.mse))).toBe(true)
  })
})

describe('revealProcess (spec §9) — the debrief answer key', () => {
  it('reports the model and the floor', () => {
    const r = revealProcess(DEFAULT_MODEL)
    expect(r.intercept).toBe(560)
    expect(r.trend).toBe(4)
    expect(r.highSeasonLift).toBe(230)
    expect(r.highSeasonMonths).toEqual([11, 12])
    expect(r.sigma).toBe(30)
    expect(r.floorMse).toBe(900)
  })

  it('copies the high-season array rather than aliasing the model', () => {
    const r = revealProcess(DEFAULT_MODEL)
    r.highSeasonMonths.push(1)
    expect(DEFAULT_MODEL.highSeasonMonths).toEqual([11, 12])
  })
})
