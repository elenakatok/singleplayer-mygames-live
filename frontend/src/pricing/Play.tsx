import { useEffect, useState } from 'react'
import { auth } from '../firebase'
import {
  pricingBootstrap, pricingGetState, pricingGetQuestions, STUDENT_CLASSROOM_URL,
  type PricingHistoryRow, type PricingLabels, type PricingMarket, type PricingRoundResult,
  type PricingKcQuestionClient, type PricingPostStageQuestionClient,
} from './api'
import { PageShell } from '../shared/PageShell'
import { SequenceRunner, loopScreen, type SequenceScreen } from '../shared/sequence'
import { ChoosePrice, RevealRound } from './RoundScreen'
import { PmgRulesScreen } from './PmgRulesScreen'
import { KcScreen } from './KcScreen'
import { DebriefScreen } from './DebriefScreen'
import { EndScreen } from './EndScreen'
import { pricingResumeIndex, pricingScreenCount, pricingStartIteration } from './resume'
import { useStudentSession, typography } from '@mygames/game-ui'
import type { BootstrapArgs } from '@mygames/game-ui'

// ═══════════════════════════════════════════════════════════════════════════════
// Pricing Game (Cheyenne Shipping) — student entry. THE WHOLE FLOW, in one sequence:
//
//   (PMG rules)  →  KC  →  the round loop  →  the debrief  →  done
//   (PMG only,      (graded,   (self-paced,      (ungraded,
//    read-only)      no gate)   server-ended)     reveals the competitor)
//
// The PMG rules screen comes FIRST in a PMG instance (spec §6.2): it replaces the
// in-lecture announcement that the rules have changed, and a student must meet it
// before the knowledge check that tests it.
//
// The KC comes before the game (spec §8): it confirms the student can read the market
// before they start making decisions in it. It is graded but it is NOT A GATE — a
// wrong answer is recorded and the student continues regardless.
//
// RESUME, one rule for the whole flow: every step's completion is a fact stored on
// the server, so `startIndex` is just "how many steps are already done" — KC answers
// first, then the loop's own phase, then the debrief's stored answer. Nothing is kept
// in the browser; a student resumes identically on another device.
//
// ⚠ The drawn round count and the competitor's rule never reach this file during play
// (spec §3, §5) — see api.ts. The reveal sentence arrives from the server only once
// the game is over, and it is the ONLY thing about the competitor the client ever
// holds.
// ═══════════════════════════════════════════════════════════════════════════════

