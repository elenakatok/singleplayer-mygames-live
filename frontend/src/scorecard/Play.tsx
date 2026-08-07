import { useEffect, useState } from 'react'
import { auth } from '../firebase'
import { useStudentSession, typography } from '@mygames/game-ui'
import type { BootstrapArgs } from '@mygames/game-ui'
import { PageShell } from '../shared/PageShell'
import {
  scorecardBootstrap, scorecardGetState, scorecardSubmitPeriod, scorecardGetQuestions,
  STUDENT_CLASSROOM_URL,
  type ScorecardState, type ScorecardQuestions, type ScorecardReveal,
} from './api'
import { EffortScreen, ContractResultScreen } from './EffortScreen'
import { SessionSummary } from './SessionSummary'
import { KcScreen } from './KcScreen'
import { DebriefScreen, RevealPanel } from './DebriefScreen'

// ═══════════════════════════════════════════════════════════════════════════════
// Metalcraft Supplier Scorecard — student entry. The flow (spec §4):
//
//   KC  →  loop(contracts){ contract-start → loop(periods){ effort → compute }
//                           → contract-result }
//       →  session summary  →  debrief  →  reveal
//
// ⚠⚠ THE NESTED LOOP IS DRIVEN HERE, BY HAND — it deliberately does NOT use the family's
// `loopScreen` primitive (spec §14.2). That primitive does not nest, and generalising it
// for one consumer is the wrong trade: contracts are independent of each other (which is
// what satisfies architecture §2.4), but periods within a contract are not, and resume,
// key isolation and the balance reset all live at the contract boundary. Standing debt:
// if a second nested-loop game appears, extract then.
//
// ⚠⚠ THE SERVER OWNS THE POSITION. This component holds NO loop counter of its own — no
// "current contract" and no "current period" state. Every screen is rendered from the
// `ScorecardState` the server last returned, and every transition replaces that state
// wholesale. That is what makes resume free: a returning student's first `getState` puts
// them exactly where they were, and there is no client-side index that could disagree
// with the server about which period is open.
//
// ⚠⚠ T10 — `key={state.screen.id}`. The server mints an id that carries BOTH indices
// (`effort-c3-p7`), so React remounts the subtree on every period AND across the contract
// boundary. The boundary is the second instance of the PD bug class: it is where the
// balance resets to the endowment, the score resets to zero and the reliability may
// change, so a retained radio selection or a stale derived value would survive into a
// screen on which every number around it has moved. A period-only key would collide at
// c1p1 / c2p1 — exactly the transition that matters.
//
// ⚠ THE REVEAL IS NOT FETCHED SPECULATIVELY. It arrives in the debrief's own response
// and nowhere else; it would be refused anyway (the gate is server-side), but not asking
// for the answer key until it has been earned keeps the client honest.
// ═══════════════════════════════════════════════════════════════════════════════

