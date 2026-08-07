import type { Condition, ScorecardConfig } from './config'
import { isDead } from './resolve'
import type { StoredContract } from './state'

// ═══════════════════════════════════════════════════════════════════════════════
// THE ANALYSIS LAYER — per-student and per-class aggregation, shared by the debrief
// reveal (§10), the Tier-1 roster (§11) and the Tier-3 charts (§11).
//
// ⚠⚠ NOTHING IN THIS FILE TOUCHES THE DP (decided 08-07). Spec §5, §10 and §11 removed
// the DP from every student surface, and the roster's benchmark-ratio columns with it.
// The comparison that matters is **a student against themselves across conditions**, and
// secondarily against the class — never against a dynamic program nobody was asked to
// solve. The DP survives in exactly three instructor-facing places: the §3.1 settings
// panel, the optimizer robot, and Tier-3 chart 4's policy grid.
//
// ⚠⚠ EVERY RATE IS SIZE-GUARDED AND RETURNS `null` RATHER THAN 0 ON AN EMPTY DENOMINATOR
// (T2). This is not defensive habit — it is the single most dangerous shortcut available
// in this game. A `0/0 → 0` would draw **a flat line at zero**, which is exactly what
// correct play under low reliability looks like. An absent cohort would masquerade as a
// perfectly-responding one, in the chart the whole lecture rests on.
// ═══════════════════════════════════════════════════════════════════════════════

/** One student's stored contracts, plus who they are. The unit every function takes. */
export interface ParticipantContracts {
  participantId: string
  contracts: readonly StoredContract[]
}

/** Contracts of one condition that the student actually FINISHED. */
export function contractsIn(
  contracts: readonly StoredContract[],
  condition: Condition,
  config: ScorecardConfig,
): StoredContract[] {
  return contracts.filter(c =>
    c.condition === condition && c.periods.length >= config.periodsPerContract)
}

/**
 * High-effort rate across a set of contracts. Null when nothing was played.
 *
 * ⚠ NULL, NEVER 0 — see the file header.
 */
export function highEffortRate(contracts: readonly StoredContract[]): number | null {
  const periods = contracts.flatMap(c => c.periods)
  if (periods.length === 0) return null
  return periods.filter(p => p.action === 'high').length / periods.length
}

/**
 * High-effort rate BY PERIOD (1…T) across a set of contracts — Tier-3 chart 2's series
 * and the reveal's own curve.
 *
 * Returns one entry per period, `null` where no contract reached that period.
 */
export function effortByPeriod(
  contracts: readonly StoredContract[],
  config: ScorecardConfig,
): (number | null)[] {
  const out: (number | null)[] = []
  for (let p = 1; p <= config.periodsPerContract; p++) {
    const at = contracts
      .map(c => c.periods.find(x => x.period === p))
      .filter((x): x is NonNullable<typeof x> => x != null)
    out.push(at.length === 0 ? null : at.filter(x => x.action === 'high').length / at.length)
  }
  return out
}

/**
 * High-effort rate BY CONTRACT ROUND (1…N) — Tier-3 chart 1's series, reproducing slide 7.
 *
 * ⚠⚠ PLOTTED AGAINST CONTRACT ROUND, AND THE COUNTERBALANCING IS WHAT MAKES THAT LEGAL
 * (spec §11). Under `alternating`, series "high" is the ODD contracts for half the class
 * and the EVEN contracts for the other half — so at any given round the "high" series
 * draws from whichever students are in the high condition at that round. Plotting against
 * anything else (contract index within condition, say) would silently discard the order
 * effect the chart exists to show.
 *
 * `n` is carried per point because spec §11 requires it on both series: with half the
 * class in each condition at each round, a reader must be able to see that the two
 * series rest on comparable numbers of students.
 */
export interface RoundPoint {
  /** 1-based (R10). */
  round: number
  rate: number | null
  n: number
}

export function effortByRound(
  population: readonly ParticipantContracts[],
  condition: Condition,
  config: ScorecardConfig,
): RoundPoint[] {
  const out: RoundPoint[] = []
  for (let k = 1; k <= config.contracts; k++) {
    let high = 0
    let total = 0
    let students = 0
    for (const p of population) {
      const c = p.contracts.find(x => x.contract === k)
      if (!c || c.condition !== condition || c.periods.length === 0) continue
      students++
      high += c.periods.filter(x => x.action === 'high').length
      total += c.periods.length
    }
    // ⚠ Size-asserted per point, not per chart.
    out.push({ round: k, rate: total === 0 ? null : high / total, n: students })
  }
  return out
}

/** Class-level high-effort rate by period, for one condition. Nulls where empty. */
export function classEffortByPeriod(
  population: readonly ParticipantContracts[],
  condition: Condition,
  config: ScorecardConfig,
): (number | null)[] {
  const all = population.flatMap(p => contractsIn(p.contracts, condition, config))
  return effortByPeriod(all, config)
}

