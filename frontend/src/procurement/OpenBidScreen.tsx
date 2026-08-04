import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { colors, typography } from '@mygames/game-ui'
import {
  procurementAdvance, procurementOpenBid, procurementDropOut,
  type ProcurementAuction, type ProcurementOpenTurn, type ProcurementParams,
  type DecrementBand,
} from './api'
import { ecu, signedEcu } from './format'

// ═══════════════════════════════════════════════════════════════════════════════
// THE OPEN-DESCENDING BIDDING SCREEN (open §5.1). Modeled on deck slides 17–21.
//
// ⚠⚠ THE SCREEN RENDERS THE COMMITTED STATE AND NOTHING ELSE. There is no local price,
// no animation between two server states, no optimistic bid. Every number here came back
// from a commit, which is what makes "the price you see is the price you bid against"
// true by construction rather than by care (open §4.6). Do not add interpolation.
//
// ⚠ THE CLIENT'S ONLY JOB IS *WHEN* TO ASK. The tick below waits until `nextBotAtMs` and
// calls `procurementAdvance`; the server decides whether it was time and what the bot
// bids. A client that called every 50ms would get exactly the same auction.
//
// ⚠ THE BID BOX IS LIVE AND PRE-FILLED AT ALL TIMES, including while bots are bidding
// (§5.1). It re-defaults to the minimum legal bid as the standing moves but NEVER
// overwrites a number the player has typed — that pairing is what makes a 2–3s window
// enough to take part, because the player's move is a click rather than a
// decision-plus-typing.
//
// ⚠ NO TIMEOUT ANYWHERE (§4.4). A halted round waits indefinitely. Do not add a countdown,
// an auto-drop, or an "are you still there?" — a single player who sits idle blocks nobody,
// and every one of those would turn a deliberate pause into a forfeit.
//
// ⚠ A BACKGROUNDED TAB PAUSES THE AUCTION and that is harmless (§4.6). "The round froze"
// reports will happen and the answer is almost always a backgrounded tab; the banner below
// says so rather than leaving the screen silent.
// ═══════════════════════════════════════════════════════════════════════════════

const card: CSSProperties = {
  border: `1px solid ${colors.borderMid}`, borderRadius: 8,
  padding: '1rem 1.15rem', marginTop: '1rem', background: colors.white,
}

/** The step in force at a price — the same band rule the server uses (§4.2), needed here
 *  only to MARK BAND CHANGES in the history. ⚠ Never used to decide legality: the server
 *  owns that, and the client's copy is a caption. */
function stepAt(price: number, schedule: DecrementBand[]): number {
  for (const b of schedule) if (price > b.above) return b.step
  return schedule.length > 0 ? schedule[schedule.length - 1].step : 1
}

