import { httpsCallable } from 'firebase/functions'
import { functions } from '../firebase'
import { isAuthError, instructorErrorMessage, CLASSROOM_URL, STUDENT_CLASSROOM_URL } from '../forecast/api'

// ═══════════════════════════════════════════════════════════════════════════════
// Procurement Auction — the callable client. `functions` is the shared Firebase
// instance (one project serves every single-player game); only the callable NAMES are
// procurement-specific.
//
// ⚠⚠ THE RESPONSE TYPES BELOW ARE THE CLIENT-SIDE CONTRACT, AND WHAT IS ABSENT FROM
// THEM IS THE POINT (Part 1 §4). There is no `seed` and no rival-cost array in any
// STUDENT type, because the server never sends them: rival costs are drawn at
// resolution time inside the submit transaction, and a student who could see them
// before bidding would have no decision left. Do not add such a field here; if one ever
// appears in a student response, that is a server bug, not a typing gap.
//
// ⚠ NOTE WHAT IS *NOT* IMPORTED: `db`. Every read goes through a callable. Firestore
// rules deny the client both truth/ and participants/, so the SDK could not reach this
// data even if something reached for it — and nothing does.
//
// ⚠ THE THREE ERROR HELPERS ARE RE-EXPORTED FROM forecast/api, NOT RE-IMPLEMENTED.
// They are family-level behaviour, not game behaviour: `isAuthError` carries the
// "Missing token" case that bit forecast in production on 08-02, and a fourth private
// copy of that regex is a fourth place for it to go stale. Whether they should be
// promoted into `@mygames/game-ui` alongside `useStudentSession` is a real question and
// it is Elena's — flagged, not decided.
// ═══════════════════════════════════════════════════════════════════════════════

export { isAuthError, instructorErrorMessage, CLASSROOM_URL, STUDENT_CLASSROOM_URL }

async function callFn<T>(name: string, data: object = {}): Promise<T> {
  const fn = httpsCallable<object, T>(functions, name)
  const result = await fn(data)
  return result.data
}

// ── Student: launch ─────────────────────────────────────────────────────────────

export type StudentBootstrapArgs =
  | { token: string }
  | { _test: { participant_id: string; game_instance_id: string } }

export type StudentBootstrapResult = {
  ok: boolean
  participant_id: string
  game_instance_id: string
  customToken: string
}

export const procurementBootstrap = (args: StudentBootstrapArgs) =>
  callFn<StudentBootstrapResult>('procurementBootstrap', args)

// ── Student: state ──────────────────────────────────────────────────────────────

export type ProcurementFormat = 'sealed_first_price' | 'open_descending'

export type DecrementBand = { above: number; step: number }

/**
 * The instance's parameters, as the student receives them.
 *
 * ⚠ THIS IS THE WHITELIST. Every field is printed on the bidding screen anyway. The
 * ROUND COUNT IS PUBLIC in this game — eight rounds are independent, so unlike PD and
 * pricing there is no endgame effect that knowing the horizon would let a student
 * exploit, and the screen says "Round k of N" freely.
 *
 * ⚠ THE RIVAL COST RANGE IS ALSO PUBLIC, and deliberately: the equilibrium markup the
 * debrief discusses is only computable by a student who knows the top of it. Hiding it
 * would hide the lesson.
 */
export type ProcurementParams = {
  format: ProcurementFormat
  rounds: number
  rivalCount: number
  totalBidders: number
  reserve: number
  rivalCostMin: number
  rivalCostMax: number
  playerCostMin: number
  playerCostMax: number
  bidIncrementUnit: number
  currencyLabel: string
  decrementSchedule: DecrementBand[]
  botDelayMs: [number, number]
}

export type ProcurementPlayedRow = {
  round: number
  yourCost: number
  yourBid: number | null
  won: boolean
  price: number | null
  profit: number
  profitTotal: number
}

export type ProcurementPhase = 'kc' | 'play' | 'debrief' | 'done'

