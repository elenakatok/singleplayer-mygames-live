import type { Move, Strategy } from './strategy'

// ═══════════════════════════════════════════════════════════════════════════════
// Repeated PD — the report aggregations (spec §9, Reports Contract Tier 1 + Tier 3).
// Pure: no Firestore, no I/O, so every number the instructor's charts draw is
// unit-tested directly rather than eyeballed on a rendered SVG.
//
// ⚠ INSTRUCTOR-SIDE ONLY. These aggregate the assigned STRATEGY, which is exactly
// what students must never see during play (spec §5). That is not a contradiction:
// the no-leak rule is a student-DURING-PLAY rule. Reports are reached only through
// pdGetReport, which is instructor-authenticated, and the debrief reveals the
// strategy anyway (spec §5, §11). Nothing here is reachable from a student path.
//
// EVERY AGGREGATE IS PER-ROUND-NORMALIZED, never a bare total. A student who quit
// after 3 rounds and one who played all 17 must be comparable, and a bare "years
// served" would rank the quitter better for quitting.
// ═══════════════════════════════════════════════════════════════════════════════

/** One student's game, as the aggregations consume it. */
export interface PdGameRow {
  participant_id: string
  /** The student's own moves, in round order. Empty ⇒ never played. */
  moves: readonly Move[]
  /** Years the student served, per round, aligned with `moves`. */
  years: readonly number[]
  /** Which bot they faced. null ⇒ never initialized (never opened the game). */
  strategy: Strategy | null
}

/** Cooperation rate for ONE round, split by the strategy faced (Tier 3a). */
export interface CooperationPoint {
  /** 1-based round number. */
  round: number
  /** Fraction of TFT-facing students who cooperated this round; null if none played it. */
  tft: number | null
  grim: number | null
  /** How many students of each group had played this round at all (the denominators). */
  tftN: number
  grimN: number
}

/** Average outcome for one (first move × strategy) cell (Tier 3b). */
export interface FirstMoveOutcome {
  firstMove: Move
  strategy: Strategy
  /** Mean years per round served by this group. Lower is better. null ⇒ empty group. */
  avgYearsPerRound: number | null
  /** How many students are in the group. */
  n: number
}

const mean = (xs: number[]): number | null =>
  xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length

/** A student's mean years per round, or null if they never played a round. */
export function avgYearsPerRound(row: PdGameRow): number | null {
  return mean([...row.years])
}

/** A student's cooperation rate over the rounds they played, or null if none. */
export function cooperationRate(row: PdGameRow): number | null {
  return mean(row.moves.map(m => (m === 'C' ? 1 : 0)))
}

/**
 * Tier 3a — cooperation rate per round, one series per strategy.
 *
 * The denominator for round t is the students who ACTUALLY PLAYED round t, not the
 * whole class: a student who stopped at round 4 should not drag rounds 5+ toward 0%
 * as though they had defected. That makes the tail of a line thinner (smaller n), not
 * lower, and `tftN`/`grimN` are returned so the chart can say so.
 *
 * @param rows       every participant's game
 * @param roundCount how many rounds the x-axis spans — the LONGEST game played in
 *                   this instance. Horizons are drawn per student (init.ts), so
 *                   there is no instance-wide count to pass here; the caller derives
 *                   this from the games themselves.
 */
export function cooperationByRound(rows: readonly PdGameRow[], roundCount: number): CooperationPoint[] {
  const out: CooperationPoint[] = []
  for (let round = 1; round <= roundCount; round++) {
    const played = (s: Strategy) =>
      rows.filter(r => r.strategy === s && r.moves.length >= round)
    const rate = (s: Strategy) => {
      const group = played(s)
      return { value: mean(group.map(r => (r.moves[round - 1] === 'C' ? 1 : 0))), n: group.length }
    }
    const t = rate('tft')
    const g = rate('grim')
    out.push({ round, tft: t.value, grim: g.value, tftN: t.n, grimN: g.n })
  }
  return out
}

/**
 * Tier 3b — average outcome by FIRST decision, split by strategy.
 *
 * Four cells: (first move C or D) × (TFT or GRIM). The value is mean years PER ROUND
 * (see the header note on normalization), so shorter games stay comparable. Always
 * returns all four cells, in a stable order, so the chart's bar positions never move
 * between renders — an empty cell is n:0 with a null value, not a missing bar.
 */
export function outcomeByFirstMove(rows: readonly PdGameRow[]): FirstMoveOutcome[] {
  const moves: Move[] = ['C', 'D']
  const strategies: Strategy[] = ['tft', 'grim']
  return moves.flatMap(firstMove =>
    strategies.map(strategy => {
      const group = rows.filter(r =>
        r.strategy === strategy && r.moves.length > 0 && r.moves[0] === firstMove)
      const perStudent = group
        .map(avgYearsPerRound)
        .filter((v): v is number => v !== null)
      return { firstMove, strategy, avgYearsPerRound: mean(perStudent), n: group.length }
    }),
  )
}
