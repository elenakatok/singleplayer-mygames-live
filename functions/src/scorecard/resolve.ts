import type { Condition, ScorecardRules } from './config'

// ═══════════════════════════════════════════════════════════════════════════════
// PERIOD RESOLUTION (spec §4, §14.1) — the one place a draw happens.
//
// ⚠⚠ S1 — THE DRAW IS TAKEN AT RESOLUTION AND WRITTEN IMMEDIATELY. This is the rule that
// the CP3 production blocker on procurement was about: a value that is DERIVED on read
// rather than RECORDED when drawn re-rolls on every read, because `makeRng` falls back to
// `Math.random` when the seed is null — and CLASSROOM INSTANCES SET NO SEED. There, a
// student was shown a cost of 33 and resolved against 58.
//
// So `resolvePeriod` returns a record containing `u` ITSELF, not merely the outcome. The
// caller writes the whole record. Nothing anywhere may reconstruct `acceptable` from
// `(action, reliability)` — the coin is not re-flippable.
//
// ⚠⚠ `reliabilityUsed` IS WRITTEN, NOT RE-DERIVED (spec §14.1). It would be trivial to
// recover it at read time from `startsWith` + `contractIndex` + the schedule, and that is
// precisely the coupling that lets a treatment collapse silently: change the schedule
// setting mid-session, or lose `startsWith`, and every historical period's condition
// silently rewrites itself to something the student never played. The stored value is the
// evidence; the schedule is only how the next one is chosen.
//
// ── THE DRAW CONVENTION ───────────────────────────────────────────────────────
//
// ONE draw per period, taken unconditionally, BEFORE the action is consulted. Procurement
// BUILD_NOTES §4 established the rule family-wide: a call site takes its draw whether or
// not it uses the value, so the stream position after an operation never depends on the
// data. Here it means a seeded replay of a student who chose High in period 3 and one who
// chose Low sees the same `u` in period 4 — without which two seeded runs diverging only
// in a student's choice would diverge in every later draw, and "the harness passes but
// production differs".
// ═══════════════════════════════════════════════════════════════════════════════

/** What the student chose this period. */
export type EffortAction = 'high' | 'low'

/**
 * One resolved period, exactly as it is written to the participant document
 * (spec §14.1: "(action, u, acceptable, score, reliabilityUsed)").
 */
export interface PeriodRecord {
  /** 1-based within the contract (R10). */
  period: number
  action: EffortAction
  /** ⚠ THE DRAW ITSELF, recorded (S1). Never regenerated, never re-derived. */
  u: number
  acceptable: boolean
  /** ⚠ P(acceptable) that this period was actually resolved against — WRITTEN (§14.1). */
  reliabilityUsed: number
  /** The condition in force, recorded alongside its probability for the reports. */
  condition: Condition
  /** Scorecard total AFTER this period. */
  score: number
  /** Contract balance AFTER this period's effort cost. Bonus is added at contract end. */
  balance: number
}

export interface ResolveInput {
  period: number
  action: EffortAction
  /** The reliability in force — from the CONDITION of the contract being played. */
  reliability: number
  condition: Condition
  /** Scorecard total BEFORE this period. */
  score: number
  /** Contract balance BEFORE this period. */
  balance: number
  rules: ScorecardRules
}

/**
 * Resolve one period.
 *
 * `draw` is called EXACTLY ONCE and unconditionally (see the header). It must be the
 * instance's RNG; the returned `u` is what gets written.
 *
 * ⚠ P(acceptable) DEPENDS ON THE ACTION **AND** THE CONDITION, and only through
 * `reliability` for high effort. Low effort resolves at `pAcceptableLow` in BOTH
 * conditions (spec §2.1) — this asymmetry is the entire mechanism, and the harness's
 * four-cell draw-rate check (spec §13) exists to catch a version that lost it.
 */
export function resolvePeriod(input: ResolveInput, draw: () => number): PeriodRecord {
  const u = draw()
  const p = input.action === 'high' ? input.reliability : input.rules.pAcceptableLow
  const acceptable = u < p
  const cost = input.action === 'high' ? input.rules.highEffortCost : input.rules.lowEffortCost
  return {
    period: input.period,
    action: input.action,
    u,
    acceptable,
    reliabilityUsed: p,
    condition: input.condition,
    score: input.score + (acceptable ? 1 : 0),
    balance: input.balance - cost,
  }
}

/**
 * Settle a finished contract: the bonus lands only now (spec §1).
 *
 *   contract earnings = endowment − c × (high-effort periods) + bonus · 1{score ≥ S*}
 */
export function settleContract(
  periods: readonly PeriodRecord[],
  rules: ScorecardRules,
): ContractResult {
  const highEffortPeriods = periods.filter(p => p.action === 'high').length
  const score = periods.length ? periods[periods.length - 1].score : 0
  const metTarget = score >= rules.targetScore
  const spend =
    rules.highEffortCost * highEffortPeriods +
    rules.lowEffortCost * (periods.length - highEffortPeriods)
  return {
    highEffortPeriods,
    score,
    metTarget,
    earnings: rules.endowmentPerContract - spend + (metTarget ? rules.bonus : 0),
  }
}

/** A completed contract, as the session summary and the reports read it. */
export interface ContractResult {
  highEffortPeriods: number
  score: number
  metTarget: boolean
  earnings: number
}

/**
 * Is the bonus already mathematically impossible? `score + periodsRemaining < targetScore`.
 *
 * ⚠⚠ SERVER-SIDE ONLY, AND IT MUST NEVER REACH THE CLIENT IN ANY FORM (spec §4.1).
 *
 * Not as a boolean, not as a banner, not as a disabled control, not as a class name, and
 * not as anything a client could compute from a field that would otherwise be absent.
 * Recognising a written-off contract IS the decision under test — a supplier that has
 * blown its rating in September gets no notice that Q4 effort is wasted.
 *
 * It exists here for the REPORTS ("periods paid for after the contract was already dead",
 * spec §11) and for the harness's negative check, both of which run after the fact. The
 * student's own inference stays available — `showRemainingPeriods` is fixed on (spec §3)
 * — but it stays an inference. ⚠ The reached-target banner IS shipped, and the asymmetry
 * is deliberate (spec §16); do not "fix" it for symmetry.
 */
export function isMathematicallyDead(
  score: number,
  periodsRemaining: number,
  targetScore: number,
): boolean {
  return score + periodsRemaining < targetScore
}

/**
 * Periods a student paid high effort for after the contract was already dead — the
 * Tier-1 column (spec §11). Computed from the STORED record, after play.
 */
export function periodsPaidAfterDead(
  periods: readonly PeriodRecord[],
  rules: ScorecardRules,
): number {
  let wasted = 0
  for (let i = 0; i < periods.length; i++) {
    const scoreBefore = i === 0 ? 0 : periods[i - 1].score
    const remaining = rules.periodsPerContract - i
    if (isMathematicallyDead(scoreBefore, remaining, rules.targetScore) && periods[i].action === 'high') {
      wasted++
    }
  }
  return wasted
}
