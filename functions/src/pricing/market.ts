// ═══════════════════════════════════════════════════════════════════════════════
// Pricing Game (Cheyenne Shipping) — THE MARKET MODEL (spec §2 Standard, §6 PMG).
//
// Pure and Firestore-free, so the whole compute step is unit-testable without an
// emulator — the same split as pd/payoff.ts. Every value is CONFIG, not code
// (spec §2/§3): every function here takes the market config object, and the
// constants below are only the defaults a fresh instance gets (the case's numbers).
//
//   STANDARD (§2)
//     CSC share  = clamp( s_c + (p_w − p_c)/k , 0, 1 )
//     WNS share  = clamp( s_w + (p_c − p_w)/k , 0, 1 )    [sum-capped at 1]
//     profit     = M × share × (price − unit cost)
//
//   PMG (§6.1)
//     effective price = min(p_c, p_w)  — customers ALWAYS pay the lower posted price
//     shares frozen at base (prices no longer move share at all)
//     profit          = M × base share × (effective price − unit cost)
//
// ⚠ PROFIT MAY BE NEGATIVE. Pricing below unit cost loses money on every container,
// and the game shows that rather than flooring at zero — KC Q4 exists to plant
// exactly that lesson (spec §8.1), so clamping it here would make the game disagree
// with its own knowledge check.
//
// ⚠ ONE MODEL, TWO MODES — never two models. Everything that consumes the market
// (the round loop, the competitor's best reply, the reports) calls computeRound(),
// so the competitor's behaviour is always evaluated in the SAME environment the
// student is scored in. Spec §5: "an edited payoff environment can never disagree
// with the bot's behaviour."
// ═══════════════════════════════════════════════════════════════════════════════

/** The market environment (spec §2/§3). All of it is student-facing: the
 *  price-entry screen prints every field (spec §4), including the competitor's
 *  base share and unit cost. */
export interface PricingMarketConfig {
  /** Market size M, in containers. Default 190,000. */
  marketSize: number
  /** The student's (CSC's) base share — their share when both firms post the same
   *  price. Default 0.35. */
  studentBaseShare: number
  /** The competitor's (WNS's) base share. Default 0.65. */
  competitorBaseShare: number
  /** The student's unit cost, in dollars per container. Default 966. */
  studentUnitCost: number
  /** The competitor's unit cost. Default 900. */
  competitorUnitCost: number
  /** Share slope k: a $k price gap moves one full share point. Default 1000. */
  slope: number
  /** Lowest posted price a student may enter, inclusive. Default 900. */
  minPrice: number
  /** Highest posted price a student may enter, inclusive. Default 2000. */
  maxPrice: number
  /**
   * The competitor's decision grid, in dollars — the case's payoff-matrix grid
   * (spec §5). The student's own entry is CONTINUOUS within the bounds (any integer
   * dollar); this step applies only to the competitor's best reply.
   */
  gridStep: number
}

/** Spec §2's defaults, from the case. Instances may override every field. */
export const DEFAULT_MARKET: PricingMarketConfig = {
  marketSize: 190_000,
  studentBaseShare: 0.35,
  competitorBaseShare: 0.65,
  studentUnitCost: 966,
  competitorUnitCost: 900,
  slope: 1000,
  minPrice: 900,
  maxPrice: 2000,
  gridStep: 100,
}

/** One round's market outcome, from both sides. Containers and dollars — nothing
 *  here is rounded or formatted; display (millions, two decimals) is the UI's job. */
export interface PricingOutcome {
  studentShare: number
  competitorShare: number
  /** Containers won = M × share. */
  studentDemand: number
  competitorDemand: number
  /** M × share × (price − unit cost). MAY BE NEGATIVE. */
  studentProfit: number
  competitorProfit: number
  /**
   * Under PMG, the single price every customer actually pays = min(posted prices)
   * (spec §6.4 shows it beside the two posted prices). Under Standard there is no
   * such thing — each firm's customers pay that firm's posted price — so it is
   * null, not a copy of one of the two.
   */
  effectivePrice: number | null
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v))

/**
 * The two shares, clamped and sum-capped (spec §2).
 *
 * With the shipped defaults the base shares sum to exactly 1 and the two price
 * terms cancel, so the sum is 1 by construction and the cap never binds. It exists
 * for the EDITED case: an instructor may set base shares that sum to more than 1,
 * and without the cap the market would sell more than M containers. Capping scales
 * both sides down proportionally, which preserves their ratio — the thing the
 * pedagogy is about — rather than truncating one arbitrarily.
 */
function shares(rawStudent: number, rawCompetitor: number): { student: number; competitor: number } {
  let student = clamp01(rawStudent)
  let competitor = clamp01(rawCompetitor)
  const sum = student + competitor
  if (sum > 1) {
    student /= sum
    competitor /= sum
  }
  return { student, competitor }
}

/**
 * One round of the market.
 *
 * @param studentPrice     the student's posted price for this round
 * @param competitorPrice  the competitor's posted price for this round
 * @param m                the instance's market config
 * @param pmg              is the Price Matching Guarantee in force? (spec §6)
 *
 * Pure: no Firestore, no defaults baked in — pass the loaded config.
 */
