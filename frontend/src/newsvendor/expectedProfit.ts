// ═══════════════════════════════════════════════════════════════════════════════
// EXPECTED PROFIT AS A FUNCTION OF ORDER QUANTITY — the analytical curves behind the
// instructor's comparison chart.
//
// ⚠ PURELY ANALYTICAL. Nothing here reads a student, a period, or a stored anything:
// every value is a closed form in the instance's CONFIG. That is what lets the chart
// render the moment parameters are set, before anyone has played — and it is why this
// module has no server side at all.
//
// ⚠ INSTRUCTOR-ONLY, by placement. It is imported by Reports.tsx and nothing else; no
// student screen touches it. The curves peak at Q*, so this is the benchmark drawn in
// full, and spec §9.2 keeps that off every student surface.
//
// ⚠ THE NORMAL FORMULAS ARE VERBATIM FROM THE BRIEF — verified against simulation
// there, and deliberately not rearranged here even where a tidier algebraic form
// exists. The one restructuring is that both share an EXPECTED SHORTAGE term:
//
//     Normal:   E[(D − Q)⁺] = σ · L(z),  z = (Q − μ)/σ,  L(z) = φ(z) − z(1 − Φ(z))
//
// so `σL` in the brief is exactly `expectedShortage()` below. Substituting it changes
// no arithmetic and is what lets the Uniform case reuse the same two profit lines.
// ═══════════════════════════════════════════════════════════════════════════════

/** The instance parameters these curves need. A subset of NewsvendorParams plus the
 *  second-supplier cost, which the report supplies even for a regular instance. */
export interface ExpectedProfitParams {
  P: number
  c: number
  v: number
  g: number
  h: number
  /** Full second-supplier cost. Always present here — see the report's `secondSourceCost`. */
  cL: number
  isNormal: boolean
  mean: number
  sd: number
  minD: number
  maxD: number
}

/** φ(z) — the standard normal density. */
export const normalPdf = (z: number): number =>
  Math.exp(-(z * z) / 2) / Math.sqrt(2 * Math.PI)

/** Φ(z) — the standard normal CDF, via A&S 7.1.26's erf. Good to ~1e-7, which is far
 *  more than a chart pixel or a rounded Q* needs. */
export function normalCdf(z: number): number {
  const sign = z < 0 ? -1 : 1
  const x = Math.abs(z) / Math.SQRT2
  const t = 1 / (1 + 0.3275911 * x)
  const erf = 1 - (((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t
    + 0.254829592) * t) * Math.exp(-x * x)
  return 0.5 * (1 + sign * erf)
}

/** The standard normal LOSS function: L(z) = φ(z) − z·(1 − Φ(z)). */
export const lossFunction = (z: number): number =>
  normalPdf(z) - z * (1 - normalCdf(z))

/**
 * E[(D − Q)⁺] — expected units of demand ABOVE the order quantity.
 *
 * This is the single quantity both profit lines turn on: in regular mode it is the
 * expected shortage (lost sales), in dual mode the expected top-up (units bought in).
 * Same number, two meanings — exactly as `units_short` and `topup` are on the server.
 *
 *   NORMAL:  σ · L((Q − μ)/σ)                              — the brief's `σL`
 *   UNIFORM: (maxD − Q)² / (2·(maxD − minD)) on [minD,maxD],
 *            clamped to the flat regions outside it.
 *
 * ⚠ THE UNIFORM CLOSED FORM IS AN ADDITION BEYOND THE BRIEF, which specified Normal
 * and asked for Uniform to be flagged rather than guessed. It is derived, not adapted:
 * ∫_Q^b (d − Q)·(1/(b − a)) dd = (b − Q)²/(2(b − a)). The harness checks it against a
 * numerical integration of the same integral, so the two agree by two routes or the
 * build fails.
 */
export function expectedShortage(Q: number, p: ExpectedProfitParams): number {
  if (p.isNormal) {
    if (p.sd <= 0) return Math.max(0, p.mean - Q)
    return p.sd * lossFunction((Q - p.mean) / p.sd)
  }
  const a = p.minD
  const b = p.maxD
  if (b <= a) return Math.max(0, a - Q)
  if (Q <= a) return (a + b) / 2 - Q      // below the support: every unit above Q is short
  if (Q >= b) return 0                    // above the support: never short
  return ((b - Q) * (b - Q)) / (2 * (b - a))
}

/** Mean demand, whichever distribution this instance uses. */
export const meanDemand = (p: ExpectedProfitParams): number =>
  p.isNormal ? p.mean : (p.minD + p.maxD) / 2

/**
 * REGULAR (single-source) expected profit, verbatim from the brief:
 *
 *   E[profit] = P·(μ − σL) − c·Q + (v − h)·(Q − μ + σL) − g·(σL)
 *
 * (μ − σL) is expected sales; (Q − μ + σL) is expected leftover.
 */
export function expectedProfitRegular(Q: number, p: ExpectedProfitParams): number {
  const mu = meanDemand(p)
  const S = expectedShortage(Q, p)
  return p.P * (mu - S) - p.c * Q + (p.v - p.h) * (Q - mu + S) - p.g * S
}

/**
 * DUAL expected profit, verbatim from the brief:
 *
 *   E[profit] = P·μ − c·Q − c_l·(σL) + (v − h)·(Q − μ + σL)
 *
 * ⚠ NO GOODWILL TERM. All demand is met — the shortfall is bought in at c_l rather
 * than lost — so there is nothing to penalise. Note also that P multiplies μ, not
 * expected sales: every unit of demand sells.
 */
export function expectedProfitDual(Q: number, p: ExpectedProfitParams): number {
  const mu = meanDemand(p)
  const S = expectedShortage(Q, p)
  return p.P * mu - p.c * Q - p.cL * S + (p.v - p.h) * (Q - mu + S)
}

// ── The optima ─────────────────────────────────────────────────────────────────

/** Φ⁻¹ by bisection on the CDF above — slow, obvious, and accurate to well under a
 *  unit of Q. The chart needs a marker position, not nine decimal places. */
export function invNorm(target: number): number {
  if (!(target > 0 && target < 1)) return 0
  let lo = -8, hi = 8
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2
    if (normalCdf(mid) < target) lo = mid; else hi = mid
  }
  return (lo + hi) / 2
}

