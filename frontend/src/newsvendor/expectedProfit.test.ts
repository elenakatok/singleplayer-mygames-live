import { describe, it, expect } from 'vitest'
import {
  expectedShortage, expectedProfitRegular, expectedProfitDual,
  regularOptimum, dualOptimum, buildCurves, orderRange, lossFunction, normalCdf,
  type ExpectedProfitParams,
} from './expectedProfit'

// ═══════════════════════════════════════════════════════════════════════════════
// The analytical curves, checked against the brief's own verified numbers AND — for
// the parts the brief did not specify — against an independent numerical integration.
//
// The brief's stated targets at the shipped defaults:
//   regular peak at Q = 1265, ≈ 1,785,000
//   dual    peak at Q = 1129, ≈ 1,836,000
// ═══════════════════════════════════════════════════════════════════════════════

/** The shipped defaults. c_l is the default 2000, which is what the chart uses for the
 *  dual line even on a regular instance. */
const DEFAULTS: ExpectedProfitParams = {
  P: 3000, c: 1000, v: 800, g: 150, h: 300, cL: 2000,
  isNormal: true, mean: 1000, sd: 300, minD: 0, maxD: 100,
}

/**
 * E[(D − Q)⁺] by brute-force numerical integration — the independent oracle. Written
 * from the definition rather than from the closed form it checks, which is the entire
 * point: a shared implementation could not disagree.
 */
function integrateShortage(Q: number, p: ExpectedProfitParams): number {
  const n = 200_000
  if (p.isNormal) {
    const lo = p.mean - 8 * p.sd, hi = p.mean + 8 * p.sd
    const step = (hi - lo) / n
    let sum = 0
    for (let i = 0; i < n; i++) {
      const d = lo + (i + 0.5) * step
      const density = Math.exp(-((d - p.mean) ** 2) / (2 * p.sd * p.sd))
        / (p.sd * Math.sqrt(2 * Math.PI))
      sum += Math.max(0, d - Q) * density * step
    }
    return sum
  }
  const step = (p.maxD - p.minD) / n
  let sum = 0
  for (let i = 0; i < n; i++) {
    const d = p.minD + (i + 0.5) * step
    sum += Math.max(0, d - Q) * (1 / (p.maxD - p.minD)) * step
  }
  return sum
}

describe('the loss function', () => {
  it('L(0) = φ(0) = 0.3989', () => {
    expect(lossFunction(0)).toBeCloseTo(0.3989, 4)
  })
  it('decays toward 0 as z grows', () => {
    expect(lossFunction(3)).toBeLessThan(0.005)
    expect(lossFunction(3)).toBeGreaterThan(0)
  })
  it('Φ is a CDF: Φ(0) = 0.5, Φ(1.96) ≈ 0.975', () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 6)
    expect(normalCdf(1.96)).toBeCloseTo(0.975, 4)
  })
})

describe('expected shortage — closed form vs numerical integration', () => {
  it('agrees for the NORMAL case across the range', () => {
    let checked = 0
    for (const Q of [400, 700, 1000, 1265, 1600, 1900]) {
      expect(expectedShortage(Q, DEFAULTS)).toBeCloseTo(integrateShortage(Q, DEFAULTS), 2)
      checked++
    }
    expect(checked).toBe(6)
  })

  it('⚠ agrees for the UNIFORM case too — the closed form the brief did not specify', () => {
    const uni: ExpectedProfitParams = { ...DEFAULTS, isNormal: false, minD: 200, maxD: 800 }
    let checked = 0
    for (const Q of [200, 300, 500, 650, 800]) {
      expect(expectedShortage(Q, uni)).toBeCloseTo(integrateShortage(Q, uni), 2)
      checked++
    }
    expect(checked).toBe(5)
  })

  it('is 0 above a uniform support and (μ − Q) below it', () => {
    const uni: ExpectedProfitParams = { ...DEFAULTS, isNormal: false, minD: 200, maxD: 800 }
    expect(expectedShortage(900, uni)).toBe(0)
    expect(expectedShortage(0, uni)).toBeCloseTo(500, 6)   // μ = 500
  })
})

