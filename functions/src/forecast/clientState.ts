import type { ForecastConfig } from './config'
import { periodLabelLong, periodLabelShort, monthOf, yearOf } from './history'

// ═══════════════════════════════════════════════════════════════════════════════
// Forecasting — the pieces every student callable shares: the parameter WHITELIST and
// the flow phase. Pure and Firestore-free, so both are unit-testable.
//
// Kept in one file precisely because forecastGetState and forecastSubmitRound must
// never drift apart on what a student is allowed to see: two hand-built copies of the
// same whitelist is how a field ends up leaking through one endpoint and not the other.
//
// ⚠⚠ WHAT IS DELIBERATELY ABSENT FROM ClientParams, AND WHY IT IS ABSENT BY
// CONSTRUCTION: `clientParams` takes a ForecastConfig — the STUDENT-SAFE half — and
// has no access to a ForecastModel at all. It is not that the model is omitted from
// the return; it is that the function cannot reach it. To leak a, b, H, σ or the high
// season from here you would have to widen the signature, which is a review-visible
// change rather than a slip. Same for the seed.
//
// Everything a student may know about how demand is generated, they must infer from
// the sixty months in front of them. That inference IS the exercise (spec §7).
// ═══════════════════════════════════════════════════════════════════════════════

/** The instance parameters AS SENT TO THE STUDENT. Built field by field, never spread. */
export interface ClientParams {
  /** Months of history shown before play. They see every one of them. */
  numHistory: number
  /** Months to be played. PUBLIC in this game — the header says "month k of N"
   *  (spec §4). Unlike PD and pricing there is no hidden horizon: spec §14 records
   *  that showing it was chosen deliberately (no strategic reason to hide it, SoPHIE
   *  showed it, a visible planning horizon is realistic). */
  rounds: number
  /** The forecast box's bounds (spec §3) — the same ones the server enforces.
   *  Generous on purpose, so the range is not a hint about the answer. */
  forecastMin: number
  forecastMax: number
  /** Cosmetic labels (spec §3). */
  productName: string
  unitLabel: string
  periodLabel: string
  /** The first PERIOD of play — numHistory + 1. Sent so the client never has to add,
   *  and so every label on screen keys off one server-supplied origin. */
  firstPlayPeriod: number
  /** The notional bonus at 100% accuracy (spec §5a), so the client renders the frame
   *  without hardcoding a dollar figure of its own. */
  bonusAtPerfect: number
}

export function clientParams(config: ForecastConfig, bonusAtPerfect: number): ClientParams {
  return {
    numHistory: config.numHistory,
    rounds: config.rounds,
    forecastMin: config.forecastMin,
    forecastMax: config.forecastMax,
    productName: config.productName,
    unitLabel: config.unitLabel,
    periodLabel: config.periodLabel,
    firstPlayPeriod: config.numHistory + 1,
    bonusAtPerfect,
  }
}

/**
 * One month of the COMMON history, as the chart and the grid table render it.
 *
 * ⚠ NO `highSeason` FLAG HERE, deliberately — unlike the CSV, which spec §4 requires
 * to carry the coded indicator. The on-screen chart and grid are where the student is
 * meant to SPOT the season for themselves (spec §4: "this is how a student spots
 * seasonality by eye"). Shading the high months on the chart would do the noticing for
 * them and quietly delete the observation the exercise is built around.
 */
export interface ClientHistoryPoint {
  period: number
  year: number
  month: number
  /** "Y1 Jan" — the chart's axis tick and the grid's row/column key. */
  label: string
  demand: number
}

/** The common history, shaped for the client. Identical for every student (demand.ts). */
export function clientHistory(history: readonly number[]): ClientHistoryPoint[] {
  return history.map((demand, i) => {
    const period = i + 1
    return {
      period,
      year: yearOf(period),
      month: monthOf(period),
      label: periodLabelShort(period),
      demand,
    }
  })
}

/**
 * Where a student is in the flow.
 *
 * 'play'    — the month loop is open.
 * 'debrief' — every month has been played; what remains is the final screen and the
 *             debrief paragraph (spec §4, §5, §9). Terminal.
 */
export type ForecastPhase = 'play' | 'debrief'

/** The phase implied by a stored participant doc. Derived from the finish STAMP, so
 *  the read path and the write path agree on one fact rather than two counts. */
export function phaseOf(pData: Record<string, unknown>): ForecastPhase {
  return pData.finished_at != null ? 'debrief' : 'play'
}

/** The heading for the month about to be forecast: "Year 6, January" (spec §4). */
export function headingFor(period: number): string {
  return periodLabelLong(period)
}
