import { useEffect, useState } from 'react'
import { auth } from '../firebase'
import {
  forecastBootstrap, forecastGetState, forecastGetQuestions, forecastGetReveal,
  STUDENT_CLASSROOM_URL,
  type ForecastHistoryPoint, type ForecastParams, type ForecastPlayedRow,
  type ForecastRoundResult, type ForecastRunning, type ForecastYears,
  type ForecastDebriefQuestionClient, type ForecastReveal, type ForecastStageRowClient,
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
//   PRE stage  →  the month loop  →  final results  →  POST stage  →  the REVEAL
//  (the nine +      (forecast →        (spec §5)        (the debrief    (spec §9)
//   any pre-stage    compute →                           paragraph +
//   addition;        results, ×N)                        any post-stage
//   graded, no gate)                                     addition)
//
// ⚠⚠ THE AFTER-PLAY STAGE SITS BETWEEN THE STUDENT'S OWN RESULTS AND THE REVEAL, and the
// server enforces that: `forecastGetReveal` refuses until every VISIBLE row of it is
// answered (functions forecast/reveal.ts). The debrief is one ROW of that stage now rather
// than a screen of its own, so an instructor can add questions beside it — and anything
// they add inherits the same protection, which is the reason the gate was widened from the
// one paragraph to the whole stage.
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
  /** ⚠ SERVER-ORDERED, hidden rows already gone. The client re-derives nothing. */
  preStage: ForecastStageRowClient[]
  postStage: ForecastStageRowClient[]
  debrief: ForecastDebriefQuestionClient | null
  /** Non-null only for a returning student who has ALREADY finished the after-play stage —
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
        // ⚠ THE TWO STAGES, SERVER-ORDERED, with `hidden` and the `kcEnabled` gate already
        // applied. The legacy `kc.authored` / `kc.added` fields still ship, but flattening
        // them here would re-derive an order the server has already decided — and would
        // lose the debrief row, which is a member of the post stage rather than a field.
        const preStage = questions.stages.pre
        const postStage = questions.stages.post

        // ⚠ ONLY when the server says the whole after-play stage is behind them. See the
        // header: the reveal is never requested speculatively. Asking early would simply be
        // refused, but not asking for the answer key until it has been earned keeps the
        // client honest about what it is entitled to.
        let reveal: ForecastReveal | null = null
        if (state.gameOver && postStage.every(r => r.answered)) {
          try { reveal = (await forecastGetReveal()).reveal } catch { reveal = null }
        }
        if (cancelled) return

        setLoaded({
          params: state.params,
          history: state.history,
          preStage,
          postStage,
          debrief: questions.debrief,
          reveal,
        })
        setPlayed(state.played)
        setRunning(state.running)
        setYears(state.years)

        const start = forecastResumeIndex({
          gameOver: state.gameOver,
          preAnswered: preStage.map(r => r.answered),
          postAnswered: postStage.map(r => r.answered),
        })
        if (start >= forecastScreenCount(preStage.length, postStage.length)) {
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
    const { params, history, preStage, postStage } = loaded

    /**
     * ONE row of a stage.
     *
     * ⚠ `kind` ROUTES THE SUBMIT, and it is read here rather than inferred from `type`: an
     * ADDED free-text question is `type: 'text'` and goes to forecastSubmitKcAnswer, while
     * the debrief row goes to forecastSubmitDebrief and is the one that returns the reveal.
     */
    const renderRow = (
      row: ForecastStageRowClient, i: number, total: number, heading: string, lastLabel: string,
    ) => ({
      id: row.field,
      render: ({ onDone }: { onDone: () => void }) => (
        row.kind === 'free-text'
          ? (
            <DebriefScreen
              question={{ field: row.field, prompt: row.prompt, placeholder: row.placeholder ?? '' }}
              onDone={onDone}
              initialReveal={loaded.reveal}
            />
          )
          : (
            <KcScreen
              question={{ field: row.field, prompt: row.prompt, options: row.options, type: row.type }}
              index={i}
              total={total}
              onDone={onDone}
              heading={heading}
              lastLabel={lastLabel}
            />
          )
      ),
    })

    const screens: SequenceScreen[] = [
      // ── The PRE stage FIRST: one graded screen per question, no gate ─────────
      // Graded, and NOT a gate — a wrong answer is recorded, scored, and the student
      // continues regardless (spec §8).
      ...preStage.map((row, i) => renderRow(row, i, preStage.length, 'Knowledge check', 'Start the game')),

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

      // ── The POST stage: the debrief paragraph and anything beside it (spec §9). ──
      //
      // ⚠ THE REVEAL IS EARNED BY THE WHOLE STAGE. When the debrief is the last outstanding
      // row, forecastSubmitDebrief returns the reveal and DebriefScreen shows it inline —
      // today's behaviour, unchanged for the shipped configuration. When it is NOT, that
      // callable returns `reveal: null`, DebriefScreen advances, and the reveal is fetched
      // once the stage completes (`onAllComplete` below).
      ...postStage.map((row, i) => renderRow(row, i, postStage.length, 'One last thing', 'Finish')),
    ]

    return (
      <PageShell>
        <SequenceRunner
          screens={screens}
          startIndex={screen.startIndex}
          onAllComplete={() => {
            // ⚠ FETCH THE REVEAL ON COMPLETION, not before. The stage is finished, so the
            // server-side gate now passes; a student who reached the end through a row
            // OTHER than the debrief has no reveal in hand yet, and the terminal screen
            // below would otherwise show them the results page they have already read.
            void forecastGetReveal()
              .then(r => setLoaded(prev => (prev ? { ...prev, reveal: r.reveal } : prev)))
              .catch(() => { /* the terminal screen falls back to the results page */ })
              .finally(() => setScreen({ name: 'done' }))
          }}
        />
      </PageShell>
    )
  }

  return <main style={{ padding: '2rem', fontFamily: typography.fontFamily }}><p>Loading…</p></main>
}