export interface Optimum {
  /** The critical ratio for this mode. */
  CR: number
  /** Q* — the quantile of demand at CR, rounded to a whole unit. */
  Qopt: number
  /** The expected profit AT Q*, i.e. the peak of the curve. */
  peak: number
}

/** Regular: CR = (P − c + g) / ((P − c + g) + (c − (v − h))). */
export function regularOptimum(p: ExpectedProfitParams): Optimum | null {
  const CU = p.P - p.c + p.g
  const CO = p.c - (p.v - p.h)
  return optimumFrom(CU, CO, p, expectedProfitRegular)
}

/** Dual: CR = (c_l − c) / ((c_l − c) + (c − (v − h))) — the PREMIUM over the overage. */
export function dualOptimum(p: ExpectedProfitParams): Optimum | null {
  const CU = p.cL - p.c
  const CO = p.c - (p.v - p.h)
  return optimumFrom(CU, CO, p, expectedProfitDual)
}

function optimumFrom(
  CU: number,
  CO: number,
  p: ExpectedProfitParams,
  profitAt: (Q: number, p: ExpectedProfitParams) => number,
): Optimum | null {
  // A non-positive underage or overage has no interior optimum — the same degenerate
  // case the server refuses to save. The chart omits the marker rather than drawing a
  // line at ±∞.
  if (!(CU > 0) || !(CO > 0)) return null
  const CR = CU / (CU + CO)
  const Qopt = Math.max(0, Math.round(
    p.isNormal ? p.mean + invNorm(CR) * p.sd : p.minD + CR * (p.maxD - p.minD),
  ))
  return { CR, Qopt, peak: profitAt(Qopt, p) }
}

// ── The plotted series ─────────────────────────────────────────────────────────

export interface CurvePoint {
  Q: number
  regular: number
  dual: number
}

/**
 * The x-domain: mean ± 3·SD, clamped at 0 (so 100–1900 at the shipped defaults). For a
 * Uniform instance the support itself is the natural range.
 */
export function orderRange(p: ExpectedProfitParams): { min: number; max: number } {
  return p.isNormal
    ? { min: Math.max(0, Math.round(p.mean - 3 * p.sd)), max: Math.round(p.mean + 3 * p.sd) }
    : { min: Math.max(0, Math.round(p.minD)), max: Math.round(p.maxD) }
}

/**
 * Both curves, sampled across the range.
 *
 * ⚠ Q* IS FORCED INTO THE SAMPLE. Without it a coarse grid can miss the true peak by a
 * few units and the marker would sit visibly off the top of its own curve — the one
 * defect an instructor projecting this would notice immediately.
 */
export function buildCurves(p: ExpectedProfitParams, samples = 120): CurvePoint[] {
  const { min, max } = orderRange(p)
  if (!(max > min)) return []
  const step = (max - min) / samples

  const qs = new Set<number>()
  for (let i = 0; i <= samples; i++) qs.add(Math.round(min + i * step))
  for (const opt of [regularOptimum(p), dualOptimum(p)]) {
    if (opt && opt.Qopt >= min && opt.Qopt <= max) qs.add(opt.Qopt)
  }

  return [...qs].sort((a, b) => a - b).map(Q => ({
    Q,
    regular: expectedProfitRegular(Q, p),
    dual: expectedProfitDual(Q, p),
  }))
}
