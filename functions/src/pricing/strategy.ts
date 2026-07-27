import { computeRound, type PricingMarketConfig } from './market'

// ═══════════════════════════════════════════════════════════════════════════════
// Pricing Game — THE COMPETITOR STRATEGY LIBRARY (spec §5).
//
// Every rule is a PURE, DETERMINISTIC function of the student's OWN prior prices.
// No Firestore, no randomness, no clock, no other student's data. This is what keeps
// history carryover legal inside the single-player family: the competitor reads
// exactly one student's history and nothing else (architecture §2.3).
//
// The compute step calls competitorPrice() AFTER the student's round-t price is
// accepted and committed, passing history through t−1 — so the competitor's price
// for round t can never depend on the student's round-t price, and can never be
// reachable by the student before they commit (spec §1, §4).
//
// ⚠ THE RULE'S IDENTITY IS NOT SHOWN DURING PLAY (spec §5). It is never returned by
// a callable and never written to a client-readable document; the debrief reveals
// it, and the reports state it. The whole point of the Standard rule is that the
// student watches it undercut them and works out what it is doing.
//
// ⚠ ONE RULE PER MODE — deliberately unlike PD, which splits students between two
// bots. Here the MODE is the treatment (Standard vs PMG), so every student in an
// instance faces the same competitor and the class's charts are comparable.
// ═══════════════════════════════════════════════════════════════════════════════

/** The v1 library. Named rules, so a future variant (e.g. a matching competitor) is
 *  config, not a rebuild. */
export type PricingStrategy = 'standard-highstart-bestreply' | 'pmg-ceiling'

/** Every rule id, in a stable order. */
export const PRICING_STRATEGIES: readonly PricingStrategy[] =
  ['standard-highstart-bestreply', 'pmg-ceiling'] as const

/** The shipped rule for Standard mode (spec §5). */
export const DEFAULT_STANDARD_STRATEGY: PricingStrategy = 'standard-highstart-bestreply'

/** The shipped rule for PMG mode (spec §5). */
export const DEFAULT_PMG_STRATEGY: PricingStrategy = 'pmg-ceiling'

/** Type guard for a stored/config-supplied rule id. */
export function isPricingStrategy(v: unknown): v is PricingStrategy {
  return v === 'standard-highstart-bestreply' || v === 'pmg-ceiling'
}

/**
 * Human-readable description of a rule — for the DEBRIEF REVEAL and the report
 * headers only (spec §9, §10). Never sent to a student mid-game.
 */
export const STRATEGY_DESCRIPTIONS: Record<PricingStrategy, string> = {
  'standard-highstart-bestreply':
    'open at the highest allowed price, then each round post whichever price on the ' +
    '$100 grid would have earned it the most profit against your previous price — ' +
    'undercutting you when you priced high, and pricing above you when you priced low',
  'pmg-ceiling':
    'post the highest allowed price every round, because under a price-matching ' +
    'guarantee its share cannot change and the price everyone pays is whichever of ' +
    'you posts lower',
}

/**
 * The competitor's decision grid: every price from minPrice upward in gridStep
 * steps, never past maxPrice (spec §5 — the case's payoff-matrix grid).
 *
 * The top of the band is INCLUDED explicitly when the step does not divide the band
 * evenly, because the Standard rule's round-1 opening IS the ceiling and an edited
 * band (say $900–$1,950 in $100s) must not silently drop it from the grid the rest
 * of the rule chooses from.
 */
export function priceGrid(m: PricingMarketConfig): number[] {
  const grid: number[] = []
  for (let p = m.minPrice; p <= m.maxPrice; p += m.gridStep) grid.push(p)
  if (grid.length === 0 || grid[grid.length - 1] !== m.maxPrice) grid.push(m.maxPrice)
  return grid
}

