import { useEffect, useState } from 'react'
import { auth } from '../firebase'
import {
  pdBootstrap, pdGetState, CLASSROOM_URL,
  type PdHistoryRow, type PdMoveLabels, type PdPayoffs, type PdRoundResult,
} from './api'
import { PageShell } from '../shared/PageShell'
import { SequenceRunner, loopScreen } from '../shared/sequence'
import { ChooseRound, RevealRound } from './RoundScreen'
import { HistoryTable } from './HistoryTable'
import { useStudentSession, typography, colors } from '@mygames/game-ui'
import type { BootstrapArgs } from '@mygames/game-ui'

// ═══════════════════════════════════════════════════════════════════════════════
// Repeated Prisoner's Dilemma — student entry (spec §4, the round loop).
//
// Launch (pdBootstrap) → pdGetState → the loop → the end screen.
//
// RESUME (self-paced; close and come back anytime): the loop's starting iteration is
// simply HOW MANY ROUNDS ARE ALREADY STORED — `history.length`, straight from
// pdGetState. It is the loop's analogue of Poll's findIndex-the-first-unanswered:
// n rounds played ⇒ iteration n ⇒ round n+1, and the history table comes back
// populated. Nothing is kept in the browser between visits; the server's record of
// played rounds IS the resume point, so a different device resumes identically.
//
// The loop ENDS ON THE SERVER'S WORD (`gameOver`), never on a count held here — the
// round count must never reach this bundle (spec §3). A student who returns after
// finishing skips the loop entirely and lands on the end screen.
//
// SLICE 2 ends at "the game is over" + the final history. The debrief question and
// the knowledge check arrive in Slice 3.
// ═══════════════════════════════════════════════════════════════════════════════

type Screen =
  | { name: 'loading' }
  | { name: 'error'; message: string }
  | { name: 'playing'; startIteration: number }
  | { name: 'over' }

function EndScreen({ history, labels }: { history: PdHistoryRow[]; labels: PdMoveLabels }) {
  const last = history[history.length - 1]
  return (
    <div>
      <h1 data-testid="pd-game-over" style={{ marginTop: 0, fontSize: '1.6rem', color: colors.text }}>
        The game is over
      </h1>
      <p style={{ lineHeight: 1.6, color: colors.text }}>
        That was the last round. You played <strong>{history.length}</strong> round{history.length === 1 ? '' : 's'} and
        served a total of <strong>{last ? last.studentTotal : 0}</strong> year
        {last && last.studentTotal === 1 ? '' : 's'} in prison; the other player served{' '}
        <strong>{last ? last.botTotal : 0}</strong>.
      </p>
      <p style={{ lineHeight: 1.6, color: colors.text }}>
        Your full record is below. You can close this tab.
      </p>
      <div style={{ marginTop: '1.25rem' }}>
        <HistoryTable history={history} labels={labels} />
      </div>
    </div>
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
      const r = await pdBootstrap(args)
      return {
        participantId: r.participant_id,
        gameInstanceId: r.game_instance_id,
        customToken: r.customToken,
      }
    },
  })

  const [screen, setScreen] = useState<Screen>({ name: 'loading' })
  // The running history + the instance's settings, held here because BOTH loop phases
  // and the end screen render them. Seeded by pdGetState, then advanced by each
  // round's response — the server returns the whole history every time, so this can
  // never drift from the record and is replaced wholesale rather than appended to.
  const [history, setHistory] = useState<PdHistoryRow[]>([])
  const [labels, setLabels] = useState<PdMoveLabels>({ C: 'Cooperate', D: 'Defect' })
  const [payoffs, setPayoffs] = useState<PdPayoffs | null>(null)

  useEffect(() => {
    if (session.kind !== 'ready') return
    let cancelled = false
    pdGetState()
      .then(res => {
        if (cancelled) return
        setLabels(res.labels)
        setPayoffs(res.payoffs)
        setHistory(res.history)
        // Resume: n rounds stored ⇒ start the loop at iteration n (⇒ round n+1).
        if (res.gameOver) setScreen({ name: 'over' })
        else setScreen({ name: 'playing', startIteration: res.history.length })
      })
      .catch(err => {
        if (!cancelled) {
          setScreen({ name: 'error', message: err instanceof Error ? err.message : 'Failed to load the game.' })
        }
      })
    return () => { cancelled = true }
  }, [session])

  if (session.kind === 'loading') {
    return <main style={{ padding: '2rem', fontFamily: typography.fontFamily }}><p>Loading…</p></main>
  }
  if (session.kind === 'no-token') {
    return (
      <main style={{ padding: '2rem', fontFamily: typography.fontFamily, maxWidth: '480px', margin: '2rem auto' }}>
        <h2 style={{ marginBottom: '0.75rem' }}>Repeated Prisoner&rsquo;s Dilemma</h2>
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

  if (screen.name === 'error') return <PageShell><p style={{ color: '#c00' }}>{screen.message}</p></PageShell>
  if (screen.name === 'over') return <PageShell><EndScreen history={history} labels={labels} /></PageShell>

  if (screen.name === 'playing' && payoffs !== null) {
    return (
      <PageShell>
        <SequenceRunner
          screens={[
            loopScreen<PdRoundResult>({
              id: 'pd-rounds',
              startIteration: screen.startIteration,
              ask: ({ iteration, onResult }) => (
                <ChooseRound
                  // Iteration 0 is round 1.
                  roundNumber={iteration + 1}
                  labels={labels}
                  payoffs={payoffs}
                  history={history}
                  onResult={(res, done) => { setHistory(res.history); onResult(res, done) }}
                />
              ),
              display: ({ iteration, result, onContinue }) => (
                <RevealRound
                  roundNumber={iteration + 1}
                  result={result}
                  labels={labels}
                  payoffs={payoffs}
                  onContinue={onContinue}
                />
              ),
            }),
          ]}
          onAllComplete={() => setScreen({ name: 'over' })}
        />
      </PageShell>
    )
  }

  return <main style={{ padding: '2rem', fontFamily: typography.fontFamily }}><p>Loading…</p></main>
}
