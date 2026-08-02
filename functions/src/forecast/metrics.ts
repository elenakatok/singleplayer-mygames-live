import { yearOf } from './history'
import { BONUS_AT_PERFECT } from './config'

// ═══════════════════════════════════════════════════════════════════════════════
// Forecasting — THE SCORECARD (spec §4, §5, §5a). Pure, Firestore-free, unit-tested
// against independent recomputation.
//
// ⚠ MSE IS THE OBJECTIVE AND THE HEADLINE (spec §5a). MAPE, Forecast Accuracy and the
// bonus are reported ALONGSIDE it, never instead of it. Spec §5a records that the
// bonus mapping COMPRESSES the very distinction the game teaches — the analyst beats
// the do-nothing forecaster 11× on MSE and by under 5% on the bonus — and that Elena
// accepted that on 08-02 because the bonus is motivational framing while MSE carries
// the lesson. Two sharper mappings were considered and rejected. DO NOT RE-LITIGATE.
//
// ⚠ THE VOCABULARY IS THE LECTURE'S, NOT THE TEXTBOOK'S. √MSE is reported as
// "Standard Error", never as "RMSE" (spec §0, §5, §15) — slide 10's own summary-row
// label. Renaming it would break the mapping between the game and the deck, which is
// the entire reason this game exists rather than the SoPHIE original.
//
// ⚠ SIGNED ERROR IS FIRST-CLASS (spec §4). Bias — chronically under-forecasting a
// rising trend, chronically missing December — is the most legible lesson here and is
// invisible in absolute errors. `error` keeps its sign everywhere, and `meanError` is
// reported in its own right.
// ═══════════════════════════════════════════════════════════════════════════════

/** One month's raw pair: what they said, and what happened. */
export interface ForecastPoint {
  /** 1-based PERIOD on the continuous axis (61 = Y6 Jan), not a round index. */
  period: number
  forecast: number
  actual: number
}

/** One month's derived error figures (spec §4's history-table columns). */
export interface PointMetrics {
  /** actual − forecast. SIGNED: positive means demand came in ABOVE the forecast. */
  error: number
  /** |error| */
  absoluteError: number
  /** error² */
  squaredError: number
  /**
   * |error| / actual — the absolute PERCENTAGE error, as a fraction (0.05 = 5%).
   *
   * ⚠ NULL WHEN ACTUAL IS ZERO, and that is a real case, not defensive padding.
   * Demand is floored at 0 (spec §2), so an instructor who configures a low level and
   * large σ can produce a zero month — and |e|/0 is undefined, not infinite-but-usable.
   * A null is EXCLUDED from the MAPE mean rather than counted as zero (which would
   * flatter the student) or as some large constant (which would punish them for the
   * instructor's config). Spec §5a's stability floor and its Settings warning exist
   * because of exactly this.
   */
  absolutePercentageError: number | null
}

/** The running scorecard after k months (spec §4's round-results card, §5's finals). */
export interface RunningMetrics {
  /** Months scored. */
  n: number
  /** Mean Absolute Error. */
  mae: number
  /** Mean Squared Error — THE OBJECTIVE (spec §5a). */
  mse: number
  /** √MSE, reported under the lecture's label "Standard Error" — never "RMSE". */
  standardError: number
  /**
   * Mean Absolute Percentage Error, as a fraction (0.05 = 5%).
   *
   * Averaged over months with a DEFINED APE only — see PointMetrics. Null when no
   * month had one (every actual was zero, or nothing has been played).
   */
  mape: number | null
  /** How many months actually entered the MAPE mean. Shown so a divergence between
   *  `n` and this is visible rather than silently changing what MAPE means. */
  mapeN: number
  /** 1 − MAPE, as a fraction (0.973 = 97.3%). Null exactly when MAPE is. */
  accuracy: number | null
  /** BONUS_AT_PERFECT × (1 − MAPE), in dollars. Null exactly when MAPE is. */
  bonus: number | null
  /** Mean SIGNED error — the bias figure (spec §5). Positive ⇒ they under-forecast. */
  meanError: number
}

/** Per-month figures for one point. */
export function pointMetrics(p: ForecastPoint): PointMetrics {
  const error = p.actual - p.forecast
  return {
    error,
    absoluteError: Math.abs(error),
    squaredError: error * error,
    absolutePercentageError: p.actual === 0 ? null : Math.abs(error) / p.actual,
  }
}

