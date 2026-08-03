import { monthOf } from './history'
import { systematic, usesPublishedHistory, DEFAULT_SIGMA, type ForecastModel } from './demand'
import type { ForecastPoint } from './metrics'

// ═══════════════════════════════════════════════════════════════════════════════
// Forecasting — THE BENCHMARK RULES (spec §2.3). The debrief slide, in code.
//
// Spec §2.3 publishes EXPECTED MSE for eight rules, simulated across 4,000 student
// futures on the fixed history. Four lecture points fall out of that table, and the
// debrief screen (spec §9) and the Tier-3 summary box (spec §10) both display it
// beside the student's own MSE.
//
// ⚠ TWO KINDS OF NUMBER LIVE HERE, AND CONFUSING THEM WOULD BE A REAL BUG:
//
//   • PUBLISHED_BENCHMARKS — the spec §2.3 table. EXPECTED values, valid only for the
//     published history at the shipped model. They are constants because they are the
//     result of a 4,000-run simulation nobody wants to redo in a Cloud Function, and
//     because they are the numbers Elena's slide already carries.
//   • realizedBenchmarks() — what each rule WOULD ACTUALLY HAVE SCORED against one
//     student's own realized demand. Always valid, including on an instance whose
//     model an instructor has edited, where the published constants are simply wrong.
//
// The published table is served with a `validForThisInstance` flag rather than
// unconditionally, so an edited instance shows the realized comparison instead of a
// table of numbers describing a game nobody played.
//
// ⚠ THE CONSTANTS ARE NO LONGER SPEC §2.3's PRINTED FIGURES. They were re-simulated
// at σ = 60 when the default noise was raised (Elena, 08-02) — see the table's own
// note. The same script reproduces spec §2.3 exactly when run at σ = 30, which is what
// validates the replacement.
// ═══════════════════════════════════════════════════════════════════════════════

/** One row of the spec §2.3 comparison. */
export interface Benchmark {
  /** Stable id — the client keys its rows on this, never on the label. */
  id: string
  /** The label as spec §2.3 writes it. */
  label: string
  /** Expected MSE (spec §2.3). */
  mse: number
  /** √MSE, under the lecture's "Standard Error" label. */
  standardError: number
  /** Short gloss — the lecture point this row makes. Rendered under the label. */
  note: string
}

const bench = (id: string, label: string, mse: number, note: string): Benchmark => ({
  id, label, mse, standardError: Math.round(Math.sqrt(mse)), note,
})

/**
 * Spec §2.3's table, in its published ORDER — worst rule first, floor last, so the
 * improvement from "simple average" to "regression" reads down the column.
 *
 * ⚠⚠ RE-SIMULATED AT σ = 60 (Elena, 08-02). Spec §2.3's published table was computed
 * at σ = 30; raising the noise moves every row, so leaving those figures here would
 * have printed a confident, wrong comparison on the debrief screen and the Tier-3 box.
 *
 * ⚠ RE-SIMULATED A SECOND TIME when the HISTORY was regenerated at σ = 60. Several
 * rules are fitted on or lagged into the history — the flat mean, both regressions, and
 * the first year of the seasonal-naive and moving-average rules — so changing those
 * sixty numbers moves them. Leaving the previous figures would have been the same
 * mistake in a new place.
 *
 * Method, identical throughout: 40,000 simulated 24-month futures at σ = 60 against the
 * fixed published history, each rule scored the way a student following it would be.
 * Run under two independent seeds, agreeing to within 0.2% on every row. The same
 * script at σ = 30 against the OLD history reproduced spec §2.3 exactly
 * (37,821 / 10,071 / 9,048 / 4,166 / 999 / 899 / 897), which is what validates it.
 *
 * ⚠ TWO LESSONS WEAKEN AT σ = 60, and it is better to know that than to discover it on
 * a slide:
 *   • The simple-average-to-regression improvement falls from ≈42× to ≈11×. Still a
 *     large, teachable gap, but not the headline number spec §2.3 quotes.
 *   • The parsimony penalty falls from ≈11% to ≈2.7% (3,699 vs 3,601). The eleven-dummy
 *     model is fitted on the σ = 30 HISTORY, so its extra estimation error is small
 *     next to σ = 60 future noise. The ordering still holds and the point still stands,
 *     but it is now a fine distinction rather than a striking one.
 */
