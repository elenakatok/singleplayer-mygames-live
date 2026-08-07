import { Timestamp } from 'firebase-admin/firestore'
import {
  conditionFor, scheduleFor,
} from './schedule'
import { settleContract, type EffortAction, type PeriodRecord, type ContractResult } from './resolve'
import {
  reliabilityOf, renderLabel,
  type Condition, type ScorecardConfig, type ScorecardTruth,
} from './config'

// ═══════════════════════════════════════════════════════════════════════════════
// THE NESTED LOOP (spec §4, §14.2) — participant state, resume, and the screen a
// student is on. Pure and Firestore-free apart from the Timestamp value type.
//
//   loop(contracts) { contract-start → loop(periods){ effort → compute } → contract-result }
//
// ⚠⚠ BESPOKE, NOT A GENERALISED PRIMITIVE (spec §14.2). Every other single-player game
// is `loop(N){…}`; the family's loop primitive does not nest and nothing has needed it
// to. Contracts are independent of one another — which is what satisfies architecture
// §2.4's "rounds are independent" — but PERIODS WITHIN A CONTRACT ARE NOT, and that is
// exactly why the inner loop is written out here rather than folded into the primitive.
// Standing debt: if a second nested-loop game appears, extract then.
//
// ── ⚠⚠ HOW THE CONTRACT BOUNDARY WORKS, AND WHY IT IS BUILT THIS WAY ──────────
//
// The build prompt calls the contract boundary "a second instance of the PD bug class",
// and the leak rule (spec §13) forbids "next-contract reliability before that contract
// starts". Those two together decide the design:
//
// 1. CONTRACT-START IS NOT A SEPARATE SERVER SCREEN. Spec §4 describes it as
//    "Contract k of 10 · Period 1 of 10 · the reliability label · score 0 · balance =
//    endowment" — which is precisely period 1's effort-choice screen with a heading. So
//    it ships as `effort-choice` carrying `isContractStart: true`. This is why the build
//    prompt lists exactly THREE resume boundaries (mid-contract, contract-result,
//    session-summary) and not four: contract-start is not a distinct position.
//
// 2. THE NEXT CONTRACT'S CONDITION IS NEVER WRITTEN AHEAD. It is DERIVED from the stored
//    `startsWith` when — and only when — the student advances past contract-result. There
//    is no pre-materialised record for it, so the leak check has nothing to omit: the
//    omission is in the data model (the S8 posture — a structural fix beats a discipline
//    fix).
//
// 3. ADVANCING IS A GATED READ, NOT A WRITE. `scorecardGetState({ advance: true })` moves
//    contract-result → the next contract's period 1. ⚠ It is REFUSED unless the student
//    is actually sitting at contract-result, which is what stops it being a peek-ahead: a
//    mid-contract student who calls it learns nothing. Nothing is written, so a student
//    who reloads sees contract-result again — correct, and idempotent.
//
// ⚠ A PLAYED CONTRACT'S CONDITION IS READ FROM THE RECORD, NEVER RE-DERIVED. Only the
// not-yet-started contract is derived. An instructor who edits `reliabilitySchedule`
// mid-session must not retroactively rewrite what a student already played — which is the
// same failure `reliabilityUsed` guards at the period level (spec §14.1).
// ═══════════════════════════════════════════════════════════════════════════════

// ── Stored shape (snake_case, Firestore style) ────────────────────────────────

/** One resolved period, as stored. Spec §14.1's `(action, u, acceptable, score,
 *  reliabilityUsed)`, plus the balance so the arithmetic is auditable without replay. */
export interface StoredPeriod {
  period: number
  action: EffortAction
  /** ⚠ THE DRAW ITSELF (S1). Never regenerated. */
  u: number
  acceptable: boolean
  /** ⚠ WRITTEN, not re-derived (spec §14.1). */
  reliability_used: number
  score: number
  balance: number
}

/**
 * One contract a student has started. The last element may be in progress.
 *
 * ⚠ `condition` and `reliability` are WRITTEN when the contract's first period is
 * submitted, and read back thereafter — see the header.
 */
export interface StoredContract {
  /** 1-based. */
  contract: number
  condition: Condition
  reliability: number
  periods: StoredPeriod[]
  /** Settlement, written when the final period resolves. Absent while in progress. */
  high_effort_periods?: number
  score?: number
  met_target?: boolean
  earnings?: number
  completed_at?: Timestamp
}

// ── Defensive parsing ─────────────────────────────────────────────────────────

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

