// ═══════════════════════════════════════════════════════════════════════════════
// Newsvendor — the report aggregates (spec §9.2). Pure, Firestore-free, unit-testable.
//
// ⚠ CORRECT ON PARTIAL DATA, which is the normal case. Elena opens the reports
// mid-week with the class spread across the assignment: some finished, some four
// periods in, some not started. Every aggregate below is over WHO ACTUALLY PLAYED that
// period, the x-axis is the longest game anyone played, and nothing divides by a
// denominator it has not checked. The per-period denominator travels with each point
// (`n`) precisely so a tail wobble reads as three students being left rather than as a
// finding.
//
// ⚠ THE BENCHMARK LIVES HERE AND ONLY HERE (spec §9.2). Q_opt and profitOpt are
// stored per period and aggregated for the instructor; no student-facing module
// imports this file.
// ═══════════════════════════════════════════════════════════════════════════════

/** One student's whole game, flattened to the arrays the aggregates need. */
export interface NewsvendorGameRow {
  participant_id: string
  orders: number[]
  demands: number[]
  profits: number[]
  /** The benchmark's profit for the same period, against the same demand draw. */
  benchmarkProfits: number[]
  serviceLevels: number[]
}

/** One period of a two-series chart, with the number of students it averages over. */
export interface SeriesPoint {
  round: number
  student: number
  competitor: number
  n: number
}

const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length

/** Average over every value every student produced, or null when nobody has played. */
function flatMean(rows: readonly NewsvendorGameRow[], pick: (r: NewsvendorGameRow) => number[]): number | null {
  const all = rows.flatMap(pick)
  return all.length === 0 ? null : mean(all)
}

/**
 * Builds one two-series chart: for each period 1..maxPeriods, the class average of two
 * per-period quantities over the students who had played that period.
 *
 * A period nobody reached is SKIPPED rather than plotted as zero — a zero there would
 * draw a cliff at the end of every mid-week chart.
 */
function byPeriod(
  rows: readonly NewsvendorGameRow[],
  maxPeriods: number,
  a: (r: NewsvendorGameRow) => number[],
  b: (r: NewsvendorGameRow) => number[],
): SeriesPoint[] {
  const points: SeriesPoint[] = []
  for (let round = 1; round <= maxPeriods; round++) {
    const played = rows.filter(r => a(r).length >= round)
    if (played.length === 0) continue
    points.push({
      round,
      student: mean(played.map(r => a(r)[round - 1])),
      competitor: mean(played.map(r => b(r)[round - 1])),
      n: played.length,
    })
  }
  return points
}

/** Chart 1 — the class's average ORDER against the average DEMAND it met (spec §9.2).
 *  The two together are the whole story: how far the class ordered from what turned up. */
export function ordersByPeriod(rows: readonly NewsvendorGameRow[], maxPeriods: number): SeriesPoint[] {
  return byPeriod(rows, maxPeriods, r => r.orders, r => r.demands)
}

/** Chart 2 — realized profit against the BENCHMARK's profit, period by period. The gap
 *  between the two lines IS the optimality gap, drawn. */
export function profitsByPeriod(rows: readonly NewsvendorGameRow[], maxPeriods: number): SeriesPoint[] {
  return byPeriod(rows, maxPeriods, r => r.profits, r => r.benchmarkProfits)
}

// ── Per-student figures (Tier 1) ───────────────────────────────────────────────

export const averageOrder = (r: NewsvendorGameRow): number | null =>
  r.orders.length === 0 ? null : mean(r.orders)

export const averageDemand = (r: NewsvendorGameRow): number | null =>
  r.demands.length === 0 ? null : mean(r.demands)

export const averageServiceLevel = (r: NewsvendorGameRow): number | null =>
  r.serviceLevels.length === 0 ? null : mean(r.serviceLevels)

