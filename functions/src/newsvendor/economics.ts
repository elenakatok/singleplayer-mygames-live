import type { NewsvendorConfig } from './config'

// ═══════════════════════════════════════════════════════════════════════════════
// Newsvendor — THE MATH (spec §4). Pure, Firestore-free, no I/O, so every formula
// here is unit-testable without an emulator. Same split as pricing's market.ts.
//
// REGULAR (single-source) MODE ONLY. Part 2 adds the dual branch; nothing here has a
// `dual` parameter, so adding it will be a visible signature change rather than a
// silent behaviour change. `assertRegular` below is the guard that makes that true.
//
// ⚠ THE BENCHMARK IS FOR REPORTS ONLY (spec §9.2). `Q_opt` and `profitOpt` are
// computed every period and STORED, and they must never appear on a student screen —
// not on the round-results screen, not on the final screen. The whitelist that
// enforces that is rounds.ts's toClientHistory; this file only computes them.
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Refuses to compute anything for a dual-sourcing instance.
 *
 * Part 1 ships the single-source game. A config with `dual` set would otherwise be
 * scored with the REGULAR profit formula — which is not merely approximate, it is a
 * different game (spec §5: no goodwill term, a premium-based critical ratio). Failing
 * loudly is the only honest option until Part 2 lands.
 */
export function assertRegular(config: NewsvendorConfig): void {
  if (config.dual) {
    throw new Error('Dual sourcing is not built yet — this instance cannot be played or scored.')
  }
}

// ── Per-period outcome (spec §4) ───────────────────────────────────────────────

export interface PeriodOutcome {
  /** Units actually sold: min(Q, D). */
  sales: number
  /** Unsold units: max(Q − D, 0). Salvaged at the NET rate (v − h). */
  leftover: number
  /** Unmet demand: max(D − Q, 0). Each unit costs goodwill g. */
  unitsShort: number
  /** Realized profit for the period. MAY BE NEGATIVE. */
  profit: number
  /**
   * Demand proportion met = min(Q,D)/D, capped at 1 (spec §6).
   * ⚠ D = 0 ⇒ 1, not a division. Uniform demand with minD = 0 really can draw 0.
   */
  serviceLevel: number
}

/**
 * The period's outcome for an order Q against a realized demand D (spec §4):
 *
 *   sales  = min(Q, D)
 *   profit = P·sales − c·Q + (Q − sales)·(v − h) − (D − sales)·g
 *
 * Both arguments are non-negative integers by the time they reach here (the callable
 * validates Q; the draw produces D), but the formula is total for any reals.
 */
export function computePeriod(Q: number, D: number, config: NewsvendorConfig): PeriodOutcome {
  const { P, c, v, g, h } = config
  const sales = Math.min(Q, D)
  const leftover = Math.max(Q - sales, 0)
  const unitsShort = Math.max(D - sales, 0)
  const profit = P * sales - c * Q + leftover * (v - h) - unitsShort * g
  return {
    sales,
    leftover,
    unitsShort,
    profit,
    // The D = 0 guard (spec §6). Without it this is 0/0.
    serviceLevel: D <= 0 ? 1 : Math.min(1, sales / D),
  }
}

// ── The critical ratio and the benchmark order (spec §4) ───────────────────────

export interface CriticalRatio {
  /** Underage: the margin plus goodwill lost per unit short. */
  CU: number
  /** Overage: cost sunk minus net salvage per leftover unit. */
  CO: number
  /** CU / (CU + CO) — the optimal probability that demand is met. */
  CR: number
}

/**
 * The regular-mode critical ratio (spec §4):
 *
 *   CU = P − c + g          CO = c − (v − h)          CR = CU / (CU + CO)
 *
 * Both costs are strictly positive for any config that passes validation
 * (`economicsError` below), so the denominator cannot be zero here.
 */
export function criticalRatio(config: NewsvendorConfig): CriticalRatio {
  const CU = config.P - config.c + config.g
  const CO = config.c - (config.v - config.h)
  return { CU, CO, CR: CU / (CU + CO) }
}

