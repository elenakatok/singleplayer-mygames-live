// ═══════════════════════════════════════════════════════════════════════════════
// Procurement Auction — display formatting. Pure, no React, no imports from the app.
//
// ⚠ THE CURRENCY LABEL IS CONFIG (`currencyLabel`, default "ECU"), never hardcoded in a
// screen. It travels through `params`, so an instructor renaming it renames it
// everywhere at once rather than in the places someone remembered.
//
// Every number in this game is a whole ECU: costs and bids are integers by construction
// (§3.1, §6.2) and a first-price payoff is a difference of two integers. So there is no
// rounding decision to get wrong here, and no decimals to print.
// ═══════════════════════════════════════════════════════════════════════════════

/** "48 ECU". */
export function ecu(amount: number, label: string): string {
  return `${amount} ${label}`
}

/** A signed profit — "+12 ECU", "0 ECU". Losses are possible (a bid below your own cost
 *  is allowed, §6.2) and print with their own minus sign. */
export function signedEcu(amount: number, label: string): string {
  const sign = amount > 0 ? '+' : ''
  return `${sign}${amount} ${label}`
}

/** A bid line's amount, or the reserve explanation for a bidder who made none. */
export function bidAmount(amount: number | null, label: string): string {
  return amount === null ? 'no bid' : ecu(amount, label)
}
