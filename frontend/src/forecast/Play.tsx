import { useEffect, useState } from 'react'
import { auth } from '../firebase'
import {
  forecastBootstrap, forecastGetState, STUDENT_CLASSROOM_URL,
  type ForecastHistoryPoint, type ForecastParams, type ForecastPlayedRow,
  type ForecastRoundResult, type ForecastRunning, type ForecastYears,
} from './api'
import { PageShell } from '../shared/PageShell'
import { SequenceRunner, loopScreen, type SequenceScreen } from '../shared/sequence'
import { EnterForecast, MonthResults } from './ForecastScreen'
import { EndScreen } from './EndScreen'
import { forecastResumeIndex, forecastScreenCount, forecastStartIteration } from './resume'
import { useStudentSession, typography } from '@mygames/game-ui'
import type { BootstrapArgs } from '@mygames/game-ui'

// ═══════════════════════════════════════════════════════════════════════════════
// Forecasting — student entry. The flow (spec §4):
//
//   KC  →  the month loop  →  final results  →  debrief  →  done
//  (graded,  (forecast →       (spec §5)        (free text,
//   no gate)  compute →                          reveals the
//             results, ×N)                       process — §9)
//
// ⚠ SLICE 2 BUILDS THE LOOP AND THE FINAL SCREEN. The KC and the debrief are Slice 3;
// their screens slot into the positions the sequence below already reserves for them,
// and `resume.ts` already counts them — so adding them is a change to this file's
// screen list, not to the resume arithmetic.
//
// ⚠ THE HORIZON IS SHOWN, unlike PD and pricing (spec §4, §15). `params.rounds` is
// public config here; there is no hidden round count to keep out of the bundle, so the
// loop's screens can say "month 4 of 24" freely. What IS kept out is the model — see
// api.ts.
//
// RESUME, one rule for the whole flow: every step's completion is a fact stored on the
// server, so `startIndex` is just "how many steps are already done". Nothing is kept in
// the browser; a student resumes identically on another device. The arithmetic lives in
// resume.ts and is unit-tested, because an off-by-one here puts a student back onto a
// month the server has already locked.
// ═══════════════════════════════════════════════════════════════════════════════

type Loaded = {
  params: ForecastParams
  history: ForecastHistoryPoint[]
}

type Screen =
  | { name: 'loading' }
  | { name: 'error'; message: string }
  | { name: 'flow'; startIndex: number; startIteration: number }
  | { name: 'done' }

export default function Play() {
  const search = new URLSearchParams(window.location.search)
  const token = search.get('token')
  const testPid = import.meta.env.DEV ? search.get('_pid') : null
  const testGid = import.meta.env.DEV ? search.get('_gid') : null

  const session = useStudentSession({
    auth,
    token,
    testIds: (testPid && testGid) ? { participantId: testPid, gameInstanceId: testGid } : null,
    bootstrap: async (args: BootstrapArgs) => {
      const r = await forecastBootstrap(args)
      return {
        participantId: r.participant_id,
        gameInstanceId: r.game_instance_id,
        customToken: r.customToken,
      }
    },
  })

  const [screen, setScreen] = useState<Screen>({ name: 'loading' })
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  // The running position: seeded by forecastGetState, then replaced wholesale by each
  // month's response (the server returns the entire history and scorecard every time,
  // so this cannot drift).
  const [played, setPlayed] = useState<ForecastPlayedRow[]>([])
  const [running, setRunning] = useState<ForecastRunning>({
    n: 0, mae: 0, mse: 0, standardError: 0,
    mape: null, mapeN: 0, accuracy: null, bonus: null, meanError: 0,
  })
  const [years, setYears] = useState<ForecastYears>({ first: null, second: null, improved: null })

  useEffect(() => {
    if (session.kind !== 'ready') return
    let cancelled = false
    forecastGetState()
      .then(state => {
        if (cancelled) return
        setLoaded({ params: state.params, history: state.history })
        setPlayed(state.played)
        setRunning(state.running)
        setYears(state.years)

        // Slice 2: no KC and no debrief screens yet, so both counts are zero/false.
        // Slice 3 passes the real numbers; the arithmetic does not change.
        const kcCount = 0
        const debriefEnabled = false
        const start = forecastResumeIndex({
          gameOver: state.gameOver,
          kcCount,
          kcAnswered: 0,
          debriefEnabled,
          debriefSubmitted: false,
        })
        if (start >= forecastScreenCount(kcCount, debriefEnabled)) {
          setScreen({ name: 'done' })
        } else {
          setScreen({
            name: 'flow',
            startIndex: start,
            startIteration: forecastStartIteration(state.roundsPlayed),
          })
        }
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
        <h2 style={{ marginBottom: '0.75rem' }}>The Forecasting Game</h2>
        <p>Please launch this game from the classroom to begin.</p>
        <p style={{ marginTop: '1.5rem' }}><a href={STUDENT_CLASSROOM_URL}>← Go to my classroom</a></p>
      </main>
    )
  }
  if (session.kind === 'error') {
    return (
      <main style={{ padding: '2rem', fontFamily: typography.fontFamily }}>
        <p style={{ color: '#c00' }}>{session.message}</p>
        <p><a href={STUDENT_CLASSROOM_URL}>← Return to my classroom</a></p>
      </main>
    )
  }

  if (screen.name === 'error') return <PageShell><p style={{ color: '#c00' }}>{screen.message}</p></PageShell>

  if (screen.name === 'done' && loaded !== null) {
    return (
      <PageShell>
        <EndScreen
          params={loaded.params}
          history={loaded.history}
          played={played}
          running={running}
          years={years}
        />
      </PageShell>
    )
  }

  if (screen.name === 'flow' && loaded !== null) {
    const { params, history } = loaded

    const screens: SequenceScreen[] = [
      // ── The month loop: forecast → results, repeated to the configured N ─────
      loopScreen<ForecastRoundResult>({
        id: 'forecast-months',
        startIteration: screen.startIteration,
        ask: ({ iteration, onResult }) => (
          <EnterForecast
            roundNumber={iteration + 1}
            params={params}
            history={history}
            played={played}
            onResult={(res, done) => {
              setPlayed(res.history)
              setRunning(res.running)
              setYears(res.years)
              onResult(res, done)
            }}
          />
        ),
        display: ({ result, onContinue }) => (
          <MonthResults
            result={result}
            params={params}
            history={history}
            onContinue={onContinue}
          />
        ),
      }),

      // ── Final results (spec §5) — the last content screen in Slice 2. ────────
      {
        id: 'forecast-final',
        render: ({ onDone }: { onDone: () => void }) => (
          <EndScreen
            params={params}
            history={history}
            played={played}
            running={running}
            years={years}
            onContinue={onDone}
          />
        ),
      },
    ]

    return (
      <PageShell>
        <SequenceRunner
          screens={screens}
          startIndex={screen.startIndex}
          onAllComplete={() => setScreen({ name: 'done' })}
        />
      </PageShell>
    )
  }

  return <main style={{ padding: '2rem', fontFamily: typography.fontFamily }}><p>Loading…</p></main>
}
