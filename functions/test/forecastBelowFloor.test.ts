import { describe, it, expect } from 'vitest'
import {
  chiSquareLowerTail, belowFloorFlag, thresholdMseFor,
  BELOW_FLOOR_ALPHA, MIN_MONTHS_TO_FLAG,
} from '../src/forecast/belowFloor'
import { DEFAULT_MODEL, systematic, drawDemand, type ForecastModel } from '../src/forecast/demand'
import { runningMetrics, type ForecastPoint } from '../src/forecast/metrics'

// ═══════════════════════════════════════════════════════════════════════════════
// Forecasting — the below-floor flag (spec §5b).
//
// The load-bearing tests are the THRESHOLD TABLE and the FALSE-POSITIVE RATE. The flag
// exists to tell Elena something true about one student; a test that only checked "an
// impossibly good score flags" would miss the failure that actually matters — flagging
// honest students who happened to stop early.
// ═══════════════════════════════════════════════════════════════════════════════

describe('chiSquareLowerTail', () => {
  it('matches the closed form at n = 2, where χ² is exponential', () => {
    // P(χ²₂ ≤ x) = 1 − e^(−x/2) exactly.
    expect(chiSquareLowerTail(2, 2)).toBeCloseTo(1 - Math.exp(-1), 10)
    expect(chiSquareLowerTail(1, 2)).toBeCloseTo(1 - Math.exp(-0.5), 10)
    expect(chiSquareLowerTail(6, 2)).toBeCloseTo(1 - Math.exp(-3), 10)
  })

  it('⚠ P(χ²_n ≤ n) sits just OVER 0.5 and approaches it from above', () => {
    // Worth pinning the DIRECTION: the chi-square median is slightly BELOW n, so the
    // CDF evaluated at n exceeds a half. (The §5b note had this the other way round —
    // "just under 0.5" — which a correct implementation would fail.)
    const vals = [2, 6, 12, 24, 60, 200].map(n => chiSquareLowerTail(n, n))
    for (const v of vals) expect(v).toBeGreaterThan(0.5)
    // Monotonically decreasing toward 0.5 as n grows.
    for (let i = 1; i < vals.length; i++) expect(vals[i]).toBeLessThan(vals[i - 1])
    expect(vals[vals.length - 1]).toBeLessThan(0.52)
  })

  it('is a CDF: 0 at the bottom, →1 at the top, monotone in between', () => {
    expect(chiSquareLowerTail(0, 12)).toBe(0)
    expect(chiSquareLowerTail(-5, 12)).toBe(0)
    expect(chiSquareLowerTail(500, 12)).toBeGreaterThan(0.999999)
    let prev = -1
    for (let x = 0.5; x < 60; x += 0.5) {
      const v = chiSquareLowerTail(x, 12)
      expect(v).toBeGreaterThanOrEqual(prev)
      prev = v
    }
  })

  it('⚠ is accurate on the UPPER branch too, not just the tail the flag lives in', () => {
    // An ordinary student sits at x ≈ n, which uses the continued fraction. Shipping
    // only the series would make the reported p-value garbage for everyone unflagged.
    // Checked against the n = 2 closed form, which spans both branches.
    for (const x of [0.5, 1, 2, 3, 5, 10, 20]) {
      expect(chiSquareLowerTail(x, 2)).toBeCloseTo(1 - Math.exp(-x / 2), 10)
    }
  })

  it('returns 0 for degenerate degrees of freedom rather than NaN', () => {
    expect(chiSquareLowerTail(5, 0)).toBe(0)
    expect(chiSquareLowerTail(5, -3)).toBe(0)
    expect(Number.isNaN(chiSquareLowerTail(5, 12))).toBe(false)
  })
})