export function OpenBidScreen({
  params,
  roundNumber,
  cost,
  auction: initialAuction,
  totalProfit,
  onRoundEnd,
}: {
  params: ProcurementParams
  roundNumber: number
  /** The student's OWN drawn cost for this round, from the server (§4). */
  cost: number
  auction: ProcurementAuction
  totalProfit: number
  /** Called once the SERVER has resolved the round, with everything it returned. */
  onRoundEnd: (turn: ProcurementOpenTurn) => void
}) {
  const c = params.currencyLabel

  const [auction, setAuction] = useState(initialAuction)
  const [typed, setTyped] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // ⚠ THE COLD-START FLAG. Play is asynchronous — students play days apart — so the FIRST
  // call of a session is usually a cold function start: a few seconds before anything
  // happens, then smooth, because the round's own traffic keeps it warm. This is not a
  // stall, and the screen must say something during it rather than sitting blank (§4.6).
  const [slow, setSlow] = useState(false)

  // One in-flight request at a time. Without this a slow advance and a click would both
  // land, and the second would act on a state the player never saw.
  const inFlight = useRef(false)
  const ended = useRef(false)

  const apply = useCallback((turn: ProcurementOpenTurn) => {
    setAuction(turn.auction)
    setError(turn.rejected)
    // ⚠ A REJECTED BID CLEARS THE TYPED NUMBER so the box re-defaults to the NEW minimum.
    // Leaving the refused number in place would invite the player to click Bid again on
    // the same illegal amount.
    if (turn.rejected !== null) setTyped(null)
    if (turn.roundOutcome !== null && !ended.current) {
      ended.current = true
      onRoundEnd(turn)
    }
  }, [onRoundEnd])

  const call = useCallback(async (fn: () => Promise<ProcurementOpenTurn>) => {
    if (inFlight.current || ended.current) return
    inFlight.current = true
    const slowTimer = setTimeout(() => setSlow(true), 1_200)
    try {
      apply(await fn())
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong. Try again.')
    } finally {
      clearTimeout(slowTimer)
      setSlow(false)
      inFlight.current = false
    }
  }, [apply])

  // ── the tick: wait until the bot is due, then ask ─────────────────────────
  //
  // ⚠ ONE TIMER, RE-ARMED FROM THE SERVER'S OWN `nextBotAtMs` after every commit. Not a
  // polling interval: an interval would call constantly and be refused constantly, and it
  // would drift out of step with a schedule the server is free to change mid-round.
  useEffect(() => {
    if (auction.status !== 'bot_turn' || ended.current) return
    const wait = Math.max(0, (auction.nextBotAtMs ?? 0) - Date.now())
    const t = setTimeout(() => { void call(procurementAdvance) }, wait)
    return () => clearTimeout(t)
  }, [auction.status, auction.nextBotAtMs, auction.sequence, call])

  // ⚠ THE PRE-FILL RE-DEFAULTS AS THE STANDING MOVES, BUT NEVER OVERWRITES A TYPED NUMBER
  // (§5.1). `typed === null` means "the player has not touched the box", so the value
  // shown is always the current minimum; the moment they type, it is theirs.
  const minNext = auction.minNextBid
  const boxValue = typed ?? (minNext === null ? '' : String(minNext))

  const parsed = /^\d+$/.test(boxValue.trim()) ? Number(boxValue.trim()) : NaN
  const live = auction.status !== 'resolved' && !auction.youAreOut && !busy
  // ⚠ §4.2: THE HOLDER MAY NOT UNDERCUT THEMSELVES, and that includes the player. The box
  // stays live while the BOTS bid (§5.1) — which is exactly the window in which the player
  // holds their own bid — so bidding is closed while they are winning. The server refuses
  // it independently; this is what stops the screen inviting it. Drop Out stays live:
  // quitting while ahead is a real, if unwise, decision.
  const canBid = live && !auction.youHold

  const submit = async (amount: number) => {
    setBusy(true)
    // ⚠ THE SEQUENCE THE PLAYER WAS LOOKING AT travels with the bid, so a collision can be
    // described accurately. It is never why a bid is refused — the server re-checks
    // against the new standing and accepts if it still clears (§4.6).
    await call(() => procurementOpenBid(amount, auction.sequence))
    setTyped(null)
    setBusy(false)
  }

  return (
    <div style={{ fontFamily: typography.fontFamily }}>
      <p style={{ fontSize: '0.8rem', color: colors.textSecondary, margin: 0 }}>
        Round {roundNumber} of {params.rounds}
      </p>
      <h1 style={{ fontSize: '1.15rem', margin: '0.25rem 0 0' }}>
        You are bidding to provide a widget
      </h1>

      {/* ── the standing price: the biggest thing on the screen ─────────── */}
      <section style={card}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.75rem', flexWrap: 'wrap' }}>
          <span style={{ fontSize: '0.8rem', color: colors.textSecondary }}>
            Current auction price
          </span>
          <strong data-testid="proc-open-standing" style={{ fontSize: '2rem' }}>
            {auction.standing}
          </strong>
          <span style={{ fontSize: '0.8rem', color: colors.textSecondary }}>{c}</span>
          {auction.holderLabel !== null && (
            <span data-testid="proc-open-holder" style={{ fontSize: '0.85rem', color: colors.textSecondary }}>
              held by {auction.holderLabel}
            </span>
          )}
          {auction.holderLabel === null && (
            <span style={{ fontSize: '0.85rem', color: colors.textSecondary }}>
              the incumbent's price — nobody has bid yet
            </span>
          )}
        </div>

        {/* ⚠ WINNING / NOT WINNING, in the spec's own words and colours (§5.1). */}
        <p
          data-testid="proc-open-winning"
          style={{
            margin: '0.5rem 0 0', fontWeight: 600,
            color: auction.youHold ? colors.successText ?? '#0a7' : colors.errorAction,
          }}
        >
          {auction.youAreOut ? 'You have dropped out of this auction'
            : auction.youHold ? 'You are winning' : 'You are not winning'}
        </p>

        <dl style={{ margin: '0.7rem 0 0', fontSize: '0.85rem', color: colors.textSecondary }}>
          {/* ⚠⚠ THE OPENING TOTAL, AND ONLY THE OPENING TOTAL. It never moves. There was
              a "Still bidding — 3 of 5" row here; it is gone, along with the field behind
              it (Elena, 2026-08-04). A competitor's departure is not announced in a live
              auction: the player infers it from silence, and silence is ambiguous between
              "priced out" and "still thinking". A count destroys that. ⚠ Do not restore
              it — the server no longer computes it, and that is deliberate. */}
          <Fact
            label="Bidders"
            value={`${auction.totalBidders} in this auction, including you`}
            testId="proc-open-bidders"
          />
          <Fact label="Your cost" value={ecu(cost, c)} testId="proc-open-cost" />
          <Fact label="Reserve" value={ecu(params.reserve, c)} />
          {auction.minNextBid !== null && (
            <Fact
              label="Minimum next bid"
              value={`${auction.minNextBid} ${c} — bids must fall by at least ${auction.step} ${c}`}
              testId="proc-open-min"
            />
          )}
        </dl>
      </section>

      {/* ── the controls ─────────────────────────────────────────────────── */}
      <section style={card}>
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            data-testid="proc-open-bid-input"
            aria-label={`Your bid in ${c}`}
            inputMode="numeric"
            value={boxValue}
            disabled={!canBid}
            style={{ width: '6rem', padding: '0.4rem 0.5rem', fontSize: '1.1rem' }}
            onChange={e => setTyped(e.target.value)}
          />
          <button
            data-testid="proc-open-bid"
            disabled={!canBid || !Number.isInteger(parsed)}
            onClick={() => void submit(parsed)}
          >
            Bid
          </button>
          {/* ⚠ ONE CLICK, NO TYPING (§5.1). This button is why a 2–3s gap is enough for
              genuine participation: a player who has decided needs only to press it. */}
          <button
            data-testid="proc-open-bid-min"
            disabled={!canBid || minNext === null}
            onClick={() => { if (minNext !== null) void submit(minNext) }}
          >
            Bid minimum ({minNext ?? '—'})
          </button>
          <span style={{ flex: 1 }} />
          {/* ⚠ DROP OUT EXISTS HERE AND ONLY HERE (§4.5). A deliberate strategic action,
              recorded as play — never a timeout and never an absence. */}
          <button
            data-testid="proc-open-dropout"
            disabled={!live}
            onClick={() => { void call(procurementDropOut) }}
          >
            Drop Out
          </button>
        </div>

        {error !== null && (
          <p data-testid="proc-open-error" style={{ margin: '0.6rem 0 0', color: colors.errorAction, fontSize: '0.85rem' }}>
            {error}
          </p>
        )}

        <p style={{ margin: '0.6rem 0 0', fontSize: '0.78rem', color: colors.textSecondary }}>
          You may bid lower than the minimum — a bigger jump is legal, and sometimes
          useful. There is no clock: the auction waits for you.
        </p>

        {/* ⚠ SOMETHING VISIBLE DURING A COLD START (§4.6). Play is asynchronous, so the
            first call of a session usually waits on a cold function. Silence reads as a
            broken page; this reads as an auction that has not opened yet. */}
        {slow && (
          <p data-testid="proc-open-slow" style={{ margin: '0.5rem 0 0', fontSize: '0.8rem', color: colors.textSecondary }}>
            Opening the auction… the first move of a session can take a few seconds.
          </p>
        )}
        {auction.youHold && auction.status !== 'resolved' && (
          <p data-testid="proc-open-holding" style={{ margin: '0.5rem 0 0', fontSize: '0.8rem', color: colors.textSecondary }}>
            You hold the low bid — you cannot outbid yourself. Wait and see whether anyone
            undercuts you.
          </p>
        )}
        {auction.status === 'bot_turn' && !slow && !auction.youHold && (
          <p data-testid="proc-open-bots" style={{ margin: '0.5rem 0 0', fontSize: '0.8rem', color: colors.textSecondary }}>
            The other suppliers are bidding…
          </p>
        )}
        {/* ⚠ IT SAYS "IT IS YOUR MOVE", NOT "NOBODY ELSE WILL GO LOWER". The earlier
            wording announced, in words, exactly what removing the active-bidder count
            exists to withhold: that every remaining supplier has stopped. The player
            still gets the affordance — the price is not moving and the controls are
            live — without being told why. ⚠ See the residual noted in BUILD_NOTES §6h:
            `status` itself still carries this boundary, because the client has to know
            when to stop asking. */}
        {auction.status === 'waiting' && (
          <p data-testid="proc-open-waiting" style={{ margin: '0.5rem 0 0', fontSize: '0.8rem', color: colors.textSecondary }}>
            It is your move — bid, or drop out. There is no clock.
          </p>
        )}
      </section>

      {/* ── the history, most recent first, with band markers ───────────── */}
      <section style={card}>
        <h2 style={{ fontSize: '0.95rem', margin: '0 0 0.5rem' }}>Bidding so far</h2>
        <ol data-testid="proc-open-history" style={{ margin: 0, padding: 0, listStyle: 'none', fontSize: '0.88rem' }}>
          {historyRows(auction, params.decrementSchedule, params.reserve, c).map((row, i) => (
            row.kind === 'open' ? (
              /* ⚠ THE OPENING LINE. The auction begins with the incumbent's price
                 STANDING and UNOWNED (§4.1) — a real standing bid for the purpose of the
                 decrement rule, and the thing the first bid must undercut. Without this
                 row the history starts mid-story, and on a round nobody has bid in yet it
                 is empty, which reads as a page that has not loaded. It is rendered from
                 `params.reserve`, public config, not from a synthetic server event: a
                 fabricated event would end up in `open_history` and in §5.2's replay as
                 a bid that nobody made. */
              <li key={`open-${i}`} data-testid="proc-open-opened"
                style={{ padding: '0.2rem 0', color: colors.textSecondary }}>
                Auction opened at {row.amount}
              </li>
            ) : row.kind === 'band' ? (
              /* ⚠ THE MOMENT 5 BECOMES 2 IS WHEN THE ENDGAME STARTS (§5.1). A player who
                 misses it will misjudge how much room is left, so it is marked rather
                 than left to be inferred from the numbers. */
              <li key={`band-${i}`} data-testid="proc-open-band"
                style={{ padding: '0.3rem 0', color: colors.textSecondary, fontStyle: 'italic' }}>
                — steps are now {row.step} {c} —
              </li>
            ) : (
              <li key={`row-${i}`} style={{
                padding: '0.2rem 0',
                fontWeight: row.isYou ? 600 : 400,
                borderBottom: `1px solid ${colors.borderLight ?? '#eee'}`,
              }}>
                {row.label}{row.amount === null ? ' — dropped out' : ` — ${row.amount}`}
              </li>
            )
          ))}
        </ol>
      </section>

      <p style={{ fontSize: '0.8rem', color: colors.textSecondary }}>
        Cumulative profit so far: {signedEcu(totalProfit, c)}
      </p>
    </div>
  )
}

