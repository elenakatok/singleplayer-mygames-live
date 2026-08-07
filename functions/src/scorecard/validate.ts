import {
  marginalThreshold, reliabilityOf,
  type ScorecardConfig,
  type ScorecardTruth,
  type Condition,
} from './config'
import { solve, type Benchmarks } from './dp'

// ═══════════════════════════════════════════════════════════════════════════════
// THE SETTINGS-SCREEN INDUCED-BEHAVIOUR PANEL (spec §3.1).
//
// "Every number is a setting" is only honest if the instructor can see what the numbers
// they typed actually INDUCE. The DP is ~110 cells and nobody can read a threshold policy
// off seven parameters; so this solves BOTH conditions at save time and shows the answer.
//
// ⚠⚠ EVERY WARNING INFORMS, NONE BLOCK — platform doctrine, and spec §3.1 states it
// explicitly. An instructor who wants a degenerate configuration for a demonstration gets
// it. The one thing that genuinely blocks is the standing parameter lock (rule-affecting
// settings frozen once a student has started), which is a different mechanism entirely
// and is not implemented here.
//
// ⚠ THE PANEL CALLS `solve()` — the same solver as the reports, the debrief and the
// optimizer robot (spec §16). If this file ever grows its own approximation of the
// policy, the settings screen starts describing a game the students are not playing.
// ═══════════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════════
// ⚠ THE OPTIMAL-POLICY GRID (spec §11 chart 4, added 08-07) — INSTRUCTOR ONLY.
//
// Reproduces lecture slide 6 from the instance's own parameters. It depends on NO student
// data, which is why it renders in two places from one implementation: the §3.1 settings
// panel (where an instructor can see what their edits induce before anyone plays) and the
// Tier-3 reports (where it is a debrief asset).
//
// ⚠⚠ PANEL ORDER IS LOW LEFT, HIGH RIGHT — deliberately NOT §6.2's ordering. This is a
// LECTURE ASSET FIRST and should drop into the deck without rework, so it follows the
// slide rather than the spec's own prose. Do not "fix" it to match §6.2.
//
// ⚠ TITLES READ LIVE CONFIG. "Reliability = 40%" is rendered from `reliabilityLow`, never
// typed in — the same rule as `labelHigh`/`labelLow`, and for the same reason: an
// instructor who edits a probability must not be shown a grid captioned with the old one.
//
// ⚠ NEVER RENDERED ON A STUDENT SCREEN. This IS the DP, and spec §5/§10 removed the DP
// from everything students see. It exists so the instructor can show the shape in debrief
// without asking anyone to have derived it.
// ═══════════════════════════════════════════════════════════════════════════════

/** One cell of the grid. `null` = unreachable and simply absent from the plot. */
export type PolicyCell = 'high' | 'low' | null

export interface PolicyPanel {
  condition: Condition
  reliability: number
  /** ⚠ Rendered from the live value (see above). */
  title: string
  /**
   * `cells[score][periodIndex]`, score 0…T and period 1…T (R10 — 1-based on the axis).
   * A cell is `null` where `score > periodIndex` — you cannot hold a score higher than
   * the number of periods already played.
   */
  cells: PolicyCell[][]
  /** The marginal threshold, for the panel's subtitle. */
  threshold: number
}

/**
 * Both panels, in SLIDE ORDER: low reliability first (left), high second (right).
 *
 * ⚠ Scores run 0…T, not 0…S* with a "S*+" row. Spec §11 chart 4 says "y-axis Score 0–10"
 * — a chart, unlike §6.2's text grid, has room for the coasting region above the target
 * and showing it is the point: those open circles ARE the "stop paying once you have won"
 * half of the threshold shape.
 */
