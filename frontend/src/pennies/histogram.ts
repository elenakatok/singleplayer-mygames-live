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

// ── X-axis layout + adaptive tick density ───────────────────────────────────────
// The plot width is BOUNDED: it grows with the bin count up to a cap, then stops, so
// a wide range packs bins tighter (rather than the chart growing without limit). That
// is what makes tick thinning real — with an unbounded width every bin is 34px and
// nothing ever collides.
const BAR_GROUP_PX = 34   // natural width per whole-dollar bin (two bars + gaps)
const MIN_PLOT_W = 360
const MAX_PLOT_W = 900
const CHAR_PX = 6         // ~ width of one glyph ('$' or a digit) at fontSize 10
const LABEL_GAP_PX = 8    // minimum clear space between adjacent labels

/** Plot width in viewBox units: grows with bins, clamped to [MIN, MAX]. */
export function plotWidth(binCount: number): number {
  return Math.min(MAX_PLOT_W, Math.max(MIN_PLOT_W, binCount * BAR_GROUP_PX))
}

/**
 * Adaptive x-tick step. Labels EVERY whole-dollar bin when they fit; when the range
 * is wide enough that adjacent "$NN" labels would collide, thins to the SMALLEST of
 * 2 / 5 / 10 that fits. Never returns a step that lets labels overlap (a label needs
 * its glyph width + a gap; the widest label is the largest bin, "$" + (binCount-1)).
 */
export function tickStep(binCount: number): number {
  if (binCount <= 1) return 1
  const binW = plotWidth(binCount) / binCount
  const widestLabelPx = `$${binCount - 1}`.length * CHAR_PX
  const needed = widestLabelPx + LABEL_GAP_PX
  for (const s of [1, 2, 5]) {
    if (s * binW >= needed) return s
  }
  return 10
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
