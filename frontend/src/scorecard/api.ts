import { httpsCallable } from 'firebase/functions'
import { functions } from '../firebase'
import { isAuthError, instructorErrorMessage, CLASSROOM_URL, STUDENT_CLASSROOM_URL } from '../forecast/api'

// ═══════════════════════════════════════════════════════════════════════════════
// Metalcraft Supplier Scorecard — the callable client.
//
// ⚠⚠ THE RESPONSE TYPES BELOW ARE THE WHOLE CLIENT-SIDE CONTRACT, AND WHAT IS ABSENT
// FROM THEM IS THE POINT (spec §8, §13). No student type carries:
//
//   • BOTH reliabilities, or the fact that there are exactly two conditions
//   • `reliabilitySchedule`, `startsWith`, or anything about the counterbalancing
//   • the NEXT contract's reliability — `ScorecardContract` describes the contract in
//     play and nothing else
//   • the seed, the raw draw `u`, the DP, any policy or any benchmark
//   • ⚠ ANY FIELD ANNOUNCING THAT THE TARGET HAS BECOME UNREACHABLE (spec §4.1)
//
// The reached-target flag DOES exist (`targetReached`). The asymmetry is deliberate
// (spec §16) — do not add its mirror.
//
// If any of these ever appears in a student response, that is a SERVER bug, not a typing
// gap. The harness pins the exact key set (T6).
//
// ⚠ NOTE WHAT IS *NOT* IMPORTED: `db`. Every read goes through a callable; Firestore
// rules deny the client both truth/ and participants/.
// ═══════════════════════════════════════════════════════════════════════════════

async function callFn<T>(name: string, data: object = {}): Promise<T> {
  const fn = httpsCallable<object, T>(functions, name)
  const result = await fn(data)
  return result.data
}

// ⚠ Re-exported from forecast/api rather than duplicated — the one cross-game import in
// this tree, and procurement already relies on it (procurement BUILD_NOTES §7). It means
// a change to forecast/api.ts changes SCORECARD's behaviour too, which matters for
// deploy scope.
export { isAuthError, instructorErrorMessage, CLASSROOM_URL, STUDENT_CLASSROOM_URL }

