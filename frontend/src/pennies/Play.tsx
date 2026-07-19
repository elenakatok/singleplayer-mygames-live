import { useEffect, useState } from 'react'
import { auth } from '../firebase'
import { penniesBootstrap, penniesGetScreen, CLASSROOM_URL, type JarQuestion } from '../api'
import { PageShell } from '../shared/PageShell'
import { SequenceRunner } from '../shared/sequence'
import { JarScreen } from './JarScreen'
import { useStudentSession, typography, colors } from '@mygames/game-ui'
import type { BootstrapArgs } from '@mygames/game-ui'

// ═══════════════════════════════════════════════════════════════════════════════
// Jar of Pennies — student entry. Launch (penniesBootstrap via useStudentSession),
// then fetch the screen. A returning student who already submitted lands on the
// confirmation, not the form (the one-shot lock, spec §3.3). No KC, gate, role,
// attendance code, or matching — launch → screen → submit → done.
// ═══════════════════════════════════════════════════════════════════════════════

type Screen =
  | { name: 'loading' }
  | { name: 'error'; message: string }
  | { name: 'form'; jarImage: string; questions: JarQuestion[] }
  | { name: 'confirmation' }

function Confirmation() {
  return (
    <PageShell>
      <h1 style={{ marginTop: 0, fontSize: '1.6rem', color: colors.text }}>Thank you</h1>
      <p style={{ lineHeight: 1.6, color: colors.text }}>
        Your estimate and bid have been recorded. You can close this tab.
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
      const r = await penniesBootstrap(args)
      return {
        participantId: r.participant_id,
        gameInstanceId: r.game_instance_id,
        customToken: r.customToken,
      }
    },
  })

  const [screen, setScreen] = useState<Screen>({ name: 'loading' })

  useEffect(() => {
    if (session.kind !== 'ready') return
    let cancelled = false
    penniesGetScreen()
      .then(res => {
        if (cancelled) return
        if (res.already_submitted) setScreen({ name: 'confirmation' })
        else setScreen({ name: 'form', jarImage: res.jar_image, questions: res.questions })
      })
      .catch(err => {
        if (!cancelled) setScreen({ name: 'error', message: err instanceof Error ? err.message : 'Failed to load the game.' })
      })
    return () => { cancelled = true }
  }, [session])

  // ── Pre-session states ────────────────────────────────────────────────────

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

  // ── session.kind === 'ready' ──────────────────────────────────────────────

  if (screen.name === 'confirmation') return <Confirmation />

  if (screen.name === 'error') {
    return (
      <PageShell>
        <p style={{ color: '#c00' }}>{screen.message}</p>
      </PageShell>
    )
  }

  if (screen.name === 'form') {
    return (
      <PageShell>
        <SequenceRunner
          screens={[
            {
              id: 'jar',
              render: ({ onDone }) => (
                <JarScreen jarImage={screen.jarImage} questions={screen.questions} onDone={onDone} />
              ),
            },
          ]}
          onAllComplete={() => setScreen({ name: 'confirmation' })}
        />
      </PageShell>
    )
  }

  // screen.name === 'loading'
  return (
    <main style={{ padding: '2rem', fontFamily: typography.fontFamily }}>
      <p>Loading…</p>
    </main>
  )
}
