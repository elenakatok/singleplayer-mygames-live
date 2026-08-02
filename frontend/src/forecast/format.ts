// ═══════════════════════════════════════════════════════════════════════════════
// Forecasting — display formatting. One module, so the card, the table, the final
// screen and the reports cannot render the same number three different ways.
//
// ⚠ THE LABELS ARE THE LECTURE'S (spec §0, §5, §15). √MSE is "Standard Error", never
// "RMSE" — slide 10's own summary-row label. The strings live here rather than being
// typed at each call site so that renaming one renames all of them, and so a grep for
// "RMSE" over this repo stays empty.
// ═══════════════════════════════════════════════════════════════════════════════

/** The metric names, exactly as the lecture writes them. */
export const METRIC_LABELS = {
  mae: 'MAE',
  mse: 'MSE',
  standardError: 'Standard Error',
  mape: 'MAPE',
  accuracy: 'Forecast Accuracy',
  bonus: 'Bonus',
  bias: 'Mean signed error',
} as const

/** A whole number of units, thousands-separated. */
export function formatUnits(n: number): string {
  return Math.round(n).toLocaleString()
}

/**
 * A metric that can be large (MSE) or small (MAE).
 *
 * MSE at these parameters runs from ~900 to ~40,000, so it is shown whole; MAE and the
 * Standard Error sit in the tens and get one decimal, which is the difference between
 * "MAE 24" and "MAE 23.7" mattering when a student compares two months.
 */
export function formatMetric(n: number, decimals = 1): string {
  return n.toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })
}

/** MSE and squared errors — always whole; a decimal on a five-figure number is noise. */
export function formatBig(n: number): string {
  return Math.round(n).toLocaleString()
}

/** A fraction as a percentage. Null renders as an em dash, never as "NaN%" — a
 *  zero-demand month genuinely has no percentage error (spec §5a). */
export function formatPercent(v: number | null, decimals = 1): string {
  if (v === null || !Number.isFinite(v)) return '—'
  return `${(v * 100).toFixed(decimals)}%`
}

/** Dollars, whole. Null renders as an em dash. */
export function formatMoney(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return '—'
  return `$${Math.round(v).toLocaleString()}`
}

/**
 * A SIGNED error, with an explicit + on positives.
 *
 * ⚠ THE SIGN IS SHOWN ON PURPOSE (spec §4). Bias — chronically under-forecasting a
 * rising trend, chronically missing December — is the most legible lesson in the game
 * and is invisible in absolute errors. A bare "50" does not say which way they missed;
 * "+50" does.
 */
export function formatSigned(n: number, decimals = 0): string {
  const s = n.toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })
  return n > 0 ? `+${s}` : s
}
