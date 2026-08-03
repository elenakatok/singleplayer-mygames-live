import { useEffect, useState } from 'react'
import { auth } from '../firebase'
import { useStudentSession, typography, colors } from '@mygames/game-ui'
import type { BootstrapArgs } from '@mygames/game-ui'
import { PageShell } from '../shared/PageShell'
import { SequenceRunner, loopScreen, type SequenceScreen } from '../shared/sequence'
import { PlaceBid, RoundResult } from './RoundScreen'
import { EndScreen } from './EndScreen'
import {
  procurementBootstrap, procurementGetState, STUDENT_CLASSROOM_URL,
  type ProcurementParams, type ProcurementPlayedRow, type ProcurementRoundResult,
} from './api'

// ═══════════════════════════════════════════════════════════════════════════════
// Procurement Auction — student entry. The flow, as of Checkpoint 3a:
//
//   the round loop  →  final results
//   (see your cost → bid → resolve → round result, ×8)
//
// ⚠ NOT YET IN THIS FLOW: the knowledge check, the prep paragraph and the debrief
// paragraph. All three exist server-side and are reachable through
// `procurementGetQuestions` / `procurementSubmitKcAnswer` / `procurementSubmitFreeText`;
// they are not wired into this sequence yet (CP3b). This is an omission, stated, not a
// stub pretending to be a screen.
//
// ⚠ THE TWO FORMATS SHARE THIS ENTRY POINT. `state.params.format` selects the bidding
// screen — sealed today, open at CP4 — and nothing else about the flow differs. Never a
// second Play component and never a second route: `format` is instance config. The open
// format has no screen yet and says so below rather than rendering the sealed one, which
// would silently resolve a different mechanism than the instance is configured for.
//
// ⚠ THE ROUND COUNT IS SHOWN in this game, unlike PD and pricing. Rounds are independent
// (§2), so there is no endgame effect a visible horizon would let a student exploit, and
// `params.rounds` is public config.
//
// RESUME: every step's completion is a fact stored on the server. `startIteration` is
// just `roundsPlayed`, and the current round's cost is re-derived server-side from
// (seed, participantId, round) rather than cached in the browser — so a student resumes
// identically on another device, and cannot reload into a friendlier cost.
// ═══════════════════════════════════════════════════════════════════════════════

type Loaded = {
  params: ProcurementParams
  startIteration: number
  currentCost: number | null
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
  // The running history and totals: seeded by getState, then REPLACED WHOLESALE by each
  // round's response. The server returns the entire history every time, so the client
  // never accumulates and cannot drift out of step with the stored record.
  const [history, setHistory] = useState<ProcurementPlayedRow[]>([])
  const [totals, setTotals] = useState({ profit: 0, benchmark: 0, wins: 0 })
  // The cost for the round about to be played. Server-derived, never computed here.
  const [cost, setCost] = useState<number | null>(null)

  useEffect(() => {
    if (session.kind !== 'ready') return
    let cancelled = false
    procurementGetState()
      .then(state => {
        if (cancelled) return
        setLoaded({
          params: state.params,
          startIteration: state.roundsPlayed,
          currentCost: state.currentCost,
        })
        setHistory(state.played)
        setTotals({
          profit: state.totalProfit,
          benchmark: state.totalEquilibriumProfit,
          wins: state.roundsWon,
        })
        setCost(state.currentCost)

        if (state.params.format !== 'sealed_first_price') {
          setScreen({ name: 'unsupported-format' })
        } else if (state.gameOver || state.roundsPlayed >= state.params.rounds) {
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
  // than what the instance says they mean — which is exactly what the `format` lock
  // exists to prevent (instance.ts).
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

  if (screen.name === 'done') {
    return (
      <PageShell>
        <EndScreen
          params={loaded.params}
          history={history}
          totalProfit={totals.profit}
          totalEquilibriumProfit={totals.benchmark}
          roundsWon={totals.wins}
        />
      </PageShell>
    )
  }

  const screens: SequenceScreen[] = [
    loopScreen<ProcurementRoundResult>({
      id: 'procurement-rounds',
      startIteration: loaded.startIteration,
      ask: ({ iteration, onResult }) => (
        // The cost can only be null if the server said there was no round to play, and
        // that case never reaches here — `done` is decided above. Guarding rather than
        // asserting: a bidding screen with a missing cost must not render a bid field.
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