type Phase =
  | { name: 'loading' }
  | { name: 'error'; message: string }
  | { name: 'kc'; index: number }
  | { name: 'play' }
  | { name: 'debrief' }
  | { name: 'reveal'; reveal: ScorecardReveal }

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
      const r = await scorecardBootstrap(args)
      return {
        participantId: r.participant_id,
        gameInstanceId: r.game_instance_id,
        customToken: r.customToken,
      }
    },
  })

  const [phase, setPhase] = useState<Phase>({ name: 'loading' })
  const [state, setState] = useState<ScorecardState | null>(null)
  const [questions, setQuestions] = useState<ScorecardQuestions | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (session.kind !== 'ready') return
    let cancelled = false
    Promise.all([scorecardGetState(), scorecardGetQuestions()])
      .then(([st, qs]) => {
        if (cancelled) return
        setState(st)
        setQuestions(qs)

        // ── Resume: every step's completion is a fact stored on the server ─────
        // Nothing is kept in the browser, so a student resumes identically on another
        // device. The KC comes first (spec §4); an unfinished KC resumes at the first
        // unanswered question.
        const answered = new Set(qs.kc.answeredIds)
        const nextKc = qs.kc.questions.findIndex(q => !answered.has(q.id))
        if (nextKc !== -1) { setPhase({ name: 'kc', index: nextKc }); return }
        if (!st.gameOver) { setPhase({ name: 'play' }); return }
        if (!qs.debrief.answered) { setPhase({ name: 'debrief' }); return }
        // ⚠ A finished student who already wrote their debrief lands back on the session
        // summary rather than a dead end. The reveal itself is NOT re-fetched — it comes
        // only from the debrief submission, and asking again would be asking for the
        // answer key a second time.
        setPhase({ name: 'play' })
      })
      .catch(err => {
        if (!cancelled) {
          setPhase({
            name: 'error',
            message: err instanceof Error ? err.message : 'Failed to load the game.',
          })
        }
      })
    return () => { cancelled = true }
  }, [session])

  // ── Transitions ────────────────────────────────────────────────────────────

  async function submitPeriod(action: 'high' | 'low') {
    if (!state?.contract || busy) return
    setBusy(true)
    try {
      setState(await scorecardSubmitPeriod(state.contract.contract, state.contract.period, action))
    } catch (e) {
      setPhase({ name: 'error', message: e instanceof Error ? e.message : 'Could not submit.' })
    } finally {
      setBusy(false)
    }
  }

  /** Contract-result → the next contract's period 1 (spec §4). */
  async function advance() {
    if (busy) return
    setBusy(true)
    try {
      // ⚠ `advance: true` is a GATED READ. The server refuses it unless the student is
      // genuinely at contract-result, so it cannot be used to look ahead — and it writes
      // nothing, so the next contract's reliability does not exist until its first period
      // is submitted.
      setState(await scorecardGetState(true))
    } catch (e) {
      setPhase({ name: 'error', message: e instanceof Error ? e.message : 'Could not continue.' })
    } finally {
      setBusy(false)
    }
  }

  // ── Session chrome ─────────────────────────────────────────────────────────

  if (session.kind === 'loading') {
    return <main style={{ padding: '2rem', fontFamily: typography.fontFamily }}><p>Loading…</p></main>
  }
  if (session.kind === 'no-token') {
    return (
      <main style={{ padding: '2rem', fontFamily: typography.fontFamily, maxWidth: 480, margin: '2rem auto' }}>
        <h2 style={{ marginBottom: '0.75rem' }}>The Supplier Scorecard Game</h2>
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

  if (phase.name === 'error') {
    return <PageShell><p style={{ color: '#c00' }}>{phase.message}</p></PageShell>
  }
  if (phase.name === 'loading' || state === null || questions === null) {
    return <main style={{ padding: '2rem', fontFamily: typography.fontFamily }}><p>Loading…</p></main>
  }

  // ── The knowledge check (spec §9) ──────────────────────────────────────────
  if (phase.name === 'kc') {
    const q = questions.kc.questions[phase.index]
    return (
      <PageShell>
        {/* ⚠ Keyed on the question id, for the same reason the play screens are keyed —
            a retained radio selection must not survive into the next question. */}
        <KcScreen
          key={q.id}
          question={q}
          index={phase.index}
          total={questions.kc.total}
          onDone={() => {
            const next = phase.index + 1
            if (next < questions.kc.questions.length) setPhase({ name: 'kc', index: next })
            else setPhase({ name: 'play' })
          }}
        />
      </PageShell>
    )
  }

  // ── The debrief and the reveal (spec §10) ──────────────────────────────────
  if (phase.name === 'reveal') {
    return <PageShell><RevealPanel reveal={phase.reveal} params={state.params} /></PageShell>
  }
  if (phase.name === 'debrief') {
    return (
      <PageShell>
        <DebriefScreen
          question={questions.debrief}
          params={state.params}
          onDone={(reveal) => setPhase({ name: 'reveal', reveal })}
        />
      </PageShell>
    )
  }

  // ── The nested loop (spec §4) ──────────────────────────────────────────────
  //
  // ⚠ EVERY BRANCH IS KEYED ON `state.screen.id` (T10). The id carries the contract AND
  // the period, so the subtree remounts at both boundaries.
  return (
    <PageShell>
      {state.screen.kind === 'effort-choice' && state.contract !== null && (
        <EffortScreen
          key={state.screen.id}
          contract={state.contract}
          params={state.params}
          onSubmit={submitPeriod}
          busy={busy}
        />
      )}

      {state.screen.kind === 'contract-result' && state.result !== null && (
        <ContractResultScreen
          key={state.screen.id}
          result={state.result}
          params={state.params}
          isLast={state.contractsCompleted >= state.params.contracts}
          onContinue={advance}
          busy={busy}
        />
      )}

      {state.screen.kind === 'session-summary' && (
        <SessionSummary
          key={state.screen.id}
          completed={state.completed}
          params={state.params}
          totalEarnings={state.totalEarnings}
          onContinue={questions.debrief.answered ? undefined : () => setPhase({ name: 'debrief' })}
        />
      )}

      {/* The prior-contracts panel (spec §3) — this student's own completed contracts,
          shown alongside the contract in play. Never a class comparison (spec §5). */}
      {state.params.showPriorContractsPanel
        && state.screen.kind === 'effort-choice'
        && state.completed.length > 0 && (
        <div style={{ marginTop: '1.5rem', opacity: 0.85 }}>
          <SessionSummary
            completed={state.completed}
            params={state.params}
            totalEarnings={state.totalEarnings}
          />
        </div>
      )}
    </PageShell>
  )
}
