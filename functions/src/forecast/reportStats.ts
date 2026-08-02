import { systematic, type ForecastModel } from './demand'
import { pointMetrics, type ForecastPoint } from './metrics'

// ═══════════════════════════════════════════════════════════════════════════════
// Forecasting — the report aggregates (spec §10). Pure, Firestore-free, unit-testable.
//
// ⚠ CORRECT ON PARTIAL DATA, which is the normal case. Elena opens the reports mid-week
// with the class spread across the assignment: some finished, some four months in, some
// not started. Every aggregate below is over WHO ACTUALLY PLAYED that month, the x-axis
// is the longest game anyone played, and nothing divides by a denominator it has not
// checked. The per-month denominator travels with each point (`n`) precisely so a tail
// wobble reads as three students being left rather than as a finding — spec §10 calls
// this out explicitly ("late months average fewer students — composition, not
// behavior").
//
// ⚠ THE MODEL LIVES HERE AND ONLY HERE ON THE INSTRUCTOR SIDE. The Tier-3 dashed
// reference is the true systematic component, "auto-derived from config, never
// hand-entered" (spec §10) — so this module takes a ForecastModel. No student-facing
// module imports it.
// ═══════════════════════════════════════════════════════════════════════════════

/** One student's whole game, flattened to what the aggregates need. */
export interface ForecastGameRow {
  participant_id: string
  points: ForecastPoint[]
}

/** One month of the Tier-3 class chart, with the number of students it averages over. */
export interface ClassSeriesPoint {
  period: number
  /** "Y6 Jan" — the axis label. */
  label: string
  /** Class average of realized demand for this month. */
  actual: number
  /** Class average of the forecasts submitted for this month. */
  forecast: number
  /** The TRUE systematic component (spec §10's dashed reference), from the model. */
  systematic: number
  /** How many students this month averages over. Never omitted — see the header. */
  n: number
}

const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length

/**
 * The Tier-3 class chart (spec §10): average actual demand, average forecast, and the
 * true systematic component, month by month.
 *
 * ⚠ AVERAGED OVER STUDENTS WHO PLAYED THAT MONTH, not over the class. Two students
 * face DIFFERENT realized demand for the same month (spec §2.2: futures are per
 * student), so "average actual" is a real average of different numbers rather than one
 * number repeated — and it should sit near the systematic component, which is the
 * comparison the chart exists to make.
 *
 * A month nobody has reached is SKIPPED rather than plotted as zero — a zero there
 * would draw a cliff at the end of every mid-week chart.
 */
export function classSeries(
  rows: readonly ForecastGameRow[],
  model: ForecastModel,
  labelFor: (period: number) => string,
): ClassSeriesPoint[] {
  const byPeriod = new Map<number, ForecastPoint[]>()
  for (const r of rows) {
    for (const p of r.points) {
      const bucket = byPeriod.get(p.period)
      if (bucket) bucket.push(p)
      else byPeriod.set(p.period, [p])
    }
  }

  return [...byPeriod.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([period, ps]) => ({
      period,
      label: labelFor(period),
      actual: mean(ps.map(p => p.actual)),
      forecast: mean(ps.map(p => p.forecast)),
      systematic: systematic(model, period),
      n: ps.length,
    }))
}

// ── Per-student figures (Tier 1) ───────────────────────────────────────────────

/** Every Tier-1 outcome column for one student (spec §10). Nulls where they have
 *  played nothing, so the table shows a dash rather than a zero they did not earn. */
export interface StudentOutcome {
  monthsPlayed: number
  mae: number | null
  mse: number | null
  standardError: number | null
  mape: number | null
  accuracy: number | null
  bonus: number | null
  meanError: number | null
  /** Y6 and Y7 MSE, and whether the second beat the first. */
  firstYearMse: number | null
  secondYearMse: number | null
  improved: boolean | null
}

/**
 * ⚠ RECOMPUTED FROM THE RAW PAIRS, not read off the denormalized cache that
 * forecastSubmitRound writes.
 *
 * The participant doc carries `mse`, `mae`, `mape` and `mean_error` so a roster of 200
 * students does not re-derive 24 months of metrics per row per page load. But the
 * REPORT recomputes from `rounds` anyway, because the cache is written by one code path
 * and read by another: if they ever disagreed, the cache would win silently and Elena
 * would grade from a number nothing could reproduce. Recomputing here means the cache
 * is an optimization that cannot become a second source of truth.
 */