function parsePeriods(raw: unknown, expectedCount: number): StoredPeriod[] {
  if (!Array.isArray(raw)) return []
  const out: StoredPeriod[] = []
  for (const el of raw) {
    const p = (typeof el === 'object' && el !== null ? el : {}) as Record<string, unknown>
    const expected = out.length + 1
    // Stops at the first bad element, so the surviving prefix is a contiguous 1..n with
    // no hole — which every consumer assumes and none of them re-checks.
    if (p.period !== expected) break
    if (p.action !== 'high' && p.action !== 'low') break
    if (!isNum(p.u) || !isNum(p.reliability_used) || !isNum(p.score) || !isNum(p.balance)) break
    if (typeof p.acceptable !== 'boolean') break
    if (out.length >= expectedCount) break
    out.push({
      period: expected,
      action: p.action,
      u: p.u,
      acceptable: p.acceptable,
      reliability_used: p.reliability_used,
      score: p.score,
      balance: p.balance,
    })
  }
  return out
}

/** Defensive read of the stored contracts array. Same posture as `parseStoredRounds`. */
export function parseStoredContracts(
  raw: unknown,
  config: ScorecardConfig,
): StoredContract[] {
  if (!Array.isArray(raw)) return []
  const out: StoredContract[] = []
  for (const el of raw) {
    const c = (typeof el === 'object' && el !== null ? el : {}) as Record<string, unknown>
    const expected = out.length + 1
    if (c.contract !== expected) break
    if (c.condition !== 'high' && c.condition !== 'low') break
    if (!isNum(c.reliability)) break
    if (out.length >= config.contracts) break

    const periods = parsePeriods(c.periods, config.periodsPerContract)
    const complete = periods.length >= config.periodsPerContract
    const rec: StoredContract = {
      contract: expected,
      condition: c.condition,
      reliability: c.reliability,
      periods,
    }
    if (complete) {
      // ⚠ Settlement is RECOMPUTED from the periods rather than trusted from the stored
      // summary fields. The periods are the audit record; the summary is a cache, and a
      // cache that disagrees with its source must lose.
      const settled = settleContract(toPeriodRecords(rec), config)
      rec.high_effort_periods = settled.highEffortPeriods
      rec.score = settled.score
      rec.met_target = settled.metTarget
      rec.earnings = settled.earnings
      if (c.completed_at instanceof Timestamp) rec.completed_at = c.completed_at
    }
    out.push(rec)
    // A contract that is not complete must be the LAST one — no gaps in the middle.
    if (!complete) break
  }
  return out
}

/** Stored periods as the `PeriodRecord` shape the pure core consumes. */
export function toPeriodRecords(c: StoredContract): PeriodRecord[] {
  return c.periods.map(p => ({
    period: p.period,
    action: p.action,
    u: p.u,
    acceptable: p.acceptable,
    reliabilityUsed: p.reliability_used,
    condition: c.condition,
    score: p.score,
    balance: p.balance,
  }))
}

// ── Where the student is ──────────────────────────────────────────────────────

export type Phase = 'play' | 'debrief'

/** The screen a student is on (spec §4). `contract-start` is `effort-choice` with the
 *  flag set — see the header for why that is not a fourth position. */
export type ScreenKind = 'effort-choice' | 'contract-result' | 'session-summary'

export interface Position {
  kind: ScreenKind
  /** 1-based contract this position refers to. Absent on session-summary. */
  contract?: number
  /** 1-based period, on effort-choice only. */
  period?: number
}

/**
 * Where a student is, from their stored contracts alone.
 *
 * ⚠⚠ THIS FUNCTION IS THE RESUME LOGIC. All three boundaries the build prompt names are
 * branches here, and each is unit-tested by reconstructing a doc mid-flow rather than by
 * replaying — because replay would exercise the writer, not the reader.
 */
export function positionOf(
  contracts: readonly StoredContract[],
  config: ScorecardConfig,
  finished: boolean,
): Position {
  const T = config.periodsPerContract
  if (finished) return { kind: 'session-summary' }

  // Nothing started yet → contract 1, period 1.
  if (contracts.length === 0) return { kind: 'effort-choice', contract: 1, period: 1 }

  const last = contracts[contracts.length - 1]
  // Mid-contract → the next unplayed period.
  if (last.periods.length < T) {
    return { kind: 'effort-choice', contract: last.contract, period: last.periods.length + 1 }
  }
  // The last contract is complete. If it was the last one, the session is over; the
  // caller stamps `finished_at`, but derive it here too so a doc missing the stamp still
  // reads correctly.
  if (contracts.length >= config.contracts) return { kind: 'session-summary' }
  // Otherwise: sitting at the contract-result screen, not yet advanced.
  return { kind: 'contract-result', contract: last.contract }
}

export function phaseOf(position: Position): Phase {
  return position.kind === 'session-summary' ? 'debrief' : 'play'
}

