import type { CSSProperties } from 'react'
import { colors, typography } from '@mygames/game-ui'
import type { ProcurementPlayedRow } from './api'
import { ecu, signedEcu } from './format'

// ═══════════════════════════════════════════════════════════════════════════════
// The history table — ONE ROW PER ROUND PLAYED, visible throughout the game (§6.1).
//
//   Round │ Your cost │ Your bid │ Winning bid │ Result │ Profit │ Cumulative
//
// ⚠ NO RIVAL COLUMN, AND THERE CANNOT BE ONE. The row type carries no rival cost — the
// server never sends one (api.ts) — so this table has nothing to reveal even by
// accident. The winning bid is public once the round is over; the cost behind it is not,
// in this round or any later one.
//
// ⚠ "ROUND k" WITH A TOTAL IS FINE HERE, unlike pricing and PD. Eight rounds are
// independent (§2), so a visible horizon creates no endgame effect to exploit, and
// `params.rounds` is public config the bidding screen prints anyway.
// ═══════════════════════════════════════════════════════════════════════════════

const th: CSSProperties = {
  padding: '0.3rem 0.5rem', textAlign: 'right', fontWeight: 600,
  borderBottom: `2px solid ${colors.borderLight}`, whiteSpace: 'nowrap',
}
const td: CSSProperties = {
  padding: '0.3rem 0.5rem', textAlign: 'right',
  borderBottom: `1px solid ${colors.borderMid}`, whiteSpace: 'nowrap',
}
/** The student's own columns are shaded, as in pricing, PD and Crisis. */
const mine: CSSProperties = { background: colors.confirmBg }

export function HistoryTable({
  history,
  currency,
  totalRounds,
}: {
  history: ProcurementPlayedRow[]
  currency: string
  totalRounds: number
}) {
  if (history.length === 0) return null

  return (
    <section style={{ marginTop: '1.25rem' }}>
      <h2 style={{ fontSize: '0.95rem', margin: '0 0 0.4rem', color: colors.text }}>
        Your rounds so far
      </h2>
      <div style={{ overflowX: 'auto' }}>
        <table
          data-testid="proc-history"
          style={{
            borderCollapse: 'collapse', fontFamily: typography.fontFamily,
            fontSize: '0.85rem', minWidth: '34rem',
          }}
        >
          <thead>
            <tr>
              <th style={th}>Round</th>
              <th style={{ ...th, ...mine }}>Your cost</th>
              <th style={{ ...th, ...mine }}>Your bid</th>
              <th style={th}>Winning bid</th>
              <th style={{ ...th, textAlign: 'center' }}>Result</th>
              <th style={{ ...th, ...mine }}>Profit</th>
              <th style={th}>Cumulative</th>
            </tr>
          </thead>
          <tbody>
            {history.map(r => (
              <tr key={r.round} data-testid={`proc-history-row-${r.round}`}>
                <td style={td}>{r.round} of {totalRounds}</td>
                <td style={{ ...td, ...mine }}>{ecu(r.yourCost, currency)}</td>
                <td style={{ ...td, ...mine }}>
                  {r.yourBid === null ? '—' : ecu(r.yourBid, currency)}
                </td>
                <td style={td}>{r.price === null ? 'no award' : ecu(r.price, currency)}</td>
                <td style={{ ...td, textAlign: 'center' }}>{r.won ? 'Won' : 'Lost'}</td>
                <td style={{
                  ...td, ...mine,
                  // The figure is already signed; colour is reinforcement, never the
                  // only cue that a round lost money.
                  ...(r.profit < 0 ? { color: colors.errorAction, fontWeight: 600 } : null),
                }}>
                  {signedEcu(r.profit, currency)}
                </td>
                <td style={td}>{signedEcu(r.profitTotal, currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}
