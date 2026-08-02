import { useEffect, useState } from 'react'
import { auth } from '../firebase'
import {
  forecastBootstrap, forecastGetState, forecastGetQuestions, forecastGetReveal,
  STUDENT_CLASSROOM_URL,
  type ForecastHistoryPoint, type ForecastParams, type ForecastPlayedRow,
  type ForecastRoundResult, type ForecastRunning, type ForecastYears,
  type ForecastKcQuestionClient, type ForecastDebriefQuestionClient, type ForecastReveal,
} from './api'
import { PageShell } from '../shared/PageShell'
import { SequenceRunner, loopScreen, type SequenceScreen } from '../shared/sequence'
import { EnterForecast, MonthResults } from './ForecastScreen'
import { EndScreen } from './EndScreen'
import { KcScreen } from './KcScreen'
import { DebriefScreen, RevealPanel } from './DebriefScreen'
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
// ⚠ THE KC COMES FIRST, and that is spec §4's flow line (instructions → KC → loop).
// Students arrive having had the forecasting lecture, so the KC checks the LECTURE
// rather than the play: Q4 and Q5 are read straight off slide 14 and are the skill they
// need to fit the game's own model. Putting it after play would test what they had
// already been forced to work out for themselves.
//
// ⚠ THE REVEAL IS NOT FETCHED SPECULATIVELY. `forecastGetReveal` is called ONLY when
// the server has already told us the debrief is submitted — never on mount, never
// "just in case". It would be refused anyway (the gate is server-side, functions
// forecast/reveal.ts), but not asking for the answer key until it has been earned keeps
// the client's behaviour honest about what it is entitled to.
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
  kc: ForecastKcQuestionClient[]
  debrief: ForecastDebriefQuestionClient | null
  debriefEnabled: boolean
  /** Non-null only for a returning student who has ALREADY written their debrief —
   *  fetched through the gated callable, never speculatively. */
  reveal: ForecastReveal | null
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
    Promise.all([forecastGetState(), forecastGetQuestions()])
      .then(async ([state, questions]) => {
        if (cancelled) return
        // Rendered order: the authored nine, THEN the instructor's additions. The
        // server keeps the two sources apart and grades each on its own path (api.ts);
        // this flattening is for rendering ORDER only.
        const kc = [...questions.kc.authored, ...questions.kc.added]

        // ⚠ ONLY when the server says the debrief is already answered. See the header:
        // the reveal is never requested speculatively.
        let reveal: ForecastReveal | null = null
        if (questions.debriefSubmitted) {
          try { reveal = (await forecastGetReveal()).reveal } catch { reveal = null }
        }
        if (cancelled) return

        setLoaded({
          params: state.params,
          history: state.history,
          kc,
          debrief: questions.debrief,
          debriefEnabled: questions.debriefEnabled,
          reveal,
        })
        setPlayed(state.played)
        setRunning(state.running)
        setYears(state.years)

        const kcCount = kc.length
        const debriefEnabled = questions.debriefEnabled
        const start = forecastResumeIndex({
          gameOver: state.gameOver,
          kcCount,
          kcAnswered: questions.kcAnswered.length,
          debriefEnabled,
          debriefSubmitted: questions.debriefSubmitted,
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
    // ⚠ A FINISHED STUDENT LANDS ON THE REVEAL, not on the results screen they have
    // already read. Spec §9 calls it the highest-value screen in the game, so a student
    // who closes the tab after submitting and comes back must find it again rather than
    // a dead end. `loaded.reveal` is populated only when the server confirmed the
    // debrief was answered.
    return (
      <PageShell>
        {loaded.reveal !== null
          ? <RevealPanel reveal={loaded.reveal} />
          : (
            <EndScreen
              params={loaded.params}
              history={loaded.history}
              played={played}
              running={running}
              years={years}
            />
          )}
      </PageShell>
    )
  }

  if (screen.name === 'flow' && loaded !== null) {
    const { params, history, kc, debrief } = loaded

    const screens: SequenceScreen[] = [
      // ── The knowledge check FIRST: one graded screen per question, no gate ───
      // Graded, and NOT a gate — a wrong answer is recorded, scored, and the student
      // continues regardless (spec §8).
      ...kc.map((q, i) => ({
        id: q.field,
        render: ({ onDone }: { onDone: () => void }) => (
          <KcScreen question={q} index={i} total={kc.length} onDone={onDone} />
        ),
      })),

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

      // ── Final results (spec §5), then the debrief. ───────────────────────────
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

      // ── The debrief paragraph, then the REVEAL (spec §9). ────────────────────
      ...(debrief ? [{
        id: debrief.field,
        render: ({ onDone }: { onDone: () => void }) => (
          <DebriefScreen question={debrief} onDone={onDone} initialReveal={loaded.reveal} />
        ),
      }] : []),
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