export const PUBLISHED_BENCHMARKS: readonly Benchmark[] = [
  bench('flat_mean', 'Flat at the five-year mean', 41338,
    "The lecture's “simple forecast” — one number for every month, so all the seasonality is error."),
  bench('naive', 'Repeat last month', 16253,
    'Ignores both the trend and the season; systematically low on a rising series.'),
  bench('ma12', 'Trailing 12-month moving average', 11881,
    'Barely better than doing nothing — averaging over a full year DELETES the seasonality that carries the signal. The trap that looks sophisticated.'),
  bench('seasonal_naive', 'Same month last year', 8399,
    "The lecture's “seasonality forecast” — captures the season, but carries a whole year of noise and misses the trend."),
  bench('reg_month_dummies', 'Regression: trend + eleven month dummies', 3853,
    'A good answer that still pays for ten parameters estimating nothing real — the parsimony price tag, though a smaller one at this noise level.'),
  bench('reg_holiday', 'Regression: trend + ONE holiday dummy', 3607,
    "The lecture's own model, and the right answer here — three parameters, landing essentially on the floor."),
  bench('true_process', 'Knowing the true process', 3599,
    'What perfect knowledge of the systematic component buys. The regression is essentially at it.'),
  bench('floor', 'The floor (σ²)', 3600,
    'Unsystematic variability. No forecast can beat this — it is what “some variability cannot be predicted” means numerically.'),
]

/** The row the debrief highlights as "where the lecture's method would have landed". */
export const LECTURE_MODEL_BENCHMARK_ID = 'reg_holiday'

/**
 * Whether spec §2.3's published table describes THIS instance.
 *
 * The table was simulated on the published history at the shipped model. An instance
 * whose model an instructor has edited is a different game, and showing these numbers
 * there would put a confident, wrong comparison on a student's debrief screen.
 */
export function publishedBenchmarksValid(model: ForecastModel, numHistory: number): boolean {
  // ⚠ σ IS CHECKED HERE EVEN THOUGH usesPublishedHistory NO LONGER CHECKS IT, and the
  // asymmetry is the point. The published HISTORY is a constant that σ cannot alter;
  // the published BENCHMARKS are expectations computed AT a particular σ, so an
  // instance at any other noise level must fall back to realized figures rather than
  // show a table describing a different game.
  return usesPublishedHistory(model, numHistory) && model.sigma === DEFAULT_SIGMA
}

// ── Realized benchmarks: what each rule would have scored on YOUR months ────────

/**
 * Least squares by explicit normal equations with Gaussian elimination.
 *
 * Small and self-contained on purpose: the alternative is a matrix dependency in a
 * Cloud Function for a problem that is at most 13×13 and runs on 60 rows. Returns null
 * for a singular system rather than NaNs — a caller that gets null omits the row
 * instead of charting a coefficient vector full of garbage.
 */