/**
 * IN-STOCK RATE — the fraction of a student's periods in which they were FULLY stocked
 * (Q ≥ D, nothing short).
 *
 * ⚠ THIS IS NOT THE AVERAGE DEMAND-MET FRACTION, and it replaced that column precisely
 * because the two are different questions. "Demand met" averages a ratio within each
 * period and lands high for a student who is nearly-but-not-quite covered every time.
 * This counts PERIODS, so it is directly comparable to the critical ratio: order at Q*
 * and you are fully stocked about CR of the time (≈0.81 at the shipped regular
 * defaults). That comparability is the whole point — it lets an instructor read the
 * column against one number they already have on screen.
 *
 * Computed from orders and demands rather than from the stored service level, because
 * a service level of exactly 1 is the same event as Q ≥ D and this way the definition
 * is visible rather than inferred.
 */
export function inStockRate(r: NewsvendorGameRow): number | null {
  if (r.orders.length === 0) return null
  const fullyStocked = r.orders.filter((q, i) => q >= r.demands[i]).length
  return fullyStocked / r.orders.length
}

export const averageProfit = (r: NewsvendorGameRow): number | null =>
  r.profits.length === 0 ? null : mean(r.profits)

export const totalProfit = (r: NewsvendorGameRow): number =>
  r.profits.reduce((a, b) => a + b, 0)

export const totalBenchmarkProfit = (r: NewsvendorGameRow): number =>
  r.benchmarkProfits.reduce((a, b) => a + b, 0)

/**
 * The benchmark's mean profit PER PERIOD — the figure the roster shows.
 *
 * ⚠ PER PERIOD, NOT TOTAL, and that is the point of the column. A total scales with
 * how many periods a student has played, so a mid-week roster silently ranks the
 * furthest-along student top; and it sits on a different scale from the
 * expected-profit chart, which is per period by construction. The averages line the
 * two up: an optimal orderer's Avg profit lands on the chart's peak.
 */
export const averageBenchmarkProfit = (r: NewsvendorGameRow): number | null =>
  r.benchmarkProfits.length === 0 ? null : mean(r.benchmarkProfits)

/**
 * The optimality gap PER PERIOD — benchmark minus realized, averaged.
 *
 * Identically (averageBenchmarkProfit − averageProfit), which is exactly why it is
 * computed from the same arrays rather than by dividing the total somewhere else: the
 * three dollar columns must stay arithmetically consistent on screen.
 *
 * ⚠ STILL SIGNED. A negative average gap means the student beat the benchmark over the
 * periods they played — see optimalityGap for why the sign is kept.
 */
export function averageOptimalityGap(r: NewsvendorGameRow): number | null {
  if (r.profits.length === 0) return null
  return (totalBenchmarkProfit(r) - totalProfit(r)) / r.profits.length
}

/**
 * The optimality gap: what the benchmark earned MINUS what the student earned, over
 * the periods they actually played (spec §9.2).
 *
 * ⚠ SIGNED, AND IT CAN BE NEGATIVE. A student who ordered away from Q* and got lucky
 * with the draws genuinely beat the benchmark over a short game — the benchmark is
 * optimal in expectation, not period by period. Reporting |gap| would hide exactly
 * the case worth discussing in the debrief, so the sign is kept.
 *
 * Null when they have played nothing, so the table shows a dash rather than a zero
 * gap they did not earn.
 */
export function optimalityGap(r: NewsvendorGameRow): number | null {
  if (r.profits.length === 0) return null
  return totalBenchmarkProfit(r) - totalProfit(r)
}

// ── Class figures (Tier 3 summary box) ─────────────────────────────────────────

export const classAverageOrder = (rows: readonly NewsvendorGameRow[]): number | null =>
  flatMean(rows, r => r.orders)

export const classAverageDemand = (rows: readonly NewsvendorGameRow[]): number | null =>
  flatMean(rows, r => r.demands)

export const classAverageServiceLevel = (rows: readonly NewsvendorGameRow[]): number | null =>
  flatMean(rows, r => r.serviceLevels)

export const classAverageProfit = (rows: readonly NewsvendorGameRow[]): number | null =>
  flatMean(rows, r => r.profits)

export const classAverageBenchmarkProfit = (rows: readonly NewsvendorGameRow[]): number | null =>
  flatMean(rows, r => r.benchmarkProfits)
