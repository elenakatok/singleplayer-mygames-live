import { Timestamp } from 'firebase-admin/firestore'
import { periodLabelShort, periodLabelLong, monthOf, yearOf } from './history'
import { pointMetrics, runningMetrics, type ForecastPoint, type RunningMetrics } from './metrics'

// ═══════════════════════════════════════════════════════════════════════════════
// Forecasting — the MONTH RECORD: how a played month is stored, and how it is
// reshaped for the student. Pure and Firestore-free (bar the Timestamp value type).
//
// ⚠⚠ ONLY THE RAW PAIR IS STORED — a deliberate divergence from newsvendor, which
// stores its derived per-period figures alongside the raw ones.
//
// Here every derived number (error, AE, SE, APE, and all four running metrics) is a
// PURE FUNCTION of (forecast, actual), computed in metrics.ts. Storing them too would
// create a second source of truth that can silently disagree with the first — and this
// game recomputes those figures in four places (the round card, the history table, the
// final screen, and both report tiers), so a drift would show up as one screen
// contradicting another with no way to tell which was right. The raw pair IS the audit
// record; nothing is recoverable from the derived values that is not recoverable from
// it. Rounds stay auditable in the architecture §8 sense — order, outcome, and when.
//
// ⚠⚠ AN UNPLAYED MONTH HAS NO RECORD AT ALL. This is the structural half of the
// no-leak requirement (spec §12): realized demand for a month the student has not yet
// forecast is not written anywhere, not marked pending, not pre-generated. It does not
// exist until the compute step draws it, which happens after the forecast is committed.
// There is therefore nothing for a whitelist to omit — the omission is in the data
// model itself.
// ═══════════════════════════════════════════════════════════════════════════════

/** One played month, AS STORED on the participant doc (snake_case, Firestore style). */
export interface StoredRound {
  /** 1-based ROUND index: 1 is the first month played. */
  round: number
  /**
   * 1-based PERIOD on the continuous axis (spec §2): 61 is Y6 Jan.
   *
   * Stored rather than derived from `round` because the two differ whenever
   * `numHistory` is not 60, and every calendar label, the year split and both CSVs key
   * off the period. Deriving it at read time would need numHistory in scope in five
   * more places, each free to get it wrong.
   */
  period: number
  /** What the student said. */
  forecast: number
  /** What actually happened — the realized demand drawn for THIS student (spec §2.2). */
  actual: number
  /**
   * When the month was played. A CONCRETE Timestamp, deliberately not
   * FieldValue.serverTimestamp(): Firestore rejects sentinel values inside array
   * elements, and months are stored as an array.
   */
  played_at: Timestamp
}

/**
 * One played month, AS SENT TO THE STUDENT (camelCase, client style) — the history
 * table's row (spec §4).
 *
 * Every field is either the raw pair or derived from it. Note what is absent: no model
 * parameter, no systematic component, no benchmark, and no month the student has not
 * played.
 */
export interface ClientRound {
  round: number
  period: number
  /** "Y6 Jan" — the row label. */
  label: string
  forecast: number
  actual: number
  /** SIGNED (spec §4): positive means demand came in above the forecast. */
  error: number
  absoluteError: number
  squaredError: number
  /** Fraction, or null on a zero-demand month (metrics.ts). */
  absolutePercentageError: number | null
  /** Running figures THROUGH this month — the "to date" columns. */
  maeToDate: number
  mseToDate: number
  mapeToDate: number | null
}

/**
 * Defensive read of the stored months array. Anything malformed is DROPPED rather than
 * thrown on — the same posture as loadForecastConfig. Stops at the first bad element so
 * the surviving prefix stays a contiguous history (round 1..n with no hole), which is
 * what every consumer assumes.
 */
export function parseStoredRounds(raw: unknown): StoredRound[] {
  if (!Array.isArray(raw)) return []
  const out: StoredRound[] = []
  const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

  for (const el of raw) {
    const r = (typeof el === 'object' && el !== null ? el : {}) as Record<string, unknown>
    const expected = out.length + 1
    if (r.round !== expected) break
    if (!num(r.period) || !num(r.forecast) || !num(r.actual)) break

    out.push({
      round: expected,
      period: r.period,
      forecast: r.forecast,
      actual: r.actual,
      played_at: r.played_at instanceof Timestamp ? r.played_at : Timestamp.fromMillis(0),
    })
  }
  return out
}

/** The stored months as the raw (period, forecast, actual) triples metrics.ts consumes.
 *  One conversion, so no caller re-derives the mapping and gets the period wrong. */
export function toPoints(rounds: readonly StoredRound[]): ForecastPoint[] {
  return rounds.map(r => ({ period: r.period, forecast: r.forecast, actual: r.actual }))
}

/**
 * The student-facing history: one row per month PLAYED, with the running columns
 * (spec §4).
 *
 * Built field by field. Nothing is spread from the stored record, and the only inputs
 * are the raw pair and the period — so a field added to StoredRound later cannot ride
 * out to a student by accident.
 */
export function toClientHistory(rounds: readonly StoredRound[]): ClientRound[] {
  const points = toPoints(rounds)
  return rounds.map((r, i) => {
    const m = pointMetrics(points[i])
    const running = runningMetrics(points.slice(0, i + 1))
    return {
      round: r.round,
      period: r.period,
      label: periodLabelShort(r.period),
      forecast: r.forecast,
      actual: r.actual,
      error: m.error,
      absoluteError: m.absoluteError,
      squaredError: m.squaredError,
      absolutePercentageError: m.absolutePercentageError,
      maeToDate: running.mae,
      mseToDate: running.mse,
      mapeToDate: running.mape,
    }
  })
}

/** This month's card (spec §4's round-results screen) — the single month, plus the
 *  running scorecard as of it. */
export interface ClientRoundResult {
  round: number
  period: number
  /** "Year 6, January" — the card's heading. */
  label: string
  month: number
  year: number
  forecast: number
  actual: number
  error: number
  absoluteError: number
  squaredError: number
  absolutePercentageError: number | null
  /** MAE · MSE · Standard Error · MAPE · Accuracy · bonus, running since round 1. */
  running: RunningMetrics
}

/** One month's result card, built from the stored months up to and including it. */
export function toClientResult(rounds: readonly StoredRound[]): ClientRoundResult {
  const last = rounds[rounds.length - 1]
  const points = toPoints(rounds)
  const m = pointMetrics(points[points.length - 1])
  return {
    round: last.round,
    period: last.period,
    label: periodLabelLong(last.period),
    month: monthOf(last.period),
    year: yearOf(last.period),
    forecast: last.forecast,
    actual: last.actual,
    error: m.error,
    absoluteError: m.absoluteError,
    squaredError: m.squaredError,
    absolutePercentageError: m.absolutePercentageError,
    running: runningMetrics(points),
  }
}