function ols(X: number[][], y: readonly number[]): number[] | null {
  const k = X[0]?.length ?? 0
  if (k === 0 || X.length < k) return null

  const XtX: number[][] = Array.from({ length: k }, () => new Array<number>(k).fill(0))
  const Xty = new Array<number>(k).fill(0)
  for (let i = 0; i < X.length; i++) {
    for (let j = 0; j < k; j++) {
      Xty[j] += X[i][j] * y[i]
      for (let l = 0; l < k; l++) XtX[j][l] += X[i][j] * X[i][l]
    }
  }

  // Augmented [XtX | Xty], eliminated with partial pivoting.
  const M = XtX.map((row, i) => [...row, Xty[i]])
  for (let c = 0; c < k; c++) {
    let piv = c
    for (let r = c + 1; r < k; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r
    if (Math.abs(M[piv][c]) < 1e-10) return null          // singular — e.g. a dummy that never fires
    const t = M[c]; M[c] = M[piv]; M[piv] = t
    for (let r = 0; r < k; r++) {
      if (r === c) continue
      const f = M[r][c] / M[c][c]
      for (let l = c; l <= k; l++) M[r][l] -= f * M[c][l]
    }
  }
  return M.map((row, i) => row[k] / row[i])
}

/** Design row for "trend + one holiday dummy" — the lecture's three-parameter model. */
function rowHoliday(p: number, highMonths: readonly number[]): number[] {
  return [1, p, highMonths.includes(monthOf(p)) ? 1 : 0]
}

/** Design row for "trend + eleven month dummies" — January is the omitted base. */
function rowMonthDummies(p: number): number[] {
  const row = [1, p]
  const m = monthOf(p)
  for (let j = 2; j <= 12; j++) row.push(m === j ? 1 : 0)
  return row
}

/** One realized benchmark: a rule, and the MSE it would have earned on these months. */
export interface RealizedBenchmark {
  id: string
  label: string
  /** MSE against the student's OWN actual demand. Null when the rule cannot be formed
   *  (e.g. a 12-month lag with less than a year of series behind it). */
  mse: number | null
}

/**
 * What each spec §2.3 rule would have scored against ONE student's realized months.
 *
 * ⚠ THE REGRESSIONS ARE FITTED ON THE HISTORY ONLY (spec §2.3: "all fitted on the same
 * fixed history"), never re-fitted as play proceeds. That is what a student doing the
 * assignment actually does — fit once on the five years they were given — and re-fitting
 * would silently make the benchmark a better forecaster than any student could be.
 *
 * The lag rules, by contrast, use the SERIES AS REVEALED: "repeat last month" at Y6 Feb
 * genuinely knows Y6 Jan, because that month has been revealed by then. That is the
 * rule a student could actually have followed.
 *
 * `points` must be the student's played months in period order. `history` is the common
 * five years, p = 1…history.length.
 */
export function realizedBenchmarks(
  history: readonly number[],
  points: readonly ForecastPoint[],
  model: ForecastModel,
): RealizedBenchmark[] {
  if (points.length === 0) return []

  // The full series by period: history, then each revealed actual.
  const series = new Map<number, number>()
  history.forEach((v, i) => series.set(i + 1, v))
  for (const p of points) series.set(p.period, p.actual)

  const historyPeriods = history.map((_, i) => i + 1)
  const bHoliday = ols(historyPeriods.map(p => rowHoliday(p, model.highSeasonMonths)), history)
  const bMonths = ols(historyPeriods.map(rowMonthDummies), history)
  const flat = history.reduce((s, v) => s + v, 0) / history.length

  const dot = (row: number[], b: number[] | null) =>
    b === null ? null : row.reduce((s, v, i) => s + v * b[i], 0)

  /** MSE of a forecasting rule over the played months; null if any month is unformable. */
  const mseOf = (forecastAt: (p: number) => number | null): number | null => {
    let sum = 0
    for (const pt of points) {
      const f = forecastAt(pt.period)
      if (f === null) return null
      sum += (pt.actual - f) ** 2
    }
    return sum / points.length
  }

  const lag = (p: number, k: number): number | null => series.get(p - k) ?? null

  const movingAverage12 = (p: number): number | null => {
    let sum = 0
    for (let k = 1; k <= 12; k++) {
      const v = series.get(p - k)
      if (v === undefined) return null
      sum += v
    }
    return sum / 12
  }

  return [
    { id: 'flat_mean', label: 'Flat at the five-year mean', mse: mseOf(() => flat) },
    { id: 'naive', label: 'Repeat last month', mse: mseOf(p => lag(p, 1)) },
    { id: 'ma12', label: 'Trailing 12-month moving average', mse: mseOf(movingAverage12) },
    { id: 'seasonal_naive', label: 'Same month last year', mse: mseOf(p => lag(p, 12)) },
    {
      id: 'reg_month_dummies',
      label: 'Regression: trend + eleven month dummies',
      mse: mseOf(p => dot(rowMonthDummies(p), bMonths)),
    },
    {
      id: 'reg_holiday',
      label: 'Regression: trend + ONE holiday dummy',
      mse: mseOf(p => dot(rowHoliday(p, model.highSeasonMonths), bHoliday)),
    },
    {
      id: 'true_process',
      label: 'Knowing the true process',
      mse: mseOf(p => systematic(model, p)),
    },
  ]
}

/**
 * The TRUE PROCESS, revealed (spec §9) — the debrief screen's headline.
 *
 * ⚠ INSTRUCTOR/DEBRIEF ONLY. This is the answer key: it is served exactly once, by the
 * debrief callable, AFTER the student's paragraph is stored and the game is over. It
 * must never appear in any response reachable before that (spec §12).
 */
export interface RevealedProcess {
  intercept: number
  trend: number
  highSeasonLift: number
  /** 1-based month numbers, so the client can name them. */
  highSeasonMonths: number[]
  sigma: number
  /** σ² — the floor no forecast can beat (spec §2.3). */
  floorMse: number
  seasonality: 'additive' | 'multiplicative'
}

export function revealProcess(model: ForecastModel): RevealedProcess {
  return {
    intercept: model.a,
    trend: model.b,
    highSeasonLift: model.H,
    highSeasonMonths: [...model.highSeasonMonths],
    sigma: model.sigma,
    floorMse: model.sigma * model.sigma,
    seasonality: model.seasonality,
  }
}