// ═══════════════════════════════════════════════════════════════════════════════
// ⚠⚠ WHICH SUBMITS ARE LEGAL — THE CONTRACT BOUNDARY, AS A FUNCTION.
//
// This was a comment inside `submitPeriod` and it should not have been. The rule it
// encodes is the one that broke every session at contract 2, period 1 during CP2:
//
//   effort-choice(k, p)  → (k, p)     the ordinary case
//   contract-result(k)   → (k+1, 1)   THE CONTRACT BOUNDARY
//
// The boundary case exists because `advance` WRITES NOTHING (getState.ts) — it is a gated
// read, so the next contract does not exist in the database until its first period lands.
// That is what keeps the next contract's reliability out of the payload, and the price is
// that the ordering check has to know the boundary is crossable.
//
// ⚠ IT LIVES HERE, PURE, SO IT CAN BE TESTED WITHOUT AN EMULATOR — and so that a future
// reader who tries to "simplify" the check back to a single case fails a unit test rather
// than shipping a game that dies on contract 2. A remembered rule is not an enforced one.
// ═══════════════════════════════════════════════════════════════════════════════

export type SubmitVerdict =
  | { legal: true; startsNewContract: boolean }
  | { legal: false; reason: 'session-over' | 'out-of-step' }

export function legalSubmit(
  position: Position,
  contractNumber: number,
  periodNumber: number,
  config: ScorecardConfig,
): SubmitVerdict {
  if (position.kind === 'session-summary') return { legal: false, reason: 'session-over' }

  if (position.kind === 'effort-choice'
    && position.contract === contractNumber
    && position.period === periodNumber) {
    return { legal: true, startsNewContract: periodNumber === 1 }
  }

  if (position.kind === 'contract-result'
    && contractNumber === (position.contract ?? 0) + 1
    && contractNumber <= config.contracts
    && periodNumber === 1) {
    return { legal: true, startsNewContract: true }
  }

  return { legal: false, reason: 'out-of-step' }
}

/**
 * The condition and reliability for a contract the student is about to START.
 *
 * ⚠ DERIVED from the stored `startsWith` — never stored ahead, never re-randomised
 * (spec §14.1). Called for exactly one contract at a time.
 */
export function upcomingContract(
  contractIndex1Based: number,
  startsWith: Condition,
  config: ScorecardConfig,
  truth: ScorecardTruth,
): { condition: Condition; reliability: number; label: string } {
  const condition = conditionFor(
    contractIndex1Based - 1, startsWith, truth.reliabilitySchedule, config.contracts,
  )
  return {
    condition,
    reliability: reliabilityOf(truth, condition),
    label: renderLabel(truth, condition),
  }
}

/**
 * The whole schedule for a student — INSTRUCTOR AND REPORTS ONLY.
 *
 * ⚠ NEVER send this to a student (spec §8: they are not told that reliability
 * alternates, nor that there are exactly two conditions). It exists for the reports and
 * for the harness's schedule check.
 */
export function fullSchedule(
  startsWith: Condition,
  config: ScorecardConfig,
  truth: ScorecardTruth,
): Condition[] {
  return scheduleFor(startsWith, truth.reliabilitySchedule, config.contracts)
}

// ── Derived figures ───────────────────────────────────────────────────────────

/** Settlement of every COMPLETED contract, in order. */
export function completedResults(
  contracts: readonly StoredContract[],
  config: ScorecardConfig,
): (ContractResult & { contract: number; condition: Condition; reliability: number })[] {
  return contracts
    .filter(c => c.periods.length >= config.periodsPerContract)
    .map(c => ({
      contract: c.contract,
      condition: c.condition,
      reliability: c.reliability,
      ...settleContract(toPeriodRecords(c), config),
    }))
}

/** Total earnings across completed contracts. In-progress contracts contribute nothing
 *  — the bonus is not known until the contract settles (spec §1). */
export function totalEarnings(
  contracts: readonly StoredContract[],
  config: ScorecardConfig,
): number {
  return completedResults(contracts, config).reduce((s, r) => s + r.earnings, 0)
}

/** Score and balance as they stand inside the in-progress contract. */
export function currentStanding(
  contracts: readonly StoredContract[],
  config: ScorecardConfig,
): { score: number; balance: number; highEffortPeriods: number } {
  const last = contracts[contracts.length - 1]
  if (!last || last.periods.length >= config.periodsPerContract) {
    return { score: 0, balance: config.endowmentPerContract, highEffortPeriods: 0 }
  }
  const p = last.periods[last.periods.length - 1]
  return {
    score: p.score,
    balance: p.balance,
    highEffortPeriods: last.periods.filter(x => x.action === 'high').length,
  }
}
