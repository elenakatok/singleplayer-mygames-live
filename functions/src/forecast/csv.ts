import { MONTH_NAMES, monthOf, yearOf } from './history'
import { pointMetrics } from './metrics'
import type { StoredRound } from './rounds'

// ═══════════════════════════════════════════════════════════════════════════════
// Forecasting — THE TWO CSV EXPORTS (spec §4, §5). Pure; the callable that serves them
// is in getExport.ts.
//
// ⚠⚠ THE EXPORT IS LOAD-BEARING, NOT A CONVENIENCE (spec §4). The lecture's method is
// an EXCEL method: a student cannot run a regression on numbers they can only read off
// a chart. If this file is broken, the taught method is unusable and the assignment
// fails at the first screen.
//
// ⚠⚠ NO PRE-CODED HIGH-SEASON INDICATOR (spec §4, amended 08-02). An earlier build
// shipped a `HighSeason` 0/1 column, on the reading that slide 12's worked example has
// one. Elena's call reversed that, and the reasoning is worth keeping here because the
// column is the obvious thing to "helpfully" add back:
//
//     Slide 11 presents adding the indicator as something the ANALYST DOES — "add an
//     indicator variable that is 1 for Friday and Saturday and 0 otherwise". Shipping
//     it pre-coded hands the student BOTH the noticing step (which months are
//     systematic) and the coding step — the two things the exercise exists to make
//     them perform. Coding it is one IF formula over sixty rows.
//
// `Month` is supplied as a NAME precisely so that coding is possible; the on-screen
// chart and the month-by-year grid are left un-shaded for the same reason (spec §4).
// DO NOT ADD THE INDICATOR BACK.
//
// ⚠ A STRUCTURAL CONSEQUENCE WORTH NOTING: neither builder takes a ForecastModel any
// more. The indicator was the only thing either needed it for, so the export path now
// has no access to a, b, H, σ or the high season at all. The files cannot leak the
// model because they are never handed it — which is a stronger guarantee than the
// review discipline that preceded it.
//
// ⚠⚠ TWO EXPORTS, TWO DIFFERENT RULES — and mixing them up is the leak (spec §12):
//
//   buildHistoryCsv  IN-PLAY.  FROZEN at the five-year history, months 1…numHistory.
//                    It does NOT grow as play proceeds (Elena, 08-02 — spec §4, §14).
//                    Nothing is hidden by that: the on-screen chart and the
//                    month-by-year table always show every revealed month, so a
//                    student re-fitting mid-game adds the handful of new numbers by
//                    hand.
//   buildFullCsv     FINAL SCREEN. History PLUS every month the student actually
//                    PLAYED — their forecast, the actual, and the errors. This is the
//                    one export that grows, and it exists for the debrief and for any
//                    follow-up analysis (spec §5).
//
// ⚠⚠ NEITHER CAN CONTAIN AN UNPLAYED MONTH, and that is structural rather than
// filtered: `buildFullCsv` iterates the STORED ROUNDS, and an unplayed month has no
// stored round (rounds.ts). There is no array of futures to accidentally slice one row
// too far. The harness asserts both files directly (spec §12).
// ═══════════════════════════════════════════════════════════════════════════════

/** RFC-4180 field escaping. Overkill for integers, correct for an edited product name
 *  containing a comma — which is a real thing an instructor can type. */
function cell(v: string | number | null): string {
  if (v === null) return ''
  const s = String(v)
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

function toCsv(header: readonly string[], rows: readonly (string | number | null)[][]): string {
  // \r\n line endings: Excel on Windows is the actual target application here, and it
  // is the one that cares.
  return [header, ...rows].map(r => r.map(cell).join(',')).join('\r\n') + '\r\n'
}

/**
 * THE IN-PLAY EXPORT (spec §4) — "Demand history, Years 1–5". FROZEN at the history.
 *
 * Columns are exactly spec §4's: `Time, Year, Month, Demand`. `Time` is the period
 * index 1…N, which is the regressor slide 12 uses; `Year` and `Month` let a student
 * pivot, group and — crucially — write the IF formula that codes their own indicator.
 *
 * ⚠ TAKES THE HISTORY AND NOTHING ELSE. There is no parameter through which a played
 * month could enter this file, and none through which the model could — which is what
 * "frozen" and "leak-free" mean in code rather than in a comment.
 */
export function buildHistoryCsv(history: readonly number[]): string {
  const rows = history.map((demand, i) => {
    const period = i + 1
    return [period, yearOf(period), MONTH_NAMES[monthOf(period) - 1], demand]
  })
  return toCsv(['Time', 'Year', 'Month', 'Demand'], rows)
}

/** The filename the in-play download offers. Named for what it contains, per spec §4's
 *  requirement that it be LABELLED as the five-year history. */
export function historyCsvFilename(history: readonly number[]): string {
  return `demand-history-years-1-${Math.ceil(history.length / 12)}.csv`
}

/**
 * THE FINAL-SCREEN EXPORT (spec §5) — history plus every month actually played.
 *
 * History rows carry a Demand and blank forecast/error cells; played rows carry all of
 * it. The blanks are deliberate: a zero there would be a data point a student could
 * accidentally regress on, and an omitted history block would break the continuous
 * `Time` axis that makes the file fittable.
 *
 * ⚠ NO INDICATOR COLUMN HERE EITHER. Spec §5 lists this file's contents as "history,
 * every forecast, actual, and error" — no indicator — and the §4 reasoning applies with
 * equal force: this export exists for "any follow-up analysis you assign", so
 * pre-coding the indicator would undercut the same skill a second time. It also keeps
 * the two files consistent for a student who fits on one and extends with the other.
 *
 * ⚠ ONLY PLAYED MONTHS ARE APPENDED. `rounds` is the stored array; an unplayed month
 * has no element in it, so this file cannot reach past where the student actually got
 * to — including for a student who somehow requests it mid-game.
 */
export function buildFullCsv(
  history: readonly number[],
  rounds: readonly StoredRound[],
): string {
  const header = [
    'Time', 'Year', 'Month', 'Demand',
    'Forecast', 'Error', 'AbsoluteError', 'SquaredError', 'AbsolutePercentageError',
  ]

  const rows: (string | number | null)[][] = history.map((demand, i) => {
    const period = i + 1
    return [
      period, yearOf(period), MONTH_NAMES[monthOf(period) - 1], demand,
      null, null, null, null, null,
    ]
  })

  for (const r of rounds) {
    const m = pointMetrics({ period: r.period, forecast: r.forecast, actual: r.actual })
    rows.push([
      r.period,
      yearOf(r.period),
      MONTH_NAMES[monthOf(r.period) - 1],
      r.actual,
      r.forecast,
      m.error,
      m.absoluteError,
      m.squaredError,
      // Rounded to six places so a repeating fraction does not print 17 digits into a
      // spreadsheet cell. Null (blank) on a zero-demand month, as everywhere else.
      m.absolutePercentageError === null ? null : Number(m.absolutePercentageError.toFixed(6)),
    ])
  }

  return toCsv(header, rows)
}

/** The filename the final download offers. */
export const FULL_CSV_FILENAME = 'demand-and-forecasts.csv'
