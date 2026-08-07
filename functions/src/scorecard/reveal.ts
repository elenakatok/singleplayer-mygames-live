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
  /** How many students the class comparison rests on. ⚠ Shown, so a class of one
   *  cannot read as a consensus. */
  classSize: number
}

function buildCondition(
  condition: Condition,
  contracts: readonly StoredContract[],
  population: readonly ParticipantContracts[],
  config: ScorecardConfig,
  truth: ScorecardTruth,
): RevealCondition {
  const mine = contractsIn(contracts, condition, config)
  const classContracts = population.flatMap(p => contractsIn(p.contracts, condition, config))

  return {
    condition,
    reliability: reliabilityOf(truth, condition),
    label: renderLabel(truth, condition),
    yourEffortByPeriod: effortByPeriod(mine, config),
    classEffortByPeriod: classEffortByPeriod(population, condition, config),
    contractsPlayed: mine.length,
    yourHighEffortRate: highEffortRate(mine),
    classHighEffortRate: highEffortRate(classContracts),
    yourMeanEarnings: meanEarnings(contracts, condition, config),
  }
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
  const high = buildCondition('high', contracts, population, config, truth)
  const low = buildCondition('low', contracts, population, config, truth)

  const gap = (h: number | null, l: number | null) => (h === null || l === null ? null : h - l)

  return {
    high,
    low,
    yourEffortGap: gap(high.yourHighEffortRate, low.yourHighEffortRate),
    classEffortGap: gap(high.classHighEffortRate, low.classHighEffortRate),
    contractsPerCondition: { high: high.contractsPlayed, low: low.contractsPlayed },
    classSize: population.length,
  }
}
