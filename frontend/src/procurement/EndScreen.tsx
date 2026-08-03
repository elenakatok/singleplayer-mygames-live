import type { CSSProperties } from 'react'
import { colors, typography } from '@mygames/game-ui'
import type { ProcurementParams, ProcurementPlayedRow, ProcurementRivalPoint } from './api'
import { ScatterSVG } from './ScatterSVG'
import { ecu, signedEcu } from './format'

// ═══════════════════════════════════════════════════════════════════════════════
// The final results screen (§9): the numbers, the per-round table, the benchmark
// sentence, and the scatter.
//
// ⚠ THE BENCHMARK IS COMPUTED SERVER-SIDE against the SAME realized rival bids
// (`totalEquilibriumProfit`). It is not "the average student", not a class rank and not a
// target — it is what β would have earned from THIS student's draws, which is the only
// comparison that controls for the luck in their own cost sequence. A student who drew
// four costs of 55 and one who drew four of 15 are not playing the same game, and a
// class-relative number would say the second one bid better.
//
// ⚠ PROFIT IS NOT THE GRADE (§11). Said on the screen, because a results page that looks
// like a scoreboard and says nothing invites the opposite assumption.
//
// ⚠ THE EQUILIBRIUM COLUMN IS THE SERVER'S NUMBER, carried on each history row, never
// re-derived here. Two derivations of β on two sides of the wire is exactly how the
// table and the scatter's line come to disagree by one ECU and nobody notices.
// ═══════════════════════════════════════════════════════════════════════════════

const card: CSSProperties = {
  border: `1px solid ${colors.borderMid}`, borderRadius: 8,
  padding: '1rem 1.15rem', marginTop: '1rem', background: colors.white,
}
const th: CSSProperties = {
  padding: '0.3rem 0.5rem', textAlign: 'right', fontWeight: 600,
  borderBottom: `2px solid ${colors.borderLight}`, whiteSpace: 'nowrap',
}
const td: CSSProperties = {
  padding: '0.3rem 0.5rem', textAlign: 'right',
  borderBottom: `1px solid ${colors.borderMid}`, whiteSpace: 'nowrap',
}
const mine: CSSProperties = { background: colors.confirmBg }

export function EndScreen({
  params,
  history,
  totalProfit,
  totalEquilibriumProfit,
  roundsWon,
  rivalPoints,
  onContinue,
}: {
  params: ProcurementParams
  history: ProcurementPlayedRow[]
  totalProfit: number
  totalEquilibriumProfit: number
  roundsWon: number
  /** null until the server has stamped `finished_at`. */
  rivalPoints: ProcurementRivalPoint[] | null
  /** Present when a debrief question follows; absent on the terminal view. */
  onContinue?: () => void
}) {
  const c = params.currencyLabel

  return (
    <div style={{ fontFamily: typography.fontFamily }}>
      <h1 data-testid="proc-end-heading" style={{ marginTop: 0, fontSize: '1.5rem', color: colors.text }}>
        All {params.rounds} rounds are done
      </h1>

      <section style={{ ...card, marginTop: 0 }}>
        <p style={{ margin: 0, fontSize: '1.1rem' }}>
          You won <strong data-testid="proc-end-wins">{roundsWon}</strong> of {params.rounds}{' '}
          contracts and earned{' '}
          <strong data-testid="proc-end-profit">{signedEcu(totalProfit, c)}</strong> in total.
        </p>
        <p data-testid="proc-end-benchmark" style={{ margin: '0.8rem 0 0', color: colors.textSecondary }}>
          A perfect player would have earned {signedEcu(totalEquilibriumProfit, c)} from your
          draws — bidding the optimal markup every round, against the very same rivals you
          faced.
        </p>
        <p style={{ margin: '0.8rem 0 0', fontSize: typography.sizeSm, color: colors.textSecondary }}>
          Your profit is not your grade. You are marked on completing the game and on the
          knowledge check.
        </p>
      </section>

      <section style={card}>
        <h2 style={{ fontSize: '0.95rem', margin: '0 0 0.6rem', color: colors.text }}>Every round</h2>
        <div style={{ overflowX: 'auto' }}>
          <table
            data-testid="proc-end-table"
            style={{ borderCollapse: 'collapse', fontSize: typography.sizeTable, minWidth: '38rem' }}
          >
            <thead>
              <tr>
                <th style={th}>Round</th>
                <th style={{ ...th, ...mine }}>Your cost</th>
                <th style={{ ...th, ...mine }}>Your bid</th>
                <th style={th}>Optimal bid</th>
                <th style={th}>Auction price</th>
                <th style={{ ...th, textAlign: 'center' }}>Won?</th>
                <th style={{ ...th, ...mine }}>Profit</th>
              </tr>
            </thead>
            <tbody>
              {history.map(r => (
                <tr key={r.round} data-testid={`proc-end-row-${r.round}`}>
                  <td style={td}>{r.round}</td>
                  <td style={{ ...td, ...mine }}>{ecu(r.yourCost, c)}</td>
                  <td style={{ ...td, ...mine }}>{r.yourBid === null ? '—' : ecu(r.yourBid, c)}</td>
                  {/* Null when the student's own cost was above the reserve — there was
                      no bid worth making, so there is no optimal one to show. */}
                  <td style={td}>
                    {r.yourEquilibriumBid === null ? 'no bid worth making' : ecu(r.yourEquilibriumBid, c)}
                  </td>
                  <td style={td}>{r.price === null ? 'no award' : ecu(r.price, c)}</td>
                  <td style={{ ...td, textAlign: 'center' }}>{r.won ? 'Yes' : 'No'}</td>
                  <td style={{
                    ...td, ...mine,
                    ...(r.profit < 0 ? { color: colors.errorAction, fontWeight: 600 } : null),
                  }}>
                    {signedEcu(r.profit, c)}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td style={{ ...td, fontWeight: 600 }} colSpan={6}>Total</td>
                <td style={{ ...td, ...mine, fontWeight: 600 }} data-testid="proc-end-table-total">
                  {signedEcu(totalProfit, c)}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      </section>

      <section style={card}>
        <h2 style={{ fontSize: '0.95rem', margin: '0 0 0.2rem', color: colors.text }}>
          Your bids against your costs
        </h2>
        <p style={{ margin: '0 0 0.8rem', fontSize: typography.sizeSm, color: colors.textSecondary, maxWidth: '34rem' }}>
          Each dot is one round. The dashed line is bidding exactly your cost — a
          guaranteed zero. The green line is the bid that maximises expected profit at
          each cost.
        </p>
        <ScatterSVG params={params} history={history} rivals={rivalPoints} />
      </section>

      {onContinue && (
        <button
          data-testid="proc-end-continue"
          onClick={onContinue}
          style={{
            marginTop: '1.2rem', padding: '0.7rem 1.75rem', fontSize: '1rem', fontWeight: 600,
            backgroundColor: colors.text, color: colors.white, border: 'none',
            borderRadius: 6, cursor: 'pointer',
          }}
        >
          Continue
        </button>
      )}
    </div>
  )
}