type Row =
  | { kind: 'event'; label: string; amount: number | null; isYou: boolean }
  | { kind: 'band'; step: number }
  | { kind: 'open'; amount: string }

/**
 * The history, MOST RECENT FIRST, with a marker wherever the step size changed and the
 * opening price as the oldest row.
 *
 * ⚠ THE MARKER IS COMPUTED FROM THE SCHEDULE, not stored per event, so an instructor who
 * retunes the bands at the §9 step-5 checkpoint sees the markers move with them.
 *
 * ⚠ EVERY ROW IS AN ACTION SOMEBODY TOOK, or the auction opening. There is no "bot 3 has
 * stopped" row and there is no way to render one — the server never emits such an event
 * (see `OpenEvent` in auction/openAuction.ts). That invariant is what lets this list stay
 * fully public while the active-bidder count does not: a bid is an announcement, and a
 * departure is silence.
 */
function historyRows(
  auction: ProcurementAuction,
  schedule: DecrementBand[],
  reserve: number,
  currency: string,
): Row[] {
  const rows: Row[] = []
  const events = auction.history
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]
    rows.push({ kind: 'event', label: e.label, amount: e.amount, isYou: e.isYou })
    // Compare THIS bid's band with the one before it, in chronological order — the
    // marker belongs between them, which reading backwards means after the newer row.
    const prev = events[i - 1]
    if (e.kind === 'bid' && prev?.kind === 'bid' && prev.amount !== null && e.amount !== null) {
      const now = stepAt(e.amount, schedule)
      const before = stepAt(prev.amount, schedule)
      if (now !== before) rows.push({ kind: 'band', step: now })
    }
  }
  // Oldest last, because the list reads newest first.
  rows.push({ kind: 'open', amount: ecu(reserve, currency) })
  return rows
}