describe('the threshold table (spec §5b)', () => {
  const SIGMA = 60
  const V = SIGMA * SIGMA

  // The exact cutoffs the test produces at each n, as multiples of σ².
  const TABLE: [number, number][] = [
    [4, 0.014], [6, 0.045], [8, 0.082], [12, 0.152], [18, 0.236], [24, 0.300],
  ]

  it('reproduces every published row to three decimals', () => {
    for (const [n, expected] of TABLE) {
      const t = thresholdMseFor(n, SIGMA) / V
      expect(t, `n = ${n}`).toBeCloseTo(expected, 3)
    }
  })

  it('the thresholds RISE with n — a longer run is less variable', () => {
    const ts = TABLE.map(([n]) => thresholdMseFor(n, SIGMA))
    for (let i = 1; i < ts.length; i++) expect(ts[i]).toBeGreaterThan(ts[i - 1])
  })

  it('⚠ a FIXED 0.3 × σ² cutoff would be badly wrong at small n', () => {
    // The whole reason the flag is a p-value and not a constant. These are the
    // false-positive rates spec §5b tabulates for the naive cutoff.
    const rate = (n: number) => chiSquareLowerTail(0.3 * n, n)
    expect(rate(4)).toBeGreaterThan(0.10)      // ~12.2% — one in eight
    expect(rate(6)).toBeGreaterThan(0.05)      // ~6.3%
    expect(rate(12)).toBeGreaterThan(0.008)    // ~1.0%
    expect(rate(24)).toBeCloseTo(BELOW_FLOOR_ALPHA, 4)  // and correct only here
  })

  it('every threshold sits at exactly the target p-value, at any n', () => {
    for (const n of [6, 7, 9, 13, 20, 24, 36]) {
      const mse = thresholdMseFor(n, SIGMA)
      expect(chiSquareLowerTail((mse * n) / V, n)).toBeCloseTo(BELOW_FLOOR_ALPHA, 6)
    }
  })

  it('⚠ scales with σ² — an instructor editing σ moves the threshold', () => {
    // The flag must never be a hardcoded MSE. Doubling σ quadruples the cutoff.
    expect(thresholdMseFor(24, 120)).toBeCloseTo(thresholdMseFor(24, 60) * 4, 6)
    expect(thresholdMseFor(24, 30)).toBeCloseTo(thresholdMseFor(24, 60) / 4, 6)
  })
})

describe('belowFloorFlag', () => {
  const SIGMA = 60
  const V = SIGMA * SIGMA

  it('flags an MSE well below the floor', () => {
    const r = belowFloorFlag(0.05 * V, 24, SIGMA)!
    expect(r.flagged).toBe(true)
    expect(r.pValue).toBeLessThan(BELOW_FLOOR_ALPHA)
  })

  it('does NOT flag a legitimately excellent student sitting near the floor', () => {
    // The lecture's own model lands essentially ON σ². That must never flag.
    const r = belowFloorFlag(V, 24, SIGMA)!
    expect(r.flagged).toBe(false)
    expect(r.pValue).toBeGreaterThan(0.4)
  })

  it('⚠ does NOT flag at n = 24 what it WOULD flag at n = 6 — and vice versa', () => {
    // 0.10 × σ² is comfortably inside the flag zone at 24 months and comfortably
    // outside it at 6. The same MSE, a different verdict, which is the point.
    expect(belowFloorFlag(0.10 * V, 24, SIGMA)!.flagged).toBe(true)
    expect(belowFloorFlag(0.10 * V, 6, SIGMA)!.flagged).toBe(false)
  })

  it('⚠ is silent below the display minimum even when the score is impossible', () => {
    // A student with 3 months and an MSE of zero is arithmetically extreme, but a badge
    // there is noise on the roster (spec §5b).
    const r = belowFloorFlag(0, 3, SIGMA)!
    expect(r.flagged).toBe(false)
    expect(r.pValue).toBe(0)                 // the statistic is still computed honestly
    expect(MIN_MONTHS_TO_FLAG).toBe(6)
    // …and it DOES flag the moment the minimum is reached.
    expect(belowFloorFlag(0, 6, SIGMA)!.flagged).toBe(true)
  })

  it('reports the threshold the student would have had to beat', () => {
    const r = belowFloorFlag(0.5 * V, 24, SIGMA)!
    expect(r.thresholdMse).toBeCloseTo(thresholdMseFor(24, SIGMA), 6)
    expect(r.months).toBe(24)
  })

  it('returns null on degenerate inputs rather than dividing by zero', () => {
    expect(belowFloorFlag(null, 24, SIGMA)).toBeNull()
    expect(belowFloorFlag(1000, 0, SIGMA)).toBeNull()
    expect(belowFloorFlag(1000, 24, 0)).toBeNull()
    expect(belowFloorFlag(1000, 24, -60)).toBeNull()
    expect(belowFloorFlag(-5, 24, SIGMA)).toBeNull()
  })
})

