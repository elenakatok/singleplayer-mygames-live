import type { NewsvendorConfig } from './config'
import { orderBounds } from './economics'

// ═══════════════════════════════════════════════════════════════════════════════
// Newsvendor — the pieces both student callables share: the parameter WHITELIST and
// the flow phase. Pure and Firestore-free, so both are unit-testable.
//
// Kept in one file precisely because newsvendorGetState and newsvendorSubmitRound
// must never drift apart on what a student is allowed to see: two hand-built copies
// of the same whitelist is how a field ends up leaking through one endpoint and not
// the other.
// ═══════════════════════════════════════════════════════════════════════════════

/** The instance parameters AS SENT TO THE STUDENT. Built field by field, never spread. */
export interface ClientParams {
  /** Retail price per unit. */
  P: number
  /** Production cost per unit. */
  c: number
  /** Salvage value per leftover unit. */
  v: number
  /** Goodwill (shortage) cost per unit short. */
  g: number
  /** Holding cost per leftover unit. */
  h: number
  /** Demand distribution (spec §7a: the demand box states which, and its parameters). */
  isNormal: boolean
  mean: number
  sd: number
  minD: number
  maxD: number
  /** Total periods. Student-facing here, unlike pricing's horizon: the screen says
   *  "Period k of N" (spec §7a), so N is not a secret in this game. */
  periods: number
  /** The order box's bounds (spec §3) — the same ones the server enforces. */
  orderMin: number
  orderMax: number
  /** Display toggles (spec §2). */
  showCalculator: boolean
  showServiceLevel: boolean
}

/**
 * Everything the place-order screen prints (spec §7a), and nothing else.
 *
 * ⚠ WHAT IS DELIBERATELY OMITTED:
 *   • the SEED — it derives every future demand draw (demand.ts), so a student who
 *     held it could compute next period's demand before ordering this one;
 *   • `premium` and `dual` — Part 2's fields, which say nothing about this game;
 *   • the BENCHMARK (Q_opt, CR, profitOpt) — spec §9.2 keeps it off every student
 *     screen. Note it is not merely unsent: it is not derivable from anything here
 *     either, because a student holding P, c, v, g, h could compute CR themselves —
 *     which is FINE and is exactly what the knowledge check asks them to do. What
 *     they must not be handed is the answer for THEIR instance alongside their own
 *     result, framed as the score they should have got.
 */
export function clientParams(config: NewsvendorConfig): ClientParams {
  const bounds = orderBounds(config)
  return {
    P: config.P,
    c: config.c,
    v: config.v,
    g: config.g,
    h: config.h,
    isNormal: config.isNormal,
    mean: config.mean,
    sd: config.sd,
    minD: config.minD,
    maxD: config.maxD,
    periods: config.periods,
    orderMin: bounds.min,
    orderMax: bounds.max,
    showCalculator: config.showCalculator,
    showServiceLevel: config.showServiceLevel,
  }
}

/**
 * Where a student is in the flow.
 *
 * 'play'    — the period loop is open.
 * 'debrief' — every period has been played; what remains is the final screen, the
 *             knowledge check and the debrief (spec §7d, §8). Terminal.
 */
export type NewsvendorPhase = 'play' | 'debrief'

/** The phase implied by a stored participant doc. Derived from the finish STAMP, so
 *  the read path and the write path agree on one fact rather than two counts. */
export function phaseOf(pData: Record<string, unknown>): NewsvendorPhase {
  return pData.finished_at != null ? 'debrief' : 'play'
}
