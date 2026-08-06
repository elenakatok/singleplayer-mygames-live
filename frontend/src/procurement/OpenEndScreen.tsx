import type { CSSProperties } from 'react'
import { useState } from 'react'
import { colors, typography } from '@mygames/game-ui'
import { ExitScatterSVG, ExitScatterCaption, type ExitPoint } from './ExitScatterSVG'
import type { ProcurementParams, ProcurementPlayedRow } from './api'
import { signedEcu } from './format'

// ═══════════════════════════════════════════════════════════════════════════════
// THE OPEN FORMAT'S FINAL RESULTS (§5.3 — "as Part 1 §9, with the scatter replaced per
// §7"). Same overall shape as the sealed screen — summary card, per-round table, chart —
// with open content throughout.
//
// ⚠⚠ IT DOES NOT REUSE `EndScreen`, AND THAT REFUSAL IS THE WHOLE REASON THIS FILE
// EXISTS. The sealed screen's scatter plots BID against cost and draws β as the
// benchmark. β is the sealed first-price equilibrium: it is the right answer to "what
// single sealed bid maximises expected profit", and it is not an answer to any question a
// descending auction asks. Rendering it here would judge every round against a line the
// round was never played against — which is exactly the live bug on the instructor side
// that CP4b exists to fix, and it would be worse here because the student would believe it.
//
// ⚠ THE PER-ROUND TABLE'S COLUMNS ARE THE OPEN ONES: cost, EXIT PRICE, final price, won,
// profit. There is no "your equilibrium bid" column, because there is no equilibrium bid.
//
// ⚠ THE BENCHMARK LINE IS "a perfect player would have earned X from your draws" — the
// same sentence Part 1 §9 uses, computed for this format by a CLOSED FORM (server:
// `auction/perfectPlay.ts`): the lowest-cost bidder wins at the second-lowest cost, so
// perfect play earns that gap and nothing when somebody else is cheaper. It de-noises
// luck — a student who played well into bad draws sees that, instead of a column of zeros
// — and it is the result the lecture states, so the screen and the slide agree.
// ═══════════════════════════════════════════════════════════════════════════════

const card: CSSProperties = {
  border: `1px solid ${colors.borderMid}`, borderRadius: 8,
  padding: '1rem 1.15rem', marginTop: '1rem', background: colors.white,
}
const th: CSSProperties = {
  textAlign: 'right', padding: '0.3rem 0.55rem', fontSize: '0.78rem',
  color: colors.textSecondary, borderBottom: `1px solid ${colors.borderMid}`, whiteSpace: 'nowrap',
}
const td: CSSProperties = {
  textAlign: 'right', padding: '0.28rem 0.55rem', fontSize: '0.85rem',
  borderBottom: `1px solid ${colors.borderLight ?? '#eee'}`,
}