/**
 * All rounds played, in the OPEN format.
 *
 * ⚠⚠ THIS IS NOT §5.3. The final-results screen — the per-round table, the exit-price
 * scatter, the benchmark — is CP4b. The sealed format's `EndScreen` is deliberately NOT
 * reused: its scatter plots bid against cost with the first-price optimal line `β`, which
 * is the wrong benchmark for this mechanism entirely (§7 replaces it with the exit-price
 * scatter). Showing it here would assert a line these rounds were never played against.
 */
export function OpenAllRoundsDone({
  params,
  roundsPlayed,
  roundsWon,
  totalProfit,
  onContinue,
}: {
  params: ProcurementParams
  roundsPlayed: number
  roundsWon: number
  totalProfit: number
  onContinue?: () => void
}) {
  const c = params.currencyLabel
  return (
    <div style={{ fontFamily: typography.fontFamily }}>
      <h1 style={{ fontSize: '1.15rem' }}>That is all {roundsPlayed} auctions</h1>
      <section style={card}>
        <dl style={{ margin: 0, fontSize: '0.9rem' }}>
          <Fact label="Contracts won" value={`${roundsWon} of ${roundsPlayed}`} />
          <Fact label="Cumulative profit" value={signedEcu(totalProfit, c)} testId="proc-open-total" />
        </dl>
        <p style={{ margin: '0.7rem 0 0', fontSize: '0.85rem', color: colors.textSecondary }}>
          Your full results and the class charts are still being built — for now, one last
          question.
        </p>
      </section>
      {onContinue && (
        <p style={{ marginTop: '1rem' }}>
          <button data-testid="proc-open-done-continue" onClick={onContinue}>Continue</button>
        </p>
      )}
    </div>
  )
}

