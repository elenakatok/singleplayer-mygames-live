import { useEffect, useState } from 'react'
import { auth } from '../firebase'
import { useStudentSession, typography, colors } from '@mygames/game-ui'
import type { BootstrapArgs } from '@mygames/game-ui'
import { PageShell } from '../shared/PageShell'
import { SequenceRunner, loopScreen, type SequenceScreen } from '../shared/sequence'
import { PlaceBid, RoundResult } from './RoundScreen'
import { KcScreen } from './KcScreen'
import { FreeTextScreen } from './FreeTextScreen'
import { EndScreen } from './EndScreen'
import { procurementResumeIndex, procurementScreenCount, procurementStartIteration } from './resume'
import {
  procurementBootstrap, procurementGetState, procurementGetQuestions, STUDENT_CLASSROOM_URL,
  type ProcurementParams, type ProcurementPlayedRow, type ProcurementRoundResult,
  type ProcurementKcQuestionClient, type ProcurementRivalPoint,
} from './api'

// ═══════════════════════════════════════════════════════════════════════════════
// Procurement Auction — student entry. THE WHOLE FLOW, in one sequence (§6, §9, §10):
//
//   KC  →  prep  →  the round loop  →  final results  →  debrief
//   (17-question    (S8,     (see your cost →   (§9, with     (S9,
//    merged pool,    open     bid → resolve →    the scatter)  open
//    graded, NO      response,  round result,                   response,
//    GATE)           ungraded)  ×8)                              ungraded)
//
// ⚠ THE KC IS NOT A GATE (§10). A wrong answer is recorded, explained, and the student
// continues. There is no pass mark in this family and none may be added.
//
// ⚠ THE DENOMINATOR IS NEVER ON THE CLIENT. The number of questions rendered is whatever
// the server resolved for this instance; `gradedTotal` rides along for display only, and
// the score is computed server-side out of `gradedFor()` at scoring time. There is no
// `/17` in this file and there must never be one.
//
// ⚠ THE TWO FORMATS SHARE THIS ENTRY POINT. `state.params.format` selects the bidding
// screen — sealed today, open at CP4 — and nothing else about the flow differs. The open
// format has no screen yet and says so rather than rendering the sealed one, which would
// resolve a different mechanism than the instance is configured for.
//
// RESUME: every step's completion is a fact stored on the SERVER — KC answers, the two
// free-text answers, the rounds array. `resume.ts` turns those into an index; nothing is
// kept in the browser, so a student resumes identically on another device and cannot
// skip a step by clearing storage. The current round's cost is re-derived server-side
// rather than cached, so a reload cannot re-roll it either.
// ═══════════════════════════════════════════════════════════════════════════════

type Loaded = {
  params: ProcurementParams
  kc: ProcurementKcQuestionClient[]
  prep: ProcurementKcQuestionClient | null
  debrief: ProcurementKcQuestionClient | null
  startIndex: number
  startIteration: number
}

