import type { CSSProperties } from 'react'
import { colors, typography } from '@mygames/game-ui'
import type { NewsvendorHistoryRow } from './api'
import { formatMoney, formatPercent, formatUnits } from './format'

// ═══════════════════════════════════════════════════════════════════════════════
// The history table (spec §7c) — ONE ROW PER PERIOD PLAYED, shown from period 2 on.
// Grouped-header style, as PD's and pricing's: a block row above plain sub-labels,
// so "Units" doesn't need a per-side suffix.
//
//   Period │      You       │  What happened   │   Your profit
//          │ Order  Met [%] │ Demand Over Short│ This period  Average
//
// The demand-proportion column appears only when the instance has
// showServiceLevel on (spec §2, §7c).
//
// ⚠ NO CUMULATIVE COLUMN — removed deliberately, and it is not coming back. Running
// total and running average say nearly the same thing at a glance, and carrying both
// pushed the table past the readable width on a laptop for no extra insight. The
// AVERAGE is the one that survives, because it is the figure comparable across
// students and across periods; a cumulative total mostly measures how far through the
// game you are, which the Period column already says. `yourTotal` is still on the row
// type and still comes from the server, unrendered — the final screen reports the
// total once, which is where a running sum actually pays off.
//
// ⚠ NO BENCHMARK COLUMN, AND THERE NEVER WILL BE ONE HERE (spec §9.2). The optimal
// order and the profit it would have earned are stored for every period and are on
// the instructor's reports; the student's table shows what THEY did. The row type
// this renders (NewsvendorHistoryRow) does not carry the benchmark at all, so adding
// a column would take changing the server whitelist first — which is the point.
//
// ⚠ ONE ROW PER PERIOD PLAYED, so the table's length is the period count so far. That
// is fine here in a way it is not in pricing: this game's total N is public (spec §7a
// says "Period k of N"), so there is nothing for a row count to leak.
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
/** The student's own block is shaded, exactly as it is in PD, pricing and Crisis. */
const mineShade: CSSProperties = { background: colors.confirmBg }
const mine = (extra?: CSSProperties) => ({ ...mineShade, ...extra })

/** A profit cell: the formatted figure, coloured when it is a LOSS. The string is
 *  already signed (format.ts), so the colour is reinforcement, never the only cue. */
function ProfitCell({ value, testId, style }: { value: number; testId?: string; style?: CSSProperties }) {
  const loss = value < 0
  return (
    <td data-testid={testId} style={{ ...style, ...(loss ? { color: colors.errorAction, fontWeight: 600 } : null) }}>
      {formatMoney(value)}
    </td>
  )
}

export function HistoryTable({
  history,
  showServiceLevel,
}: {
  history: NewsvendorHistoryRow[]
  showServiceLevel: boolean
}) {
  if (history.length === 0) {
    return (
      <p data-testid="nv-history-empty" style={{ color: colors.textSecondary, fontSize: typography.sizeSm }}>
        No periods played yet. Your results will appear here after each period.
      </p>
    )
  }

  return (
    <div style={{ overflowX: 'auto', maxWidth: '100%' }}>
      <table
        data-testid="nv-history"
        style={{ borderCollapse: 'collapse', fontSize: typography.sizeTable, fontFamily: typography.fontFamily, width: '100%' }}
      >
        <thead>
          {/* Row 1 — the blocks. */}
          <tr>
            <th rowSpan={2} style={{ ...th, textAlign: 'left' }}>Period</th>
            <th
              colSpan={showServiceLevel ? 2 : 1}
              data-testid="nv-hist-block-you"
              style={mine({ ...th, textAlign: 'center', ...blockSep })}
            >
              You
            </th>
            <th colSpan={3} data-testid="nv-hist-block-happened" style={{ ...th, textAlign: 'center', ...blockSep }}>
              What happened
            </th>
            <th colSpan={2} data-testid="nv-hist-block-profit" style={mine({ ...th, textAlign: 'center', ...blockSep })}>
              Your profit
            </th>
          </tr>
          {/* Row 2 — plain sub-labels, no suffixes. */}
          <tr>
            <th style={mine({ ...th, ...blockSep })}>Order</th>
            {showServiceLevel && <th style={mine(th)} data-testid="nv-hist-sl-header">Demand met</th>}
            <th style={{ ...th, ...blockSep }}>Demand</th>
            <th style={th}>Units over</th>
            <th style={th}>Units short</th>
            <th style={mine({ ...th, ...blockSep })}>This period</th>
            <th style={mine(th)}>Average</th>
          </tr>
        </thead>
        <tbody>
          {history.map(r => (
            <tr key={r.round} data-testid={`nv-history-row-${r.round}`}>
              <td style={{ ...td, textAlign: 'left' }}>{r.round}</td>
              <td style={mine({ ...td, ...blockSep })} data-testid={`nv-history-order-${r.round}`}>
                {formatUnits(r.yourOrder)}
              </td>
              {showServiceLevel && (
                <td style={mine(td)} data-testid={`nv-history-sl-${r.round}`}>
                  {formatPercent(r.serviceLevel)}
                </td>
              )}
              <td style={{ ...td, ...blockSep }} data-testid={`nv-history-demand-${r.round}`}>
                {formatUnits(r.demand)}
              </td>
              <td style={td}>{formatUnits(r.unitsOver)}</td>
              <td style={td}>{formatUnits(r.unitsShort)}</td>
              <ProfitCell value={r.profit} style={mine({ ...td, ...blockSep })} testId={`nv-history-profit-${r.round}`} />
              <ProfitCell value={r.yourAverage} style={mine(td)} testId={`nv-history-average-${r.round}`} />
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
