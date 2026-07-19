import { useEffect, useState } from 'react'
import { auth } from '../firebase'
import { pollBootstrap, pollGetQuestions, CLASSROOM_URL, type PollQuestionClient } from './api'
import { PageShell } from '../shared/PageShell'
import { SequenceRunner } from '../shared/sequence'
import { QuestionScreen } from './QuestionScreen'
import { useStudentSession, typography, colors } from '@mygames/game-ui'
import type { BootstrapArgs } from '@mygames/game-ui'

// ═══════════════════════════════════════════════════════════════════════════════
// Poll — student entry. Launch (pollBootstrap), fetch the VISIBLE questions + which
// the caller already answered, and walk them one per screen. RESUME (spec §5.3): a
// student who closed the browser mid-poll lands on the first visible question with no
// answer; if all are answered they land on the confirmation. No grading, no gate.
// ═══════════════════════════════════════════════════════════════════════════════

type Screen =
  | { name: 'loading' }
  | { name: 'error'; message: string }
  | { name: 'questions'; questions: PollQuestionClient[]; startIndex: number }
  | { name: 'confirmation' }

function Confirmation() {
  return (
    <PageShell>
      <h1 style={{ marginTop: 0, fontSize: '1.6rem', color: colors.text }}>Thanks</h1>
      <p style={{ lineHeight: 1.6, color: colors.text }}>
        Your responses have been recorded. You can close this tab.
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
      const r = await pollBootstrap(args)
      return { participantId: r.participant_id, gameInstanceId: r.game_instance_id, customToken: r.customToken }
    },
  })

  const [screen, setScreen] = useState<Screen>({ name: 'loading' })

  useEffect(() => {
    if (session.kind !== 'ready') return
    let cancelled = false
    pollGetQuestions()
      .then(res => {
        if (cancelled) return
        const { questions, answered } = res
        const answeredSet = new Set(answered)
        const firstUnanswered = questions.findIndex(q => !answeredSet.has(q.id))
        if (questions.length === 0 || firstUnanswered === -1) setScreen({ name: 'confirmation' })
        else setScreen({ name: 'questions', questions, startIndex: firstUnanswered })
      })
      .catch(err => {
        if (!cancelled) setScreen({ name: 'error', message: err instanceof Error ? err.message : 'Failed to load the poll.' })
      })
    return () => { cancelled = true }
  }, [session])

  if (session.kind === 'loading') {
    return <main style={{ padding: '2rem', fontFamily: typography.fontFamily }}><p>Loading…</p></main>
  }
  if (session.kind === 'no-token') {
    return (
      <main style={{ padding: '2rem', fontFamily: typography.fontFamily, maxWidth: '480px', margin: '2rem auto' }}>
        <h2 style={{ marginBottom: '0.75rem' }}>Poll</h2>
        <p>Please launch this poll from the classroom to begin.</p>
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

  if (screen.name === 'confirmation') return <Confirmation />
  if (screen.name === 'error') return <PageShell><p style={{ color: '#c00' }}>{screen.message}</p></PageShell>

  if (screen.name === 'questions') {
    const { questions } = screen
    return (
      <PageShell>
        <SequenceRunner
          startIndex={screen.startIndex}
          screens={questions.map((q, i) => ({
            id: q.id,
            render: ({ onDone }) => <QuestionScreen question={q} index={i} total={questions.length} onDone={onDone} />,
          }))}
          onAllComplete={() => setScreen({ name: 'confirmation' })}
        />
      </PageShell>
    )
  }

  return <main style={{ padding: '2rem', fontFamily: typography.fontFamily }}><p>Loading…</p></main>
}
