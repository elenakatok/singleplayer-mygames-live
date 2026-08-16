import type { PdStrategy } from './strategies'

// ═══════════════════════════════════════════════════════════════════════════════
// ONE COLOUR PER STRATEGY, for both Tier-3 charts.
//
// ⚠ THE OLD PALETTE HAD TWO COLOURS AND THAT WAS THE WHOLE PALETTE — `TFT_COLOR` and
// `GRIM_COLOR`, declared locally in each of the two chart files. Seven series needs
// seven, and needs them in ONE place: two copies of a seven-entry map is two chances
// for the cooperation chart and the outcome chart to colour `random` differently in the
// same report.
//
// ⚠ TIT-FOR-TAT AND GRIM KEEP THEIR EXISTING BLUE AND RED, deliberately. Those two
// lines are what Elena has been projecting; renaming a colour mid-course costs more
// than the marginal separation a fresh palette would buy.
//
// ⚠ ACCESSIBILITY, STATED RATHER THAN CLAIMED: these seven are distinguishable in
// normal vision and print, but blue/red/emerald under deuteranopia are the weakest
// pairing here. Every series is ALSO labelled in the legend with its own name and n=,
// so colour is not the only channel carrying the distinction — which is the mitigation,
// not a claim that the palette is colour-blind-safe. Flagged for Elena.
// ═══════════════════════════════════════════════════════════════════════════════

export const STRATEGY_COLOR: Record<PdStrategy, string> = {
  tft: '#2563eb',           // blue      (unchanged)
  grim: '#dc2626',          // red       (unchanged)
  random: '#059669',        // emerald
  always_first: '#d97706',  // amber
  always_second: '#7c3aed', // violet
  alternate: '#0891b2',     // cyan
  match_stay: '#be185d',    // magenta
}

/** Fallback for an id this build does not know — never expected, never silent. */
export const UNKNOWN_STRATEGY_COLOR = '#6b7280'

export function strategyColor(id: PdStrategy): string {
  return STRATEGY_COLOR[id] ?? UNKNOWN_STRATEGY_COLOR
}