// ── Behavioural checks against the real demand process ─────────────────────────

const PER_STUDENT: ForecastModel = { ...DEFAULT_MODEL, demandDraw: 'perStudent' }
const PLAYED = Array.from({ length: 24 }, (_, i) => 61 + i)

/** One student's game, forecasting by a given rule against their own drawn demand. */
function play(rule: (p: number, actual: number) => number, who: string): ForecastPoint[] {
  return PLAYED.map(period => {
    const actual = drawDemand(PER_STUDENT, 'flag-seed', who, period)
    return { period, forecast: rule(period, actual), actual }
  })
}

describe('against the real process', () => {
  const SIGMA = DEFAULT_MODEL.sigma

  it('⚠ a PERFECT-model forecaster flags at roughly the expected rate, and no more', () => {
    // The false-positive test, and the one that matters most: a student who knows the
    // true systematic component exactly still carries the noise, so they must almost
    // never flag. 1/2700 over 3,000 students is ~1 expected.
    let flagged = 0
    const N = 3000
    for (let i = 0; i < N; i++) {
      const pts = play(period => Math.round(systematic(PER_STUDENT, period)), `perfect-${i}`)
      const mse = runningMetrics(pts).mse
      if (belowFloorFlag(mse, pts.length, SIGMA)!.flagged) flagged++
    }
    // Poisson(≈1.1): seeing more than 8 would be a real signal that the test is loose.
    expect(flagged, `${flagged}/${N} perfect forecasters flagged`).toBeLessThan(9)
  })

  it('a robot handed the ACTUAL realized demands flags reliably', () => {
    // The case the flag exists for: with a common future, a finisher can hand the class
    // the answers. Forecasting the revealed actual is what that looks like.
    let flagged = 0
    for (let i = 0; i < 50; i++) {
      const pts = play((_, actual) => actual, `cheat-${i}`)
      const mse = runningMetrics(pts).mse
      expect(mse).toBe(0)
      if (belowFloorFlag(mse, pts.length, SIGMA)!.flagged) flagged++
    }
    expect(flagged).toBe(50)
  })

  it('…and still flags one who is merely VERY close rather than exact', () => {
    // A student copying answers is unlikely to type them perfectly. Within ±10 units
    // (σ/6) is still far below anything the noise permits.
    let flagged = 0
    for (let i = 0; i < 50; i++) {
      const pts = play((_, actual) => actual + (i % 3) - 1, `near-${i}`)
      if (belowFloorFlag(runningMetrics(pts).mse, 24, SIGMA)!.flagged) flagged++
    }
    expect(flagged).toBe(50)
  })

  it('a legitimately excellent student — the fitted regression — does NOT flag', () => {
    // The best honest answer in the game sits ON the floor, not below it.
    let flagged = 0
    const N = 500
    for (let i = 0; i < N; i++) {
      // The true process plus a small fitting error, which is what a good fit produces.
      const pts = play(period => Math.round(systematic(PER_STUDENT, period) + 5), `good-${i}`)
      if (belowFloorFlag(runningMetrics(pts).mse, 24, SIGMA)!.flagged) flagged++
    }
    expect(flagged, `${flagged}/${N} excellent students flagged`).toBeLessThan(9)
  })

  it('an ordinary student is nowhere near flagging, and gets a sane p-value', () => {
    const pts = play(period => Math.round(systematic(PER_STUDENT, period) - 40), 'ordinary')
    const r = belowFloorFlag(runningMetrics(pts).mse, 24, SIGMA)!
    expect(r.flagged).toBe(false)
    // ⚠ The p-value must be a real number on the upper branch, not 0 or NaN — this is
    // what the continued fraction is for.
    expect(r.pValue).toBeGreaterThan(0.5)
    expect(r.pValue).toBeLessThanOrEqual(1)
  })
})
