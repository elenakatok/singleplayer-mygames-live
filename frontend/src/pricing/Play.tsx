import { auth } from '../firebase'
import { pricingBootstrap, CLASSROOM_URL } from './api'
import { PageShell } from '../shared/PageShell'
import { useStudentSession, typography, colors } from '@mygames/game-ui'
import type { BootstrapArgs } from '@mygames/game-ui'

// ═══════════════════════════════════════════════════════════════════════════════
// Pricing Game (Cheyenne Shipping) — student entry.
//
// SLICE 0 (SCAFFOLD): launch only. The student exchanges the classroom JWT for a
// Firebase session via pricingBootstrap (useStudentSession, exactly as pennies,
// poll, and pd do) and lands on the game shell. There is deliberately NO game here
// yet — the knowledge check, the price-entry screen, the compute step, and the
// history table arrive in later slices. This route exists now to prove the whole
// path serves: classroom launch → pricing.mygames.live → bootstrap →
// authenticated session → shell.
//
// Copy rule (spec §1), in force from the first line of student-facing text: the
// opponent is always "your competitor", NEVER "the bot".
// ═══════════════════════════════════════════════════════════════════════════════

function Scaffold() {
  return (
    <PageShell>
      <h1 style={{ marginTop: 0, fontSize: '1.6rem', color: colors.text }}>
        Cheyenne Shipping
      </h1>
      <p style={{ lineHeight: 1.6, color: colors.text }}>
        You are connected. The game is not open yet — your instructor will tell you
        when to play. You can close this tab.
      </p>
    </PageShell>
  )
}

export default function Play() {
  const params = new URLSearchParams(window.location.search)
  const token = params.get('token')
  const testPid = import.meta.env.DEV ? params.get('_pid') : null
  const testGid = import.meta.env.DEV ? params.get('_gid') : null

  const session = useStudentSession({
    auth,
    token,
    testIds: (testPid && testGid) ? { participantId: testPid, gameInstanceId: testGid } : null,
    bootstrap: async (args: BootstrapArgs) => {
      const r = await pricingBootstrap(args)
      return {
        participantId: r.participant_id,
        gameInstanceId: r.game_instance_id,
        customToken: r.customToken,
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
        <h2 style={{ marginBottom: '0.75rem' }}>Cheyenne Shipping</h2>
        <p>Please launch this game from the classroom to begin.</p>
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

  // session.kind === 'ready'
  return <Scaffold />
}