export function OpenEndScreen({
  params,
  history,
  totalProfit,
  totalPerfectProfit,
  roundsWon,
  /** Each simulated supplier's own cost, revealed only once the game is over (server
   *  gates it on `finished_at`). ⚠ THE BOT SERIES IS THE BENCHMARK SHOWN BEING PLAYED. */
  botCosts,
  onContinue,
}: {
  params: ProcurementParams
  history: ProcurementPlayedRow[]
  totalProfit: number
  totalPerfectProfit: number
  roundsWon: number
  botCosts: number[] | null
  onContinue?: () => void
}) {
  const c = params.currencyLabel
  // ⚠ DEFAULT OFF (§7). The student sees their own cloud first and reveals the benchmark,
  // which is the same self-documenting trick Part 1 §9 uses for the optimal line.
  const [showBots, setShowBots] = useState(false)

  const points: ExitPoint[] = history
    .filter(r => r.exitPrice !== null)
    .map(r => ({ cost: r.yourCost, exitPrice: r.exitPrice!, censored: r.exitCensored }))

  return (
    <div style={{ fontFamily: typography.fontFamily }}>
      <h1 data-testid="proc-open-end-heading" style={{ fontSize: '1.2rem' }}>
        Your {history.length} auctions
      </h1>

      {/* ── the summary card ─────────────────────────────────────────────── */}
      <section style={card}>
        <div style={{ display: 'flex', gap: '2.5rem', flexWrap: 'wrap' }}>
          <Big label="Contracts won" value={`${roundsWon} of ${history.length}`} />
          <Big label="Total profit" value={signedEcu(totalProfit, c)} testId="proc-open-end-profit" />
          <Big label="With no bid increments" value={signedEcu(totalPerfectProfit, c)} testId="proc-open-end-perfect" />
        </div>
        {/* ⚠⚠ THE BENCHMARK IS THE FRICTIONLESS OUTCOME, NOT A MARK OUT OF TEN (Elena,
            2026-08-04). The previous wording — "perfect play would have earned" — invited a
            student above it to read the figures as broken and a student below it to read
            the gap as a grade. Neither is right: real increments are discrete, a discrete
            step hands the winner a small surplus, and **that gap is the lesson** — it is
            why increment size is an auction-design decision. Works in both directions, and
            never implies an error. The arithmetic is untouched. */}
        <p style={{ margin: '0.8rem 0 0', fontSize: '0.85rem', color: colors.textSecondary }}>
          In an auction with <strong>no bid increments</strong>, the contract goes to the
          lowest-cost supplier at the second-lowest cost — every time. Against{' '}
          <strong>the same suppliers you actually faced</strong>, that comes to{' '}
          {signedEcu(totalPerfectProfit, c)}. It is the frictionless outcome, not a score.
        </p>
        <p data-testid="proc-open-end-benchmark-note" style={{ margin: '0.5rem 0 0', fontSize: '0.85rem', color: colors.textSecondary }}>
          {totalProfit > totalPerfectProfit
            ? <>You earned <strong>more</strong> than that. Real auctions move in steps, and
              a step hands the winner whatever is left between the last two bids — so
              earning above the frictionless figure is the increments working in your
              favour, not a mistake in the numbers.</>
            : totalProfit === totalPerfectProfit
              ? <>You earned exactly that.</>
              : <>You earned <strong>less</strong> than that, which usually means stopping
                while the next legal bid still cleared your cost. Increments cut both
                ways — they can hand a winner a surplus, and they can end a round a step
                before you meant to leave.</>}
          {' '}This is why <strong>increment size is an auction-design decision</strong>,
          not a detail.
        </p>
      </section>

      {/* ── the per-round table (§5.3 / Part 1 §9, open columns) ─────────── */}
      <section style={card}>
        <h2 style={{ fontSize: '0.95rem', margin: '0 0 0.5rem' }}>Round by round</h2>
        <div style={{ overflowX: 'auto' }}>
          <table data-testid="proc-open-end-table" style={{ borderCollapse: 'collapse', width: '100%' }}>
            <thead>
              <tr>
                <th style={th}>Round</th>
                <th style={th}>Your cost</th>
                {/* ⚠ EXIT PRICE, not bid — see the file header. */}
                <th style={th}>Where you stopped</th>
                <th style={th}>Final price</th>
                <th style={{ ...th, textAlign: 'left' }}>Won</th>
                <th style={th}>Profit</th>
              </tr>
            </thead>
            <tbody>
              {history.map(r => (
                <tr key={r.round}>
                  <td style={td}>{r.round}</td>
                  <td style={td}>{r.yourCost}</td>
                  <td style={td}>
                    {r.exitPrice ?? '—'}
                    {/* ⚠ The censoring marker travels with the number wherever it is
                        shown, not only on the chart. A winner's stopping point is an
                        upper bound, and a table that hid that would undo the chart's
                        careful separation one column over. */}
                    {r.exitCensored && <span title="you won — nobody pushed you lower"> ↑</span>}
                  </td>
                  <td style={td}>{r.price ?? '—'}</td>
                  <td style={{ ...td, textAlign: 'left' }}>{r.won ? 'yes' : ''}</td>
                  <td style={td}>{signedEcu(r.profit, c)}</td>
                </tr>
              ))}
              {history.length === 0 && (
                <tr><td style={{ ...td, textAlign: 'left' }} colSpan={6}>No rounds played.</td></tr>
              )}
            </tbody>
          </table>
        </div>
        <p style={{ margin: '0.5rem 0 0', fontSize: '0.78rem', color: colors.textSecondary }}>
          ↑ marks a round you won: the auction ended before anyone pushed you lower, so
          that number is where you stopped <em>being pushed</em>, not where you would have
          stopped.
        </p>
      </section>

      {/* ── the §7 scatter ───────────────────────────────────────────────── */}
      <section style={card}>
        <h2 style={{ fontSize: '0.95rem', margin: '0 0 0.5rem' }}>
          Where you stopped, against your cost
        </h2>
        <ExitScatterSVG
          points={points}
          botExits={botCosts ?? []}
          showBots={showBots && botCosts !== null}
          min={params.rivalCostMin}
          max={params.rivalCostMax}
          currencyLabel={c}
          subjectLabel="Your rounds"
          // ⚠ COUNTED FROM THE DATA — rounds the student left without ever bidding have no
          // stopping point to plot. Nothing is shown when there are none.
          neverBidCount={history.filter(r => r.exitPrice === null).length}
        />
        {botCosts !== null && (
          <label style={{ display: 'block', fontSize: '0.8rem', marginTop: '0.5rem' }}>
            <input
              type="checkbox"
              data-testid="proc-open-end-show-bots"
              checked={showBots}
              onChange={e => setShowBots(e.target.checked)}
            />
            {' '}Show the simulated suppliers
          </label>
        )}
        <ExitScatterCaption subject="you" />
      </section>

      {onContinue && (
        <p style={{ marginTop: '1rem' }}>
          <button data-testid="proc-open-end-continue" onClick={onContinue}>Continue</button>
        </p>
      )}
    </div>
  )
}

function Big({ label, value, testId }: { label: string; value: string; testId?: string }) {
  return (
    <div>
      <div style={{ fontSize: '0.75rem', color: colors.textSecondary }}>{label}</div>
      <div data-testid={testId} style={{ fontSize: '1.5rem', fontWeight: 600 }}>{value}</div>
    </div>
  )
}