export function studentOutcome(
  points: readonly ForecastPoint[],
  running: (pts: readonly ForecastPoint[]) => {
    mae: number; mse: number; standardError: number
    mape: number | null; accuracy: number | null; bonus: number | null; meanError: number
  },
  years: (pts: readonly ForecastPoint[]) => {
    first: { mse: number } | null; second: { mse: number } | null; improved: boolean | null
  },
): StudentOutcome {
  if (points.length === 0) {
    return {
      monthsPlayed: 0, mae: null, mse: null, standardError: null, mape: null,
      accuracy: null, bonus: null, meanError: null,
      firstYearMse: null, secondYearMse: null, improved: null,
    }
  }
  const r = running(points)
  const y = years(points)
  return {
    monthsPlayed: points.length,
    mae: r.mae,
    mse: r.mse,
    standardError: r.standardError,
    mape: r.mape,
    accuracy: r.accuracy,
    bonus: r.bonus,
    meanError: r.meanError,
    firstYearMse: y.first?.mse ?? null,
    secondYearMse: y.second?.mse ?? null,
    improved: y.improved,
  }
}

// ── Class figures (the Tier-3 summary box) ─────────────────────────────────────

export interface ClassSummary {
  /** How many students have played at least one month. */
  students: number
  meanMae: number | null
  meanMse: number | null
  /** ⚠ √(mean MSE), NOT the mean of each student's Standard Error — see below. */
  standardError: number | null
  meanBias: number | null
  meanMape: number | null
}

/**
 * The Tier-3 summary box (spec §10): "class mean MAE / MSE / Standard Error / bias,
 * beside all six benchmark MSEs from §2.3. This box IS the debrief slide."
 *
 * ⚠ THE CLASS STANDARD ERROR IS √(MEAN MSE), NOT THE MEAN OF THE STUDENTS' √MSE. The
 * two differ (Jensen's inequality — the mean of square roots is below the square root
 * of the mean), and only the first is comparable with spec §2.3's benchmark column,
 * which is √(expected MSE). Averaging the students' own Standard Errors would put a
 * number in this box that sits systematically BELOW the benchmark table beside it and
 * flatter the class by construction.
 */
export function classSummary(
  rows: readonly ForecastGameRow[],
  running: (pts: readonly ForecastPoint[]) => {
    mae: number; mse: number; mape: number | null; meanError: number
  },
): ClassSummary {
  const played = rows.filter(r => r.points.length > 0)
  if (played.length === 0) {
    return { students: 0, meanMae: null, meanMse: null, standardError: null, meanBias: null, meanMape: null }
  }
  const each = played.map(r => running(r.points))
  const meanMse = mean(each.map(e => e.mse))
  const mapes = each.map(e => e.mape).filter((m): m is number => m !== null)

  return {
    students: played.length,
    meanMae: mean(each.map(e => e.mae)),
    meanMse,
    standardError: Math.sqrt(meanMse),
    meanBias: mean(each.map(e => e.meanError)),
    meanMape: mapes.length === 0 ? null : mean(mapes),
  }
}

/**
 * The MSE histogram (spec §10's SECOND Tier-3 chart, "build in v1"): the class's MSE
 * distribution, with the §2.3 benchmarks marked as reference lines by the client.
 *
 * ⚠ BINNED ON A LOG SCALE. Student MSEs at these parameters span roughly 900 to 40,000
 * — a 40× range — and spec §10 wants the chart to "locate the chased-the-noise tail".
 * Linear bins would put every competent student in the first bucket and the entire
 * lesson in a smear at the left edge. Log bins make the benchmark reference lines land
 * at readable, well-separated positions, which is the whole reason the chart exists.
 *
 * Returns null when nobody has played — the caller renders a note, not an empty axis.
 */
export interface MseHistogram {
  bins: { lo: number; hi: number; count: number }[]
  min: number
  max: number
}

export function mseHistogram(mses: readonly number[], binCount = 12): MseHistogram | null {
  const valid = mses.filter(m => Number.isFinite(m) && m > 0)
  if (valid.length === 0) return null

  const min = Math.min(...valid)
  const max = Math.max(...valid)
  // A degenerate spread (one student, or every student identical) still needs a chart
  // with width, so the range is widened rather than divided by zero.
  const lo = Math.log10(min)
  const hi = Math.log10(max)
  const span = hi - lo < 1e-9 ? 0.5 : hi - lo
  const base = hi - lo < 1e-9 ? lo - 0.25 : lo

  const bins = Array.from({ length: binCount }, (_, i) => ({
    lo: 10 ** (base + (span * i) / binCount),
    hi: 10 ** (base + (span * (i + 1)) / binCount),
    count: 0,
  }))
  for (const m of valid) {
    const t = (Math.log10(m) - base) / span
    // The top value lands exactly on 1 and must go in the LAST bin, not past the end.
    const idx = Math.min(binCount - 1, Math.max(0, Math.floor(t * binCount)))
    bins[idx].count += 1
  }
  return { bins, min, max }
}

/** Per-month figures for the instructor's per-student drill-down (spec §10, Tier 1:
 *  "each row drills through to that student's individual report"). */
export function studentMonthRows(points: readonly ForecastPoint[]) {
  return points.map(p => {
    const m = pointMetrics(p)
    return {
      period: p.period,
      forecast: p.forecast,
      actual: p.actual,
      error: m.error,
      absoluteError: m.absoluteError,
      squaredError: m.squaredError,
      absolutePercentageError: m.absolutePercentageError,
    }
  })
}
