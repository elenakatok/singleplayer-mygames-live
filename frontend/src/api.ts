import { httpsCallable } from 'firebase/functions'
import { FirebaseError } from 'firebase/app'
import { functions } from './firebase'

// ── Helper ────────────────────────────────────────────────────────────────────
// The Firebase SDK auto-attaches the ID-token Bearer when auth.currentUser exists
// (student after penniesBootstrap, instructor after penniesInstructorSession), and
// sends nothing during the bootstrap calls themselves.

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

export const penniesBootstrap = (args: StudentBootstrapArgs) =>
  callFn<StudentBootstrapResult>('penniesBootstrap', args)

// ── Student: play ─────────────────────────────────────────────────────────────

export type JarQuestion = {
  field: string
  type: 'number'
  prompt: string
  helper: string
  min: number
  order: number
}

export type GetScreenResult = {
  ok: boolean
  jar_image: string
  already_submitted: boolean
  questions: JarQuestion[]
}

export const penniesGetScreen = () => callFn<GetScreenResult>('penniesGetScreen', {})

export const penniesSubmit = (estimate: number, bid: number) =>
  callFn<{ ok: boolean }>('penniesSubmit', { estimate, bid })

// ── Instructor: session ─────────────────────────────────────────────────────────

export type InstructorSessionArgs =
  | { token: string }
  | { _dev: { game_instance_id: string } }

export const penniesInstructorSession = (args: InstructorSessionArgs) =>
  callFn<{ ok: boolean; customToken: string }>('penniesInstructorSession', args)

// ── Instructor: config / settings ───────────────────────────────────────────────

export type ConfigData = { ok: boolean; true_value: number; jar_image: string }

export const penniesGetConfig = () => callFn<ConfigData>('penniesGetConfig', {})

export const penniesUpdateConfig = (patch: { true_value?: number; jar_image?: string }) =>
  callFn<{ ok: boolean }>('penniesUpdateConfig', patch)

// ── Instructor: scoring + reports ─────────────────────────────────────────────

export type ScoreResult = {
  ok: boolean
  winner: string | null
  scored: number
  names: Record<string, string | null>
  push: { total: number; succeeded: number; failed: { participant_id: string; reason: string }[] } | null
}

export const penniesScoreAndRecord = () => callFn<ScoreResult>('penniesScoreAndRecord', {})

export type ReportParticipant = {
  participant_id: string
  name: string | null
  submitted: boolean
  estimate: number | null
  bid: number | null
  won: boolean | null
  profit: number | null
}

export type ReportData = {
  ok: boolean
  scored: boolean
  true_value: number
  participants: ReportParticipant[]
  stats: {
    responses: number
    avgEstimate: number | null
    avgBid: number | null
    winningBid: number | null
  }
}

export const penniesGetReport = () => callFn<ReportData>('penniesGetReport', {})
