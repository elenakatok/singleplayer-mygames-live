import { useEffect, useState } from 'react'
import { signInWithCustomToken } from 'firebase/auth'
import { auth } from '../firebase'
import { penniesInstructorSession } from '../api'

// ═══════════════════════════════════════════════════════════════════════════════
// Instructor session bootstrap for the single-player family. The instructor lands on
// /dashboard, /settings, or /reports with ?token=<instructor JWT> (DEV: ?_gid=<id>),
// exchanges it once via penniesInstructorSession for a Firebase custom token, and
// signs in. Subsequent instructor callables authenticate on the auto-attached
// Bearer id-token. Mirrors eBay's inline bootstrap, extracted to one hook.
// ═══════════════════════════════════════════════════════════════════════════════

export type InstructorSessionState =
  | { kind: 'loading' }
  | { kind: 'no-token' }
  | { kind: 'error'; message: string }
  | { kind: 'ready' }

export function useInstructorSession(): InstructorSessionState {
  const [state, setState] = useState<InstructorSessionState>({ kind: 'loading' })

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const token = params.get('token')
    const devGid = import.meta.env.DEV ? params.get('_gid') : null
    let cancelled = false

    const run = async () => {
      if (!token && !devGid) {
        setState({ kind: 'no-token' })
        return
      }
      try {
        await auth.authStateReady()
        if (cancelled) return
        const args = token ? { token } : { _dev: { game_instance_id: devGid as string } }
        const { customToken } = await penniesInstructorSession(args)
        if (cancelled) return
        await signInWithCustomToken(auth, customToken)
        if (!cancelled) setState({ kind: 'ready' })
      } catch (err) {
        if (!cancelled) {
          setState({ kind: 'error', message: err instanceof Error ? err.message : 'Failed to start instructor session.' })
        }
      }
    }

    void run()
    return () => { cancelled = true }
  }, [])

  return state
}
