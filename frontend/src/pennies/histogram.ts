// ═══════════════════════════════════════════════════════════════════════════════
// Pure binning math for the Class Analysis histogram (Report 1), extracted so it can
// be unit-tested without React/SVG. WHOLE-DOLLAR bins (confirmed design): bin k covers
// the half-open range [k, k+1), and a value v lands in bin Math.floor(v).
//
// THE FIX (regression): the bin COUNT must be floor(max)+1 — bins 0..floor(max)
// INCLUSIVE — not ceil(max). ceil(max) equals max for a whole-dollar max (e.g. $15),
// which left bins 0..14 while a $15 value needs bin index 15 (floor(15)=15) — so the
// top bar was silently dropped and the axis stopped one bin short. The max may come
// from EITHER series; both are folded into `maxValue`.
// ═══════════════════════════════════════════════════════════════════════════════

export interface HistogramData {
  /** Number of whole-dollar bins; indices 0..binCount-1, each covering [k, k+1). */
  binCount: number
  bins: number[]
  bidCounts: number[]
  estCounts: number[]
  /** The largest value across both series — the axis span [0, binCount) is always > this. */
  maxValue: number
  /** Tallest bar count (≥ 1), for the y-axis. */
  maxCount: number
}

export function computeHistogram(bids: number[], estimates: number[]): HistogramData {
  const maxValue = Math.max(0, ...bids, ...estimates)
  // bins 0..floor(maxValue) inclusive → floor(maxValue)+1 bins. This guarantees the
  // bin holding the largest value (index floor(maxValue)) always exists, so the top
  // bar is never dropped or clipped — and the whole-dollar bin design is preserved.
  const binCount = Math.max(1, Math.floor(maxValue) + 1)
  const bins = Array.from({ length: binCount }, (_, k) => k)

  const countIn = (xs: number[], k: number) => xs.filter(v => Math.floor(v) === k).length
  const bidCounts = bins.map(k => countIn(bids, k))
  const estCounts = bins.map(k => countIn(estimates, k))
  const maxCount = Math.max(1, ...bidCounts, ...estCounts)

  return { binCount, bins, bidCounts, estCounts, maxValue, maxCount }
}
