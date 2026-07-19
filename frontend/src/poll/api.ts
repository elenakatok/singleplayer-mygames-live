import { httpsCallable } from 'firebase/functions'
import { FirebaseError } from 'firebase/app'
import { functions } from '../firebase'

// Poll's callable client. `functions` is the shared Firebase instance (one project
// serves every single-player game); only the callable NAMES are poll-specific.

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

export const pollBootstrap = (args: StudentBootstrapArgs) =>
  callFn<StudentBootstrapResult>('pollBootstrap', args)

// ── Student: questions ──────────────────────────────────────────────────────────

export type PollOption = { value: string; label: string }
export type PollQuestionClient = {
  id: string
  type: 'text' | 'mc'
  prompt: string
  options: PollOption[] | null
}

export type GetQuestionsResult = {
  ok: boolean
  questions: PollQuestionClient[]
  answered: string[]
}

export const pollGetQuestions = () => callFn<GetQuestionsResult>('pollGetQuestions', {})

export const pollSubmitAnswer = (questionId: string, value: string) =>
  callFn<{ ok: boolean; stored: boolean; value: string }>('pollSubmitAnswer', { question_id: questionId, value })

// ── Instructor: session ─────────────────────────────────────────────────────────

export type InstructorSessionArgs =
  | { token: string }
  | { _dev: { game_instance_id: string } }

export const pollInstructorSession = (args: InstructorSessionArgs) =>
  callFn<{ ok: boolean; customToken: string }>('pollInstructorSession', args)

// ── Instructor: config / settings ───────────────────────────────────────────────

export type PollQuestionFull = {
  id: string
  type: 'text' | 'mc'
  prompt: string
  visible: boolean
  order: number
  system: boolean
  options?: PollOption[]
}

export const pollGetConfig = () => callFn<{ ok: boolean; questions: PollQuestionFull[] }>('pollGetConfig', {})

export const pollUpdateConfig = (questions: PollQuestionFull[]) =>
  callFn<{ ok: boolean; questions: PollQuestionFull[] }>('pollUpdateConfig', { questions })

export const pollSyncRoster = () =>
  callFn<{ ok: boolean; synced?: number; note?: string }>('pollSyncRoster', {})

// ── Instructor: reports ─────────────────────────────────────────────────────────

export type TextAnswerRow = { participant_id: string; name: string | null; value: string }
export type TextReport = { id: string; type: 'text'; prompt: string; answers: TextAnswerRow[] }
export type McSlice = { value: string; label: string; count: number }
export type McReport = { id: string; type: 'mc'; prompt: string; total: number; slices: McSlice[] }
export type QuestionReport = TextReport | McReport

export type ResponseRow = {
  participant_id: string
  name: string | null
  answered: number
  total: number
  completed: boolean
}

export type PollReportData = {
  ok: boolean
  reports: QuestionReport[]
  responseStatus: ResponseRow[]
  totalParticipants: number
}

export const pollGetReport = () => callFn<PollReportData>('pollGetReport', {})