/**
 * The continuous best reply to a student price — the competitor's profit-maximising
 * price if it could post any real number:
 *
 *   p_w = ( s_w·k + c_w + p_c ) / 2
 *
 * ⚠ REFERENCE ONLY — the rule below does NOT use this. It is here because it is
 * what the algebra says the grid argmax should approximate, and the unit tests check
 * the two agree across the whole grid. The IMPLEMENTATION is the argmax (spec §5),
 * evaluated with computeRound() against the instance's real config, so an edited
 * market can never leave the competitor optimising a formula the students aren't
 * playing in.
 */
export function continuousBestReply(studentPrice: number, m: PricingMarketConfig): number {
  return (m.competitorBaseShare * m.slope + m.competitorUnitCost + studentPrice) / 2
}

/**
 * The grid price that maximises the COMPETITOR's own profit against a known student
 * price, evaluated in the instance's actual market (spec §5).
 *
 * Exact tie → the HIGHER price (spec §5). Ties are real, not hypothetical: the
 * profit function is a symmetric parabola in the competitor's price, so whenever the
 * continuous optimum lands exactly midway between two grid points, both are worth
 * the same. Iterating upward and taking `>=` therefore lands on the higher one, and
 * the epsilon makes that survive floating-point drift on products of ~10^8.
 */
export function gridBestReply(studentPrice: number, m: PricingMarketConfig, pmg: boolean): number {
  const grid = priceGrid(m)
  let bestPrice = grid[0]
  let bestProfit = -Infinity
  for (const p of grid) {
    const profit = computeRound(studentPrice, p, m, pmg).competitorProfit
    // Relative epsilon: profits are M × share × margin, so ~10^8 at the defaults,
    // where double rounding is around 10^-8 — an absolute epsilon would be either
    // useless or overwhelming depending on the instance's market size.
    const eps = 1e-6 * Math.max(1, Math.abs(bestProfit))
    if (profit > bestProfit + eps || (Math.abs(profit - bestProfit) <= eps && p > bestPrice)) {
      bestProfit = profit
      bestPrice = p
    }
  }
  return bestPrice
}

/**
 * The competitor's posted price for the round whose history is `studentPrices`.
 *
 * @param strategy      which rule this instance runs (fixed for the whole game)
 * @param studentPrices the student's OWN prior posted prices, in round order,
 *                      through round t−1. Empty ⇒ this is round 1.
 * @param m             the instance's market config
 * @param pmg           is the PMG rule in force? (profits are evaluated under the
 *                      instance's real rules, whichever rule is chosen)
 * @returns the competitor's price for round t
 *
 * Pure: same inputs ⇒ same output, always. Never mutates `studentPrices`.
 */
export function competitorPrice(
  strategy: PricingStrategy,
  studentPrices: readonly number[],
  m: PricingMarketConfig,
  pmg: boolean,
): number {
  switch (strategy) {
    // HIGH START, THEN BEST REPLY ON THE GRID (Standard, spec §5).
    //
    // Round 1 ALWAYS posts the ceiling — every student in the class sees the same
    // opening, which is what makes their charts comparable and their inference a
    // fair one. From round 2 it posts the grid argmax of its own profit against the
    // student's LAST price, which behaves exactly as the case's payoff table
    // suggests: it undercuts a high price ($2,000 → $1,800) and prices above a low
    // one ($900 → $1,200). Play converges on the interior Nash from above.
    case 'standard-highstart-bestreply': {
      if (studentPrices.length === 0) return m.maxPrice
      return gridBestReply(studentPrices[studentPrices.length - 1], m, pmg)
    }

    // CEILING POSTER (PMG, spec §5). Posts the ceiling every round — which IS the
    // rational play under PMG: shares are fixed, so the competitor simply wants the
    // minimum posted price as high as possible. It also hands the student the
    // discovery the mode exists for: their own price becomes the price everyone
    // pays, so raising it raises profit with zero share loss.
    case 'pmg-ceiling':
      return m.maxPrice
  }
}