function Fact({ label, value, testId }: { label: string; value: string; testId?: string }) {
  return (
    <div style={{ display: 'flex', gap: '0.5rem', padding: '0.12rem 0' }}>
      <dt style={{ minWidth: '10rem', fontWeight: 600 }}>{label}</dt>
      <dd data-testid={testId} style={{ margin: 0 }}>{value}</dd>
    </div>
  )
}

/**
 * The round's outcome, DELIBERATELY SPARE.
 *
 * ⚠⚠ THIS IS NOT §5.2. The round-result screen — the gap message ("you stopped at 38, your
 * cost was 34, so you had 4 ECU of room left"), the counterfactual for a player who
 * dropped out, the replayable history — is CP4b (§9 step 6–7), and building it here would
 * put it on top of a loop whose feel is not yet confirmed. What is here is the minimum
 * that makes eight rounds playable: what happened, and a way onward.
 */
export function OpenRoundEnd({
  params,
  outcome,
  done,
  onContinue,
}: {
  params: ProcurementParams
  outcome: NonNullable<ProcurementOpenTurn['roundOutcome']>
  done: boolean
  onContinue: () => void
}) {
  const c = params.currencyLabel
  return (
    <div style={{ fontFamily: typography.fontFamily }}>
      <h1 style={{ fontSize: '1.15rem' }}>Round {outcome.round} — {outcome.won ? 'you won the contract' : 'you did not win'}</h1>
      <section style={card}>
        <dl style={{ margin: 0, fontSize: '0.9rem' }}>
          <Fact label="Final price" value={outcome.price === null ? 'no contract awarded' : ecu(outcome.price, c)} testId="proc-open-final-price" />
          <Fact label="Your last bid" value={outcome.yourLastBid === null ? 'you never bid' : ecu(outcome.yourLastBid, c)} />
          <Fact label="Your cost" value={ecu(outcome.yourCost, c)} />
          <Fact label="Profit this round" value={signedEcu(outcome.profit, c)} testId="proc-open-round-profit" />
          <Fact label="Cumulative profit" value={signedEcu(outcome.profitTotal, c)} />
        </dl>
        {outcome.droppedOut && (
          <p style={{ margin: '0.6rem 0 0', fontSize: '0.85rem', color: colors.textSecondary }}>
            You dropped out, and the remaining suppliers settled it between themselves.
          </p>
        )}
      </section>
      <p style={{ marginTop: '1rem' }}>
        <button data-testid="proc-open-continue" onClick={onContinue}>
          {done ? 'See your results' : 'Next round'}
        </button>
      </p>
    </div>
  )
}
