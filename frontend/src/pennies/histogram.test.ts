import { describe, it, expect } from 'vitest'
import { computeHistogram, plotWidth, tickStep, niceBinWidth, dollarLabel } from './histogram'

// Regression: the Class Analysis histogram dropped the top bar when the largest value
// fell exactly on a whole dollar (ceil(max) === max → bins 0..max-1, missing bin max).

describe('computeHistogram — top-bin inclusion', () => {
  it('includes a value that falls EXACTLY on a bin boundary (whole dollar)', () => {
    // The reported bug: a $15 estimate with everything else lower.
    const h = computeHistogram([12, 4, 3], [15, 8, 5, 2])
    expect(h.binCount).toBe(16)                 // bins 0..15 inclusive, not 0..14
    expect(h.bins[h.bins.length - 1]).toBe(15)  // top bin is $15
    expect(h.estCounts[15]).toBe(1)             // the $15 estimate is counted, not dropped
    expect(h.binCount).toBeGreaterThan(h.maxValue) // axis span [0,binCount) is above the max
  })

  it('accounts for the max when it comes from an ESTIMATE, not a bid', () => {
    const h = computeHistogram([12], [15]) // max (15) is the estimate; the bid is lower
    expect(h.binCount).toBe(16)
    expect(h.estCounts[15]).toBe(1)
    expect(h.bidCounts[12]).toBe(1)
    // No value is silently lost: every input lands in some bin.
    const totalBinned = h.bidCounts.reduce((s, c) => s + c, 0) + h.estCounts.reduce((s, c) => s + c, 0)
    expect(totalBinned).toBe(2)
  })

  it('accounts for the max when it comes from a BID (symmetry)', () => {
    const h = computeHistogram([15], [12])
    expect(h.binCount).toBe(16)
    expect(h.bidCounts[15]).toBe(1)
  })

  it('non-integer max still bins correctly (regression guard, unchanged behavior)', () => {
    const h = computeHistogram([14.83], [3.5])
    expect(h.binCount).toBe(15)        // bins 0..14; 14.83 → bin 14
    expect(h.bidCounts[14]).toBe(1)
    expect(h.estCounts[3]).toBe(1)
  })

  it('a lone high outlier with everything else low still spans 0..max (whole-dollar bins)', () => {
    const h = computeHistogram([23], [1, 2, 3, 4])
    expect(h.binCount).toBe(24)        // 0..23 — sparse but complete, not truncated
    expect(h.bidCounts[23]).toBe(1)
  })

  it('empty data yields a single $0 bin (no crash)', () => {
    const h = computeHistogram([], [])
    expect(h.binCount).toBe(1)
    expect(h.maxValue).toBe(0)
  })

  it('all-zero data yields a single $0 bin', () => {
    const h = computeHistogram([0], [0])
    expect(h.binCount).toBe(1)
    expect(h.bidCounts[0]).toBe(1)
    expect(h.estCounts[0]).toBe(1)
  })

  it('forward-scale data keeps whole-dollar bins (binWidth 1, unchanged)', () => {
    const h = computeHistogram([12, 4, 3], [15, 8])
    expect(h.binWidth).toBe(1)
    expect(h.binCount).toBe(16)
  })
})

describe('adaptive binning for reverse (six-figure) ranges', () => {
  it('niceBinWidth stays 1 for small ranges, steps up for large ones', () => {
    expect(niceBinWidth(25)).toBe(1)      // forward game — unchanged
    expect(niceBinWidth(40)).toBe(1)      // still whole-dollar at the threshold
    expect(niceBinWidth(320_000)).toBe(10_000)
    expect(niceBinWidth(1_000_000)).toBe(25_000)
  })

  it('a six-figure reverse spread produces a BOUNDED bin count (no 300k rects)', () => {
    const bids = [280_000, 300_000, 320_000, 305_000, 295_000]
    const estimates = [290_000, 310_000, 285_000]
    const h = computeHistogram(bids, estimates)
    expect(h.binWidth).toBe(10_000)
    expect(h.binCount).toBeLessThanOrEqual(50)     // NOT 320_001
    // Every value still lands in a bin (nothing dropped).
    const total = h.bidCounts.reduce((s, c) => s + c, 0) + h.estCounts.reduce((s, c) => s + c, 0)
    expect(total).toBe(bids.length + estimates.length)
    // The top value ($320k → bin 32 at width 10k) exists and is counted.
    expect(h.bidCounts[32]).toBe(1)
  })

  it('dollarLabel abbreviates only at/above $1,000 (forward labels unchanged)', () => {
    expect(dollarLabel(0)).toBe('$0')
    expect(dollarLabel(23)).toBe('$23')
    expect(dollarLabel(10_000)).toBe('$10k')
    expect(dollarLabel(2_500)).toBe('$2.5k')
    expect(dollarLabel(1_200_000)).toBe('$1.2m')
  })

  it('tickStep never overlaps labels even with wide six-figure labels', () => {
    // width 10k, 33 bins → widest label "$320k". Whatever step it picks must clear it.
    const binWidth = 10_000
    const binCount = 33
    const step = tickStep(binCount, binWidth)
    const binW = plotWidth(binCount) / binCount
    const widest = dollarLabel((binCount - 1) * binWidth).length * 6
    expect(step * binW).toBeGreaterThanOrEqual(widest + 8)
  })
})

describe('tickStep — adaptive x-axis label density', () => {
  const CHAR_PX = 6, GAP = 8
  const labelPx = (binCount: number) => `$${binCount - 1}`.length * CHAR_PX

  it('labels EVERY bin (step 1) for a narrow / typical range ($0–$25)', () => {
    expect(tickStep(26)).toBe(1)   // the typical case
    expect(tickStep(15)).toBe(1)   // $0–$14
    expect(tickStep(24)).toBe(1)   // $0–$23 — fits, so every bin
    expect(tickStep(1)).toBe(1)
  })

  it('a WIDE range picks a LARGER step rather than overlapping', () => {
    expect(tickStep(51)).toBeGreaterThan(1)   // $0–$50
    expect(tickStep(51)).toBe(2)
    expect(tickStep(101)).toBe(5)             // $0–$100
  })

  it('the chosen step never lets adjacent labels overlap', () => {
    // For any range, step * (space per bin) must clear the widest label + gap.
    for (const binCount of [10, 26, 40, 51, 80, 101, 200]) {
      const binW = plotWidth(binCount) / binCount
      const spacing = tickStep(binCount) * binW
      expect(spacing).toBeGreaterThanOrEqual(labelPx(binCount) + GAP)
    }
  })

  it('is monotonic — wider ranges never use a smaller step', () => {
    const steps = [15, 26, 40, 51, 80, 101].map(tickStep)
    for (let i = 1; i < steps.length; i++) expect(steps[i]).toBeGreaterThanOrEqual(steps[i - 1])
  })

  it('plotWidth is bounded [360, 900]', () => {
    expect(plotWidth(1)).toBe(360)
    expect(plotWidth(26)).toBe(884)     // grows with bins…
    expect(plotWidth(1000)).toBe(900)   // …until the cap
  })
})