export type ProcurementState = {
  ok: boolean
  params: ProcurementParams
  played: ProcurementPlayedRow[]
  totalProfit: number
  /** What the §8 benchmark bid would have earned against the SAME realized rivals. */
  totalEquilibriumProfit: number
  roundsWon: number
  roundsPlayed: number
  /**
   * The round to play next (1-based) and the student's own drawn cost for it — the one
   * drawn number a student receives before acting, and the whole premise of the bidding
   * screen (§4, §6.1). Both null once every round is played.
   *
   * ⚠ THE COST IS THE PLAYER'S OWN, off its own stream. There is no rival cost here and
   * there never will be: rival costs are drawn at resolution, inside the submit
   * transaction. If one ever appears in this type, that is a server bug.
   */
  currentRound: number | null
  currentCost: number | null
  phase: ProcurementPhase
  gameOver: boolean
}

export const procurementGetState = () => callFn<ProcurementState>('procurementGetState')

// ── Student: one sealed round ───────────────────────────────────────────────────

/** One bidder's line on the round-result table. ⚠ NOTE WHAT IS ABSENT: `cost`. The bids
 *  are revealed once the round resolves; the costs behind them never are. */
export type ProcurementBidLine = {
  label: string
  /** null = this rival was priced out by the reserve and made no bid (§3.1). */
  amount: number | null
  isYou: boolean
  won: boolean
}

export type ProcurementRoundResult = {
  round: number
  yourCost: number
  yourBid: number | null
  /** Every bidder, LOWEST FIRST, the player's and the winner's marked. */
  bids: ProcurementBidLine[]
  won: boolean
  price: number | null
  profit: number
  profitTotal: number
  /** No admissible bid at all — nobody won. Only reachable at a lowered reserve. */
  noAward: boolean
  /** The player's own cost was above the reserve: there was no bid worth making. */
  costAboveReserve: boolean
  tie: boolean
  /** Fires the "two bids tied at the lowest price" line — without it a student sees two
   *  identical lowest bids with the other marked winner and reads it as a bug. */
  tiedAndLost: boolean
  equilibriumBid: number | null
  equilibriumWouldHaveWon: boolean
  equilibriumProfit: number
}

export type ProcurementSubmitBidResult = {
  ok: boolean
  /** The next round and the student's own cost for it, so the loop starts without a
   *  second round trip. Both null once the game is over. */
  nextRound: number | null
  nextCost: number | null
  round: ProcurementRoundResult
  history: ProcurementPlayedRow[]
  totalProfit: number
  totalEquilibriumProfit: number
  roundsWon: number
  roundsPlayed: number
  phase: ProcurementPhase
  gameOver: boolean
}

/** ⚠ SUBMIT AND LOCK. A resubmit for a round already stored returns that round and
 *  writes nothing — the retry is safe, and it cannot trigger a second cost draw. */
export const procurementSubmitBid = (round: number, bid: number) =>
  callFn<ProcurementSubmitBidResult>('procurementSubmitBid', { round, bid })

// ── Student: questions ──────────────────────────────────────────────────────────

export type ProcurementKcQuestionClient = {
  field: string
  kind: 'mc' | 'text'
  prompt: string
  options: { value: string; label: string }[]
  placeholder: string | null
}

export type ProcurementQuestions = {
  ok: boolean
  kcEnabled: boolean
  kc: ProcurementKcQuestionClient[]
  kcAnswered: string[]
  /** ⚠ COMPUTED SERVER-SIDE from the VISIBLE GRADED questions, never stored. The
   *  student's score is out of exactly this. There is no `/17` on the client either. */
  gradedTotal: number
  prep: ProcurementKcQuestionClient[]
  prepAnswered: string[]
  debrief: ProcurementKcQuestionClient[]
  debriefAnswered: string[]
}

export const procurementGetQuestions = () =>
  callFn<ProcurementQuestions>('procurementGetQuestions')

export const procurementSubmitKcAnswer = (field: string, answer: string) =>
  callFn<{ ok: boolean; correct: boolean; graded: boolean; explanation: string }>(
    'procurementSubmitKcAnswer', { field, answer })

/** ⚠ ONE callable for the prep AND the debrief paragraph — routed server-side by the
 *  question's stage tag. */
export const procurementSubmitFreeText = (field: string, answer: string) =>
  callFn<{ ok: boolean; field: string; stage: QuestionStage; stored: boolean; answer: string }>(
    'procurementSubmitFreeText', { field, answer })

