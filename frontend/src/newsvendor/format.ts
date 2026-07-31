// ═══════════════════════════════════════════════════════════════════════════════
// Newsvendor — number formatting, in one place so the place-order screen, the
// results screen, the history table and the reports cannot render the same value
// three different ways.
// ═══════════════════════════════════════════════════════════════════════════════

/** Whole dollars with a thousands separator: 26000 → "$26,000". */
export const formatMoney = (v: number): string => {
  const rounded = Math.round(v)
  const body = `$${Math.abs(rounded).toLocaleString('en-US')}`
  // A minus sign, not a hyphen — losses are common in this game and read badly with a
  // hyphen jammed against a dollar sign.
  return rounded < 0 ? `−${body}` : body
}

/** A unit count: 1043.2 → "1,043". */
export const formatUnits = (v: number): string => Math.round(v).toLocaleString('en-US')

/** A proportion as a percentage with one decimal: 0.8765 → "87.7%". */
export const formatPercent = (v: number): string => `${(v * 100).toFixed(1)}%`

/** An average order, which is genuinely fractional across periods: 1043.25 → "1,043.3". */
export const formatAverageUnits = (v: number): string =>
  v.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })

/** A nullable figure, as a dash when there is nothing to show. A student who has
 *  played no periods has no average order — not an average order of zero. */
export const dash = <T,>(v: T | null, render: (x: T) => string): string =>
  v == null ? '—' : render(v)

/**
 * A COMPACT dollar figure, for columns that must fit: $37.3M, $748.5K, $312.
 *
 * ⚠ THE UNIT IS CHOSEN PER VALUE, not fixed. Newsvendor totals run to tens of millions
 * while an optimality gap can be a few hundred thousand — pinning everything to "M"
 * would render a real $74,750 gap as "$0.07M", which reads as zero. One decimal keeps
 * every column the same width without collapsing the small values.
 *
 * Full precision is never lost: it is a DISPLAY format for the roster table only. The
 * per-period figures, the charts and the exported data all keep the exact numbers.
 */
export const formatMoneyCompact = (v: number): string => {
  const abs = Math.abs(v)
  const sign = v < 0 ? '−' : ''
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(1)}K`
  return `${sign}$${Math.round(abs).toLocaleString('en-US')}`
}
