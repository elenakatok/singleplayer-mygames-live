import { useState } from 'react'
import type { CSSProperties } from 'react'
import { colors, typography } from '@mygames/game-ui'
import {
  procurementSubmitBid,
  type ProcurementParams, type ProcurementPlayedRow, type ProcurementRoundResult,
  type ProcurementSubmitBidResult,
} from './api'
import { HistoryTable } from './HistoryTable'
import { ecu, signedEcu, bidAmount } from './format'

// ═══════════════════════════════════════════════════════════════════════════════
// One sealed round, as the two phases of the loop's iteration (§6.1, §6.4):
//
//   PlaceBid    — the ASK phase: your cost, the auction's parameters, one bid, one submit.
//   RoundResult — the DISPLAY phase: every bid, who won, what you earned, and the §8
//                 counterfactual.
//
// ⚠⚠ THERE IS NO DROP OUT AND NO "DO NOT BID" IN THE SEALED FORMAT (§6.3). Once this
// screen is reached a bid is required. A student who abandons has an unfinished
// assignment, not a played round — nothing is written for them, and there is
// deliberately no control here that would write one.
//
// ⚠ THE RESERVE IS A VALIDATION GATE WITH A VISIBLE MESSAGE (§6.2, §13.5), never a
// silent clamp and never a disabled field. A student who bids above it is TOLD why it
// was refused, in the spec's own words, and the round is not consumed. The client hint
// below is a courtesy; `procurementSubmitBid` gates the same thing server-side and is
// the actual authority.
//
// ⚠ BIDDING BELOW YOUR OWN COST IS ALLOWED and is not warned about (§6.2). Losing money
// is a legitimate mistake and part of the lesson; the lecture's own scatter shows
// students doing it. Do not add a "that's below your cost" hint.
//
// ⚠ RIVAL COSTS ARE NEVER SHOWN — not before the round, not after it. The result screen
// reveals the rivals' BIDS, which is what a sealed auction's opening reveals in the
// room. The costs behind them stay server-side forever (api.ts).
// ═══════════════════════════════════════════════════════════════════════════════

const card: CSSProperties = {
  border: `1px solid ${colors.borderMid}`, borderRadius: 8,
  padding: '1rem 1.15rem', marginTop: '1rem', background: colors.white,
}
const sectionTitle: CSSProperties = {
  fontSize: '0.95rem', margin: '0 0 0.6rem', color: colors.text,
}
const dtStyle: CSSProperties = { minWidth: '11rem', fontWeight: 600 }

function Fact({ label, value, testId }: { label: string; value: string; testId?: string }) {
  return (
    <div style={{ display: 'flex', gap: '0.5rem', padding: '0.15rem 0' }}>
      <dt style={dtStyle}>{label}</dt>
      <dd data-testid={testId} style={{ margin: 0 }}>{value}</dd>
    </div>
  )
}

/** The auction's parameters, on BOTH phases: a student deciding round 7 should be able
 *  to re-read the rules without navigating.
 *
 *  ⚠ THE RIVAL COST RANGE IS PRINTED, DELIBERATELY (§1). The equilibrium markup the
 *  debrief discusses is only computable by a student who knows the top of it — hiding it
 *  would hide the lesson.
 *
 *  ⚠⚠ THE PLAYER'S OWN RANGE IS NOT PRINTED, AND MUST NOT BE (§4): "students are told the
 *  rival distribution only; their own range is never mentioned because it is not needed
 *  to bid well." Their own DISTRIBUTION does not enter their optimization (§5.2) — the
 *  cost is realized before they bid, so only the realized number matters, and that is on
 *  the screen above. Naming the range would invite reasoning about an irrelevant quantity
 *  and would hint at the player/rival asymmetry the spec keeps quiet. The server does not
 *  send it (clientState.ts), so this is belt and braces.
 *
 *  ⚠ THIS PANEL BELONGS TO THE BIDDING SCREEN ONLY. It used to render on the knowledge
 *  check too, where it gave away S1, S2, S3, S4 and S5 — see KcScreen.tsx. */