// ── Instructor ──────────────────────────────────────────────────────────────────

// ⚠ ONLY the session exchange takes arguments. Every other instructor callable
// authenticates on the auto-attached Bearer id-token that `useInstructorSession`
// established — matching forecast, newsvendor, pricing and PD. An `args` parameter here
// would invite a caller to re-send the classroom JWT on every navigation, which is the
// 15-minute `jwt expired` bug the shared hook's resume guard exists to prevent.
import type { InstructorSessionArgs } from '../shared/useInstructorSession'

export type ProcurementConfig = {
  format: ProcurementFormat
  direction: 'reverse'
  rounds: number
  rivalCount: number
  reserve: number
  rivalCostDist: { distribution: 'uniform'; min: number; max: number; integer: boolean }
  playerCostDist: { distribution: 'uniform'; min: number; max: number; integer: boolean }
  bidIncrementUnit: number
  decrementSchedule: DecrementBand[]
  botDelayMs: [number, number]
  currencyLabel: string
  kcEnabled: boolean
  /** ⚠ Includes the PREP and DEBRIEF questions (S8/S9, O9/O10) — they are pool entries
   *  with a `stage` tag, toggled here like every graded question. There is deliberately
   *  no separate debriefEnabled/debriefPrompt pair. */
  kcVisible: string[]
}

export type QuestionStage = 'kc' | 'prep' | 'debrief'

export type ProcurementKcPoolRow = {
  id: string
  stage: QuestionStage
  prompt: string
  graded: boolean
  visible: boolean
}

export type ProcurementConfigResult = {
  ok: boolean
  config: ProcurementConfig
  /** ⚠ MASKED — whether a seed is set, never the seed itself. */
  seedSet: boolean
  formatLocked: boolean
  kcPool: ProcurementKcPoolRow[]
  kcPoolTotal: number
  kcVisibleCount: number
  kcGradedCount: number
}

export const procurementGetConfig = () =>
  callFn<ProcurementConfigResult>('procurementGetConfig')

export const procurementUpdateConfig = (
  config: Partial<ProcurementConfig> & { seed?: string | null },
) =>
  callFn<{ ok: boolean; config: ProcurementConfig; updated: string[]; seedWritten: boolean; rejected: string[] }>(
    'procurementUpdateConfig', { config })

export const procurementSyncRoster = () =>
  callFn<{ ok: boolean; synced: number; note?: string }>('procurementSyncRoster')

export type ProcurementPushSummary = { total: number; succeeded: number; failed: unknown[] }

export const procurementScoreAndRecord = () =>
  callFn<{ ok: boolean; scored: number; finishers: number; push: ProcurementPushSummary | null }>(
    'procurementScoreAndRecord')

export type ProcurementReportRow = {
  participantId: string
  name: string | null
  externalId: string | null
  finished: boolean
  roundsPlayed: number
  roundsWon: number
  profitTotal: number
  knowledgeCheckScore: number | null
  rawScore: number | null
  normalizedScore: number | null
  rounds: ProcurementPlayedRow[]
  /** Every free-text answer, keyed by question id. */
  freeText: Record<string, string>
}

export type ProcurementReport = {
  ok: boolean
  format: ProcurementFormat
  rounds: number
  reserve: number
  currencyLabel: string
  gradedTotal: number
  finalized: boolean
  /** ⚠ ONE ENTRY PER TIER-2 TILE — the spawn gate. Four across the two formats. */
  textQuestions: { field: string; stage: QuestionStage; prompt: string }[]
  rows: ProcurementReportRow[]
}

export const procurementGetReport = () => callFn<ProcurementReport>('procurementGetReport')

export const procurementInstructorSession = (args: InstructorSessionArgs) =>
  callFn<{ ok: boolean; customToken: string }>('procurementInstructorSession', args)

// ── Display helpers ─────────────────────────────────────────────────────────────

export const FORMAT_LABEL: Record<ProcurementFormat, string> = {
  sealed_first_price: 'Sealed-bid, first price',
  open_descending: 'Open-bid, descending',
}
