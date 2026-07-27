import type { PricingMarketConfig } from './market'

// ═══════════════════════════════════════════════════════════════════════════════
// Pricing Game — the pieces both student callables share: the market WHITELIST and
// the flow phase. Pure and Firestore-free, so both are unit-testable.
//
// Kept in one file precisely because pricingGetState and pricingSubmitPrice must
// never drift apart on what a student is allowed to see: two hand-built copies of
// the same whitelist is how a field ends up leaking through one endpoint and not the
// other.
// ═══════════════════════════════════════════════════════════════════════════════

/** The market AS SENT TO THE STUDENT. Built field by field, never spread. */
export interface ClientMarket {
  marketSize: number
  studentBaseShare: number
  competitorBaseShare: number
  studentUnitCost: number
  competitorUnitCost: number
  slope: number
  minPrice: number
  maxPrice: number
}

/**
 * Everything the price-entry screen prints (spec §4), and nothing else.
 *
 * ⚠ `gridStep` IS DELIBERATELY OMITTED. It is the only market field that exists
 * solely to parameterise the COMPETITOR's rule (the $100 decision grid, spec §5),
 * and the rule is not shown during play. It tells a student nothing they need to
 * price, so it does not travel.
 */
export function clientMarket(m: PricingMarketConfig): ClientMarket {
  return {
    marketSize: m.marketSize,
    studentBaseShare: m.studentBaseShare,
    competitorBaseShare: m.competitorBaseShare,
    studentUnitCost: m.studentUnitCost,
    competitorUnitCost: m.competitorUnitCost,
    slope: m.slope,
    minPrice: m.minPrice,
    maxPrice: m.maxPrice,
  }
}

/**
 * Where a student is in the flow.
 *
 * 'play'    — the round loop is open.
 * 'debrief' — their drawn horizon has been reached; the game is over and the
 *             debrief is what remains (spec §9). Terminal.
 *
 * A later slice prepends 'kc' (spec §8: the knowledge check runs before play).
 */
export type PricingPhase = 'play' | 'debrief'

/** The phase implied by a stored participant doc. Derived from the finish STAMP, not
 *  from counting rounds — the client must never be able to make the
 *  rounds-played-vs-round-count comparison, and neither should the server's own
 *  read path, which would only invite it back in. */
export function phaseOf(pData: Record<string, unknown>): PricingPhase {
  return pData.finished_at != null ? 'debrief' : 'play'
}
