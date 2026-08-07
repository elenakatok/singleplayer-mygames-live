import {
  reliabilityOf, renderLabel,
  type Condition, type ScorecardConfig, type ScorecardTruth,
} from './config'
import { solve, optimalProfile, type Benchmarks } from './dp'
import type { StoredContract } from './state'

// ═══════════════════════════════════════════════════════════════════════════════
// THE DEBRIEF REVEAL (spec §10) and the FINAL STUDENT SCREEN (spec §5).
//
// ⚠⚠ THIS IS THE ONLY STUDENT-REACHABLE PAYLOAD THAT NAMES THE TREATMENT. It carries both
// conditions, both labels, the DP-optimal curves and the §6.3 table. It is served by
// exactly one callable (`scorecardSubmitDebrief`), past a gate on the stored
// `finished_at` stamp, and AFTER the student's paragraph is written.
//
// ⚠⚠ CONSUMER 4 OF THE ONE SOLVER (spec §16). `solve()` and `optimalProfile()` are called
// here — never a local approximation of the policy. The settings panel, the reports and
// the optimizer robot are the other three.
//
// ⚠ THE FRAMING IS "FRICTIONLESS BENCHMARK", NOT A GRADE (spec §5, procurement's settled
// wording). Two reasons, and both are correctness rather than tone:
//   • Earnings are NEVER graded (spec §7) — under this design correct play in the low
//     condition EARNS LESS, so grading earnings would punish the lesson.
//   • Five contracts per condition is far too short for realised earnings to converge on
//     any expectation, which the payload says explicitly rather than leaving to inference.
// ═══════════════════════════════════════════════════════════════════════════════

/** One condition's row of the §6.3 table, filled in at this instance's parameters. */
export interface RevealCondition {
  condition: Condition
  reliability: number
  label: string
  /** One scorecard point must be worth more than this. */
  threshold: number
  benchmarks: Benchmarks
  /** P(high effort) by period under optimal play — the dashed reference (spec §11). */
  optimalEffortByPeriod: number[]
  /** What the student actually did, by period, in this condition. Null where they
   *  played no contract at that period under this condition. */
  yourEffortByPeriod: (number | null)[]
  /** Contracts the student played in this condition. */
  contractsPlayed: number
  /** Share of periods the student used high effort, across those contracts. */
  yourHighEffortRate: number | null
  /** Realised earnings per contract in this condition. */
  yourMeanEarnings: number | null
}

export interface Reveal {
  high: RevealCondition
  low: RevealCondition
  /**
   * ⚠ THE HEADLINE (spec §5, §11): how far the student pulled back when the scorecard
   * went unreliable, against how far they should have. Null when they played only one
   * condition (`betweenSubject`, or an unfinished session).
   */
  yourEffortGap: number | null
  optimalEffortGap: number
  /** Spec §5's explicit note that five contracts is too short to converge. */
  contractsPerCondition: { high: number; low: number }
}

/** High-effort rate per period across a set of contracts. Null where nothing was played. */
function effortByPeriod(
  contracts: readonly StoredContract[],
  periodsPerContract: number,
): (number | null)[] {
  const out: (number | null)[] = []
  for (let p = 1; p <= periodsPerContract; p++) {
    const played = contracts
      .map(c => c.periods.find(x => x.period === p))
      .filter((x): x is NonNullable<typeof x> => x != null)
    // ⚠ SIZE-ASSERTED BEFORE THE RATE (T2). An empty period would otherwise report 0/0
    // as 0 — a flat line at zero that looks exactly like perfect play under the low
    // condition, which is the single most misleading thing this chart could show.
    out.push(played.length === 0
      ? null
      : played.filter(x => x.action === 'high').length / played.length)
  }
  return out
}

function buildCondition(
  condition: Condition,
  contracts: readonly StoredContract[],
  config: ScorecardConfig,
  truth: ScorecardTruth,
): RevealCondition {
  const reliability = reliabilityOf(truth, condition)
  const mine = contracts.filter(c => c.condition === condition
    && c.periods.length >= config.periodsPerContract)

  const allPeriods = mine.flatMap(c => c.periods)
  const highs = allPeriods.filter(p => p.action === 'high').length

  const earned = mine.map(c => c.earnings).filter((e): e is number => typeof e === 'number')

  return {
    condition,
    reliability,
    label: renderLabel(truth, condition),
    threshold: solve(config, reliability).benchmarks.marginalThreshold,
    benchmarks: solve(config, reliability).benchmarks,
    optimalEffortByPeriod: optimalProfile(config, reliability).map(m => m.pHigh),
    yourEffortByPeriod: effortByPeriod(mine, config.periodsPerContract),
    contractsPlayed: mine.length,
    yourHighEffortRate: allPeriods.length === 0 ? null : highs / allPeriods.length,
    yourMeanEarnings: earned.length === 0
      ? null
      : earned.reduce((s, e) => s + e, 0) / earned.length,
  }
}

/**
 * The reveal for one student.
 *
 * `schedule` is passed in (from the stored `startsWith`) rather than re-derived here, so
 * this function cannot disagree with what the student actually played.
 */
export function buildReveal(
  contracts: readonly StoredContract[],
  _schedule: readonly Condition[],
  config: ScorecardConfig,
  truth: ScorecardTruth,
): Reveal {
  const high = buildCondition('high', contracts, config, truth)
  const low = buildCondition('low', contracts, config, truth)

  return {
    high,
    low,
    // ⚠ Null rather than zero when a condition is missing. A student who played only one
    // condition has an UNDEFINED gap, not a gap of nought — and "0" is the finding this
    // report is looking for, so conflating them would manufacture the headline result.
    yourEffortGap:
      high.yourHighEffortRate == null || low.yourHighEffortRate == null
        ? null
        : high.yourHighEffortRate - low.yourHighEffortRate,
    optimalEffortGap:
      (high.benchmarks.expectedHighEffortPeriods - low.benchmarks.expectedHighEffortPeriods)
      / config.periodsPerContract,
    contractsPerCondition: { high: high.contractsPlayed, low: low.contractsPlayed },
  }
}