/**
 * The inverse standard normal CDF — Acklam's rational approximation, refined by one
 * Halley step. Absolute error < 1e-9 over the whole open interval, which is far more
 * than an integer order quantity needs.
 *
 * Written out rather than pulled from a package: the platform vendors small numerical
 * kernels (the auction resolver, the z-score helper) instead of taking a dependency
 * for twenty lines, and this one has to be auditable against the spec's Q_opt.
 */
export function invNorm(p: number): number {
  if (!(p > 0 && p < 1)) throw new Error(`invNorm requires 0 < p < 1 (got ${p})`)

  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02,
    1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00]
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02,
    6.680131188771972e+01, -1.328068155288572e+01]
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00,
    -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00]
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00,
    3.754408661907416e+00]

  const pLow = 0.02425, pHigh = 1 - pLow
  let x: number

  if (p < pLow) {
    const q = Math.sqrt(-2 * Math.log(p))
    x = (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
      / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
  } else if (p <= pHigh) {
    const q = p - 0.5
    const r = q * q
    x = (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q
      / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
  } else {
    const q = Math.sqrt(-2 * Math.log(1 - p))
    x = -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
      / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
  }

  // One Halley refinement against the true CDF, using the erfc-based Φ below.
  const e = normalCdf(x) - p
  const u = e * Math.sqrt(2 * Math.PI) * Math.exp((x * x) / 2)
  return x - u / (1 + (x * u) / 2)
}

/**
 * Φ(x), the standard normal CDF, via a high-accuracy erfc (Numerical Recipes).
 *
 * ⚠ Φ(x) = ½·erfc(−x/√2), NOT 1 − ½·erfc(−x/√2). The complement form is the easy slip
 * (it is what you write for the upper tail), it agrees with the truth at x = 0, and it
 * is silently wrong everywhere else — which then poisons invNorm's Halley step and
 * moves Q* to nonsense. Sanity anchors: Φ(0) = 0.5, Φ(1.96) ≈ 0.975.
 */
export function normalCdf(x: number): number {
  return 0.5 * erfc(-x / Math.SQRT2)
}

function erfc(x: number): number {
  const z = Math.abs(x)
  const t = 2 / (2 + z)
  const ty = 4 * t - 2
  const cof = [-1.3026537197817094, 6.4196979235649026e-1, 1.9476473204185836e-2,
    -9.561514786808631e-3, -9.46595344482036e-4, 3.66839497852761e-4,
    4.2523324806907e-5, -2.0278578112534e-5, -1.624290004647e-6,
    1.303655835580e-6, 1.5626441722e-8, -8.5238095915e-8,
    6.529054439e-9, 5.059343495e-9, -9.91364156e-10,
    -2.27365122e-10, 9.6467911e-11, 2.394038e-12,
    -6.886027e-12, 8.94487e-13, 3.13092e-13,
    -1.12708e-13, 3.81e-16, 7.106e-15]
  let d = 0, dd = 0
  for (let j = cof.length - 1; j > 0; j--) {
    const tmp = d
    d = ty * d - dd + cof[j]
    dd = tmp
  }
  const ans = t * Math.exp(-z * z + 0.5 * (cof[0] + ty * d) - dd)
  return x >= 0 ? ans : 2 - ans
}

/**
 * The benchmark order quantity — the demand quantile at the critical ratio (spec §4):
 *
 *   Normal:  round(mean + Φ⁻¹(CR)·sd)
 *   Uniform: round(minD + CR·(maxD − minD))
 *
 * Clamped at 0: a config with a very low CR and a wide sd can put the Normal quantile
 * below zero, and a negative benchmark order is not a quantity.
 */
export function optimalOrder(config: NewsvendorConfig): number {
  const { CR } = criticalRatio(config)
  const q = config.isNormal
    ? config.mean + invNorm(CR) * config.sd
    : config.minD + CR * (config.maxD - config.minD)
  return Math.max(0, Math.round(q))
}

/**
 * The benchmark's realized profit: the SAME profit formula, evaluated at Q_opt against
 * the SAME drawn demand the student faced (spec §4).
 *
 * ⚠ AGAINST THE SAME D — that is the whole point of the comparison. Evaluating the
 * benchmark against its own fresh draw would compare the student's luck with the
 * benchmark's luck, and the optimality gap would be mostly noise.
 */
export function benchmarkProfit(D: number, config: NewsvendorConfig): { Qopt: number; profitOpt: number } {
  const Qopt = optimalOrder(config)
  return { Qopt, profitOpt: computePeriod(Qopt, D, config).profit }
}

// ── The order-input bounds shown to the student (spec §3) ──────────────────────

/**
 * The bounds the order box offers, and the ones the server enforces.
 *
 *   Normal:  [max(0, mean − 3·sd), mean + 3·sd]
 *   Uniform: [minD, maxD]
 *
 * ⚠ THE SERVER ENFORCES THE SAME BOUNDS IT SHOWS. SoPHIE used these as input-widget
 * attributes only; here they are also validated server-side, exactly as pricing
 * validates its price band. A bound that is advisory on the server is a bound a
 * hand-rolled call ignores, and the reports would then average over orders no screen
 * could have produced.
 */
export function orderBounds(config: NewsvendorConfig): { min: number; max: number } {
  return config.isNormal
    ? { min: Math.max(0, Math.round(config.mean - 3 * config.sd)), max: Math.round(config.mean + 3 * config.sd) }
    : { min: Math.round(config.minD), max: Math.round(config.maxD) }
}

/** Is this a legal order quantity for this instance (spec §3: an integer ≥ 0, inside
 *  the displayed bounds)? */
export function isValidOrder(Q: unknown, config: NewsvendorConfig): Q is number {
  if (typeof Q !== 'number' || !Number.isInteger(Q) || Q < 0) return false
  const { min, max } = orderBounds(config)
  return Q >= min && Q <= max
}

// ── Config validation (spec §2) ────────────────────────────────────────────────

/**
 * The economic sanity of a config, as a message or null.
 *
 * Spec §2 lists: `isNormal=0` requires `maxD > minD`; `periods ≥ 1`; all prices/costs
 * ≥ 0; `P > c`.
 *
 * ⚠ TWO CHECKS BEYOND THE SPEC'S LIST, both required for the critical ratio to EXIST:
 *
 *   • CO = c − (v − h) must be > 0. If net salvage reaches the unit cost, a leftover
 *     unit is free (or profitable), CR is ≥ 1, and the quantile is +∞ — the optimal
 *     order is "everything", and the game has no interior answer to teach.
 *   • CU = P − c + g must be > 0. Implied by P > c with g ≥ 0, but checked explicitly
 *     so a future edit to either rule cannot make CR negative unnoticed.
 *
 * These are refusals rather than warnings because the resulting instance is not merely
 * hard, it is degenerate: the benchmark every report compares against would not exist.
 */
export function economicsError(config: NewsvendorConfig): string | null {
  const nonNegative: [string, number][] = [
    ['The retail price', config.P],
    ['The unit cost', config.c],
    ['The salvage value', config.v],
    ['The goodwill cost', config.g],
    ['The holding cost', config.h],
  ]
  for (const [label, value] of nonNegative) {
    if (!Number.isFinite(value) || value < 0) return `${label} must be zero or more.`
  }
  if (config.P <= config.c) {
    return 'The retail price must be above the unit cost, or no order could ever be profitable.'
  }
  if (!Number.isInteger(config.periods) || config.periods < 1) {
    return 'The number of periods must be a whole number of at least 1.'
  }

  const { CU, CO } = criticalRatio(config)
  if (CO <= 0) {
    return 'The unit cost must exceed the net salvage value (salvage − holding), or leftover '
      + 'units would cost nothing and the optimal order would be unbounded.'
  }
  if (CU <= 0) {
    return 'The underage cost (price − cost + goodwill) must be positive.'
  }

  if (config.isNormal) {
    if (!Number.isFinite(config.mean) || config.mean < 0) return 'Mean demand must be zero or more.'
    if (!Number.isFinite(config.sd) || config.sd <= 0) return 'The standard deviation must be greater than zero.'
  } else {
    if (!Number.isFinite(config.minD) || config.minD < 0) return 'Minimum demand must be zero or more.'
    if (!Number.isFinite(config.maxD) || config.maxD <= config.minD) {
      return 'Maximum demand must be greater than minimum demand.'
    }
  }

  // Dual is Part 2. Refused here as well as in updateConfig, so a config written by
  // any other route still cannot reach the compute step.
  if (config.dual) return 'Dual sourcing is not available yet.'

  return null
}
