import {
  reliabilityOf, renderLabel,
  type Condition, type ScorecardConfig, type ScorecardTruth,
} from './config'
import type { StoredContract } from './state'
import {
  contractsIn, effortByPeriod, highEffortRate, meanEarnings, classEffortByPeriod,
  type ParticipantContracts,
} from './stats'

// ═══════════════════════════════════════════════════════════════════════════════
// THE DEBRIEF REVEAL (spec §10) and the FINAL STUDENT SCREEN (spec §5).
//
// ⚠⚠ THE DP IS GONE FROM HERE (decided 08-07). This file previously carried
// `benchmarks`, `threshold` and `optimalEffortByPeriod`. All three are **deleted, not
// hidden** — spec §5: "the earlier 'frictionless benchmark' line is removed, not
// softened."
//
// Elena's reason, worth keeping because it is a design position and not a preference:
// **students are not asked to solve a dynamic program and must not be framed as having
// failed to.** Showing someone a number they were never expected to reach reframes a
// reasonable session as a shortfall. The lesson is the DIRECTION — low reliability
// produces low effort — not the distance from optimal.
//
// ⚠ SO THE COMPARISON IS NOW: their two curves against EACH OTHER, and against the CLASS
// AVERAGE (spec §10). That makes the reliability effect visible as a shared pattern
// rather than an individual shortfall — a student who barely responded sees that the room
// barely responded either, which is the actual finding.
//
// ⚠ The DP survives in exactly three instructor-facing places: the §3.1 settings panel
// (validate.ts), the optimizer robot, and Tier-3 chart 4's policy grid. If a DP number
// ever reappears in this file, that is the decision being reversed by accident.
// ═══════════════════════════════════════════════════════════════════════════════

/** One condition's half of the reveal. ⚠ No benchmark, no threshold, no optimal curve. */
export interface RevealCondition {
  condition: Condition
  reliability: number
  label: string
  /** High-effort rate by period — this student. Null where they played no such period. */
  yourEffortByPeriod: (number | null)[]
  /** ⚠ THE COMPARATOR (spec §10). The class, same axes, same condition. */
  classEffortByPeriod: (number | null)[]
  contractsPlayed: number
  yourHighEffortRate: number | null
  classHighEffortRate: number | null
  yourMeanEarnings: number | null
}

/**
 * ⚠⚠ THE MINIMUM CLASS SIZE FOR THE STUDENT-FACING AVERAGE (spec §11, 08-07).
 *
 * The FIRST STUDENT TO FINISH would otherwise be shown a "class average" consisting
 * entirely of themselves — two curves that coincide exactly, presented as though the room
 * had independently done the same thing. That is not a weak comparison, it is a false one.
 *
 * Below this, `classEffortByPeriod` and `classHighEffortRate` are NULL and the screen says
 * the class comparison is not available yet. ⚠ Null, never a silently-thinner average.
 */
export const MIN_CLASS_N_FOR_STUDENT_AVERAGE = 5

export interface Reveal {
  high: RevealCondition
  low: RevealCondition
  /**
   * ⚠ THE HEADLINE (spec §5): "you used high effort X% of the time under the 70%
   * scorecard and Y% under the 40% one." One sentence, no interpretation, no verdict.
   *
   * Null when only one condition was played — an UNDEFINED gap, not a gap of nought.
   */
  yourEffortGap: number | null
  /** The same figure for the class, so the student sees the shared pattern. */
  classEffortGap: number | null
  contractsPerCondition: { high: number; low: number }
  /** ⚠ How many students the comparison rests on. Shown, so a thin class cannot read as
   *  a consensus. */
  classSize: number
  /** False below `MIN_CLASS_N_FOR_STUDENT_AVERAGE` — the screen then says the class
   *  comparison is not available yet rather than drawing a curve of one person. */
  classAvailable: boolean
}

function buildCondition(
  condition: Condition,
  contracts: readonly StoredContract[],
  population: readonly ParticipantContracts[],
  config: ScorecardConfig,
  truth: ScorecardTruth,
  classAvailable: boolean,
): RevealCondition {
  const mine = contractsIn(contracts, condition, config)
  const classContracts = population.flatMap(p => contractsIn(p.contracts, condition, config))
  const emptyCurve = Array.from({ length: config.periodsPerContract }, () => null)

  return {
    condition,
    reliability: reliabilityOf(truth, condition),
    label: renderLabel(truth, condition),
    yourEffortByPeriod: effortByPeriod(mine, config),
    // ⚠ SUPPRESSED, NOT THINNED, below the minimum n — see the constant above.
    classEffortByPeriod: classAvailable
      ? classEffortByPeriod(population, condition, config)
      : emptyCurve,
    contractsPlayed: mine.length,
    yourHighEffortRate: highEffortRate(mine),
    classHighEffortRate: classAvailable ? highEffortRate(classContracts) : null,
    yourMeanEarnings: meanEarnings(contracts, condition, config),
  }
}

/**
 * The HUMANS of a participant collection, shaped for `buildReveal`.
 *
 * ⚠ The student-facing class average is humans-only ALWAYS, with no demo-cohort fallback
 * (botFilter.ts). An instructor looking at a robot cohort gets a banner; a student never
 * gets robots at all.
 */
export function humanPopulation(
  docs: readonly { id: string; data: Record<string, unknown> }[],
  isBot: (id: string, data: Record<string, unknown>) => boolean,
  config: ScorecardConfig,
  parse: (raw: unknown, config: ScorecardConfig) => StoredContract[],
): ParticipantContracts[] {
  return docs
    .filter(d => !isBot(d.id, d.data))
    .map(d => ({ participantId: d.id, contracts: parse(d.data.contracts, config) }))
}

/**
 * The reveal for one student, against the class.
 *
 * `population` is every participant in the instance INCLUDING this student — the class
 * average is the room's average, not "everyone but you", which would make two students'
 * reveals disagree about the same class.
 */
export function buildReveal(
  contracts: readonly StoredContract[],
  population: readonly ParticipantContracts[],
  config: ScorecardConfig,
  truth: ScorecardTruth,
): Reveal {
  // ⚠ Counted over students who have PLAYED — a roster of never-started classmates is not
  // a class average, and including them in the n would let the suppression open early.
  const played = population.filter(p => p.contracts.length > 0)
  const classAvailable = played.length >= MIN_CLASS_N_FOR_STUDENT_AVERAGE

  const high = buildCondition('high', contracts, played, config, truth, classAvailable)
  const low = buildCondition('low', contracts, played, config, truth, classAvailable)

  const gap = (h: number | null, l: number | null) => (h === null || l === null ? null : h - l)

  return {
    high,
    low,
    classAvailable,
    yourEffortGap: gap(high.yourHighEffortRate, low.yourHighEffortRate),
    classEffortGap: gap(high.classHighEffortRate, low.classHighEffortRate),
    contractsPerCondition: { high: high.contractsPlayed, low: low.contractsPlayed },
    classSize: played.length,
  }
}