type Loaded = {
  pmg: boolean
  labels: PricingLabels
  market: PricingMarket
  minRounds: number
  maxRounds: number
  kc: PricingKcQuestionClient[]
  postStage: PricingPostStageQuestionClient[]
  competitorReveal: string | null
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
      const r = await pricingBootstrap(args)
      return {
        participantId: r.participant_id,
        gameInstanceId: r.game_instance_id,
        customToken: r.customToken,
      }
    },
  })

  const [screen, setScreen] = useState<Screen>({ name: 'loading' })
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  // The running history: seeded by pricingGetState, then replaced wholesale by each
  // round's response (the server returns the entire history every time, so this
  // cannot drift), along with the running totals it computed.
  const [history, setHistory] = useState<PricingHistoryRow[]>([])
  const [totals, setTotals] = useState<{ total: number; average: number }>({ total: 0, average: 0 })
  // The reveal, refreshed when the loop ends — the state call that seeded the page
  // was made mid-game, when the server correctly refused to send it.
  const [reveal, setReveal] = useState<string | null>(null)

  useEffect(() => {
    if (session.kind !== 'ready') return
    let cancelled = false
    Promise.all([pricingGetState(), pricingGetQuestions()])
      .then(([state, questions]) => {
        if (cancelled) return
        // Rendered order: the mode's derived questions, THEN the instructor's
        // additions. The server keeps the two sources apart and grades each on its
        // own path (api.ts); this flattening is for rendering ORDER only.
        const kc = [...questions.kc.derived, ...questions.kc.added]
        setLoaded({
          pmg: state.pmg,
          labels: state.labels,
          market: state.market,
          minRounds: state.minRounds,
          maxRounds: state.maxRounds,
          kc,
          // ⚠ The whole AFTER-THE-RESULTS stage, server-ordered: the debrief row plus any
          // added question assigned there. Empty when the instructor hid everything in it.
          postStage: questions.postStage,
          competitorReveal: questions.competitorReveal,
        })
        setHistory(state.history)
        setTotals({ total: state.totalProfit, average: state.averageProfit })
        setReveal(questions.competitorReveal)

        const start = pricingResumeIndex({
          pmg: state.pmg,
          kcCount: kc.length,
          kcAnswered: questions.kcAnswered.length,
          gameOver: state.gameOver,
          // ⚠ One flag per post row, in served order — resume lands on the FIRST
          // unanswered one, so a student part-way through the after-results questions
          // comes back to the right screen rather than to the top of the stage.
          postAnswered: questions.postStage.map(q => q.answered),
        })
        if (start >= pricingScreenCount(state.pmg, kc.length, questions.postStage.length)) {
          setScreen({ name: 'done' })
        } else {
          setScreen({ name: 'flow', startIndex: start, startIteration: pricingStartIteration(state.history.length) })
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
        <h2 style={{ marginBottom: '0.75rem' }}>Cheyenne Shipping</h2>
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
          history={history}
          labels={loaded.labels}
          pmg={loaded.pmg}
          totalProfit={totals.total}
          averageProfit={totals.average}
          competitorReveal={reveal}
        />
      </PageShell>
    )
  }

  if (screen.name === 'flow' && loaded !== null) {
    const { pmg, labels, market, minRounds, maxRounds, kc, postStage } = loaded

    const screens: SequenceScreen[] = [
      // ── The PMG rule change, before anything else (spec §6.2) ────────────────
      ...(pmg ? [{
        id: 'pricing-pmg-rules',
        render: ({ onDone }: { onDone: () => void }) => (
          <PmgRulesScreen
            market={market} labels={labels}
            minRounds={minRounds} maxRounds={maxRounds}
            onDone={onDone}
          />
        ),
      }] : []),

      // ── The knowledge check: one graded screen per question, no gate ──────────
      ...kc.map((q, i) => ({
        id: q.field,
        render: ({ onDone }: { onDone: () => void }) => (
          <KcScreen
            question={q} index={i} total={kc.length}
            market={market} labels={labels} pmg={pmg}
            onDone={onDone}
          />
        ),
      })),

      // ── The round loop: post → reveal, repeated until the SERVER says done ────
      loopScreen<PricingRoundResult>({
        id: 'pricing-rounds',
        startIteration: screen.startIteration,
        ask: ({ iteration, onResult }) => (
          <ChoosePrice
            roundNumber={iteration + 1}
            labels={labels}
            market={market}
            pmg={pmg}
            minRounds={minRounds}
            maxRounds={maxRounds}
            history={history}
            onResult={(res, done) => {
              setHistory(res.history)
              setTotals({ total: res.totalProfit, average: res.averageProfit })
              // The game just ended, so the reveal now exists. Fetch it before the
              // debrief screen mounts — the client cannot construct this sentence.
              if (done) {
                void pricingGetQuestions()
                  .then(q => setReveal(q.competitorReveal))
                  .catch(() => { /* the debrief still works without it */ })
              }
              onResult(res, done)
            }}
          />
        ),
        display: ({ iteration, result, onContinue }) => (
          <RevealRound
            roundNumber={iteration + 1}
            result={result}
            labels={labels}
            market={market}
            pmg={pmg}
            onContinue={onContinue}
          />
        ),
      }),

      // ── AFTER THE RESULTS: the whole `post` stage, one screen per row ────────
      //
      // ⚠⚠ THE SAME POSITION THE DEBRIEF ALWAYS OCCUPIED — no new phase, no new screen
      // kind. It used to be `...(debrief ? [oneScreen] : [])`; the stage can now hold added
      // questions as well as the debrief row, so the slot maps a LIST exactly as the
      // pre-play KC slot above does. The server orders the list and applies `hidden`.
      //
      // ⚠ `kind` PICKS THE SCREEN, NOT `type`. An added free-text question is `type:'text'`
      // like the debrief but submits to a different callable, so KcScreen renders it.
      //
      // ⚠⚠ THE COMPETITOR-STRATEGY SENTENCE STAYS ON THE DEBRIEF ROW, ABOVE THE QUESTION.
      // That placement is deliberate (DebriefScreen's own note) and is the thing that makes
      // this stage "after the results" rather than merely "after play".
      ...postStage.map((q, i) => ({
        id: q.field,
        render: ({ onDone }: { onDone: () => void }) => (
          q.kind === 'added'
            ? (
              <KcScreen
                question={{ field: q.field, type: q.type, prompt: q.prompt, options: q.options }}
                index={i}
                total={postStage.length}
                market={market}
                labels={labels}
                pmg={pmg}
                onDone={onDone}
              />
            )
            : (
          <DebriefScreen
            question={{ field: q.field, prompt: q.prompt, placeholder: q.placeholder ?? '' }}
            competitorReveal={reveal}
            history={history}
            labels={labels}
            pmg={pmg}
            totalProfit={totals.total}
            averageProfit={totals.average}
            onDone={onDone}
          />
            )
        ),
      })),
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
