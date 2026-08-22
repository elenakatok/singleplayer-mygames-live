// ═══════════════════════════════════════════════════════════════════════════════
// Pure binning math for the Class Analysis histogram (Report 1), extracted so it can
// be unit-tested without React/SVG. Bin index k covers the half-open range
// [k·binWidth, (k+1)·binWidth), and a value v lands in bin Math.floor(v / binWidth).
//
// ADAPTIVE BIN WIDTH. The forward game's bids sit in $0–$25, so WHOLE-DOLLAR bins
// (binWidth 1) are the confirmed design and stay exactly as they were — niceBinWidth
// returns 1 for every small range, so the whole existing forward behavior (and its
// tests) is untouched. The REVERSE game's bids are six figures ($300k+); at binWidth 1
// that is 300,000 bins and 300,000 rects, which freezes the browser. So above ~40
// dollars the bin width steps up to a "nice" value (…, 1k, 2k, 5k, 10k, …) chosen to
// keep the bin count bounded regardless of range.
//
// THE FIX (regression): the bin COUNT must be floor(max/binWidth)+1 — bins
// 0..floor(max/binWidth) INCLUSIVE — so the bin holding the largest value always
// exists and the top bar is never dropped. The max may come from EITHER series.
// ═══════════════════════════════════════════════════════════════════════════════

export interface HistogramData {
  /** Number of bins; indices 0..binCount-1, each covering [k·binWidth, (k+1)·binWidth). */
  binCount: number
  /** Dollars spanned by one bin. 1 for the forward game; a larger nice step for reverse. */
  binWidth: number
  bins: number[]
  bidCounts: number[]
  estCounts: number[]
  /** The largest value across both series — the axis span [0, binCount·binWidth) is > this. */
  maxValue: number
  /** Tallest bar count (≥ 1), for the y-axis. */
  maxCount: number
}

/**
 * A "nice" bin width (1, 2, 2.5, 5, 10, … × 10ⁿ) that keeps the bin count near
 * `targetBins` for a wide range, and is exactly 1 for any range up to `targetBins`
 * dollars — so the forward game's whole-dollar bins are preserved unchanged.
 */
export function niceBinWidth(maxValue: number, targetBins = 40): number {
  if (maxValue <= targetBins) return 1
  const raw = maxValue / targetBins
  const mag = Math.pow(10, Math.floor(Math.log10(raw)))
  for (const m of [1, 2, 2.5, 5, 10]) {
    if (m * mag >= raw) return m * mag
  }
  return 10 * mag
}

/** A dollar amount as a compact axis label: `$23`, `$2.5k`, `$300k`, `$1.2m`. Whole
 *  dollars under $1,000 render exactly (`$199`), so the forward game's labels are
 *  unchanged. */
export function dollarLabel(v: number): string {
  const trim = (x: number) => Number(x.toFixed(1)) // drop a trailing .0
  if (v >= 1_000_000) return `$${trim(v / 1_000_000)}m`
  if (v >= 1_000) return `$${trim(v / 1_000)}k`
  return `$${trim(v)}`
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
export function tickStep(binCount: number, binWidth = 1): number {
  if (binCount <= 1) return 1
  const binW = plotWidth(binCount) / binCount
  // The widest label is the last bin's START value, formatted the way the axis renders
  // it — for binWidth 1 this is "$<binCount-1>", exactly as before.
  const widestLabelPx = dollarLabel((binCount - 1) * binWidth).length * CHAR_PX
  const needed = widestLabelPx + LABEL_GAP_PX
  for (const s of [1, 2, 5]) {
    if (s * binW >= needed) return s
  }
  return 10
}

export function computeHistogram(bids: number[], estimates: number[]): HistogramData {
  const maxValue = Math.max(0, ...bids, ...estimates)
  const binWidth = niceBinWidth(maxValue)
  // bins 0..floor(maxValue/binWidth) inclusive. This guarantees the bin holding the
  // largest value always exists, so the top bar is never dropped or clipped. For the
  // forward game binWidth is 1, so this is identical to the old whole-dollar behavior.
  const binCount = Math.max(1, Math.floor(maxValue / binWidth) + 1)
  const bins = Array.from({ length: binCount }, (_, k) => k)

  const countIn = (xs: number[], k: number) => xs.filter(v => Math.floor(v / binWidth) === k).length
  const bidCounts = bins.map(k => countIn(bids, k))
  const estCounts = bins.map(k => countIn(estimates, k))
  const maxCount = Math.max(1, ...bidCounts, ...estCounts)

  return { binCount, binWidth, bins, bidCounts, estCounts, maxValue, maxCount }
}
