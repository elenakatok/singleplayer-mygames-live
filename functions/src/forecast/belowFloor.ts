// ═══════════════════════════════════════════════════════════════════════════════
// Forecasting — THE BELOW-FLOOR FLAG (spec §5b). Pure, Firestore-free.
//
// WHY IT EXISTS. With `demandDraw: 'common'` (the default since 08-02) every student
// faces the SAME 24 realized months, so a student who finishes early can hand the class
// the answers. This FLAGS that, and does nothing else: scoring is participation-only,
// no forecast accuracy is graded, and there is one section. The point is that Elena can
// SEE it on the roster — not that anyone is stopped, penalised, or told.
//
// THE STATISTIC. A student forecasting the true systematic component perfectly still
// carries the noise, so their realized MSE over n months satisfies
//
//     MSE_hat · n / σ²  ~  χ²(n)
//
// and the flag is a lower-tail test: pValue = P(χ²_n ≤ MSE_hat · n / σ²), flagged when
// pValue < 1/2700. σ is THE INSTANCE'S OWN σ, read from truth/main — never a hardcoded
// 60 and never a hardcoded MSE cutoff, because an instructor can edit σ in Settings and
// the flag has to move with it.
//
// ⚠⚠ WHY NOT A FIXED "MSE < 0.3 × σ²" CUTOFF. Spec §5b quotes that figure, and it is
// correct ONLY at n = 24. The same cutoff applied to a student who stopped early is
// wildly too loose, because a short run is far more variable:
//
//     n =  4   P(perfect forecaster scores below 0.3σ²) = 12.2%   ← 1 in 8
//     n =  6                                              6.3%
//     n =  8                                              3.4%
//     n = 12                                              1.0%
//     n = 18                                              0.19%
//     n = 24                                              0.037%  ← 1 in 2,700
//
// A fixed 0.3 would flag roughly one in eight legitimate four-month partials. The exact
// test at the student's own n produces these equivalent cutoffs instead — and those are
// the fixtures the unit tests pin, row by row:
//
//     n:      4      6      8     12     18     24
//     MSE <  0.014  0.045  0.082  0.152  0.236  0.300  × σ²
// ═══════════════════════════════════════════════════════════════════════════════

/** Flag when the lower-tail p-value falls below this — spec §5b's 1-in-2,700. */
export const BELOW_FLOOR_ALPHA = 1 / 2700

/**
 * Months below which the flag is not DISPLAYED.
 *
 * The exact test handles n = 1 correctly — that is the whole point of using it rather
 * than a fixed cutoff — but a badge on a student with three forecasts is noise on a
 * roster Elena reads at speed. The threshold is a display decision, folded into
 * `flagged` so every consumer (the badge, the Tier-3 exclusion) agrees on one answer.
 */
export const MIN_MONTHS_TO_FLAG = 6

// ── The chi-square lower tail, from scratch ────────────────────────────────────

/** Lanczos approximation to ln Γ(x). Good to ~15 significant figures for x > 0. */
function lnGamma(x: number): number {
  const g = [
    676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012,
    9.9843695780195716e-6, 1.5056327351493116e-7,
  ]
  if (x < 0.5) {
    // Reflection, so the approximation is only ever evaluated on its good side.
    return Math.log(Math.PI / Math.sin(Math.PI * x)) - lnGamma(1 - x)
  }
  const z = x - 1
  let a = 0.99999999999980993
  const t = z + 7.5
  for (let i = 0; i < g.length; i++) a += g[i] / (z + i + 1)
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(a)
}

/**
 * The regularized lower incomplete gamma function P(a, x).
 *
 * ⚠ TWO BRANCHES, AND BOTH ARE NEEDED even though this test lives in the far lower
 * tail. The series converges quickly for x < a + 1, which is where a flagged student
 * sits; the continued fraction covers x ≥ a + 1, which is where an ORDINARY student
 * sits. Shipping only the series would make the p-value garbage for everyone who is
 * not suspicious — and the p-value is reported on the roster, not just thresholded.
 */
