import type { ScorecardConfig } from './config'
import type { StoredContract, StoredPeriod, Position } from './state'
import { toPeriodRecords } from './state'
import { settleContract } from './resolve'

// ═══════════════════════════════════════════════════════════════════════════════
// THE STUDENT WHITELIST. Everything `scorecardGetState` and `scorecardSubmitPeriod`
// send is built here, field by field, so the two endpoints cannot drift on what a
// student may see. Pure and Firestore-free.
//
// ⚠⚠ THE §4.1 ASYMMETRY, STATED PRECISELY, BECAUSE IT IS THE EASIEST THING HERE TO
// "FIX" BY MISTAKE:
//
//   REACHED the target      → ANNOUNCED. `targetReached` ships, and the banner with it
//                             (spec §4, SoPHIE parity).
//   CANNOT reach the target → NEVER ANNOUNCED. No flag, no banner, no altered copy, no
//                             disabled control, no changed field ordering.
//
// This is deliberate (spec §16, decided 08-07). Do not add the mirror flag for symmetry.
//
// ⚠ WHAT "NO DERIVABLE FIELD" MEANS HERE, EXACTLY. `score` and `periodsRemaining` ARE
// both sent — `showRemainingPeriods` is fixed on (spec §3, §4.1), so a student who thinks
// to subtract CAN work out that a contract is dead. That inference is the decision under
// test and must stay AVAILABLE. What is forbidden is a field that carries the CONCLUSION
// — `isDead`, `canReachTarget`, `periodsWasted`, a style token, anything the client could
// render without doing the arithmetic itself. The control is the exact recursive key-set
// pin in the harness (T6), which fails on any added key; a value scan would not catch a
// boolean, and value scans have false-positived twice on this platform.
//
// ⚠ NO NEXT-CONTRACT RELIABILITY. `ClientContract` describes the contract in play and
// nothing else. The next contract's condition is not omitted from this shape — it is not
// reachable from this shape's inputs at all (S8: a structural fix beats a discipline fix).
// ═══════════════════════════════════════════════════════════════════════════════

/** The parameters printed on every screen (spec §4's "Your Information" block). */
export interface ClientParams {
  contracts: number
  periodsPerContract: number
  targetScore: number
  bonus: number
  highEffortCost: number
  lowEffortCost: number
  /** P(acceptable | low effort). ⚠ Shown, and identical in both conditions (spec §2.1). */
  pAcceptableLow: number
  endowmentPerContract: number
  showTargetReachedBanner: boolean
  showPriorContractsPanel: boolean
  showRunningBalance: boolean
  showReliabilityLabel: boolean
  currency: string
  contractNoun: string
  periodNoun: string
  deliveryNoun: string
  scorecardNoun: string
  buyerName: string
  productName: string
}

/**
 * ⚠ TAKES A `ScorecardConfig` AND NOTHING ELSE. It cannot reach a `ScorecardTruth`, so it
 * cannot leak the other condition, the schedule or the seed — not because those are
 * filtered out, but because they are not in scope. Widening this signature is a
 * review-visible change rather than a slip.
 */
export function clientParams(config: ScorecardConfig): ClientParams {
  return {
    contracts: config.contracts,
    periodsPerContract: config.periodsPerContract,
    targetScore: config.targetScore,
    bonus: config.bonus,
    highEffortCost: config.highEffortCost,
    lowEffortCost: config.lowEffortCost,
    pAcceptableLow: config.pAcceptableLow,
    endowmentPerContract: config.endowmentPerContract,
    showTargetReachedBanner: config.showTargetReachedBanner,
    showPriorContractsPanel: config.showPriorContractsPanel,
    showRunningBalance: config.showRunningBalance,
    showReliabilityLabel: config.showReliabilityLabel,
    currency: config.currency,
    contractNoun: config.contractNoun,
    periodNoun: config.periodNoun,
    deliveryNoun: config.deliveryNoun,
    scorecardNoun: config.scorecardNoun,
    buyerName: config.buyerName,
    productName: config.productName,
  }
}

/** One resolved period, as the in-contract history table renders it (spec §4). */
export interface ClientPeriod {
  period: number
  action: 'high' | 'low'
  acceptable: boolean
  score: number
  balance: number
}

/**
 * ⚠ `u` AND `reliability_used` ARE DROPPED. The raw draw is the audit record and stays
 * server-side; `reliability_used` is the current contract's reliability, which the
 * student already has on screen — but sending it PER PERIOD would let a client detect a
 * mid-session parameter edit, and it is the kind of field that would quietly become the
 * carrier for a condition the student is not meant to compare against.
 */
