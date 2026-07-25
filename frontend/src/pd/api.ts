import { httpsCallable } from 'firebase/functions'
import { FirebaseError } from 'firebase/app'
import { functions } from '../firebase'

// PD's callable client. `functions` is the shared Firebase instance (one project
// serves every single-player game); only the callable NAMES are pd-specific.
//
// SLICE 2 — launch, instructor session, and the round loop. The report callable
// arrives in a later slice.
//
// ⚠ THE RESPONSE TYPES BELOW ARE THE WHOLE CLIENT-SIDE CONTRACT. There is no round
// count and no strategy in them because the server never sends either (spec §3, §5):
// the client cannot render, log, or infer from a field it never receives. Do not add
// a `rounds`, `roundsRemaining`, `total`, or `strategy` field here — if one ever
// appears in a response, that is a server bug, not a typing gap.

async function callFn<T>(name: string, data: object = {}): Promise<T> {
  const fn = httpsCallable<object, T>(functions, name)
  const result = await fn(data)
  return result.data
}

export const CLASSROOM_URL = import.meta.env.DEV
  ? 'http://localhost:5173'
  : 'https://classroom.mygames.live'

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

export const pdBootstrap = (args: StudentBootstrapArgs) =>
  callFn<StudentBootstrapResult>('pdBootstrap', args)

// ── Student: the round loop ─────────────────────────────────────────────────────

/** A move. C = Cooperate (stay silent), D = Defect (confess). */
export type Move = 'C' | 'D'

/** The four payoff values, in YEARS IN PRISON — losses, so lower is better. */
export type PdPayoffs = {
  both_cooperate: number
  sucker: number
  temptation: number
  both_defect: number
}

/** Display labels for the two moves (instructor-configurable, spec §2). */
export type PdMoveLabels = { C: string; D: string }

/** One PLAYED round, as the history table renders it. Cumulative totals are running
 *  sums over rounds played — never a fraction of a total the student cannot see. */
export type PdHistoryRow = {
  round: number
  studentMove: Move
  botMove: Move
  studentYears: number
  botYears: number
  studentTotal: number
  botTotal: number
}

export type PdStateResult = {
  ok: boolean
  labels: PdMoveLabels
  payoffs: PdPayoffs
  history: PdHistoryRow[]
  gameOver: boolean
}

export type PdRoundResult = {
  ok: boolean
  /** This round's outcome — exactly the four values the reveal shows. */
  round: { studentMove: Move; botMove: Move; studentYears: number; botYears: number }
  history: PdHistoryRow[]
  /** The ONLY thing the student learns about the schedule: it just ended, or it did
   *  not. Never how many rounds are left. */
  gameOver: boolean
}

/** Where am I? Also performs first-touch init server-side. */
export const pdGetState = () => callFn<PdStateResult>('pdGetState')

/** Play one round. `round` is the 1-based round the client believes it is on; the
 *  server verifies it and treats a resubmit for an already-played round as a no-op
 *  (submit-and-lock), so a double-click or a retry cannot burn a round. */
export const pdSubmitRound = (round: number, move: Move) =>
  callFn<PdRoundResult>('pdSubmitRound', { round, move })

// ── Student: knowledge check + debrief ──────────────────────────────────────────

/** One KC question as the client receives it — NO answer key. `correct_value` and
 *  `explanation` are stripped server-side; the explanation arrives only in the
 *  response to an answer, which is what makes it impossible to read ahead. */
export type PdKcQuestionClient = {
  field: string
  prompt: string
  options: { value: string; label: string }[]
}

export type PdDebriefQuestionClient = {
  field: string
  prompt: string
  placeholder: string
}

export type PdQuestionsResult = {
  ok: boolean
  kc: PdKcQuestionClient[]
  debrief: PdDebriefQuestionClient
  /** Fields already answered — drives KC resume (poll's findIndex pattern). */
  kcAnswered: string[]
  debriefSubmitted: boolean
}

/** The KC + debrief question set, plus what this student has already answered. */
export const pdGetQuestions = () => callFn<PdQuestionsResult>('pdGetQuestions')

/** Answer ONE KC question. Graded, but NOT a gate: a wrong answer is recorded and
 *  the student proceeds. The verdict and explanation come back post-answer. */
export const pdSubmitKcAnswer = (field: string, answer: string) =>
  callFn<{ ok: boolean; correct: boolean; explanation: string }>('pdSubmitKcAnswer', { field, answer })

/** Submit the debrief paragraph. Ungraded. */
export const pdSubmitDebrief = (answer: string) =>
  callFn<{ ok: boolean; stored: boolean; answer: string }>('pdSubmitDebrief', { answer })

// ── Instructor: roster, scoring, reports ────────────────────────────────────────
//
// ⚠ EVERYTHING BELOW IS INSTRUCTOR-ONLY and DOES carry the strategy and the round
// count. That is not a hole in the no-leak rule: these callables are
// instructor-authenticated server-side, no student screen imports them, and the
// student-facing types above still cannot express either value. Keep it that way —
// if a student component ever needs data from here, that is the bug.

export type PdStrategy = 'tft' | 'grim'

/** One roster row (Tier 1, Reports Contract). */
export type PdReportParticipant = {
  participant_id: string
  name: string | null
  launched: boolean
  completed: boolean
  rounds_played: number
  cooperation_rate: number | null
  avg_years: number | null
  student_years_total: number
  bot_years_total: number
  strategy: PdStrategy | null
  first_move: Move | null
  knowledge_check_score: number | null
  participation_score: number | null
  debrief: string | null
}

/** Tier 3a — one point per round, one value per strategy series. */
export type PdCooperationPoint = {
  round: number
  tft: number | null
  grim: number | null
  tftN: number
  grimN: number
}

/** Tier 3b — one bar per (first move × strategy). */
export type PdFirstMoveOutcome = {
  firstMove: Move
  strategy: PdStrategy
  avgYearsPerRound: number | null
  n: number
}

export type PdReportData = {
  ok: boolean
  scored: boolean
  /** The drawn round count — the cooperation chart's x-axis. Instructor-only. */
  roundCount: number
  payoffs: PdPayoffs
  labels: PdMoveLabels
  participants: PdReportParticipant[]
  charts: { cooperation: PdCooperationPoint[]; firstMove: PdFirstMoveOutcome[] }
  debriefPrompt: string
}

/** The roster + every report dataset, in one call. */
export const pdGetReport = () => callFn<PdReportData>('pdGetReport')

/** Participation scoring + the gradebook push. Re-runnable. */
export const pdScoreAndRecord = () =>
  callFn<{ ok: boolean; scored: number; finishers: number; names: Record<string, string | null>; push: { total: number; succeeded: number; failed: { participant_id: string; reason: string }[] } | null }>(
    'pdScoreAndRecord')

/** Pull the course roster so never-launched students appear (and can be graded −2). */
export const pdSyncRoster = () =>
  callFn<{ ok: boolean; synced: number; note?: string }>('pdSyncRoster')

// ── Instructor: session ─────────────────────────────────────────────────────────

export type InstructorSessionArgs =
  | { token: string }
  | { _dev: { game_instance_id: string } }

export const pdInstructorSession = (args: InstructorSessionArgs) =>
  callFn<{ ok: boolean; customToken: string }>('pdInstructorSession', args)