export function policyGridPanels(
  config: ScorecardConfig,
  truth: ScorecardTruth,
): PolicyPanel[] {
  const T = config.periodsPerContract
  const build = (condition: Condition): PolicyPanel => {
    const reliability = reliabilityOf(truth, condition)
    const sol = solve(config, reliability)
    const cells: PolicyCell[][] = []
    for (let s = 0; s <= T; s++) {
      const row: PolicyCell[] = []
      for (let p = 1; p <= T; p++) {
        // Unreachable: at period p exactly p − 1 periods have been played.
        if (s > p - 1) { row.push(null); continue }
        row.push(sol.policy[T - p + 1][s] ? 'high' : 'low')
      }
      cells.push(row)
    }
    return {
      condition,
      reliability,
      title: `Reliability = ${Math.round(reliability * 100)}%`,
      cells,
      threshold: marginalThreshold(config, reliability),
    }
  }
  // ⚠ LOW FIRST. See the header — this follows the slide, not §6.2.
  return [build('low'), build('high')]
}

export type WarningId =
  | 'separation'
  | 'degenerate_high'
  | 'bonus_probability'
  | 'odd_contracts'
  | 'target_score_rule'
  | 'no_treatment'

export interface Warning {
  id: WarningId
  /** Shown to the instructor. Carries the numbers, not just the complaint. */
  message: string
  /** 'warn' — worth reading. 'severe' — the lesson probably does not survive this. */
  level: 'warn' | 'severe'
}

/** One condition's column in the panel. */
export interface ConditionPanel {
  condition: Condition
  reliability: number
  /** Rendered with the live probability (spec §3). */
  label: string
  /** One scorecard point must be worth more than this. 10 / 40 at defaults. */
  threshold: number
  benchmarks: Benchmarks
}

export interface InducedBehaviour {
  high: ConditionPanel
  low: ConditionPanel
  /** E[#high | high] − E[#high | low]. 8.12 at defaults (spec §3.1). */
  separation: number
  warnings: Warning[]
  /** ⚠ Tier-3 chart 4, on the settings screen too (spec §11). LOW LEFT, HIGH RIGHT. */
  policyGrid: PolicyPanel[]
}

/**
 * ⚠ The separation floor from spec §3.1. Below this the two conditions induce similar
 * behaviour and THE LESSON DIES: the whole exercise is the contrast between them, and a
 * class that should behave the same way in both cannot produce it.
 */
export const MIN_SEPARATION_PERIODS = 4

/** Spec §3.1 — outside this band the high condition is either hopeless or a gimme. */
export const BONUS_PROBABILITY_BAND = { min: 0.15, max: 0.95 }

const pct = (x: number) => `${Math.round(x * 100)}%`
const ecu = (x: number) => x.toFixed(2)

/**
 * Solve both conditions at the typed parameters and report what they induce.
 *
 * ⚠ Takes config AND truth because the treatment lives in truth (see config.ts). This is
 * an INSTRUCTOR-side function and the only caller is the settings screen; it must never
 * be reachable from a student callable, because its return value contains both
 * reliabilities, both labels and the optimal policy's value — every single thing spec §8
 * says the student is not told.
 */