/** The parameter block printed on every screen (spec §4). */
export interface ScorecardParams {
  contracts: number
  periodsPerContract: number
  targetScore: number
  bonus: number
  highEffortCost: number
  lowEffortCost: number
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

export interface ScorecardPeriod {
  period: number
  action: 'high' | 'low'
  acceptable: boolean
  score: number
  balance: number
}

/** ⚠ THE CONTRACT IN PLAY, and only that one. */
export interface ScorecardContract {
  contract: number
  reliability: number
  /** Null when `showReliabilityLabel` is off — the condition still applies, unnamed. */
  label: string | null
  period: number
  periodsRemaining: number
  score: number
  balance: number
  highEffortPeriods: number
  /** ⚠ The REACHED flag. There is deliberately no `cannotReach` counterpart (spec §4.1). */
  targetReached: boolean
  isContractStart: boolean
  periods: ScorecardPeriod[]
}

export interface ScorecardContractResult {
  contract: number
  reliability: number
  label: string | null
  highEffortPeriods: number
  score: number
  metTarget: boolean
  earnings: number
}

export type ScorecardScreenKind = 'effort-choice' | 'contract-result' | 'session-summary'

export interface ScorecardState {
  ok: true
  params: ScorecardParams
  /** ⚠ `id` is what React keys on — see Play.tsx and T10. */
  screen: { id: string; kind: ScorecardScreenKind }
  contract: ScorecardContract | null
  result: ScorecardContractResult | null
  completed: ScorecardContractResult[]
  totalEarnings: number
  contractsCompleted: number
  phase: 'play' | 'debrief'
  gameOver: boolean
}

export interface ScorecardKcQuestion {
  id: string
  prompt: string
  options: { id: string; text: string }[]
}

export interface ScorecardQuestions {
  ok: true
  kc: {
    questions: ScorecardKcQuestion[]
    /** ⚠ DYNAMIC — never assume 8. */
    total: number
    answeredIds: string[]
    score: number | null
    complete: boolean
  }
  debrief: { id: string; prompt: string; followUps: string[]; answered: boolean }
}

/**
 * ⚠ The ONLY student payload that names the treatment. Gated on the finish stamp.
 *
 * ⚠⚠ NO DP FIELDS, AND THEIR ABSENCE IS THE POINT (decided 08-07). There is no
 * `benchmarks`, no `threshold`, no `optimalEffortByPeriod` — spec §5 and §10 removed the
 * DP from every student surface, deleted rather than softened. Students are not asked to
 * solve a dynamic program and must not be framed as having failed to. The comparator is
 * the CLASS. If a DP field ever reappears in this type, that is the decision being
 * reversed by accident.
 */
export interface ScorecardRevealCondition {
  condition: 'high' | 'low'
  reliability: number
  label: string
  yourEffortByPeriod: (number | null)[]
  /** ⚠ The comparator (spec §10) — the room, on the same axes. */
  classEffortByPeriod: (number | null)[]
  contractsPlayed: number
  yourHighEffortRate: number | null
  classHighEffortRate: number | null
  yourMeanEarnings: number | null
}

export interface ScorecardReveal {
  high: ScorecardRevealCondition
  low: ScorecardRevealCondition
  yourEffortGap: number | null
  classEffortGap: number | null
  contractsPerCondition: { high: number; low: number }
  classSize: number
}

// ── Student callables ─────────────────────────────────────────────────────────

export function scorecardBootstrap(args: object) {
  return callFn<{ participant_id: string; game_instance_id: string; customToken: string }>(
    'scorecardBootstrap', args,
  )
}

/**
 * ⚠ `advance: true` moves contract-result → the next contract's period 1.
 *
 * It is a GATED read: the server refuses it unless the student is actually sitting at
 * contract-result, which is what stops it being a peek-ahead. Nothing is written, so the
 * next contract's reliability does not exist in the database until its first period is
 * submitted.
 */
export function scorecardGetState(advance = false) {
  return callFn<ScorecardState>('scorecardGetState', advance ? { advance: true } : {})
}

export function scorecardSubmitPeriod(contract: number, period: number, action: 'high' | 'low') {
  return callFn<ScorecardState>('scorecardSubmitPeriod', { contract, period, action })
}

export function scorecardGetQuestions() {
  return callFn<ScorecardQuestions>('scorecardGetQuestions')
}

export function scorecardSubmitKcAnswer(questionId: string, answer: string) {
  return callFn<{ ok: true; correct: boolean; alreadyAnswered: boolean; explanation: string }>(
    'scorecardSubmitKcAnswer', { questionId, answer },
  )
}

export function scorecardSubmitDebrief(answer: string) {
  return callFn<{ ok: true; questionId: string; stored: boolean; answer: string; reveal: ScorecardReveal }>(
    'scorecardSubmitDebrief', { answer },
  )
}

// ── Instructor callables ──────────────────────────────────────────────────────

export interface ScorecardPolicyPanel {
  condition: 'high' | 'low'
  reliability: number
  /** ⚠ Rendered SERVER-SIDE from live config. Never composed on the client. */
  title: string
  /** `cells[score][periodIndex]`; null = unreachable and simply absent from the plot. */
  cells: ('high' | 'low' | null)[][]
  threshold: number
}

export interface ScorecardRoundPoint { round: number; rate: number | null; n: number }

export interface ScorecardGapDistribution {
  bins: { from: number; to: number; count: number }[]
  included: number
  excludedUndefined: number
  excludedNoPlay: number
  atZero: number
}

export interface ScorecardReportParticipant {
  participant_id: string
  name: string | null
  launched: boolean
  completed: boolean
  finalized: boolean
  contracts_completed: number
  total_earnings: number
  starts_with: 'high' | 'low' | null
  high_effort_rate_high: number | null
  high_effort_rate_low: number | null
  /** ⚠ Null means "played only one condition" — an UNDEFINED gap, never a zero. */
  effort_gap: number | null
  earnings_high: number | null
  earnings_low: number | null
  bonuses_high: number
  bonuses_low: number
  periods_paid_after_dead: number
  knowledge_check_score: number | null
  participation_score: number | null
  debrief: string | null
  from_bot_cohort: boolean
}

export interface ScorecardConditionPanel {
  condition: 'high' | 'low'
  reliability: number
  label: string
  threshold: number
  benchmarks: Record<string, number>
}

export interface ScorecardInducedBehaviour {
  high: ScorecardConditionPanel
  low: ScorecardConditionPanel
  separation: number
  warnings: { id: string; message: string; level: 'warn' | 'severe' }[]
  policyGrid: ScorecardPolicyPanel[]
}

export interface ScorecardReport {
  ok: true
  scored: boolean
  params: ScorecardParams
  /** ⚠ INSTRUCTOR-ONLY — both conditions, both labels, the schedule. Chart captions
   *  depend on `reliabilitySchedule` AND `showReliabilityLabel` (R7). */
  treatment: {
    reliabilityHigh: number
    reliabilityLow: number
    reliabilitySchedule: 'alternating' | 'blocked' | 'betweenSubject'
    labelHigh: string
    labelLow: string
    scheduleStartingHigh: ('high' | 'low')[]
    scheduleStartingLow: ('high' | 'low')[]
  }
  participants: ScorecardReportParticipant[]
  botCount: number
  debriefPrompt: string
  tier3: {
    byRound: { high: ScorecardRoundPoint[]; low: ScorecardRoundPoint[] }
    byPeriod: {
      high: (number | null)[]
      low: (number | null)[]
      /** ⚠ Optional overlay, DEFAULT OFF. Never on a student screen. */
      optimalHigh: number[]
      optimalLow: number[]
    }
    gapDistribution: ScorecardGapDistribution
    /** ⚠ LOW FIRST (left), HIGH second (right) — slide order. Do not sort. */
    policyGrid: ScorecardPolicyPanel[]
  }
  summary: {
    classEffortHigh: number | null
    classEffortLow: number | null
    classEarningsHigh: number | null
    classEarningsLow: number | null
    optimalEffortHigh: number
    optimalEffortLow: number
    optimalEarningsHigh: number
    optimalEarningsLow: number
    lowConditionEffortSpend: number
    lowConditionOptimalSpendPerContract: number
    lowConditionContractsPlayed: number
    studentsWithData: number
  }
}

export interface ScorecardConfigResponse {
  ok: true
  config: ScorecardParams
  truth: {
    reliabilityHigh: number
    reliabilityLow: number
    reliabilitySchedule: 'alternating' | 'blocked' | 'betweenSubject'
    labelHigh: string
    labelLow: string
    seed: string | null
  }
  /** ⚠ Has anyone STARTED? The standing parameter lock's input (spec §3.1). */
  started: boolean
  induced: ScorecardInducedBehaviour
}

export function scorecardGetReport() {
  return callFn<ScorecardReport>('scorecardGetReport')
}
export function scorecardGetConfig() {
  return callFn<ScorecardConfigResponse>('scorecardGetConfig')
}
export function scorecardUpdateConfig(patch: Record<string, unknown>) {
  return callFn<ScorecardConfigResponse>('scorecardUpdateConfig', patch)
}
export function scorecardScoreAndRecord() {
  return callFn<{ ok: true; scored: number; finishers: number; push: unknown }>('scorecardScoreAndRecord')
}
export function scorecardSyncRoster() {
  return callFn<{ ok: true; created: number }>('scorecardSyncRoster')
}

/** Instructor session exchange — the argument `useInstructorSession` takes. */
export const scorecardInstructorSession = (
  args: { token: string } | { _dev: { game_instance_id: string } },
) =>
  callFn<{ ok: boolean; customToken: string }>('scorecardInstructorSession', args)
