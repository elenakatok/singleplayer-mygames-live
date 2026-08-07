import type { GridCell } from './dp'

// ═══════════════════════════════════════════════════════════════════════════════
// SPEC §6.2 — THE LECTURE'S SLIDE 6, TRANSCRIBED VERBATIM AND COMMITTED AS A FIXTURE.
//
// These two grids are NOT generated. They are the published optimal-policy panels from
// `13_2_Scorecard.pdf` slide 6, typed in from spec §6.2 character for character, and the
// solver is regression-tested against them cell for cell (scorecardDp.test.ts).
//
// ⚠ THEY ARE THE REASON THE PARAMETERS ARE TRUSTED. Spec §2.4: the two conditions were
// reverse-engineered from this slide and then independently confirmed by solving the DP
// — reproducing both panels, including the isolated open circle at period 7 / score 6 in
// the 70% panel and the sparse work band at scores 4–6 in the 40% panel. If a future edit
// makes the solver disagree with these, the SOLVER is wrong, not the fixture.
//
// ⚠ DO NOT REGENERATE THESE FROM `solve()`. A fixture that is produced by the thing it
// tests asserts nothing. If they ever need to change, they change because Elena's slide
// changed, and the commit message says so.
//
// Calibration (spec §13, T1): perturbing `pAcceptableLow` from 0.30 to 0.25 breaks BOTH
// grids — one cell in the high panel, four in the low. Demonstrated in the test.
// ═══════════════════════════════════════════════════════════════════════════════

/** Rows run score 7+ down to 0; columns run period 1…10. */
export interface FixtureRow {
  /** The top row is "targetScore or better"; the rest are exact scores. */
  score: number
  cells: GridCell[]
}

function parse(block: string): FixtureRow[] {
  return block
    .trim()
    .split('\n')
    .map(line => {
      const parts = line.trim().split(/\s+/)
      const head = parts[0]
      return {
        score: Number(head.replace('+', '')),
        cells: parts.slice(1) as GridCell[],
      }
    })
}

/**
 * HIGH RELIABILITY (70%) — threshold 10 ECU.
 *
 * ⚠ The `o` at period 7 / score 6 is the cell that makes the DP non-optional: one point
 * from target with four periods left, Δ = 8.80 against a threshold of 10, so optimal play
 * takes the FREE DRAWS FIRST. Every hand-written "work until you hit the target" rule
 * gets this cell wrong.
 */
export const SLIDE6_HIGH: readonly FixtureRow[] = parse(`
  7+ . . . . . . . o o o
  6  . . . . . . o # # #
  5  . . . . . # # # # o
  4  . . . . # # # # o o
  3  . . . # # # # o o o
  2  . . # # # # o o o o
  1  . # # # o o o o o o
  0  # # # o o o o o o o
`)

/**
 * LOW RELIABILITY (40%) — threshold 40 ECU.
 *
 * ⚠ The work region is a SLIVER reachable only by getting lucky on free draws first: you
 * must already be at score 4+ by period 5, which under 30% low effort is rare. That is
 * why E[high-effort periods] is 0.13 — not "work a little" but almost never, and only
 * from contention you did not pay for.
 *
 * ⚠ Rows 5, 6 and 7+ are IDENTICAL to the high panel's, and that is correct rather than a
 * transcription slip: in the squeeze region Δ approaches the full bonus, which clears
 * both the 10 and the 40 threshold. The conditions differ only where Δ is modest.
 */
export const SLIDE6_LOW: readonly FixtureRow[] = parse(`
  7+ . . . . . . . o o o
  6  . . . . . . o # # #
  5  . . . . . # # # # o
  4  . . . . # o o o o o
  3  . . . o o o o o o o
  2  . . o o o o o o o o
  1  . o o o o o o o o o
  0  o o o o o o o o o o
`)

/** Spec §6.3's effort profile under optimal play, high reliability — the dashed
 *  reference on Tier-3 chart 2, committed so a solver change cannot silently move it.
 *  Rows: P(high), P(coasting), P(written off) — they partition to 1 in every period. */
export const SLIDE6_PROFILE_HIGH = {
  pHigh: [1.0, 1.0, 1.0, 0.97, 0.92, 0.94, 0.79, 0.82, 0.55, 0.26],
  pCoasting: [0, 0, 0, 0, 0, 0, 0, 0.04, 0.24, 0.46],
  pWrittenOff: [0, 0, 0, 0.03, 0.08, 0.06, 0.21, 0.14, 0.21, 0.28],
} as const

/** Spec §6.3, verbatim. The table the settings panel and the debrief both reproduce. */
export const SPEC_BENCHMARKS = {
  high: {
    marginalThreshold: 10,
    optimal: 94.12,
    highUntilTarget: 91.16,
    alwaysHigh: 87.95,
    alwaysLow: 51.27,
    pBonusOptimal: 0.6427,
    expectedHighEffortPeriods: 8.25,
    expectedScoreOptimal: 6.3,
  },
  low: {
    marginalThreshold: 40,
    optimal: 51.56,
    highUntilTarget: 16.71,
    alwaysHigh: 16.57,
    alwaysLow: 51.27,
    pBonusOptimal: 0.0173,
    expectedHighEffortPeriods: 0.13,
    expectedScoreOptimal: 3.01,
  },
} as const

/** Spec §6.3: share of high-reliability contracts that die with a period still to play. */
export const SPEC_DEAD_STATE_SHARE_HIGH = 0.278
