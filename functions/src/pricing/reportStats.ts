import { nashEquilibrium, type PricingMarketConfig } from './market'

// ═══════════════════════════════════════════════════════════════════════════════
// Pricing Game — the report AGGREGATIONS (spec §10). Pure: no Firestore, no I/O, so
// every one of them is unit-testable against a hand-built class.
//
// ⚠ EVERYTHING HERE MUST BE CORRECT ON PARTIAL DATA. This game is played async across
// an assignment week, so the instructor opens these reports mid-week with some
// students finished, some three rounds in, and some not started. Every average is
// therefore over WHO ACTUALLY PLAYED THAT ROUND, and every denominator is checked
// before it is divided by. A report that only worked once everyone had finished would
// be a report Elena could never look at while it mattered.
//
// ⚠ AND EVERY ROUND'S DENOMINATOR IS REPORTED. Because horizons are drawn per student
// (init.ts) and play is async, round 14 is averaged over far fewer students than round
// 2 — so a late-round wobble is usually COMPOSITION, not behaviour. Hiding `n` would
// make that wobble look like a finding. Each point carries its own n, and the chart
// prints it.
// ═══════════════════════════════════════════════════════════════════════════════

/** One student's game, flattened for aggregation. */
export interface PricingGameRow {
  participant_id: string
  /** The student's posted prices, in round order. */
  prices: number[]
  /** The competitor's posted prices, same rounds. */
  competitorPrices: number[]
  /** The price everyone paid, per round — PMG only; null under Standard. */
  effectivePrices: (number | null)[]
  /** The student's profit per round. */
  profits: number[]
}

/** One round of the Tier-3 chart (spec §10). */
export interface PricePoint {
  round: number
  /** Class mean POSTED price this round, over the students who played it. */
  student: number
  /** The competitor's mean posted price the same round. */
  competitor: number
  /**
   * How many students that mean is over. Load-bearing, not decoration: with
   * per-student horizons the tail of the chart thins, and the reader has to be able
   * to tell "three students left" from "the class changed its mind".
   */
  n: number
}

const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length

/**
 * Class average posted price per round, both sides, with the per-round denominator.
 *
 * @param rows       every participant's game (students who played nothing included —
 *                   they simply contribute to no round)
 * @param roundCount how many rounds the x-axis spans: the LONGEST game played. There
 *                   is no instance-wide horizon to use instead — they are per student
 *                   — so the caller derives this from the games themselves, exactly as
 *                   PD's report does.
 *
 * ⚠ A round nobody played is OMITTED, never emitted as 0 or NaN. Dividing by an empty
 * denominator is the one way this function could put a lie on a chart.
 */
export function pricesByRound(rows: readonly PricingGameRow[], roundCount: number): PricePoint[] {
  const out: PricePoint[] = []
  for (let round = 1; round <= roundCount; round++) {
    const played = rows.filter(r => r.prices.length >= round)
    if (played.length === 0) continue          // no data ≠ a price of zero
    out.push({
      round,
      student: mean(played.map(r => r.prices[round - 1])),
      competitor: mean(played.map(r => r.competitorPrices[round - 1])),
      n: played.length,
    })
  }
  return out
}

/** One student's mean posted price, or null if they never posted one. */
export function averagePrice(row: PricingGameRow): number | null {
  return row.prices.length === 0 ? null : mean(row.prices)
}

/** One student's mean profit per round PLAYED, or null if they played none.
 *  Per-round, not cumulative: students who are mid-game have played fewer rounds, and
 *  a cumulative column would rank them by how far along they are. */
export function averageProfitPerRound(row: PricingGameRow): number | null {
  return row.profits.length === 0 ? null : mean(row.profits)
}

/** One student's total profit. Zero for a student who played nothing — which is the
 *  true total, not a missing value. */
export function totalProfit(row: PricingGameRow): number {
  return row.profits.reduce((a, b) => a + b, 0)
}

/** The class's mean posted price across every round every student played. Null when
 *  nobody has played anything yet. */
export function classAveragePrice(rows: readonly PricingGameRow[]): number | null {
  const all = rows.flatMap(r => r.prices)
  return all.length === 0 ? null : mean(all)
}

/** The class's mean EFFECTIVE (paid) price — PMG only, where such a thing exists
 *  (spec §10: the chart plots POSTED price; effective is a summary stat beside it).
 *  Null under Standard, and null before anyone has played. */
export function classAverageEffectivePrice(rows: readonly PricingGameRow[]): number | null {
  const all = rows.flatMap(r => r.effectivePrices).filter((p): p is number => p != null)
  return all.length === 0 ? null : mean(all)
}

/** The dashed reference line(s) on the Tier-3 chart (spec §10). */
export interface EquilibriumReference {
  /** The student's reference price. */
  student: number
  /** The competitor's. Equal to `student` under PMG, where the line is the ceiling. */
  competitor: number
  /** What the chart should call it. */
  label: string
  /** PMG draws ONE line (any equal price is an equilibrium); Standard draws two. */
  singleLine: boolean
}

/**
 * The reference the class's prices are read against.
 *
 * Standard: the interior Nash equilibrium, AUTO-DERIVED from the instance's market
 * (spec §2/§10 — "never hand-entered so it can never go stale when config changes").
 *
 * PMG: the interior Nash is meaningless — ANY equal price is an equilibrium — so the
 * ceiling is drawn instead, and the label says exactly that rather than implying the
 * ceiling is uniquely optimal.
 */
export function equilibriumReference(m: PricingMarketConfig, pmg: boolean): EquilibriumReference {
  if (pmg) {
    return {
      student: m.maxPrice,
      competitor: m.maxPrice,
      label: 'PMG equilibrium (any equal price; ceiling shown)',
      singleLine: true,
    }
  }
  const eq = nashEquilibrium(m)
  return {
    student: eq.studentPrice,
    competitor: eq.competitorPrice,
    label: 'Nash equilibrium',
    singleLine: false,
  }
}