function gammaP(a: number, x: number): number {
  if (x <= 0) return 0
  if (!Number.isFinite(a) || a <= 0) return 0

  if (x < a + 1) {
    // Series: P(a,x) = x^a e^-x / Γ(a) · Σ x^k / (a(a+1)…(a+k))
    let ap = a
    let sum = 1 / a
    let del = sum
    for (let i = 0; i < 1000; i++) {
      ap += 1
      del *= x / ap
      sum += del
      if (Math.abs(del) < Math.abs(sum) * 1e-15) break
    }
    return sum * Math.exp(-x + a * Math.log(x) - lnGamma(a))
  }

  // Lentz's continued fraction for Q(a,x) = 1 − P(a,x).
  const TINY = 1e-300
  let b = x + 1 - a
  let c = 1 / TINY
  let d = 1 / b
  let h = d
  for (let i = 1; i < 1000; i++) {
    const an = -i * (i - a)
    b += 2
    d = an * d + b
    if (Math.abs(d) < TINY) d = TINY
    c = b + an / c
    if (Math.abs(c) < TINY) c = TINY
    d = 1 / d
    const delta = d * c
    h *= delta
    if (Math.abs(delta - 1) < 1e-15) break
  }
  const q = Math.exp(-x + a * Math.log(x) - lnGamma(a)) * h
  return 1 - q
}

/**
 * P(χ²_n ≤ x) — the chi-square lower-tail CDF, via P(n/2, x/2).
 *
 * Pinned in the tests against P(χ²₂ ≤ 2) = 1 − e⁻¹ ≈ 0.6321 (the exponential case,
 * known in closed form) and against spec §5b's own threshold table.
 */
export function chiSquareLowerTail(x: number, n: number): number {
  if (!Number.isFinite(x) || !Number.isFinite(n) || n <= 0) return 0
  return gammaP(n / 2, x / 2)
}

// ── The flag ───────────────────────────────────────────────────────────────────

export interface BelowFloorResult {
  /** Should this be shown as a flag? False below MIN_MONTHS_TO_FLAG even if extreme. */
  flagged: boolean
  /** P(χ²_n ≤ observed) — how unlikely this MSE is for a PERFECT forecaster. */
  pValue: number
  /** The MSE this student would have had to beat to flag, at their own n and σ. */
  thresholdMse: number
  /** Months the test was run over. */
  months: number
}

/**
 * Is this student's MSE below what the noise alone permits (spec §5b)?
 *
 * ⚠ σ IS THE INSTANCE'S OWN. Passing a constant here would silently stop working the
 * moment an instructor edits the noise level in Settings — which they can, and which
 * moves every threshold in the table above.
 *
 * Returns null for the degenerate inputs rather than dividing by zero: no months
 * played, or a non-positive σ (which an instructor can reach by setting it to 0).
 */
export function belowFloorFlag(
  mse: number | null,
  months: number,
  sigma: number,
): BelowFloorResult | null {
  if (mse === null || !Number.isFinite(mse) || mse < 0) return null
  if (!Number.isInteger(months) || months <= 0) return null
  if (!Number.isFinite(sigma) || sigma <= 0) return null

  const variance = sigma * sigma
  const statistic = (mse * months) / variance
  const pValue = chiSquareLowerTail(statistic, months)

  return {
    // ⚠ THE MIN-MONTHS RULE LIVES HERE, not at the call sites. The badge and the
    // Tier-3 exclusion must agree about who is flagged; two copies of "and n >= 6"
    // is how they would come to disagree.
    flagged: pValue < BELOW_FLOOR_ALPHA && months >= MIN_MONTHS_TO_FLAG,
    pValue,
    thresholdMse: thresholdMseFor(months, sigma),
    months,
  }
}

/**
 * The MSE at which a student with `months` played would just begin to flag.
 *
 * Found by bisection on the CDF rather than by a lookup table, so it is exact at every
 * n rather than only at the six the spec tabulates. Reported on the roster so a flag is
 * legible — "below 1,080" says more than a p-value.
 */
export function thresholdMseFor(months: number, sigma: number): number {
  if (!Number.isInteger(months) || months <= 0) return 0
  if (!Number.isFinite(sigma) || sigma <= 0) return 0
  const variance = sigma * sigma

  // t is the multiple of σ² we are solving for; the answer is always in (0, 1).
  let lo = 0
  let hi = 1
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2
    if (chiSquareLowerTail(mid * months, months) < BELOW_FLOOR_ALPHA) lo = mid
    else hi = mid
  }
  return ((lo + hi) / 2) * variance
}
