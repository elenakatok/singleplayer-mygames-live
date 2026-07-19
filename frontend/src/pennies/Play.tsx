import { auth } from '../firebase'
import { penniesBootstrap, CLASSROOM_URL } from '../api'
import { PageShell } from '../shared/PageShell'
import { SequenceRunner } from '../shared/sequence'
import { penniesScreens } from './screens'
import { useStudentSession, typography } from '@mygames/game-ui'
import type { BootstrapArgs } from '@mygames/game-ui'

// ═══════════════════════════════════════════════════════════════════════════════
// Jar of Pennies — student entry. Reuses the family's launch (penniesBootstrap) via
// the shared useStudentSession hook: the student arrives with a classroom JWT and
// exchanges it once for a persistent Firebase session. When the session is 'ready',
// the SequenceRunner walks this game's screen list.
//
// No KC, no gate, no role selection, no attendance code, no matching, no waiting
// room — none of those exist in this family. Launch → screens. That is the flow.
// ═══════════════════════════════════════════════════════════════════════════════

export default function Play() {
  const params  = new URLSearchParams(window.location.search)
  const token   = params.get('token')
  const testPid = import.meta.env.DEV ? params.get('_pid') : null
  const testGid = import.meta.env.DEV ? params.get('_gid') : null

  const session = useStudentSession({
    auth,
    token,
    testIds: (testPid && testGid) ? { participantId: testPid, gameInstanceId: testGid } : null,
    bootstrap: async (args: BootstrapArgs) => {
      const r = await penniesBootstrap(args)
      return {
        participantId:  r.participant_id,
        gameInstanceId: r.game_instance_id,
        customToken:    r.customToken,
      }
    },
  })

  if (session.kind === 'loading') {
    return (
      <main style={{ padding: '2rem', fontFamily: typography.fontFamily }}>
        <p>Loading…</p>
      </main>
    )
  }

  if (session.kind === 'no-token') {
    return (
      <main style={{ padding: '2rem', fontFamily: typography.fontFamily, maxWidth: '480px', margin: '2rem auto' }}>
        <h2 style={{ marginBottom: '0.75rem' }}>Jar of Pennies</h2>
        <p>Please launch Jar of Pennies from the classroom to begin.</p>
        <p style={{ marginTop: '1.5rem' }}><a href={CLASSROOM_URL}>← Go to classroom</a></p>
      </main>
    )
  }

  if (session.kind === 'error') {
    return (
      <main style={{ padding: '2rem', fontFamily: typography.fontFamily }}>
        <p style={{ color: '#c00' }}>{session.message}</p>
        <p><a href={CLASSROOM_URL}>← Return to classroom</a></p>
      </main>
    )
  }

  // session.kind === 'ready' — walk the screen sequence.
  return (
    <PageShell>
      <SequenceRunner screens={penniesScreens} />
    </PageShell>
  )
}
