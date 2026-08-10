import { useEffect, useState } from 'react'
import { auth } from '../firebase'
import {
  newsvendorBootstrap, newsvendorGetState, newsvendorGetQuestions, STUDENT_CLASSROOM_URL,
  type NewsvendorHistoryRow, type NewsvendorParams, type NewsvendorRoundResult,
  type NewsvendorStageRowClient,
} from './api'
import { PageShell } from '../shared/PageShell'
import { SequenceRunner, loopScreen, type SequenceScreen } from '../shared/sequence'
import { PlaceOrder, PeriodResults } from './OrderScreen'
import { KcScreen } from './KcScreen'
import { FreeTextScreen } from './FreeTextScreen'
import { EndScreen } from './EndScreen'
import { newsvendorResumeIndex, newsvendorScreenCount, newsvendorStartIteration } from './resume'
import { useStudentSession, typography } from '@mygames/game-ui'
import type { BootstrapArgs } from '@mygames/game-ui'

// ═══════════════════════════════════════════════════════════════════════════════
// Newsvendor — student entry. THE WHOLE FLOW, in one sequence:
//
//   KC  →  prep  →  the period loop  →  final results  →  debrief  →  done
//  (10     (free    (place order →      (totals; the     (free
//   graded, text,    results, ×N)        benchmark is     text,
//   no gate) ungraded)                   NOT here)        ungraded)
//
// ⚠ THE GRADED KC COMES FIRST, and the two screens after it depend on that. Students
// arrive having had the newsvendor lecture, so the KC checks the LECTURE rather than
// the play — and the prep can then ask the question that is actually interesting:
// having just computed the optimal order, do you intend to USE it? That wording lives
// in functions newsvendor/config.ts and is written against this order, so the two
// cannot be resequenced independently.
//
// ⚠ MOVING THE KC DID NOT TOUCH HOW IT GRADES. Position is all that changed: the
// questions are still resolved by resolveNewsvendorKcQuestions(participantId) and
// still graded by newsvendorSubmitKcAnswer against that same call, which is what
// keeps a moved screen from throwing "not a knowledge-check question in this game".
// The server has no notion of where in the flow a question was answered.
//
// RESUME, one rule for the whole flow: every step's completion is a fact stored on the
// server, so `startIndex` is just "how many steps are already done" — the KC answers,
// then the prep answer, then the loop's own position, then the debrief. Nothing is kept
// in the browser; a student resumes identically on another device. The arithmetic lives
// in resume.ts and is unit-tested against every branch (resume.test.ts), because an
// off-by-one here puts a student back through a question the server has already locked.
//
// ⚠ THE BENCHMARK NEVER REACHES THIS FILE (spec §9.2) — see api.ts. Q_opt and
// profitOpt are stored for every period and appear in no student response, so there is
// nothing here to accidentally render.
// ═══════════════════════════════════════════════════════════════════════════════

type Loaded = {
  params: NewsvendorParams
  preStage: NewsvendorStageRowClient[]
  postStage: NewsvendorStageRowClient[]
  prepEnabled: boolean
  debriefEnabled: boolean
}

