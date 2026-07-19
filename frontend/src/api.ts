import { httpsCallable } from 'firebase/functions'
import { FirebaseError } from 'firebase/app'
import { functions } from './firebase'

// ── Helper ────────────────────────────────────────────────────────────────────
// Single wrapper: the Firebase SDK auto-attaches the ID-token Bearer when
// auth.currentUser exists, and sends nothing when there is no session — covering
// both bootstrap (penniesBootstrap) and, in Part 2, the authed student calls.

async function callFn<T>(name: string, data: object = {}): Promise<T> {
  const fn = httpsCallable<object, T>(functions, name)
  const result = await fn(data)
  return result.data
}

// ── Bootstrap args (mirrors BootstrapArgs in game-ui's useStudentSession) ──────

export type TestArgs  = { _test: { participant_id: string; game_instance_id: string } }
export type TokenArgs = { token: string }
export type BootstrapArgs = TestArgs | TokenArgs

export type BootstrapResult = {
  ok:               boolean
  participant_id:   string
  game_instance_id: string
  customToken:      string
}

/**
 * Launch / session exchange for Jar of Pennies. No session yet — the classroom JWT
 * (or the _test emulator bypass) travels in `data`; the SDK attaches nothing.
 */
export const penniesBootstrap = (args: BootstrapArgs) =>
  callFn<BootstrapResult>('penniesBootstrap', args)

export const CLASSROOM_URL = import.meta.env.DEV
  ? 'http://localhost:5173'
  : 'https://classroom.mygames.live'

// onCall auth errors arrive as FirebaseError with these codes, not HTTP statuses.
export function isAuthError(err: unknown): boolean {
  if (!(err instanceof FirebaseError)) return false
  return (
    err.code === 'functions/permission-denied' ||
    err.code === 'functions/unauthenticated'
  )
}