export function AuctionFacts({ params }: { params: ProcurementParams }) {
  const c = params.currencyLabel
  return (
    <section style={card}>
      <h2 style={sectionTitle}>The auction</h2>
      <dl style={{ margin: 0, fontSize: '0.88rem', color: colors.textSecondary }}>
        <Fact label="Bidders" value={`you + ${params.rivalCount} other suppliers`} />
        <Fact
          label="Their costs"
          value={`each drawn independently, anywhere from ${params.rivalCostMin} to ${params.rivalCostMax} ${c}`}
        />
        <Fact label="Reserve price" value={ecu(params.reserve, c)} testId="proc-reserve" />
        <Fact label="Award rule" value="the lowest bid wins the contract and is paid its own bid" />
      </dl>
      <p style={{ margin: '0.7rem 0 0', fontSize: '0.85rem', color: colors.textSecondary }}>
        Every bid is sealed: nobody sees anybody else's until the round is over. If you
        win, you earn your bid minus your cost. If you lose, you earn nothing — you also
        pay nothing.
      </p>
    </section>
  )
}

// ── ASK phase ──────────────────────────────────────────────────────────────────

export function PlaceBid({
  roundNumber,
  cost,
  params,
  history,
  onSubmitted,
}: {
  roundNumber: number
  /** The student's OWN drawn cost for this round, from the server (§4). */
  cost: number
  params: ProcurementParams
  history: ProcurementPlayedRow[]
  /** Called once the SERVER has accepted the bid, with everything it returned — the
   *  round card, the refreshed history, and the next round's cost. */
  onSubmitted: (result: ProcurementSubmitBidResult) => void
}) {
  // Nothing pre-filled. Any default anchors the whole class's opening bid, and the two
  // obvious candidates — the cost and the reserve — anchor toward the two worst bids
  // available (zero markup, and certain loss of the contract).
  const [raw, setRaw] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const c = params.currencyLabel
  const trimmed = raw.trim()
  const parsed = /^\d+$/.test(trimmed) ? Number(trimmed) : NaN
  const hint = trimmed === '' ? null
    : !Number.isInteger(parsed) ? `Enter a whole number of ${c} — no decimals, no symbols.`
    // ⚠ The spec's own wording (§6.2). Client and server say the same sentence.
    : parsed > params.reserve ? `Bids above the reserve price of ${params.reserve} will not be accepted.`
    : null

  const canSubmit = Number.isInteger(parsed) && hint === null && !submitting

  const handleSubmit = async () => {
    if (!canSubmit) return
    setSubmitting(true)
    setError(null)
    try {
      const res = await procurementSubmitBid(roundNumber, parsed)
      onSubmitted(res)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong. Please try again.')
      setSubmitting(false)
    }
  }

  return (
    <div>
      <h1
        data-testid="proc-round-heading"
        style={{ marginTop: 0, marginBottom: '0.75rem', fontSize: '1.5rem', color: colors.text }}
      >
        Round {roundNumber} of {params.rounds}
      </h1>

      <section style={{ ...card, marginTop: 0 }}>
        <h2 style={sectionTitle}>Your cost this round</h2>
        <p data-testid="proc-cost" style={{ margin: 0, fontSize: '1.6rem', color: colors.text }}>
          {ecu(cost, c)}
        </p>
        <p style={{ margin: '0.4rem 0 0', fontSize: '0.85rem', color: colors.textSecondary }}>
          What it would cost you to fulfil this contract. It is yours alone — the other
          suppliers have their own, drawn separately, and nobody sees anybody else's.
        </p>
      </section>

      <AuctionFacts params={params} />

      <section style={card}>
        <h2 style={sectionTitle}>Your bid</h2>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.4rem' }}>
          <input
            data-testid="proc-bid-input"
            type="text"
            inputMode="numeric"
            autoComplete="off"
            aria-label={`Your bid in ${c}`}
            value={raw}
            disabled={submitting}
            onChange={e => setRaw(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && canSubmit) void handleSubmit() }}
            style={{
              width: '9rem', padding: '0.55rem 0.7rem', fontSize: '1.2rem',
              fontFamily: typography.fontFamily,
              border: `1px solid ${hint ? colors.errorBorder : colors.borderLight}`,
              borderRadius: 6,
            }}
          />
          <span style={{ fontSize: '1.1rem', color: colors.text }}>{c}</span>
        </div>
        <p style={{ margin: 0, fontSize: '0.8rem', color: hint ? colors.errorAction : colors.textSecondary }}>
          {/* ⚠ The bounds line states the CEILING only. There is no floor: a bid below
              your own cost is legal (§6.2), and saying so here would read as advice. */}
          {hint ?? `Whole ${c}, at or below the reserve price of ${params.reserve}.`}
        </p>

        <button
          data-testid="proc-bid-submit"
          onClick={() => void handleSubmit()}
          disabled={!canSubmit}
          style={{
            marginTop: '0.9rem', padding: '0.6rem 1.4rem', fontSize: '1rem',
            fontFamily: typography.fontFamily, borderRadius: 6, border: 'none',
            background: canSubmit ? colors.text : colors.disabledBtnBg,
            color: colors.white, cursor: canSubmit ? 'pointer' : 'default',
          }}
        >
          {submitting ? 'Submitting…' : 'Submit bid'}
        </button>
        <p style={{ margin: '0.5rem 0 0', fontSize: '0.8rem', color: colors.textSecondary }}>
          Once submitted, a bid is final for the round.
        </p>
        {error && (
          <p data-testid="proc-bid-error" style={{ marginTop: '0.6rem', color: colors.errorAction }}>
            {error}
          </p>
        )}
      </section>

      <HistoryTable history={history} currency={c} totalRounds={params.rounds} />
    </div>
  )
}