/**
 * The running scorecard over a list of months (spec §4, §5).
 *
 * ⚠ COMPUTED FROM THE RAW PAIRS EVERY TIME, never accumulated incrementally. An
 * incremental running mean would drift, and worse, it would make a re-scored history
 * disagree with a freshly-scored one — which is exactly the divergence that makes a
 * report irreproducible. The month arrays here are 24 long; recomputing is free.
 *
 * An empty list returns a ZEROED scorecard with nulls for the MAPE family, rather than
 * NaN: the round-results screen renders before any percentage exists on a zero-demand
 * instance, and NaN would print as "NaN" on a student's screen.
 */
export function runningMetrics(points: readonly ForecastPoint[]): RunningMetrics {
  const n = points.length
  if (n === 0) {
    return {
      n: 0, mae: 0, mse: 0, standardError: 0,
      mape: null, mapeN: 0, accuracy: null, bonus: null, meanError: 0,
    }
  }

  let sumAbs = 0, sumSq = 0, sumErr = 0, sumApe = 0, apeN = 0
  for (const p of points) {
    const m = pointMetrics(p)
    sumAbs += m.absoluteError
    sumSq += m.squaredError
    sumErr += m.error
    if (m.absolutePercentageError !== null) {
      sumApe += m.absolutePercentageError
      apeN += 1
    }
  }

  const mse = sumSq / n
  const mape = apeN === 0 ? null : sumApe / apeN

  return {
    n,
    mae: sumAbs / n,
    mse,
    standardError: Math.sqrt(mse),
    mape,
    mapeN: apeN,
    accuracy: mape === null ? null : 1 - mape,
    bonus: mape === null ? null : bonusFor(mape),
    meanError: sumErr / n,
  }
}

/**
 * The notional annual bonus (spec §5a): BONUS_AT_PERFECT × (1 − MAPE).
 *
 * ⚠ FLOORED AT ZERO. A MAPE above 100% is entirely reachable — forecast 2,000 against
 * an actual of 600 and the APE is 2.33 — and a NEGATIVE bonus would read as "you owe
 * the company money", which is not the framing and not what SoPHIE did. The floor is
 * a display decision, not a metric one: MSE, MAE and MAPE itself are all unfloored.
 */
export function bonusFor(mape: number): number {
  return Math.max(0, BONUS_AT_PERFECT * (1 - mape))
}

/**
 * MSE broken out by CALENDAR YEAR of the played months (spec §5: "Year 6 vs. Year 7
 * MSE side by side" — did they improve?).
 *
 * ⚠ KEYED BY THE REAL YEAR, NOT BY "first half / second half". At the shipped config
 * (60 history + 24 played) these are exactly Y6 and Y7, which is what the screen and
 * the Tier-1 column say. But `rounds` is editable, and a 30-month instance splitting
 * into "first 15 / last 15" would put a label on the screen that names a year the
 * split does not follow. Grouping by yearOf(period) is correct at every configuration
 * and degenerates to the spec's two groups at the shipped one.
 *
 * Returns entries in ascending year order, each with its own month count so a partial
 * final year is visible rather than silently averaged against a full one.
 */
export function mseByYear(
  points: readonly ForecastPoint[],
): { year: number; n: number; mse: number }[] {
  const byYear = new Map<number, ForecastPoint[]>()
  for (const p of points) {
    const y = yearOf(p.period)
    const bucket = byYear.get(y)
    if (bucket) bucket.push(p)
    else byYear.set(y, [p])
  }
  return [...byYear.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([year, ps]) => ({
      year,
      n: ps.length,
      mse: ps.reduce((s, p) => s + pointMetrics(p).squaredError, 0) / ps.length,
    }))
}

/**
 * The two-year comparison the final screen and the Tier-1 column render (spec §5, §10).
 *
 * `improved` is null until BOTH years have a month in them — a student twelve months
 * in has no second year to compare, and rendering "improved: false" there would tell
 * them they got worse at a game they are halfway through.
 */
export interface YearComparison {
  first: { year: number; n: number; mse: number } | null
  second: { year: number; n: number; mse: number } | null
  /** second.mse < first.mse. Null until both years exist. */
  improved: boolean | null
}

export function yearComparison(points: readonly ForecastPoint[]): YearComparison {
  const years = mseByYear(points)
  const first = years[0] ?? null
  const second = years[1] ?? null
  return {
    first,
    second,
    improved: first === null || second === null ? null : second.mse < first.mse,
  }
}

/**
 * The running scorecard AFTER EACH MONTH — one row per month, in order.
 *
 * This is the history table's "MAE to date / MSE to date / MAPE to date" columns
 * (spec §4). Built by re-running `runningMetrics` over each prefix rather than by
 * accumulating, for the reason in that function's own note: a prefix scored here and
 * the same prefix scored anywhere else must agree exactly.
 */
export function runningSeries(points: readonly ForecastPoint[]): RunningMetrics[] {
  return points.map((_, i) => runningMetrics(points.slice(0, i + 1)))
}
