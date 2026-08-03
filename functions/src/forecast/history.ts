// ═══════════════════════════════════════════════════════════════════════════════
// Forecasting — THE PUBLISHED FIVE-YEAR HISTORY (spec §2.1) and the calendar.
//
// Pure, Firestore-free, and imported by BOTH sides of the wire: the server sends the
// history to the student (it is not secret — it is the whole point of the opening
// screen) and the harness re-derives it. Nothing here is a draw; the numbers below are
// a CONSTANT.
//
// ⚠⚠ REGENERATED AT σ = 60 (Elena, 08-02). Spec §2.1's printed table was drawn at
// σ = 30 and no longer matched the game: the history carried σ = 30 noise while play
// carried σ = 60, so a student estimating σ off the history would have under-estimated
// their own error by half. These sixty integers replace it.
//
// ⚠⚠ STILL A FIXED ARRAY, NOT GENERATED PER REQUEST (spec §2.2: "the 60 months of
// history are a fixed array, identical for everyone"). Hardcoded so its properties can
// be ASSERTED rather than hoped for — the tests check every one:
//
//   1. THE SEASON READS AS A RULE. Nov and Dec beat every other month of their own year
//      in all five years, worst-year margin 133 units. THAT MARGIN WAS THE SELECTION
//      CRITERION, not the fit: at σ = 60 only ~16% of seeds clear the structural bar at
//      all, and the first good-fitting candidate had a Y5 margin of just 17 units —
//      technically passing, visually arguable. The exercise depends on the high season
//      being obvious, so the widest margin won.
//   2. THE PARSIMONIOUS FIT RECOVERS THE PROCESS: trend + one holiday dummy gives
//      intercept 559.0, trend 4.01, holiday +237.6 against true 560 / 4.00 / 230. A
//      student doing exactly what slide 12 demonstrates still lands on it.
//   3. THE §2.3 BENCHMARK TABLE IS COMPUTED AGAINST IT (benchmarks.ts) and was
//      re-simulated when these numbers changed. Different history ⇒ different
//      benchmarks ⇒ a comparison that lies.
//
// Produced by the SHIPPED generator at seed 1427, σ = 60 — so this table is exactly
// what `resolveHistory` emits for that seed, not a separate artifact that can drift.
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
 * ⚠ DO NOT EDIT THESE NUMBERS. The tests re-fit them on every run and assert the
 * coefficients still come out at 559.0 / 4.01 / 237.6, and that the seasonal margin
 * holds — so an accidental digit change fails the suite rather than quietly shipping a
 * different game.
 */
export const PUBLISHED_HISTORY: readonly number[] = [
  // Y1
  665, 560, 519, 559, 668, 668, 557, 693, 517, 566, 862, 849,
  // Y2
  574, 582, 582, 667, 571, 570, 619, 515, 653, 652, 931, 841,
  // Y3
  565, 710, 687, 659, 694, 724, 750, 714, 759, 695, 893, 939,
  // Y4
  740, 728, 722, 694, 585, 800, 798, 697, 744, 675, 933, 1053,
  // Y5
  677, 748, 765, 779, 831, 792, 822, 701, 832, 814, 1039, 1048,
]

/** How many months the published table covers. An instance whose `numHistory` differs
 *  cannot use it — see `usesPublishedHistory` in demand.ts. */
export const PUBLISHED_HISTORY_LENGTH = PUBLISHED_HISTORY.length

/** The seed the published table was generated at, σ = 60. Kept so the table can be
 *  reproduced, and so `resolveHistory`'s generated branch falls back to the same series
 *  rather than to an unrelated one. */
export const PUBLISHED_HISTORY_SEED = '1427'

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