// ── DISPLAY phase ──────────────────────────────────────────────────────────────

export function RoundResult({
  result,
  params,
  history,
  done,
  onContinue,
}: {
  result: ProcurementRoundResult
  params: ProcurementParams
  history: ProcurementPlayedRow[]
  done: boolean
  onContinue: () => void
}) {
  const c = params.currencyLabel

  return (
    <div>
      <h1
        data-testid="proc-result-heading"
        style={{ marginTop: 0, marginBottom: '0.75rem', fontSize: '1.5rem', color: colors.text }}
      >
        Round {result.round} of {params.rounds} — {result.won ? 'you won the contract' : 'you did not win'}
      </h1>

      {/* ⚠ THE COST-ABOVE-RESERVE CASE (only reachable when an instructor lowers the
          reserve below the player's cost range). Said plainly, first, because without it
          a round where every legal bid loses money reads as broken. */}
      {result.costAboveReserve && (
        <p data-testid="proc-above-reserve" style={{
          margin: '0 0 0.75rem', padding: '0.6rem 0.8rem', borderRadius: 6,
          background: colors.warnBannerBg, border: `1px solid ${colors.warnBannerBorder}`, color: colors.warnBannerText,
        }}>
          Your cost of {result.yourCost} was above the reserve of {params.reserve}. There
          was no bid worth making.
        </p>
      )}

      <section style={{ ...card, marginTop: 0 }}>
        <h2 style={sectionTitle}>Every bid, lowest first</h2>
        <table
          data-testid="proc-bid-table"
          style={{ borderCollapse: 'collapse', fontFamily: typography.fontFamily, fontSize: '0.9rem' }}
        >
          <thead>
            <tr>
              <th style={{ padding: '0.3rem 0.7rem 0.3rem 0', textAlign: 'left', fontWeight: 600 }}>Bidder</th>
              <th style={{ padding: '0.3rem 0.7rem', textAlign: 'right', fontWeight: 600 }}>Bid</th>
              <th style={{ padding: '0.3rem 0.7rem', textAlign: 'left', fontWeight: 600 }} />
            </tr>
          </thead>
          <tbody>
            {result.bids.map(b => (
              <tr
                key={b.label}
                data-testid={b.isYou ? 'proc-bid-row-you' : undefined}
                style={b.isYou ? { background: colors.confirmBg } : undefined}
              >
                <td style={{ padding: '0.3rem 0.7rem 0.3rem 0', fontWeight: b.isYou ? 600 : 400 }}>
                  {b.label}
                </td>
                <td style={{ padding: '0.3rem 0.7rem', textAlign: 'right' }}>
                  {bidAmount(b.amount, c)}
                </td>
                <td style={{ padding: '0.3rem 0.7rem', color: colors.textSecondary }}>
                  {b.won ? 'won the contract' : b.amount === null ? 'cost above the reserve' : ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {/* ⚠ WITHOUT THIS LINE a student sees two identical lowest bids with the OTHER
            one marked winner, and reasonably reads it as a bug (Elena, 08-03). */}
        {result.tiedAndLost && (
          <p data-testid="proc-tie-note" style={{ margin: '0.7rem 0 0', color: colors.text }}>
            Two bids tied at the lowest price. The contract was awarded at random.
          </p>
        )}

        {result.noAward && (
          <p data-testid="proc-no-award" style={{ margin: '0.7rem 0 0', color: colors.textSecondary }}>
            No bid was at or below the reserve, so the contract was not awarded.
          </p>
        )}
      </section>

      <section style={card}>
        <h2 style={sectionTitle}>What you earned</h2>
        <dl style={{ margin: 0, fontSize: '0.9rem' }}>
          <Fact label="Your cost" value={ecu(result.yourCost, c)} />
          <Fact
            label="Your bid"
            value={result.yourBid === null ? '—' : ecu(result.yourBid, c)}
          />
          <Fact
            label="Winning bid"
            value={result.price === null ? 'no award' : ecu(result.price, c)}
          />
          <Fact label="This round" value={signedEcu(result.profit, c)} testId="proc-round-profit" />
          <Fact label="Total so far" value={signedEcu(result.profitTotal, c)} testId="proc-total-profit" />
        </dl>
      </section>

      {/* ── The §8 counterfactual ────────────────────────────────────────────────
          Shown on a LOSING round: the bid the theory would have made at this student's
          own cost, and whether it would have lost too. The second half matters as much
          as the first — a round lost to a rival who drew a cost of 12 was not lost by
          bidding badly, and saying so is what stops the benchmark reading as a scolding. */}
      {!result.won && result.equilibriumBid !== null && (
        <section style={card}>
          <h2 style={sectionTitle}>What the theory would have bid</h2>
          <p data-testid="proc-counterfactual" style={{ margin: 0, fontSize: '0.9rem' }}>
            At a cost of {result.yourCost}, the equilibrium bid is{' '}
            <strong>{ecu(result.equilibriumBid, c)}</strong>.{' '}
            {result.equilibriumWouldHaveWon
              ? `Against this round's bids it would have won, earning ${signedEcu(result.equilibriumProfit, c)}.`
              : 'Against this round’s bids it would have lost too — somebody else drew a low cost.'}
          </p>
        </section>
      )}

      <HistoryTable history={history} currency={c} totalRounds={params.rounds} />

      <button
        data-testid="proc-result-continue"
        onClick={onContinue}
        style={{
          marginTop: '1.2rem', padding: '0.6rem 1.4rem', fontSize: '1rem',
          fontFamily: typography.fontFamily, borderRadius: 6, border: 'none',
          background: colors.text, color: colors.white, cursor: 'pointer',
        }}
      >
        {done ? 'See your results' : `Start round ${result.round + 1}`}
      </button>
    </div>
  )
}
