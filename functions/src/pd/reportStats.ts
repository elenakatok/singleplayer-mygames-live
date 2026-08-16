import { STRATEGIES, type Move, type Strategy } from './strategy'

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

/** One series' value at one round. */
export interface CooperationSeriesPoint {
  strategy: Strategy
  /** Fraction of this strategy's students who played the FIRST move this round.
   *  null ⇒ none of them had played this round at all. */
  rate: number | null
  /** How many of them had played this round — the denominator, and the legend's n=. */
  n: number
}

/**
 * Cooperation rate for ONE round, split by the strategy faced (Tier 3a).
 *
 * ⚠⚠ A LIST, NOT TWO NAMED FIELDS. It used to be `{tft, grim, tftN, grimN}` — four keys
 * hardcoding a two-strategy library. With seven the shape has to be data, and the
 * series present are the strategies ACTUALLY ASSIGNED in this instance, not the pool:
 * a strategy an instructor checked but that nobody drew has nothing to plot and gets
 * no series, no legend entry and no empty line across the chart.
 */
export interface CooperationPoint {
  /** 1-based round number. */
  round: number
  /** One entry per ASSIGNED strategy, in STRATEGIES order. Same set at every round. */
  series: CooperationSeriesPoint[]
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
  const present = assignedStrategies(rows)
  const out: CooperationPoint[] = []
  for (let round = 1; round <= roundCount; round++) {
    out.push({
      round,
      series: present.map((s) => {
        const group = rows.filter(r => r.strategy === s && r.moves.length >= round)
        return {
          strategy: s,
          rate: mean(group.map(r => (r.moves[round - 1] === 'C' ? 1 : 0))),
          n: group.length,
        }
      }),
    })
  }
  return out
}

/**
 * The strategies ACTUALLY ASSIGNED in this instance, in STRATEGIES order.
 *
 * ⚠⚠ DERIVED FROM THE DATA, NOT FROM THE POOL, and that is the whole rule for Tier 3.
 * A strategy an instructor checked but nobody drew has nothing to plot; giving it a
 * series would put an empty line and a legend entry on the chart and invite the reading
 * that its students all did something. Deriving from the data also handles the case the
 * pool cannot: a student assigned a strategy that has SINCE been unchecked is still in
 * this list, because they still played it (init.ts never reassigns).
 *
 * Exported because both Tier-3 aggregations need exactly this set, and two derivations
 * of "which strategies are in play" would eventually disagree.
 */
export function assignedStrategies(rows: readonly PdGameRow[]): Strategy[] {
  const seen = new Set(rows.map(r => r.strategy).filter((s): s is Strategy => s !== null))
  return STRATEGIES.filter(s => seen.has(s))
}

/**
 * Tier 3b — average outcome by FIRST decision, split by strategy.
 *
 * Two groups (opened with the first move / with the second) × one cell per ASSIGNED
 * strategy. The value is mean payoff PER ROUND (see the header note on normalization),
 * so shorter games stay comparable. Every (group × assigned strategy) cell is returned
 * in a stable order, so the chart's bar positions never move between renders — an empty
 * cell is n:0 with a null value, not a missing bar.
 *
 * ⚠ THE STRATEGY LIST WAS HARDCODED `['tft','grim']`. With seven ids that silently
 * omitted five: a student assigned `random` appeared in Tier 1 and in the debrief
 * grouping and simply vanished from this chart. It is the same ASSIGNED set Tier 3a
 * uses, from the same helper.
 */
export function outcomeByFirstMove(rows: readonly PdGameRow[]): FirstMoveOutcome[] {
  const moves: Move[] = ['C', 'D']
  const strategies: Strategy[] = assignedStrategies(rows)
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
