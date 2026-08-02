// ═══════════════════════════════════════════════════════════════════════════════
// Forecasting — THE PUBLISHED FIVE-YEAR HISTORY (spec §2.1) and the calendar.
//
// Pure, Firestore-free, and imported by BOTH sides of the wire: the server sends the
// history to the student (it is not secret — it is the whole point of the opening
// screen) and the harness re-derives it. Nothing here is a draw; the numbers below are
// a CONSTANT.
//
// ⚠⚠ THE HISTORY IS A FIXED ARRAY, NOT A GENERATED ONE (spec §2.2: "the 60 months of
// history are a fixed array, identical for everyone"). These sixty integers are the
// table printed in spec §2.1 and they are the authority, for three reasons that all
// point the same way:
//
//   1. Spec §2.1 states the parsimonious fit on this history is intercept 564.7,
//      trend 3.95, holiday +227.5. It is — exactly, to the printed digit. Regenerating
//      the history from a different RNG would silently break that claim.
//   2. The §2.3 benchmark table (which the debrief screen and the Tier-3 summary box
//      both DISPLAY) is computed against this specific history. Different numbers ⇒ a
//      benchmark table that lies.
//   3. Seed 1 was chosen so Nov and Dec beat every other month of their own year in
//      all five years (spec §2.1). That is a property of THESE numbers; no other draw
//      is guaranteed to have it, and the high season reading as a rule rather than a
//      run of luck is load-bearing for the exercise.
//
// A generated fallback exists in demand.ts for the case where an instructor edits the
// model away from the shipped defaults — see `usesPublishedHistory`. At the defaults,
// which is every real instance, this table is what students see.
//
// PERIODS RUN CONTINUOUSLY (spec §2): p = 1…60 is history (Y1M1…Y5M12) and p = 61…84
// is play (Y6M1…Y7M12). There is one period axis, not two, so "next month" after the
// last history month is simply p = 61.
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * The published five-year history, p = 1…60, in period order (Y1 Jan … Y5 Dec).
 *
 * ⚠ DO NOT EDIT THESE NUMBERS. They are spec §2.1's table, transcribed row by row.
 * `forecastHistoryFit` in the harness re-fits them every run and asserts the
 * coefficients still come out at 564.7 / 3.95 / 227.5, so an accidental digit change
 * fails the harness rather than quietly shipping a different game.
 */
export const PUBLISHED_HISTORY: readonly number[] = [
  // Y1
  603, 611, 574, 553, 547, 585, 557, 549, 602, 604, 850, 811,
  // Y2
  612, 614, 575, 640, 638, 704, 642, 636, 681, 654, 909, 875,
  // Y3
  667, 695, 689, 676, 644, 693, 686, 710, 698, 729, 928, 940,
  // Y4
  728, 679, 704, 705, 783, 725, 752, 755, 732, 697, 1007, 970,
  // Y5
  778, 721, 751, 806, 815, 737, 740, 783, 810, 797, 1035, 1000,
]

/** How many months the published table covers. An instance whose `numHistory` differs
 *  cannot use it — see `usesPublishedHistory` in demand.ts. */
export const PUBLISHED_HISTORY_LENGTH = PUBLISHED_HISTORY.length

// ── The calendar ───────────────────────────────────────────────────────────────

/** Month labels, index 0 = January. Used by the chart's axis, the month-by-year grid
 *  and both CSV exports, so all three agree on spelling and order. */
export const MONTH_NAMES: readonly string[] = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
]

export const MONTH_NAMES_LONG: readonly string[] = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

/** 1-based calendar month (1 = Jan … 12 = Dec) for a 1-based period. */
export function monthOf(period: number): number {
  return ((period - 1) % 12) + 1
}

/** 1-based year (Y1 = periods 1–12, Y6 = 61–72) for a 1-based period. */
export function yearOf(period: number): number {
  return Math.floor((period - 1) / 12) + 1
}

/** "Year 6, January" — the forecast-entry screen's header (spec §4). */
export function periodLabelLong(period: number): string {
  return `Year ${yearOf(period)}, ${MONTH_NAMES_LONG[monthOf(period) - 1]}`
}

/** "Y6 Jan" — the compact form the history table and the chart axis use. */
export function periodLabelShort(period: number): string {
  return `Y${yearOf(period)} ${MONTH_NAMES[monthOf(period) - 1]}`
}

/**
 * The DEFAULT high season (spec §2): November and December.
 *
 * Stored as 1-based month numbers so the set reads the same way it is written in the
 * spec and in Settings. `highSeasonMonths` is an editable set — any subset of months —
 * so nothing downstream may assume it is exactly {11, 12}.
 */
export const DEFAULT_HIGH_SEASON_MONTHS: readonly number[] = [11, 12]
