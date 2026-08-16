import { PD_STRATEGIES, type PdStrategy } from './strategies'

// ═══════════════════════════════════════════════════════════════════════════════
// ONE COLOUR PER STRATEGY, for both Tier-3 charts.
//
// ⚠⚠ THE DESIGN TARGET IS A CLASSROOM PROJECTOR, NOT A LAPTOP SCREEN. A projector
// crushes saturation and pulls mid-tone neighbours together, so the rule is SIX
// DISTINCT COLOUR FAMILIES with none adjacent on the wheel — not six values that
// happen to differ in hex.
//
// ⚠⚠ NO TEAL, AND NO THIRD COLOUR IN THE BLUE-GREEN FAMILY. That is the whole reason
// this palette was revised: `alternate` was teal (#0891b2), which sat directly beside
// tit-for-tat's blue in the legend and merged with it under projection. Magenta is as
// far from blue as the wheel allows while staying clear of red.
//
// ⚠ TIT-FOR-TAT AND GRIM KEEP THEIR EXISTING BLUE AND RED — those two lines are what
// Elena has been projecting, and recolouring them mid-course costs more than any
// marginal separation would buy.
//
// ⚠ BLACK vs CHART CHROME, checked rather than assumed. Both charts draw gridlines at
// #eee and axis lines at #ccc — both far lighter than #000, so a black SERIES cannot be
// mistaken for either. The darkest chrome is #333 (legend text and the bar value
// labels); a 2.5px black stroke and a 12px #333 glyph are not confusable in kind, but
// #333 is the closest thing on the canvas to this series and is worth knowing.
//
// ⚠ THE CLOSEST REMAINING PAIR IS RED (#dc2626, hue 0°) AND ORANGE (#d97706, hue 32°).
// Both were specified as unchanged, so the adjacency is deliberate rather than
// overlooked; orange is markedly darker and yellower, which is what separates them.
// Flagged for the projector test.
//
// ⚠ NO LINE STYLES, DASHES OR MARKERS. Deliberately out of scope — that is the fallback
// if the projector test still shows a collision, and it is a separate objective.
//
// ⚠ ONE MAP, BOTH CHARTS. Neither chart file may declare a colour constant of its own;
// two copies is two chances for the cooperation chart and the outcome chart to colour
// the same strategy differently in the same report.
// ═══════════════════════════════════════════════════════════════════════════════

export const STRATEGY_COLOR: Record<PdStrategy, string> = {
  tft: '#2563eb',           // blue     — UNCHANGED, in the existing slides
  grim: '#dc2626',          // red      — UNCHANGED, same reason
  random: '#16a34a',        // green    — a truer green; was emerald #059669, which
                            //            leaned blue and crowded the blue-green side
  always_first: '#d97706',  // orange   — unchanged; already the orange family
  always_second: '#000000',  // black   — a real black, readable on white
  alternate: '#c026d3',     // magenta  — WAS TEAL, and teal beside blue was the defect
}

/**
 * ⚠ EVERY STRATEGY HAS AN ENTRY, AND A TEST ASSERTS IT AGAINST THE ID LIST ITSELF —
 * so adding a strategy without a colour fails a test rather than rendering as a
 * fallback nobody notices. This constant is the fallback for an id from a FUTURE build
 * arriving in old client code, which is a different situation.
 */
export const UNKNOWN_STRATEGY_COLOR = '#6b7280'

export function strategyColor(id: PdStrategy): string {
  return STRATEGY_COLOR[id] ?? UNKNOWN_STRATEGY_COLOR
}

/** The ids the palette covers — exported so the completeness test compares two lists
 *  rather than restating one of them. */
export const PALETTE_IDS: readonly PdStrategy[] = PD_STRATEGIES
