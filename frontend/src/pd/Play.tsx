import { useEffect, useState } from 'react'
import { auth } from '../firebase'
import {
  pdBootstrap, pdGetState, pdGetQuestions, CLASSROOM_URL,
  type PdHistoryRow, type PdMoveLabels, type PdPayoffs, type PdRoundResult,
  type PdKcQuestionClient, type PdDebriefQuestionClient,
} from './api'
import { PageShell } from '../shared/PageShell'
import { SequenceRunner, loopScreen, type SequenceScreen } from '../shared/sequence'
import { ChooseRound, RevealRound } from './RoundScreen'
import { KcScreen } from './KcScreen'
import { DebriefScreen } from './DebriefScreen'
import { resumeIndex, screenCount } from './resume'
import { HistoryTable, averagePerRound } from './HistoryTable'
import { useStudentSession, typography, colors } from '@mygames/game-ui'
import type { BootstrapArgs } from '@mygames/game-ui'

// ═══════════════════════════════════════════════════════════════════════════════
// Repeated Prisoner's Dilemma — student entry. THE WHOLE FLOW, in one sequence:
//
//   KC Q1 … Q4  →  the round loop  →  the debrief paragraph  →  done
//   (graded,        (self-paced,        (ungraded)
//    no gate)        server-ended)
//
// The KC comes FIRST (spec §7): it confirms the student can read the payoff matrix
// before they start making decisions with it. It is graded but it is NOT A GATE —
// a wrong answer is recorded and the student continues into the game regardless.
//
// RESUME, one rule for the whole flow: every step's completion is a fact stored on
// the server, so `startIndex` is just "how many steps are already done" —
// KC answers first, then the loop's own gameOver, then the debrief's stored answer.
// Nothing is kept in the browser; a student resumes identically on another device.
//
// The round count and the strategy still never reach this file (spec §3, §5) — see
// api.ts. Slice 4 adds the reports; nothing student-facing is left after this.
// ═══════════════════════════════════════════════════════════════════════════════

type Loaded = {
  /** derived-then-added, flattened ONLY for rendering order — the server keeps the
   *  two sources apart and grades each on its own path (see api.ts). */
  kc: PdKcQuestionClient[]
  debrief: PdDebriefQuestionClient | null
  payoffs: PdPayoffs
  labels: PdMoveLabels
  unit: string
  minRounds: number
  maxRounds: number
}

type Screen =
  | { name: 'loading' }
  | { name: 'error'; message: string }
  | { name: 'flow'; startIndex: number }
  | { name: 'done' }

function DoneScreen({ history, labels, unit }: { history: PdHistoryRow[]; labels: PdMoveLabels; unit: string }) {
  // AVERAGES, not totals — the same convention the in-play history caption uses
  // (Slice 4), via the same helper, so the last screen a student sees does not
  // contradict the one they just spent the whole game reading. Summed from the
  // per-round values already on this screen and divided by rounds PLAYED.
  const studentTotal = history.reduce((a, r) => a + r.studentYears, 0)
  const botTotal = history.reduce((a, r) => a + r.botYears, 0)
  return (
    <div>
      <h1 data-testid="pd-all-done" style={{ marginTop: 0, fontSize: '1.6rem', color: colors.text }}>
        All done — thank you
      </h1>
      <p style={{ lineHeight: 1.6, color: colors.text }}>
        {/* The round COUNT is fine to state here: the hidden-horizon rule is a
            during-play rule, and the game is over. */}
        Your answers and your game have been recorded. You played{' '}
        <strong>{history.length}</strong> round{history.length === 1 ? '' : 's'} and averaged{' '}
        <strong data-testid="pd-done-your-average">{averagePerRound(studentTotal, history.length)}</strong>{' '}
        {unit} per round; the other player averaged{' '}
        <strong data-testid="pd-done-their-average">{averagePerRound(botTotal, history.length)}</strong>.
        You can close this tab.
      </p>
      {history.length > 0 && (
        <div style={{ marginTop: '1.25rem' }}>
          <HistoryTable history={history} labels={labels} unit={unit} />
        </div>
      )}
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
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  // The running history: seeded by pdGetState, then replaced wholesale by each round's
  // response (the server returns the entire history every time, so this cannot drift).
  const [history, setHistory] = useState<PdHistoryRow[]>([])

  useEffect(() => {
    if (session.kind !== 'ready') return
    let cancelled = false
    Promise.all([pdGetState(), pdGetQuestions()])
      .then(([state, questions]) => {
        if (cancelled) return
        // Rendered order: the derived four, THEN the instructor's additions.
        const kc = [...questions.kc.derived, ...questions.kc.added]
        setLoaded({
          kc,
          debrief: questions.debrief,
          payoffs: state.payoffs,
          labels: state.labels,
          unit: state.unit,
          minRounds: state.minRounds,
          maxRounds: state.maxRounds,
        })
        setHistory(state.history)
        const start = resumeIndex({
          kcCount: kc.length,
          kcAnswered: questions.kcAnswered.length,
          gameOver: state.gameOver,
          debriefEnabled: questions.debriefEnabled,
          debriefSubmitted: questions.debriefSubmitted,
        })
        // Past the last screen ⇒ everything is done.
        if (start >= screenCount(kc.length, questions.debriefEnabled)) setScreen({ name: 'done' })
        else setScreen({ name: 'flow', startIndex: start })
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
  if (screen.name === 'done') {
    return (
      <PageShell>
        <DoneScreen
          history={history}
          labels={loaded?.labels ?? { C: 'Cooperate', D: 'Defect' }}
          unit={loaded?.unit ?? 'years'}
        />
      </PageShell>
    )
  }

  if (screen.name === 'flow' && loaded !== null) {
    const { kc, debrief, payoffs, labels, unit, minRounds, maxRounds } = loaded

    const screens: SequenceScreen[] = [
      // ── The knowledge check: one graded screen per question, no gate ──────────
      ...kc.map((q, i) => ({
        id: q.field,
        render: ({ onDone }: { onDone: () => void }) => (
          <KcScreen question={q} index={i} total={kc.length} payoffs={payoffs} labels={labels} unit={unit} onDone={onDone} />
        ),
      })),

      // ── The round loop: ask → reveal, repeated until the SERVER says done ─────
      loopScreen<PdRoundResult>({
        id: 'pd-rounds',
        startIteration: history.length,
        ask: ({ iteration, onResult }) => (
          <ChooseRound
            roundNumber={iteration + 1}
            labels={labels}
            payoffs={payoffs}
            unit={unit}
            minRounds={minRounds}
            maxRounds={maxRounds}
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
            unit={unit}
            onContinue={onContinue}
          />
        ),
      }),

      // ── The debrief paragraph, IF the instructor left it on ──────────────────
      ...(debrief ? [{
        id: debrief.field,
        render: ({ onDone }: { onDone: () => void }) => (
          <DebriefScreen question={debrief} history={history} labels={labels} unit={unit} onDone={onDone} />
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
