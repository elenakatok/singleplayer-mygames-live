import type { CSSProperties } from 'react'
import { colors, typography } from '@mygames/game-ui'
import type { PdHistoryRow, PdMoveLabels } from './api'

// ═══════════════════════════════════════════════════════════════════════════════
// The history table (spec §4) — ONE ROW PER ROUND PLAYED, visible throughout the
// game. Grouped-header style per the Crisis pattern: a "You | Opponent" block row
// above plain sub-labels, so "Years" doesn't need a per-side suffix.
//
//   Round │    You     │  Opponent
//         │ Move Years │ Move Years
//
// PER-ROUND ONLY, WITH AVERAGES IN THE CAPTION. The cumulative running totals used
// to be two more columns; they are now one sentence underneath, as AVERAGES. Two
// reasons: the table stays narrow enough to read on a phone (these games are played
// outside class), and an average is the number a student can actually act on —
// "am I averaging 1 year or 10?" compares directly against the payoff matrix on the
// same screen, while a cumulative total means nothing without knowing how many
// rounds are left. Which is the second reason: a running total invites exactly the
// "how many rounds are left?" arithmetic the design refuses to support.
//
// ⚠ ROUNDS PLAYED, NEVER ROUNDS REMAINING (spec §3, §4). The table's length IS the
// round count so far, and that is all it can ever be — it renders exactly the rows
// the server sent, and the server sends only rounds already played. There is no
// total to divide by, no "of N", no progress bar: the student cannot tell round 9 of
// 20 from round 9 of 10, which is the point. The averages divide by ROUNDS PLAYED,
// which the student can already count from the rows in front of them.
// ═══════════════════════════════════════════════════════════════════════════════

/** A side's mean years per round played, to one decimal place. Exported for its unit
 *  test: this is the one arithmetic on the student's screen. */
export function averagePerRound(totalYears: number, roundsPlayed: number): string {
  if (roundsPlayed <= 0) return '0.0'
  return (totalYears / roundsPlayed).toFixed(1)
}

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
  // Summed from the PER-ROUND years in the rows above, not read off the server's
  // running total — the caption then depends on nothing but what is on screen.
  const studentYears = history.reduce((a, r) => a + r.studentYears, 0)
  const botYears = history.reduce((a, r) => a + r.botYears, 0)

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
            <th colSpan={2} data-testid="pd-hist-block-you" style={mine({ ...th, textAlign: 'center', ...blockSep })}>You</th>
            <th colSpan={2} data-testid="pd-hist-block-opponent" style={{ ...th, textAlign: 'center', ...blockSep }}>Opponent</th>
          </tr>
          {/* Row 2 — plain sub-labels, no suffixes. */}
          <tr>
            <th style={mine({ ...th, ...blockSep })}>Move</th>
            <th style={mine(th)}>Years</th>
            <th style={{ ...th, ...blockSep }}>Move</th>
            <th style={th}>Years</th>
          </tr>
        </thead>
        <tbody>
          {history.map(row => (
            <tr key={row.round} data-testid={`pd-history-row-${row.round}`}>
              <td style={{ ...td, textAlign: 'left' }}>{row.round}</td>
              <td style={mine({ ...td, ...blockSep })}>{label(row.studentMove)}</td>
              <td style={mine(td)}>{row.studentYears}</td>
              <td style={{ ...td, ...blockSep }}>{label(row.botMove)}</td>
              <td style={td}>{row.botYears}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p style={{ fontSize: typography.sizeXs, color: colors.textSecondary, margin: '0.4rem 0 0' }}>
        {/* Averages, not totals — computed here from the per-round years already in
            `history`, so this needs nothing new from the server. Denominator is rounds
            PLAYED (history.length), which is just the rows above. */}
        Years in prison — lower is better. You are averaging{' '}
        <strong data-testid="pd-your-average">{averagePerRound(studentYears, history.length)}</strong>{' '}
        years per round so far; the other player is averaging{' '}
        <strong data-testid="pd-their-average">{averagePerRound(botYears, history.length)}</strong>.
      </p>
    </div>
  )
}
