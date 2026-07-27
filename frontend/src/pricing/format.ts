// ═══════════════════════════════════════════════════════════════════════════════
// How the Pricing Game renders its numbers. Its own module, with NO imports, so the
// formatting rules are directly unit-testable — every number a student reads goes
// through one of these four functions, and the round-results screen, the history
// table and the end screen must all render the same value identically.
//
// PROFITS ARE IN MILLIONS, TWO DECIMALS ($37.11M) — the case table's own format
// (spec §4), so a student comparing the screen against their reading is comparing
// like with like.
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * A posted price: whole dollars with thousands separators, e.g. `$1,600`.
 * Prices are integers by construction (spec §3), so there are no cents to show.
 */
export function formatPrice(dollars: number): string {
  return `$${Math.round(dollars).toLocaleString('en-US')}`
}

/**
 * A profit in millions of dollars, two decimals: `$87.15M`.
 *
 * ⚠ NEGATIVE PROFITS ARE REAL AND MUST READ AS LOSSES (spec §2): pricing below unit
 * cost loses money on every container, and KC Q4 exists to plant exactly that. The
 * sign goes OUTSIDE the dollar sign (−$12.54M, not $−12.54M) because that is how a
 * loss is written, and the caller pairs this with a colour — the string alone must
 * still be unambiguous for anyone who cannot see the colour.
 */
export function formatProfitM(dollars: number): string {
  const millions = dollars / 1_000_000
  // toFixed on the absolute value, so the sign is placed deliberately rather than
  // wherever toFixed happens to leave it. -0.004 → "$0.00M", never "−$0.00M".
  const body = `$${Math.abs(millions).toFixed(2)}M`
  return Number(Math.abs(millions).toFixed(2)) === 0 ? body : (millions < 0 ? `−${body}` : body)
}

/** A market share as a percentage, one decimal: `55.0%`. One decimal because a
 *  whole-dollar price gap moves share in tenths of a point at the shipped slope, so
 *  rounding to integers would make two different rounds look identical. */
export function formatShare(share: number): string {
  return `${(share * 100).toFixed(1)}%`
}

/** Containers won, to the nearest whole container with separators: `104,500`. */
export function formatDemand(containers: number): string {
  return Math.round(containers).toLocaleString('en-US')
}