describe('⚠ THE BRIEF’S VERIFIED PEAKS, at the shipped defaults', () => {
  const reg = regularOptimum(DEFAULTS)!
  const dual = dualOptimum(DEFAULTS)!

  it('regular Q* = 1265', () => {
    expect(reg.Qopt).toBe(1265)
  })
  it('regular peak ≈ 1,785,000', () => {
    expect(reg.peak).toBeGreaterThan(1_780_000)
    expect(reg.peak).toBeLessThan(1_790_000)
  })
  it('dual Q* = 1129', () => {
    expect(dual.Qopt).toBe(1129)
  })
  it('dual peak ≈ 1,836,000', () => {
    expect(dual.peak).toBeGreaterThan(1_831_000)
    expect(dual.peak).toBeLessThan(1_841_000)
  })
  it('the critical ratios are 0.8113 and 0.6667', () => {
    expect(reg.CR).toBeCloseTo(0.8113, 4)
    expect(dual.CR).toBeCloseTo(2 / 3, 6)
  })

  it('⚠ dual peaks HIGHER and orders LESS — the lecture’s whole point', () => {
    expect(dual.peak).toBeGreaterThan(reg.peak)
    expect(dual.Qopt).toBeLessThan(reg.Qopt)
  })
})

describe('the peaks are genuinely maxima of their own curves', () => {
  // ⚠ Asserting Q* equals a formula only proves the formula. This walks the actual
  // plotted curve and checks nothing on it beats the marked point — which is what an
  // instructor sees, and the only thing that would look wrong on a projector.
  const points = buildCurves(DEFAULTS, 400)

  it('sampled the curve', () => {
    expect(points.length).toBeGreaterThan(300)
  })

  it('no sampled Q beats the regular peak', () => {
    const peak = regularOptimum(DEFAULTS)!.peak
    const best = Math.max(...points.map(p => p.regular))
    expect(best).toBeLessThanOrEqual(peak + 1e-6)
  })

  it('no sampled Q beats the dual peak', () => {
    const peak = dualOptimum(DEFAULTS)!.peak
    const best = Math.max(...points.map(p => p.dual))
    expect(best).toBeLessThanOrEqual(peak + 1e-6)
  })

  it('the argmax of each sampled curve IS its Q* (to within a sample step)', () => {
    const argmax = (key: 'regular' | 'dual') =>
      points.reduce((a, b) => (b[key] > a[key] ? b : a)).Q
    expect(Math.abs(argmax('regular') - 1265)).toBeLessThanOrEqual(5)
    expect(Math.abs(argmax('dual') - 1129)).toBeLessThanOrEqual(5)
  })

  it('⚠ Q* is forced into the sample, so the marker sits ON the curve', () => {
    expect(points.some(p => p.Q === 1265)).toBe(true)
    expect(points.some(p => p.Q === 1129)).toBe(true)
  })
})

describe('the x-domain', () => {
  it('is mean ± 3·SD at the defaults — 100 to 1900', () => {
    expect(orderRange(DEFAULTS)).toEqual({ min: 100, max: 1900 })
  })
  it('clamps at 0 for a wide SD', () => {
    expect(orderRange({ ...DEFAULTS, mean: 200, sd: 300 }).min).toBe(0)
  })
  it('uses the support itself for a uniform instance', () => {
    expect(orderRange({ ...DEFAULTS, isNormal: false, minD: 200, maxD: 800 }))
      .toEqual({ min: 200, max: 800 })
  })
})

describe('the curves render with no students and no data', () => {
  it('produces a full series from config alone', () => {
    const pts = buildCurves(DEFAULTS)
    expect(pts.length).toBeGreaterThan(100)
    expect(pts.every(p => Number.isFinite(p.regular) && Number.isFinite(p.dual))).toBe(true)
  })
})

describe('degenerate configs draw no marker rather than an infinite one', () => {
  it('returns null when the overage is non-positive (net salvage ≥ cost)', () => {
    expect(regularOptimum({ ...DEFAULTS, v: 1400, h: 0 })).toBeNull()
  })
  it('returns null for the dual optimum when c_l ≤ c (no premium)', () => {
    expect(dualOptimum({ ...DEFAULTS, cL: 1000 })).toBeNull()
  })
  it('…but the regular optimum still exists in that same config', () => {
    expect(regularOptimum({ ...DEFAULTS, cL: 1000 })).not.toBeNull()
  })
})

describe('the dual line has no goodwill in it', () => {
  it('⚠ changing g moves the REGULAR curve and leaves the DUAL curve untouched', () => {
    const withG = { ...DEFAULTS, g: 150 }
    const noG = { ...DEFAULTS, g: 99_999 }
    expect(expectedProfitDual(1129, withG)).toBe(expectedProfitDual(1129, noG))
    expect(expectedProfitRegular(1265, withG)).not.toBe(expectedProfitRegular(1265, noG))
  })
})