export function toClientPeriods(periods: readonly StoredPeriod[]): ClientPeriod[] {
  return periods.map(p => ({
    period: p.period,
    action: p.action,
    acceptable: p.acceptable,
    score: p.score,
    balance: p.balance,
  }))
}

/** The contract IN PLAY (spec §4's contract-start and effort-choice screens). */
export interface ClientContract {
  /** 1-based. */
  contract: number
  /** ⚠ The heading condition for THIS contract only. */
  reliability: number
  /** Rendered from the live config with `{pct}` interpolated (spec §3). Null when
   *  `showReliabilityLabel` is off — the condition still applies, it is just unnamed. */
  label: string | null
  period: number
  periodsRemaining: number
  score: number
  balance: number
  highEffortPeriods: number
  /** ⚠ SHIPS. The reached-target banner (spec §4). See the file header for the
   *  asymmetry — there is deliberately no `cannotReachTarget` counterpart. */
  targetReached: boolean
  /** True on period 1 — the "The New Contract is Starting" heading (spec §4). */
  isContractStart: boolean
  periods: ClientPeriod[]
}

/** One finished contract, for the contract-result screen and the session summary. */
export interface ClientContractResult {
  contract: number
  /** ⚠ Present for contracts the student has PLAYED. Spec §4's session summary requires
   *  a Reliability column — "where a student first sees their two conditions side by
   *  side" — so withholding it here would delete the screen's whole point. It is safe
   *  because these contracts are over. */
  reliability: number
  label: string | null
  highEffortPeriods: number
  score: number
  metTarget: boolean
  earnings: number
}

export function toClientResult(
  c: StoredContract,
  config: ScorecardConfig,
  label: string | null,
): ClientContractResult {
  const settled = settleContract(toPeriodRecords(c), config)
  return {
    contract: c.contract,
    reliability: c.reliability,
    label,
    highEffortPeriods: settled.highEffortPeriods,
    score: settled.score,
    metTarget: settled.metTarget,
    earnings: settled.earnings,
  }
}

/** Shape the contract in play. `label` is already rendered (or null when hidden). */
export function toClientContract(
  c: StoredContract,
  config: ScorecardConfig,
  label: string | null,
): ClientContract {
  const played = c.periods.length
  const last = c.periods[played - 1]
  const score = last?.score ?? 0
  return {
    contract: c.contract,
    reliability: c.reliability,
    label,
    period: played + 1,
    // ⚠ INCLUDES the period about to be played, which is what makes
    // `score + periodsRemaining < targetScore` the right dead test (resolve.ts).
    periodsRemaining: config.periodsPerContract - played,
    score,
    balance: last?.balance ?? config.endowmentPerContract,
    highEffortPeriods: c.periods.filter(p => p.action === 'high').length,
    targetReached: score >= config.targetScore,
    isContractStart: played === 0,
    periods: toClientPeriods(c.periods),
  }
}

/** An unstarted contract — period 1, nothing played. Built without a stored record,
 *  because none exists until the first period is submitted (see state.ts). */
export function freshClientContract(
  contract: number,
  reliability: number,
  label: string | null,
  config: ScorecardConfig,
): ClientContract {
  return {
    contract,
    reliability,
    label,
    period: 1,
    periodsRemaining: config.periodsPerContract,
    score: 0,
    balance: config.endowmentPerContract,
    highEffortPeriods: 0,
    targetReached: false,
    isContractStart: true,
    periods: [],
  }
}

/** The screen id the client keys its React tree on.
 *
 *  ⚠⚠ T10 — `key={screen.id}` ISOLATION BETWEEN PERIODS **AND BETWEEN CONTRACTS**. The
 *  contract boundary is a second instance of the PD bug class: it is where the balance
 *  resets to the endowment, the score resets to zero and the reliability may change, so
 *  a retained radio selection or a stale derived value survives into a screen where every
 *  number around it has moved. Both indices are in the id for that reason — a period-only
 *  id would collide across contracts at the same period number, which is precisely the
 *  boundary that matters.
 */
export function screenId(position: Position): string {
  switch (position.kind) {
    case 'effort-choice':
      return `effort-c${position.contract}-p${position.period}`
    case 'contract-result':
      return `result-c${position.contract}`
    case 'session-summary':
      return 'summary'
  }
}
