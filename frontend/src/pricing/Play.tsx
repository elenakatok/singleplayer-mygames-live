import { useEffect, useState } from 'react'
import { auth } from '../firebase'
import {
  pricingBootstrap, pricingGetState, STUDENT_CLASSROOM_URL,
  type PricingHistoryRow, type PricingLabels, type PricingMarket, type PricingRoundResult,
} from './api'
import { PageShell } from '../shared/PageShell'
import { SequenceRunner, loopScreen, type SequenceScreen } from '../shared/sequence'
import { ChoosePrice, RevealRound } from './RoundScreen'
import { EndScreen } from './EndScreen'
import { pricingResume } from './resume'
import { useStudentSession, typography } from '@mygames/game-ui'
import type { BootstrapArgs } from '@mygames/game-ui'

// ═══════════════════════════════════════════════════════════════════════════════
// Pricing Game (Cheyenne Shipping) — student entry.
//
// SLICE 2 — the round loop on screen:
//
//   price entry  →  round result  →  … until the SERVER says done  →  end screen
//
// The knowledge check (spec §8) comes BEFORE the loop and the debrief (spec §9)
// after it; both arrive in the next slice, and both slot into the same sequence the
// loop already runs in, exactly as PD's do.
//
// RESUME, one rule: every fact the flow branches on is stored on the SERVER — the
// rounds played and the phase. Nothing is kept in the browser, so a student resumes
// identically on another device. See resume.ts for what that does and does not
// restore.
//
// ⚠ The drawn round count and the competitor's rule never reach this file (spec §3,
// §5) — see api.ts, which is the whole client-side contract. The loop is UNBOUNDED
// here: it ends when the server says a round was the last one, never because the
// client counted to a total it was given.
// ═══════════════════════════════════════════════════════════════════════════════

type Loaded = {
  pmg: boolean
  labels: PricingLabels
  market: PricingMarket
  minRounds: number
  maxRounds: number
}

type Screen =
  | { name: 'loading' }
  | { name: 'error'; message: string }
  | { name: 'flow'; startIteration: number }
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

  useEffect(() => {
    if (session.kind !== 'ready') return
    let cancelled = false
    pricingGetState()
      .then(state => {
        if (cancelled) return
        setLoaded({
          pmg: state.pmg,
          labels: state.labels,
          market: state.market,
          minRounds: state.minRounds,
          maxRounds: state.maxRounds,
        })
        setHistory(state.history)
        setTotals({ total: state.totalProfit, average: state.averageProfit })
        const { finished, startIteration } = pricingResume({
          phase: state.phase,
          roundsPlayed: state.history.length,
        })
        setScreen(finished ? { name: 'done' } : { name: 'flow', startIteration })
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
        />
      </PageShell>
    )
  }

  if (screen.name === 'flow' && loaded !== null) {
    const { pmg, labels, market, minRounds, maxRounds } = loaded

    const screens: SequenceScreen[] = [
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
    ]

    return (
      <PageShell>
        <SequenceRunner
          screens={screens}
          startIndex={0}
          onAllComplete={() => setScreen({ name: 'done' })}
        />
      </PageShell>
    )
  }

  return <main style={{ padding: '2rem', fontFamily: typography.fontFamily }}><p>Loading…</p></main>
}
