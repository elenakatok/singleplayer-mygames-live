import { useEffect, useState } from 'react'
import { signInWithCustomToken, signOut, setPersistence, browserSessionPersistence } from 'firebase/auth'
import { auth } from '../firebase'
import { planInstructorSession, type InstructorSessionArgs } from './instructorSessionPlan'

// ═══════════════════════════════════════════════════════════════════════════════
// Instructor session bootstrap for the single-player family. The instructor lands on
// /dashboard, /settings, or /reports with ?token=<instructor JWT> (DEV: ?_gid=<id>),
// exchanges it ONCE — via the GAME'S session callable, passed in — for a Firebase
// custom token, and signs in. Subsequent instructor callables authenticate on the
// auto-attached Bearer id-token. Game-agnostic: pennies passes penniesInstructorSession,
// poll passes pollInstructorSession, etc.
//
// ⚠ "ONCE" IS LOAD-BEARING, AND USED NOT TO BE. This hook re-sent the classroom JWT
// on every mount, and every Dashboard → Settings → Reports navigation is a mount (the
// nav links carry ?token= forward). The JWT lives 15 minutes, so a quarter of an hour
// into a working session the next click threw `jwt expired` — while the Firebase
// session it had already established was still valid and still auto-refreshing.
//
// The resume guard below is transplanted from game-ui's InstructorDashboard, which the
// MULTIPLAYER family has always had; the two now behave identically. The decision
// itself lives in planInstructorSession() so it can be unit-tested — see that file for
// why the token is not consulted when a session already exists.
// ═══════════════════════════════════════════════════════════════════════════════

export type { InstructorSessionArgs }

/** The game's session-exchange callable: JWT/_dev → { customToken }. */
export type ExchangeSession = (args: InstructorSessionArgs) => Promise<{ customToken: string }>

export type InstructorSessionState =
  | { kind: 'loading' }
  | { kind: 'no-token' }
  | { kind: 'error'; message: string }
  | { kind: 'ready' }

/**
 * Mints and caches a real ID token before the session is called ready.
 *
 * ⚠ WHY THIS EXISTS — the "Missing token" flash. `signInWithCustomToken` resolving
 * means the USER is signed in; it does not mean the callables SDK has an ID token in
 * hand yet. The SDK picks the token up from the auth instance asynchronously, so a
 * callable fired in the same tick can go out with NO `Authorization: Bearer` header —
 * and every instructor callable ends at game-server's extractInstructorGameId, which
 * falls through to `data.token` and throws `invalid-argument: Missing token`. The
 * dashboard rendered that as a load error until something re-triggered the fetch, by
 * which time the token existed and the retry succeeded. Hence: an error that "fixes
 * itself on refresh".
 *
 * Awaiting getIdToken() makes `ready` mean what its consumers already assume — that an
 * authenticated call will carry credentials. It only ever ADDS a wait, so it cannot
 * break a flow that was already working.
 *
 * ⚠ IT WILL NOT REPRODUCE AGAINST THE EMULATOR. The race is latency-shaped: locally
 * the sign-in round trip is sub-millisecond and the token is always ready in time. That
 * is precisely why every harness stayed green while the live dashboard showed the
 * error, and why the fix is to remove the precondition gap rather than to chase a
 * failure the harness can observe.
 */
async function ensureIdToken(): Promise<void> {
  try {
    await auth.currentUser?.getIdToken()
  } catch {
    // A token we cannot mint here will fail loudly on the first real callable, with a
    // far better message than anything this helper could invent. Never block the page.
  }
}

export function useInstructorSession(exchange: ExchangeSession): InstructorSessionState {
  const [state, setState] = useState<InstructorSessionState>({ kind: 'loading' })

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const token = params.get('token')
    const devGid = import.meta.env.DEV ? params.get('_gid') : null
    // Appended by BOTH the classroom (SessionItemsSection) and the local launcher
    // (instructorDashboardUrl), so the expected uid never needs the token decoded.
    const urlGid = params.get('game_instance_id')
    // Opt-in per-tab session, set by the local launcher only. No-op when absent, so
    // production keeps the SDK default. Same handling as the multiplayer dashboard:
    // it keeps N student tabs in one browser from clobbering the dashboard's session,
    // which is also what lets the resume guard actually hit on a launcher re-mount.
    const tabSession = params.get('_session') === 'tab'
    let cancelled = false

    const run = async () => {
      try {
        // authStateReady() waits for the async persistence restore, so currentUser is
        // reliable before it is read. Without this the guard would miss on a reload
        // and fall straight back into the expired-token exchange.
        await auth.authStateReady()
        if (cancelled) return

        const plan = planInstructorSession({
          token,
          devGameInstanceId: devGid,
          urlGameInstanceId: urlGid,
          currentUid: auth.currentUser?.uid ?? null,
        })

        if (plan.action === 'no-token') { setState({ kind: 'no-token' }); return }

        if (plan.action === 'resume') {
          // The existing Firebase session IS the credential. The JWT is not read.
          await ensureIdToken()
          if (!cancelled) setState({ kind: 'ready' })
          return
        }

        if (plan.signOutFirst) {
          await signOut(auth)
          if (cancelled) return
        }
        const { customToken } = await exchange(plan.args)
        if (cancelled) return
        if (tabSession) await setPersistence(auth, browserSessionPersistence)
        await signInWithCustomToken(auth, customToken)
        await ensureIdToken()
        if (!cancelled) setState({ kind: 'ready' })
      } catch (err) {
        if (!cancelled) {
          setState({ kind: 'error', message: err instanceof Error ? err.message : 'Failed to start instructor session.' })
        }
      }
    }

    void run()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return state
}