type Screen =
  | { name: 'loading' }
  | { name: 'error'; message: string }
  | { name: 'flow'; startIndex: number; startIteration: number }
  | { name: 'done' }

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
      const r = await newsvendorBootstrap(args)
      return {
        participantId: r.participant_id,
        gameInstanceId: r.game_instance_id,
        customToken: r.customToken,
      }
    },
  })

  const [screen, setScreen] = useState<Screen>({ name: 'loading' })
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  // The running history: seeded by newsvendorGetState, then replaced wholesale by each
  // period's response (the server returns the entire history every time, so this
  // cannot drift), along with the running figures it computed.
  const [history, setHistory] = useState<NewsvendorHistoryRow[]>([])
  const [totals, setTotals] = useState<
    { profit: number; averageProfit: number; order: number; serviceLevel: number }>(
    { profit: 0, averageProfit: 0, order: 0, serviceLevel: 0 })

  useEffect(() => {
    if (session.kind !== 'ready') return
    let cancelled = false
    Promise.all([newsvendorGetState(), newsvendorGetQuestions()])
      .then(([state, questions]) => {
        if (cancelled) return
        // ⚠ The two stages, server-ordered, `hidden` already applied. The legacy
        // `kc.authored` / `kc.added` / `prep` / `debrief` fields are still served for
        // anything else reading them; the FLOW reads these.
        const preStage = questions.stages.pre
        const postStage = questions.stages.post
        setLoaded({
          params: state.params,
          preStage,
          postStage,
          prepEnabled: questions.prepEnabled,
          debriefEnabled: questions.debriefEnabled,
        })
        setHistory(state.history)
        setTotals({
          profit: state.totalProfit,
          averageProfit: state.averageProfit,
          order: state.averageOrder,
          serviceLevel: state.averageServiceLevel,
        })

        const start = newsvendorResumeIndex({
          gameOver: state.gameOver,
          // ⚠ One flag per row, in served order — resume lands on the FIRST unanswered,
          // gap or not, so a student part-way through either stage comes back to the right
          // screen rather than to the top of it.
          preAnswered: preStage.map(q => q.answered),
          postAnswered: postStage.map(q => q.answered),
        })
        if (start >= newsvendorScreenCount(preStage.length, postStage.length)) {
          setScreen({ name: 'done' })
        } else {
          setScreen({
            name: 'flow',
            startIndex: start,
            startIteration: newsvendorStartIteration(state.history.length),
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
        <h2 style={{ marginBottom: '0.75rem' }}>Newsvendor</h2>
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
          history={history}
          averageProfit={totals.averageProfit}
          averageOrder={totals.order}
          averageServiceLevel={totals.serviceLevel}
        />
      </PageShell>
    )
  }

  if (screen.name === 'flow' && loaded !== null) {
    const { params: gameParams, preStage, postStage } = loaded

    // ⚠⚠ ONE RENDERER FOR BOTH STAGES. `kind` picks the screen, NEVER `type`: an added
    // free-text question is `type: 'text'` like the two paragraphs but submits to a
    // different callable, so KcScreen renders it and FreeTextScreen does not.
    const stageScreen = (
      q: NewsvendorStageRowClient, i: number, total: number, title: string, submitLabel: string,
    ): SequenceScreen => ({
      id: q.field,
      render: ({ onDone }: { onDone: () => void }) => (
        q.kind === 'free-text'
          ? (
            <FreeTextScreen
              question={{ field: q.field, prompt: q.prompt, placeholder: q.placeholder ?? '' }}
              title={title}
              submitLabel={submitLabel}
              onDone={onDone}
            />
          )
          : (
            <KcScreen
              question={{ field: q.field, type: q.type, prompt: q.prompt, options: q.options }}
              index={i}
              total={total}
              onDone={onDone}
            />
          )
      ),
    })

    const screens: SequenceScreen[] = [
      // ── THE PRE STAGE: the authored set, the prep paragraph, any pre addition ──
      //
      // ⚠⚠ ONE LIST, SERVER-ORDERED. This was `...kc.map(...)` followed by an optional prep
      // screen; the prep is a ROW in the stage now (spec D9) and an instructor can put an
      // added question anywhere among them. No new phase and no new screen kind — the same
      // positions, rendering whatever the server hands over.
      //
      // Graded rows are NOT a gate: a wrong answer is recorded, scored, and the student
      // continues regardless.
      ...preStage.map((q, i) =>
        stageScreen(q, i, preStage.length, 'Before you start', 'Start the game')),

      // ── The period loop: order → results, repeated to the configured N ───────
      loopScreen<NewsvendorRoundResult>({
        id: 'newsvendor-periods',
        startIteration: screen.startIteration,
        ask: ({ iteration, onResult }) => (
          <PlaceOrder
            periodNumber={iteration + 1}
            params={gameParams}
            history={history}
            onResult={(res, done) => {
              setHistory(res.history)
              setTotals({
                profit: res.totalProfit,
                averageProfit: res.averageProfit,
                order: res.averageOrder,
                serviceLevel: res.averageServiceLevel,
              })
              onResult(res, done)
            }}
          />
        ),
        display: ({ iteration, result, onContinue }) => (
          <PeriodResults
            periodNumber={iteration + 1}
            result={result}
            params={gameParams}
            onContinue={onContinue}
          />
        ),
      }),

      // ── Final results (spec §7d) — the last content screen; only the debrief
      //    follows it now that the KC has moved to the front.
      {
        id: 'newsvendor-final',
        render: ({ onDone }: { onDone: () => void }) => (
          <EndScreen
            params={gameParams}
            history={history}
            averageProfit={totals.averageProfit}
            averageOrder={totals.order}
            averageServiceLevel={totals.serviceLevel}
            onContinue={onDone}
          />
        ),
      },

      // ── THE POST STAGE: the debrief paragraph plus any post addition ─────────
      //
      // ⚠ AFTER THE FINAL-RESULTS SCREEN, deliberately — a student answering anything here
      // has already seen their own profits and their optimality gap.
      ...postStage.map((q, i) =>
        stageScreen(q, i, postStage.length, 'One last question', 'Finish')),
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
