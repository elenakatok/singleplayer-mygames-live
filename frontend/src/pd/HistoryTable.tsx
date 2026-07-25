import type { CSSProperties } from 'react'
import { colors, typography } from '@mygames/game-ui'
import type { PdHistoryRow, PdMoveLabels } from './api'

// ═══════════════════════════════════════════════════════════════════════════════
// The history table (spec §4) — ONE ROW PER ROUND PLAYED, visible throughout the
// game. Grouped-header style per the Crisis pattern: a "You | Opponent" block row
// above plain sub-labels, so "Years" and "Total" don't need per-side suffixes.
//
//   Round │      You              │      Opponent
//         │ Move  Years  Total    │ Move  Years  Total
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
/** The student's own block is shaded, exactly as the viewer's block is in Crisis. */
const mineShade: CSSProperties = { background: colors.confirmBg }
const mine = (extra?: CSSProperties) => ({ ...mineShade, ...extra })

export function HistoryTable({
  history,
  labels,
}: {
  history: PdHistoryRow[]
  labels: PdMoveLabels
}) {
  if (history.length === 0) {
    return (
      <p data-testid="pd-history-empty" style={{ color: colors.textSecondary, fontSize: typography.sizeSm }}>
        No rounds played yet. Your results will appear here after each round.
      </p>
    )
  }

  const label = (m: 'C' | 'D') => (m === 'C' ? labels.C : labels.D)
  const last = history[history.length - 1]

  return (
    <div style={{ overflowX: 'auto', maxWidth: '100%' }}>
      <table
        data-testid="pd-history"
        style={{ borderCollapse: 'collapse', fontSize: typography.sizeTable, fontFamily: typography.fontFamily, width: '100%' }}
      >
        <thead>
          {/* Row 1 — the two blocks. */}
          <tr>
            <th rowSpan={2} style={{ ...th, textAlign: 'left' }}>Round</th>
            <th colSpan={3} data-testid="pd-hist-block-you" style={mine({ ...th, textAlign: 'center', ...blockSep })}>You</th>
            <th colSpan={3} data-testid="pd-hist-block-opponent" style={{ ...th, textAlign: 'center', ...blockSep }}>Opponent</th>
          </tr>
          {/* Row 2 — plain sub-labels, no suffixes. */}
          <tr>
            <th style={mine({ ...th, ...blockSep })}>Move</th>
            <th style={mine(th)}>Years</th>
            <th style={mine(th)}>Total</th>
            <th style={{ ...th, ...blockSep }}>Move</th>
            <th style={th}>Years</th>
            <th style={th}>Total</th>
          </tr>
        </thead>
        <tbody>
          {history.map(row => (
            <tr key={row.round} data-testid={`pd-history-row-${row.round}`}>
              <td style={{ ...td, textAlign: 'left' }}>{row.round}</td>
              <td style={mine({ ...td, ...blockSep })}>{label(row.studentMove)}</td>
              <td style={mine(td)}>{row.studentYears}</td>
              <td style={mine({ ...td, fontWeight: 600 })}>{row.studentTotal}</td>
              <td style={{ ...td, ...blockSep }}>{label(row.botMove)}</td>
              <td style={td}>{row.botYears}</td>
              <td style={{ ...td, fontWeight: 600 }}>{row.botTotal}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p style={{ fontSize: typography.sizeXs, color: colors.textSecondary, margin: '0.4rem 0 0' }}>
        Years in prison — lower is better. You have served{' '}
        <strong data-testid="pd-your-total">{last.studentTotal}</strong> year{last.studentTotal === 1 ? '' : 's'} so
        far; the other player has served <strong>{last.botTotal}</strong>.
      </p>
    </div>
  )
}
