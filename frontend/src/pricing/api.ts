import { httpsCallable } from 'firebase/functions'
import { FirebaseError } from 'firebase/app'
import { functions } from '../firebase'

// The Pricing Game's callable client. `functions` is the shared Firebase instance
// (one project serves every single-player game); only the callable NAMES are
// pricing-specific.
//
// SLICE 3 — launch, instructor session, the round loop, the knowledge check and
// the debrief.
//
// ⚠ THE RESPONSE TYPES BELOW ARE THE WHOLE CLIENT-SIDE CONTRACT. There is no round
// count and no competitor rule in them because the server never sends either
// (spec §4, §5): the client cannot render, log, or infer from a field it never
// receives. Do not add a `rounds`, `roundsRemaining`, `total`, or `strategy` field
// here — if one ever appears in a response, that is a server bug, not a typing gap.

async function callFn<T>(name: string, data: object = {}): Promise<T> {
  const fn = httpsCallable<object, T>(functions, name)
  const result = await fn(data)
  return result.data
}

/** The classroom root — the INSTRUCTOR view (behind RequireAuth). Use this only on
 *  instructor screens. */
export const CLASSROOM_URL = import.meta.env.DEV
  ? 'http://localhost:5173'
  : 'https://classroom.mygames.live'

/** Where a STUDENT goes when their session fails — the student login/portal, never
 *  the instructor courses page (which is behind RequireAuth and would strand them). */
export const STUDENT_CLASSROOM_URL = `${CLASSROOM_URL}/student`

export function isAuthError(err: unknown): boolean {
  if (!(err instanceof FirebaseError)) return false
  return err.code === 'functions/permission-denied' || err.code === 'functions/unauthenticated'
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

export const pricingBootstrap = (args: StudentBootstrapArgs) =>
  callFn<StudentBootstrapResult>('pricingBootstrap', args)

// ── Student: the round loop ─────────────────────────────────────────────────────

/** The two firms' names (instructor-configurable, spec §3). `competitor` is the
 *  FIRM's name; student-facing prose calls the opponent "your competitor" (spec §1). */
export type PricingLabels = { student: string; competitor: string }

/** The market the student prices in (spec §2/§4). Every field is printed on the
 *  price-entry screen — including the competitor's base share and unit cost, which
 *  the case gives students. */
export type PricingMarket = {
  marketSize: number
  studentBaseShare: number
  competitorBaseShare: number
  studentUnitCost: number
  competitorUnitCost: number
  slope: number
  minPrice: number
  maxPrice: number
}

/** One PLAYED round, as the history table renders it. `yourTotal` / `yourAverage`
 *  are running values over rounds PLAYED — never a fraction of a total the student
 *  cannot see. */
export type PricingHistoryRow = {
  round: number
  yourPrice: number
  competitorPrice: number
  /** PMG only — the single price every customer paid. null under Standard, where
   *  each firm's customers pay that firm's posted price (spec §6.4). */
  effectivePrice: number | null
  yourShare: number
  competitorShare: number
  yourDemand: number
  competitorDemand: number
  yourProfit: number
  competitorProfit: number
  yourTotal: number
  yourAverage: number
}

/** This round's outcome — what the round-results screen shows (spec §4). */
export type PricingRoundOutcome = {
  round: number
  yourPrice: number
  competitorPrice: number
  effectivePrice: number | null
  yourShare: number
  competitorShare: number
  yourDemand: number
  competitorDemand: number
  yourProfit: number
  competitorProfit: number
}

/**
 * Where the student is in the flow.
 *
 * 'play'    — the round loop is open.
 * 'debrief' — their drawn horizon has been reached; the game is over (spec §9).
 *
 * ⚠ It is a PHASE, not a position: it says the game ended, never how long it was.
 */
export type PricingPhase = 'play' | 'debrief'

export type PricingStateResult = {
  ok: boolean
  /** Are the Price Matching Guarantee rules in force (spec §6)? */
  pmg: boolean
  labels: PricingLabels
  market: PricingMarket
  /** The round-count RANGE — the ONLY thing about the schedule a student may be told
   *  (spec §3). The drawn count is server-side truth and is in no response. */
  minRounds: number
  maxRounds: number
  history: PricingHistoryRow[]
  totalProfit: number
  averageProfit: number
  phase: PricingPhase
  gameOver: boolean
}

export type PricingRoundResult = {
  ok: boolean
  round: PricingRoundOutcome
  history: PricingHistoryRow[]
  totalProfit: number
  averageProfit: number
  phase: PricingPhase
  gameOver: boolean
}

export const pricingGetState = () => callFn<PricingStateResult>('pricingGetState')

/** Submit one round's posted price. `price` is a whole dollar inside the instance's
 *  bounds; the server validates it again and rejects anything else. */
export const pricingSubmitPrice = (round: number, price: number) =>
  callFn<PricingRoundResult>('pricingSubmitPrice', { round, price })

// ── Student: the knowledge check + the debrief ──────────────────────────────────

/** One KC question as the student receives it — NO answer key, NO explanation.
 *  Both are earned by answering (pricingSubmitKcAnswer returns the explanation). */
export type PricingKcQuestionClient = {
  field: string
  prompt: string
  options: { value: string; label: string }[]
}

export type PricingDebriefQuestionClient = {
  field: string
  /** The MODE's prompt (spec §9), or the instructor's edit of it. */
  prompt: string
  placeholder: string
}

export type PricingQuestionsResult = {
  ok: boolean
  kcEnabled: boolean
  /** Does this instance open with the PMG rules screen (spec §6.2)? */
  pmg: boolean
  kc: PricingKcQuestionClient[]
  debriefEnabled: boolean
  debrief: PricingDebriefQuestionClient | null
  kcAnswered: string[]
  debriefSubmitted: boolean
  /**
   * "Your competitor was programmed to …" (spec §9).
   *
   * ⚠ NULL UNTIL THE GAME IS OVER. The server gates this on `finished_at`, so there
   * is no moment at which a mid-game client holds it. Do not cache it, and do not
   * try to reconstruct it here — the client never receives the rule id at all.
   */
  competitorReveal: string | null
}

export const pricingGetQuestions = () => callFn<PricingQuestionsResult>('pricingGetQuestions')

export type PricingKcAnswerResult = {
  ok: boolean
  correct: boolean
  graded: boolean
  /** Earned by answering — this is the ONLY path that returns it. */
  explanation: string
}

export const pricingSubmitKcAnswer = (field: string, answer: string) =>
  callFn<PricingKcAnswerResult>('pricingSubmitKcAnswer', { field, answer })

export const pricingSubmitDebrief = (answer: string) =>
  callFn<{ ok: boolean; stored: boolean; answer: string }>('pricingSubmitDebrief', { answer })

// ── Instructor: session ─────────────────────────────────────────────────────────

export type InstructorSessionArgs =
  | { token: string }
  | { _dev: { game_instance_id: string } }

export const pricingInstructorSession = (args: InstructorSessionArgs) =>
  callFn<{ ok: boolean; customToken: string }>('pricingInstructorSession', args)