/**
 * ONE STUDENT'S EFFORT GAP — the Tier-1 headline (spec §11).
 *
 * `rate(high) − rate(low)`. Positive means they worked harder when the scorecard was
 * responsive, which is the direction the lesson predicts.
 *
 * ⚠⚠ NULL WHEN EITHER CONDITION IS MISSING, AND THAT DISTINCTION IS LOAD-BEARING. A
 * student who played only one condition has an **undefined** gap, not a gap of nought —
 * and "0" is precisely the finding Tier-3 chart 3 is looking for ("a mass at zero is the
 * finding"). Collapsing undefined into zero would manufacture the headline result out of
 * students who never had the chance to show one. `nullsLast` on the column, always.
 */
export function effortGap(
  contracts: readonly StoredContract[],
  config: ScorecardConfig,
): number | null {
  const hi = highEffortRate(contractsIn(contracts, 'high', config))
  const lo = highEffortRate(contractsIn(contracts, 'low', config))
  if (hi === null || lo === null) return null
  return hi - lo
}

/** Mean earnings per completed contract in one condition. Null when none. */
export function meanEarnings(
  contracts: readonly StoredContract[],
  condition: Condition,
  config: ScorecardConfig,
): number | null {
  const mine = contractsIn(contracts, condition, config)
  const earned = mine.map(c => c.earnings).filter((e): e is number => typeof e === 'number')
  if (earned.length === 0) return null
  return earned.reduce((s, e) => s + e, 0) / earned.length
}

/** Bonuses won in one condition. */
export function bonusesWon(
  contracts: readonly StoredContract[],
  condition: Condition,
  config: ScorecardConfig,
): number {
  return contractsIn(contracts, condition, config).filter(c => c.met_target === true).length
}

/**
 * Periods paid for (high effort) after the contract was already DEAD — the Tier-1 column
 * (spec §11), summed across every contract.
 *
 * ⚠ USES THE STRICT `isDead`, never `isWrittenOff` (BUILD_NOTES §1a). The claim is that
 * a student paid for a contract that was ALREADY IMPOSSIBLE — a fact they could have
 * derived from the periods-remaining counter — not that they diverged from the DP.
 */
export function periodsPaidAfterDead(
  contracts: readonly StoredContract[],
  config: ScorecardConfig,
): number {
  let wasted = 0
  for (const c of contracts) {
    for (let i = 0; i < c.periods.length; i++) {
      const scoreBefore = i === 0 ? 0 : c.periods[i - 1].score
      const remaining = config.periodsPerContract - i
      if (isDead(scoreBefore, remaining, config.targetScore) && c.periods[i].action === 'high') {
        wasted++
      }
    }
  }
  return wasted
}

/** Total ECU spent on effort in one condition — the §11 summary box. */
export function effortSpend(
  contracts: readonly StoredContract[],
  condition: Condition,
  config: ScorecardConfig,
): number {
  const periods = contractsIn(contracts, condition, config).flatMap(c => c.periods)
  return periods.reduce(
    (s, p) => s + (p.action === 'high' ? config.highEffortCost : config.lowEffortCost), 0,
  )
}

/**
 * The distribution of per-student effort gaps — Tier-3 chart 3.
 *
 * ⚠ R6 — EXCLUDED POINTS ARE COUNTED FROM THE DATA AND RETURNED, so the legend can
 * reconcile them. Students with an undefined gap are not silently dropped: procurement
 * shipped four "missing" scatter points that were correct all along and only the legend
 * was absent.
 */
export interface GapDistribution {
  /** One bucket per bin, in ascending order. */
  bins: { from: number; to: number; count: number }[]
  /** Students whose gap is defined and therefore plotted. */
  included: number
  /** ⚠ Students with only one condition played — an UNDEFINED gap, not a zero. */
  excludedUndefined: number
  /** Students who have played nothing at all. */
  excludedNoPlay: number
  /** Exactly zero gap — spec §11: "a mass at zero is the finding". */
  atZero: number
}

export function gapDistribution(
  population: readonly ParticipantContracts[],
  config: ScorecardConfig,
  binWidth = 0.1,
): GapDistribution {
  const gaps: number[] = []
  let excludedUndefined = 0
  let excludedNoPlay = 0

  for (const p of population) {
    if (p.contracts.length === 0) { excludedNoPlay++; continue }
    const g = effortGap(p.contracts, config)
    if (g === null) { excludedUndefined++; continue }
    gaps.push(g)
  }

  const bins: { from: number; to: number; count: number }[] = []
  for (let lo = -1; lo < 1 - 1e-9; lo += binWidth) {
    const from = Math.round(lo * 100) / 100
    const to = Math.round((lo + binWidth) * 100) / 100
    bins.push({ from, to, count: 0 })
  }
  for (const g of gaps) {
    // Clamp into range; the last bin is closed on the right so gap = 1 lands somewhere.
    let idx = Math.floor((g + 1) / binWidth)
    if (idx >= bins.length) idx = bins.length - 1
    if (idx < 0) idx = 0
    bins[idx].count++
  }

  return {
    bins,
    included: gaps.length,
    excludedUndefined,
    excludedNoPlay,
    atZero: gaps.filter(g => g === 0).length,
  }
}