export function inducedBehaviour(
  config: ScorecardConfig,
  truth: ScorecardTruth,
): InducedBehaviour {
  const panelFor = (condition: Condition, reliability: number): ConditionPanel => ({
    condition,
    reliability,
    label: (condition === 'high' ? truth.labelHigh : truth.labelLow).replace(
      /\{pct\}/g,
      pct(reliability),
    ),
    threshold: marginalThreshold(config, reliability),
    benchmarks: solve(config, reliability).benchmarks,
  })

  const high = panelFor('high', truth.reliabilityHigh)
  const low = panelFor('low', truth.reliabilityLow)
  const separation =
    high.benchmarks.expectedHighEffortPeriods - low.benchmarks.expectedHighEffortPeriods

  const warnings: Warning[] = []

  // ── The lesson-critical one ──────────────────────────────────────────────
  if (separation < MIN_SEPARATION_PERIODS) {
    warnings.push({
      id: 'separation',
      level: 'severe',
      message:
        `Optimal play differs by only ${separation.toFixed(2)} high-effort periods between ` +
        `the two conditions (${high.benchmarks.expectedHighEffortPeriods.toFixed(2)} vs ` +
        `${low.benchmarks.expectedHighEffortPeriods.toFixed(2)}); the lesson needs at least ` +
        `${MIN_SEPARATION_PERIODS}. Students who respond correctly will look almost identical ` +
        `in both, and the effort-gap column will have nothing to measure.`,
    })
  }

  // ⚠ A distinct failure from `separation`, and it can fire while separation looks fine:
  // if the two reliabilities are equal there is no experiment at all, whatever the
  // periods say.
  if (truth.reliabilityHigh === truth.reliabilityLow) {
    warnings.push({
      id: 'no_treatment',
      level: 'severe',
      message:
        `Both conditions run at ${pct(truth.reliabilityHigh)}. There is no treatment — every ` +
        `contract is the same game, and the two Tier-3 series will be the same line.`,
    })
  }

  // ── Degeneracy in the condition that is supposed to reward effort ─────────
  if (high.benchmarks.alwaysLow >= high.benchmarks.optimal) {
    warnings.push({
      id: 'degenerate_high',
      level: 'severe',
      message:
        `Under the HIGH condition, never working (${ecu(high.benchmarks.alwaysLow)}) is as good ` +
        `as optimal play (${ecu(high.benchmarks.optimal)}). Effort buys nothing in either ` +
        `condition, so there is no correct answer to contrast with.`,
    })
  }

  // ── The high condition's bonus should be winnable but not free ────────────
  const pb = high.benchmarks.pBonusOptimal
  if (pb < BONUS_PROBABILITY_BAND.min || pb > BONUS_PROBABILITY_BAND.max) {
    warnings.push({
      id: 'bonus_probability',
      level: 'warn',
      message:
        `Even playing optimally, the bonus is won ${pct(pb)} of the time under the HIGH ` +
        `condition — outside the ${pct(BONUS_PROBABILITY_BAND.min)}–${pct(BONUS_PROBABILITY_BAND.max)} ` +
        `band. ${pb < BONUS_PROBABILITY_BAND.min ? 'Students will read the target as unreachable and stop trying for reasons that are not the lesson.' : 'The target is close to automatic, so there is no squeeze and no threshold shape to see.'}`,
    })
  }

  // ── Counterbalancing needs an even number of contracts ────────────────────
  if (truth.reliabilitySchedule === 'alternating' && config.contracts % 2 !== 0) {
    warnings.push({
      id: 'odd_contracts',
      level: 'warn',
      message:
        `${config.contracts} contracts under an alternating schedule gives every student ` +
        `${Math.ceil(config.contracts / 2)} of their starting condition and ` +
        `${Math.floor(config.contracts / 2)} of the other. The class still balances because ` +
        `half start high, but no individual student sees an even split.`,
    })
  }

  // ── The target rule (spec §3.1) ───────────────────────────────────────────
  // ⚠ THE RULE IS `S* = round(T · reliabilityHigh)`, NOT the constant 7. Seven is right
  // at the defaults BECAUSE round(10 × 0.7) = 7; it stops being right the moment T or
  // reliabilityHigh moves, which is exactly when an instructor would not think to check.
  const impliedTarget = Math.round(config.periodsPerContract * truth.reliabilityHigh)
  if (config.targetScore !== impliedTarget) {
    warnings.push({
      id: 'target_score_rule',
      level: 'warn',
      message:
        `Target score is ${config.targetScore}, but ${config.periodsPerContract} periods at ` +
        `${pct(truth.reliabilityHigh)} implies ${impliedTarget} ` +
        `(round(T × reliabilityHigh)). At the implied value the target sits right at what ` +
        `diligent effort delivers, which is what creates the squeeze.`,
    })
  }

  return { high, low, separation, warnings, policyGrid: policyGridPanels(config, truth) }
}
