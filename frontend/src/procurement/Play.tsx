import { useEffect, useState } from 'react'
import { auth } from '../firebase'
import { useStudentSession, typography, colors } from '@mygames/game-ui'
import type { BootstrapArgs } from '@mygames/game-ui'
import { PageShell } from '../shared/PageShell'
import { SequenceRunner, loopScreen, type SequenceScreen } from '../shared/sequence'
import { PlaceBid, RoundResult } from './RoundScreen'
import { OpenBidScreen, OpenRoundEnd, OpenAllRoundsDone } from './OpenBidScreen'
import { KcScreen } from './KcScreen'
import { FreeTextScreen } from './FreeTextScreen'
import { EndScreen } from './EndScreen'
import { procurementResumeIndex, procurementScreenCount, procurementStartIteration } from './resume'
import {
  procurementBootstrap, procurementGetState, procurementGetQuestions, STUDENT_CLASSROOM_URL,
  type ProcurementParams, type ProcurementPlayedRow, type ProcurementRoundResult,
  type ProcurementKcQuestionClient, type ProcurementRivalPoint,
  type ProcurementAuction, type ProcurementOpenTurn,
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
// ⚠⚠ THE TWO FORMATS SHARE THIS ENTRY POINT, AND SHARE EVERYTHING EXCEPT THE ROUND LOOP.
// KC, prep, debrief, resume and scoring are identical; `state.params.format` selects which
// pair of screens the loop is built from.
//
// The CP3-era refusal that used to live here — a "This instance uses the open-bid format
// … nothing you do here is recorded" notice — is GONE, replaced by the real screens. It
// existed so an open instance could never be resolved through the sealed mechanism, and
// that guarantee now comes from the server: `procurementSubmitBid` routes by format and
// `procurementAdvance`/`procurementDropOut` refuse a sealed instance outright.
//
// ⚠ THE OPEN LOOP RE-READS `getState` BETWEEN ROUNDS. Each round's auction is opened
// lazily by the server when the student arrives (openAuctionStore.ts), because
// `nextBotAtMs` is a wall-clock fact — a round opened while the student was still reading
// the previous result would have its first bot bid already overdue.
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
  // ⚠ OPEN FORMAT ONLY. The auction the student is looking at, as the SERVER committed it.
  // Null while the next round's is being fetched — the screen says so rather than showing
  // a stale price from the round just finished.
  const [auction, setAuction] = useState<ProcurementAuction | null>(null)

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
        setAuction(state.auction)

        if (startIndex >= total) {
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

  if (loaded === null) {
    return <PageShell><p style={{ fontFamily: typography.fontFamily }}>Loading…</p></PageShell>
  }

  const isOpen = loaded.params.format === 'open_descending'

  // ⚠ THE OPEN FORMAT DOES NOT REUSE `EndScreen`. Its scatter plots bid against cost with
  // the first-price optimal line β — the wrong benchmark for this mechanism entirely
  // (open §7 replaces it with the exit-price scatter, which is CP4b). Drawing it here
  // would assert a line these rounds were never played against.
  const results = (onContinue?: () => void) => isOpen ? (
    <OpenAllRoundsDone
      params={loaded.params}
      roundsPlayed={history.length}
      roundsWon={totals.wins}
      totalProfit={totals.profit}
      onContinue={onContinue}
    />
  ) : (
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

  /** Everything a turn's response says about where the student now stands. */
  const applyTurn = (turn: ProcurementOpenTurn) => {
    setHistory(turn.history)
    setTotals({ profit: turn.totalProfit, benchmark: 0, wins: turn.roundsWon })
  }

  // ── THE OPEN LOOP (open §4.6, §5.1) ────────────────────────────────────────
  const openLoop = loopScreen<ProcurementOpenTurn>({
    id: 'procurement-open-rounds',
    startIteration: loaded.startIteration,
    ask: ({ iteration, onResult }) => (
      // ⚠ Null means the next round's auction is still being opened. Showing the previous
      // round's price here would be exactly the "server holds a price the screen has not
      // reached" state §4.6 rejects — in miniature, and at the worst moment.
      (auction === null || cost === null)
        ? <p style={{ fontFamily: typography.fontFamily }}>Opening the next auction…</p>
        : (
          <OpenBidScreen
            // ⚠ Keyed by round: the screen owns the live auction state, and it must be
            // discarded rather than reconciled when the round changes.
            key={auction.round}
            params={loaded.params}
            roundNumber={iteration + 1}
            cost={cost}
            auction={auction}
            totalProfit={totals.profit}
            onRoundEnd={turn => {
              applyTurn(turn)
              setAuction(turn.auction)
              onResult(turn, turn.gameOver)
            }}
          />
        )
    ),
    display: ({ result, done, onContinue }) => (
      <OpenRoundEnd
        params={loaded.params}
        outcome={result.roundOutcome!}
        done={done}
        onContinue={() => {
          if (done) { onContinue(); return }
          // ⚠ CLEAR FIRST, THEN FETCH. The next round's auction is opened by the SERVER
          // when this call arrives, so its `nextBotAtMs` starts from the moment the
          // student actually gets there rather than from when the last round ended.
          setAuction(null)
          setCost(null)
          onContinue()
          void procurementGetState()
            .then(s => { setCost(s.currentCost); setAuction(s.auction) })
            .catch(() => setScreen({
              name: 'error',
              message: 'We could not open the next auction. Please reload the page.',
            }))
        }}
      />
    ),
  })

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

    // ── The round loop. ⚠ ONE OR THE OTHER, chosen by the instance's format: an open
    //    instance resolved through the sealed mechanism would produce rounds whose
    //    numbers mean something other than what the instance says they mean, which is
    //    what the `format` lock exists to prevent. The server refuses it independently.
    isOpen ? openLoop : loopScreen<ProcurementRoundResult>({
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