type Screen =
  | { name: 'loading' }
  | { name: 'error'; message: string }
  | { name: 'unsupported-format' }
  | { name: 'flow' }
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
      const r = await procurementBootstrap(args as never)
      return {
        participantId: r.participant_id,
        gameInstanceId: r.game_instance_id,
        customToken: r.customToken,
      }
    },
  })

  const [screen, setScreen] = useState<Screen>({ name: 'loading' })
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  // Replaced WHOLESALE by each round's response — the server returns the entire history
  // every time, so the client never accumulates and cannot drift.
  const [history, setHistory] = useState<ProcurementPlayedRow[]>([])
  const [totals, setTotals] = useState({ profit: 0, benchmark: 0, wins: 0 })
  const [cost, setCost] = useState<number | null>(null)
  // The scatter's bot series. Null the whole live game; re-fetched when the loop ends,
  // because the state call that seeded this page was made before `finished_at` existed
  // and the server correctly refused to send it.
  const [rivalPoints, setRivalPoints] = useState<ProcurementRivalPoint[] | null>(null)

  useEffect(() => {
    if (session.kind !== 'ready') return
    let cancelled = false
    Promise.all([procurementGetState(), procurementGetQuestions()])
      .then(([state, questions]) => {
        if (cancelled) return

        // ⚠ ONE prep and ONE debrief question by construction (the pool carries S8 and
        // S9 for the sealed format). Taking [0] rather than mapping keeps the flow's
        // shape honest — if a second is ever authored, this is where it surfaces.
        const prep = questions.prep[0] ?? null
        const debrief = questions.debrief[0] ?? null
        const kc = questions.kcEnabled ? questions.kc : []

        const resumeArgs = {
          kcCount: kc.length,
          kcAnswered: questions.kcAnswered.length,
          prepEnabled: prep !== null,
          prepAnswered: questions.prepAnswered.length > 0,
          debriefEnabled: debrief !== null,
          debriefAnswered: questions.debriefAnswered.length > 0,
          gameOver: state.gameOver || state.roundsPlayed >= state.params.rounds,
          roundsPlayed: state.roundsPlayed,
        }
        const startIndex = procurementResumeIndex(resumeArgs)
        const total = procurementScreenCount({
          kcCount: kc.length, prepEnabled: prep !== null, debriefEnabled: debrief !== null,
        })

        setLoaded({
          params: state.params,
          kc,
          prep,
          debrief,
          startIndex,
          startIteration: procurementStartIteration(state.roundsPlayed),
        })
        setHistory(state.played)
        setTotals({
          profit: state.totalProfit,
          benchmark: state.totalEquilibriumProfit,
          wins: state.roundsWon,
        })
        setCost(state.currentCost)
        setRivalPoints(state.revealRivalPoints)

        if (state.params.format !== 'sealed_first_price') {
          setScreen({ name: 'unsupported-format' })
        } else if (startIndex >= total) {
          setScreen({ name: 'done' })
        } else {
          setScreen({ name: 'flow' })
        }
      })
      .catch(err => {
        if (!cancelled) {
          setScreen({ name: 'error', message: err instanceof Error ? err.message : 'Failed to load the game.' })
        }
      })
    return () => { cancelled = true }
  }, [session.kind])

  if (session.kind === 'no-token') {
    return (
      <PageShell>
        <Notice title="This page needs a launch link">
          <p>Open the game from your course page so the link carries your session.</p>
          <p><a href={STUDENT_CLASSROOM_URL}>Go to the student portal →</a></p>
        </Notice>
      </PageShell>
    )
  }

  if (session.kind === 'error') {
    return (
      <PageShell>
        <Notice title="We could not start your session">
          <p>{session.message}</p>
          <p><a href={STUDENT_CLASSROOM_URL}>Go to the student portal →</a></p>
        </Notice>
      </PageShell>
    )
  }

  if (session.kind === 'loading' || screen.name === 'loading') {
    return <PageShell><p style={{ fontFamily: typography.fontFamily }}>Loading…</p></PageShell>
  }

  if (screen.name === 'error') {
    return (
      <PageShell>
        <Notice title="We could not load this game">
          <p style={{ color: colors.errorAction }}>{screen.message}</p>
        </Notice>
      </PageShell>
    )
  }

  // ⚠ Refuses rather than falling back to the sealed screen. An open instance resolved
  // through the sealed mechanism would produce rounds whose numbers mean something other
  // than what the instance says they mean — what the `format` lock exists to prevent.
  if (screen.name === 'unsupported-format') {
    return (
      <PageShell>
        <Notice title="This instance uses the open-bid format">
          <p>The open-bid auction has not been built yet. Nothing you do here is recorded.</p>
          <p>Please tell your instructor — the instance needs to be set to the sealed-bid format.</p>
        </Notice>
      </PageShell>
    )
  }

  if (loaded === null) {
    return <PageShell><p style={{ fontFamily: typography.fontFamily }}>Loading…</p></PageShell>
  }

  const results = (onContinue?: () => void) => (
    <EndScreen
      params={loaded.params}
      history={history}
      totalProfit={totals.profit}
      totalEquilibriumProfit={totals.benchmark}
      roundsWon={totals.wins}
      rivalPoints={rivalPoints}
      onContinue={onContinue}
    />
  )

  // The terminal view: everything is done, so the results screen stands alone with no
  // Continue. A returning student lands here.
  if (screen.name === 'done') {
    return <PageShell>{results()}</PageShell>
  }

  const screens: SequenceScreen[] = [
    // ── The knowledge check: one graded screen per question, NO GATE (§10) ──────
    ...loaded.kc.map((q, i) => ({
      id: q.field,
      render: ({ onDone }: { onDone: () => void }) => (
        <KcScreen question={q} index={i} total={loaded.kc.length} onDone={onDone} />
      ),
    })),

    // ── The prep paragraph (S8), before round 1 ────────────────────────────────
    ...(loaded.prep ? [{
      id: loaded.prep.field,
      render: ({ onDone }: { onDone: () => void }) => (
        <FreeTextScreen
          question={loaded.prep!}
          eyebrow="Before you start"
          onDone={onDone}
        />
      ),
    }] : []),

    // ── The round loop: bid → reveal, until the SERVER says done ───────────────
    loopScreen<ProcurementRoundResult>({
      id: 'procurement-rounds',
      startIteration: loaded.startIteration,
      ask: ({ iteration, onResult }) => (
        cost === null
          ? <p style={{ fontFamily: typography.fontFamily }}>Loading your cost…</p>
          : (
            <PlaceBid
              roundNumber={iteration + 1}
              cost={cost}
              params={loaded.params}
              history={history}
              onSubmitted={res => {
                setHistory(res.history)
                setTotals({
                  profit: res.totalProfit,
                  benchmark: res.totalEquilibriumProfit,
                  wins: res.roundsWon,
                })
                setCost(res.nextCost)
                // The game just ended, so `finished_at` now exists and the scatter's
                // bot series is finally available. Fetched before the results screen
                // mounts; the client cannot construct these points itself.
                if (res.gameOver) {
                  void procurementGetState()
                    .then(s => setRivalPoints(s.revealRivalPoints))
                    .catch(() => { /* the scatter still renders without the bot series */ })
                }
                onResult(res.round, res.gameOver)
              }}
            />
          )
      ),
      display: ({ result, done, onContinue }) => (
        <RoundResult
          result={result}
          params={loaded.params}
          history={history}
          done={done}
          onContinue={onContinue}
        />
      ),
    }),

    // ── Final results (§9) ─────────────────────────────────────────────────────
    // ⚠ A pass-through with no stored completion fact of its own — see resume.ts.
    {
      id: 'procurement-results',
      render: ({ onDone }: { onDone: () => void }) => results(onDone),
    },

    // ── The debrief paragraph (S9), AFTER the results ──────────────────────────
    ...(loaded.debrief ? [{
      id: loaded.debrief.field,
      render: ({ onDone }: { onDone: () => void }) => (
        <FreeTextScreen
          question={loaded.debrief!}
          eyebrow="One last question"
          onDone={onDone}
        />
      ),
    }] : []),
  ]

  return (
    <PageShell>
      <SequenceRunner
        screens={screens}
        startIndex={loaded.startIndex}
        onAllComplete={() => setScreen({ name: 'done' })}
      />
    </PageShell>
  )
}

function Notice({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{
      fontFamily: typography.fontFamily,
      maxWidth: '34rem',
      border: `1px solid ${colors.borderMid}`,
      borderRadius: 8,
      padding: '1.25rem 1.5rem',
      background: colors.white,
    }}>
      <h1 style={{ marginTop: 0, fontSize: '1.1rem' }}>{title}</h1>
      {children}
    </div>
  )
}
