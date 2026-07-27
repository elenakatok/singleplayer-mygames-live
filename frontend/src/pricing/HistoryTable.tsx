import type { CSSProperties } from 'react'
import { colors, typography } from '@mygames/game-ui'
import type { PricingHistoryRow, PricingLabels } from './api'
import { formatPrice, formatProfitM, formatShare } from './format'

// ═══════════════════════════════════════════════════════════════════════════════
// The history table (spec §4) — ONE ROW PER ROUND PLAYED, visible throughout the
// game. Grouped-header style, as PD's: a "You | Competitor" block row above plain
// sub-labels, so "Price" doesn't need a per-side suffix.
//
//   Round │        You         │     Competitor      │  Your profit
//         │ Price Share Profit │ Price Share Profit  │ Cumulative Average
//
// PMG adds ONE column at the front — the price everyone actually paid (spec §6.4).
// It sits before the two blocks rather than inside either, because under PMG it
// belongs to neither firm: it is the single price both firms' customers pay.
//
// ⚠ CUMULATIVE AND AVERAGE ARE COLUMNS HERE, unlike PD, which moved them into a
// caption. Two reasons the same argument does not apply: this game is in DOLLARS and
// higher is better, so a running total is a scoreboard a student can act on rather
// than an invitation to count rounds; and spec §4 names both as row values. The
// figures still come from the server's own running values (`yourTotal`,
// `yourAverage`), so the table cannot disagree with the end screen.
//
// ⚠ ROUNDS PLAYED, NEVER ROUNDS REMAINING (spec §3, §4). The table's length IS the
// round count so far, and that is all it can ever be — it renders exactly the rows
// the server sent, and the server sends only rounds already played. There is no
// total to divide by, no "of N", no progress bar: the student cannot tell round 9 of
// 20 from round 9 of 10, which is the point.
// ═══════════════════════════════════════════════════════════════════════════════

const th: CSSProperties = {
  padding: '0.3rem 0.5rem', textAlign: 'right', fontWeight: 600,
  borderBottom: `2px solid ${colors.borderLight}`, whiteSpace: 'nowrap',
}
const td: CSSProperties = {
  padding: '0.3rem 0.5rem', textAlign: 'right',
  borderBottom: `1px solid ${colors.borderMid}`, whiteSpace: 'nowrap',
}
const blockSep: CSSProperties = { borderLeft: `2px solid ${colors.borderMid}` }
/** The student's own block is shaded, exactly as it is in PD and Crisis. */
const mineShade: CSSProperties = { background: colors.confirmBg }
const mine = (extra?: CSSProperties) => ({ ...mineShade, ...extra })

/** A profit cell: the formatted figure, coloured when it is a LOSS. The string is
 *  already signed (format.ts), so the colour is reinforcement, never the only cue. */
export function ProfitCell({ value, testId, style }: { value: number; testId?: string; style?: CSSProperties }) {
  const loss = value < 0
  return (
    <td data-testid={testId} style={{ ...style, ...(loss ? { color: colors.errorAction, fontWeight: 600 } : null) }}>
      {formatProfitM(value)}
    </td>
  )
}

export function HistoryTable({
  history,
  labels,
  pmg,
}: {
  history: PricingHistoryRow[]
  labels: PricingLabels
  /** PMG adds the effective-price column (spec §6.4). */
  pmg: boolean
}) {
  if (history.length === 0) {
    return (
      <p data-testid="pricing-history-empty" style={{ color: colors.textSecondary, fontSize: typography.sizeSm }}>
        No rounds played yet. Your results will appear here after each round.
      </p>
    )
  }

  return (
    <div style={{ overflowX: 'auto', maxWidth: '100%' }}>
      <table
        data-testid="pricing-history"
        style={{ borderCollapse: 'collapse', fontSize: typography.sizeTable, fontFamily: typography.fontFamily, width: '100%' }}
      >
        <thead>
          {/* Row 1 — the blocks. */}
          <tr>
            <th rowSpan={2} style={{ ...th, textAlign: 'left' }}>Round</th>
            {pmg && (
              <th rowSpan={2} data-testid="pricing-hist-block-paid" style={{ ...th, ...blockSep }}>
                Price paid
              </th>
            )}
            <th colSpan={3} data-testid="pricing-hist-block-you" style={mine({ ...th, textAlign: 'center', ...blockSep })}>
              {labels.student} (you)
            </th>
            <th colSpan={3} data-testid="pricing-hist-block-competitor" style={{ ...th, textAlign: 'center', ...blockSep }}>
              {labels.competitor} (your competitor)
            </th>
            <th colSpan={2} data-testid="pricing-hist-block-totals" style={mine({ ...th, textAlign: 'center', ...blockSep })}>
              Your profit so far
            </th>
          </tr>
          {/* Row 2 — plain sub-labels, no suffixes. */}
          <tr>
            <th style={mine({ ...th, ...blockSep })}>Price</th>
            <th style={mine(th)}>Share</th>
            <th style={mine(th)}>Profit</th>
            <th style={{ ...th, ...blockSep }}>Price</th>
            <th style={th}>Share</th>
            <th style={th}>Profit</th>
            <th style={mine({ ...th, ...blockSep })}>Cumulative</th>
            <th style={mine(th)}>Average</th>
          </tr>
        </thead>
        <tbody>
          {history.map(row => (
            <tr key={row.round} data-testid={`pricing-history-row-${row.round}`}>
              <td style={{ ...td, textAlign: 'left' }}>{row.round}</td>
              {pmg && (
                <td data-testid={`pricing-history-paid-${row.round}`} style={{ ...td, ...blockSep, fontWeight: 600 }}>
                  {row.effectivePrice === null ? '—' : formatPrice(row.effectivePrice)}
                </td>
              )}
              <td style={mine({ ...td, ...blockSep })}>{formatPrice(row.yourPrice)}</td>
              <td style={mine(td)}>{formatShare(row.yourShare)}</td>
              <ProfitCell value={row.yourProfit} style={mine(td)} testId={`pricing-history-your-profit-${row.round}`} />
              <td style={{ ...td, ...blockSep }}>{formatPrice(row.competitorPrice)}</td>
              <td style={td}>{formatShare(row.competitorShare)}</td>
              <ProfitCell value={row.competitorProfit} style={td} />
              <ProfitCell value={row.yourTotal} style={mine({ ...td, ...blockSep })} testId={`pricing-history-total-${row.round}`} />
              <ProfitCell value={row.yourAverage} style={mine(td)} testId={`pricing-history-average-${row.round}`} />
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