export function computeRound(
  studentPrice: number,
  competitorPrice: number,
  m: PricingMarketConfig,
  pmg: boolean,
): PricingOutcome {
  if (pmg) {
    // §6.1 — customers always pay the lower posted price, and shares no longer
    // respond to price at all: they are frozen at base. (Still passed through
    // shares() so an edited config that oversells the market is capped the same way
    // it would be in Standard — one rule, not two.)
    const effectivePrice = Math.min(studentPrice, competitorPrice)
    const s = shares(m.studentBaseShare, m.competitorBaseShare)
    const studentDemand = m.marketSize * s.student
    const competitorDemand = m.marketSize * s.competitor
    return {
      studentShare: s.student,
      competitorShare: s.competitor,
      studentDemand,
      competitorDemand,
      studentProfit: studentDemand * (effectivePrice - m.studentUnitCost),
      competitorProfit: competitorDemand * (effectivePrice - m.competitorUnitCost),
      effectivePrice,
    }
  }

  // §2 — share responds to the price gap; each firm's customers pay that firm's
  // posted price.
  const s = shares(
    m.studentBaseShare + (competitorPrice - studentPrice) / m.slope,
    m.competitorBaseShare + (studentPrice - competitorPrice) / m.slope,
  )
  const studentDemand = m.marketSize * s.student
  const competitorDemand = m.marketSize * s.competitor
  return {
    studentShare: s.student,
    competitorShare: s.competitor,
    studentDemand,
    competitorDemand,
    studentProfit: studentDemand * (studentPrice - m.studentUnitCost),
    competitorProfit: competitorDemand * (competitorPrice - m.competitorUnitCost),
    effectivePrice: null,
  }
}

/**
 * The interior Nash equilibrium of the linear Standard model (spec §2):
 *
 *   p_c* = ( 2(s_c·k + c_c) + (s_w·k + c_w) ) / 3      → $1,394 at defaults
 *   p_w* = ( 2(s_w·k + c_w) + (s_c·k + c_c) ) / 3      → $1,472 at defaults
 *
 * ⚠ ALWAYS DERIVED, NEVER HAND-ENTERED (spec §2). It is the Tier-3 reference line,
 * and an instructor who edits the market must not be able to leave a stale number
 * drawn across their own class's chart. Not student-facing during play — students
 * meet it in the following week's lecture.
 *
 * Under PMG this quantity is meaningless (any equal price is an equilibrium); the
 * report labels the ceiling instead (spec §10), so nothing calls this with pmg on.
 */
export function nashEquilibrium(m: PricingMarketConfig): { studentPrice: number; competitorPrice: number } {
  const a = m.studentBaseShare * m.slope + m.studentUnitCost
  const b = m.competitorBaseShare * m.slope + m.competitorUnitCost
  return {
    studentPrice: (2 * a + b) / 3,
    competitorPrice: (2 * b + a) / 3,
  }
}

/** Is `p` a legal posted price for a student — an integer dollar inside the
 *  configured bounds (spec §3: integer entry, continuous within bounds, NOT
 *  grid-snapped; the $100 grid binds the competitor only). */
export function isValidPrice(p: unknown, m: PricingMarketConfig): p is number {
  return typeof p === 'number'
    && Number.isInteger(p)
    && p >= m.minPrice
    && p <= m.maxPrice
}

/** Defensive parse of a stored market map. Any missing/invalid value falls back to
 *  its default, so a half-written config doc can never make a round uncomputable —
 *  the same posture as parsePayoffs. */
export function parseMarket(raw: unknown): PricingMarketConfig {
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>

  /** A finite number, optionally required to be positive. */
  const num = (v: unknown, fallback: number, positive = false) =>
    typeof v === 'number' && Number.isFinite(v) && (!positive || v > 0) ? v : fallback
  /** A share: finite and within [0, 1]. */
  const share = (v: unknown, fallback: number) =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1 ? v : fallback

  const minPrice = num(r.min_price, DEFAULT_MARKET.minPrice)
  const maxPriceRaw = num(r.max_price, DEFAULT_MARKET.maxPrice)
  // An inverted or degenerate band would make every price invalid and the game
  // unplayable, so it falls back wholesale rather than being half-honoured.
  const bounds = maxPriceRaw > minPrice
    ? { minPrice, maxPrice: maxPriceRaw }
    : { minPrice: DEFAULT_MARKET.minPrice, maxPrice: DEFAULT_MARKET.maxPrice }

  return {
    marketSize: num(r.market_size, DEFAULT_MARKET.marketSize, true),
    studentBaseShare: share(r.student_base_share, DEFAULT_MARKET.studentBaseShare),
    competitorBaseShare: share(r.competitor_base_share, DEFAULT_MARKET.competitorBaseShare),
    studentUnitCost: num(r.student_unit_cost, DEFAULT_MARKET.studentUnitCost),
    competitorUnitCost: num(r.competitor_unit_cost, DEFAULT_MARKET.competitorUnitCost),
    // A zero or negative slope would divide by zero / invert the demand curve.
    slope: num(r.slope, DEFAULT_MARKET.slope, true),
    ...bounds,
    gridStep: num(r.grid_step, DEFAULT_MARKET.gridStep, true),
  }
}
