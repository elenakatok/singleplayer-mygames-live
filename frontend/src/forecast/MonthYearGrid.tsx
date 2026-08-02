import { colors, typography } from '@mygames/game-ui'
import type { ForecastHistoryPoint, ForecastPlayedRow } from './api'

// ═══════════════════════════════════════════════════════════════════════════════
// THE MONTH-BY-YEAR GRID (spec §4, laid out as spec §2.1's table).
//
// ⚠ THIS IS HOW A STUDENT SPOTS SEASONALITY BY EYE (spec §4). The chart shows the
// shape; the grid shows the RULE — five Novembers stacked in one column, each above
// every other month of its year, is an argument a line chart cannot make. It is free
// to render from data already on the client, and spec §4 calls it out separately from
// the chart for exactly that reason.
//
// ⚠ NO HIGH-SEASON HIGHLIGHT, for the same reason the chart has none: noticing which
// columns are tall is the exercise (spec §7). The grid presents the numbers in the
// arrangement that makes noticing POSSIBLE, and stops there.
//
// Revealed months are appended as they are played, so the grid grows a Y6 and then a
// Y7 row — which is what lets a student re-fit by hand mid-game after the in-play CSV
// deliberately froze at Year 5 (spec §4).
// ═══════════════════════════════════════════════════════════════════════════════

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

const th = {
  padding: '0.3rem 0.45rem',
  fontSize: '0.75rem',
  fontWeight: 600,
  color: colors.textSecondary,
  borderBottom: `1px solid ${colors.borderMid}`,
  textAlign: 'right' as const,
  whiteSpace: 'nowrap' as const,
}

const td = {
  padding: '0.28rem 0.45rem',
  fontSize: '0.8rem',
  textAlign: 'right' as const,
  fontVariantNumeric: 'tabular-nums' as const,
  borderBottom: `1px solid ${colors.borderLight ?? '#eee'}`,
}

export function MonthYearGrid({
  history,
  played = [],
}: {
  history: ForecastHistoryPoint[]
  played?: ForecastPlayedRow[]
}) {
  // One map from period → demand, so history and revealed play are the same series.
  const byPeriod = new Map<number, number>()
  for (const h of history) byPeriod.set(h.period, h.demand)
  for (const p of played) byPeriod.set(p.period, p.actual)

  const periods = [...byPeriod.keys()].sort((a, b) => a - b)
  if (periods.length === 0) return null
  const lastYear = Math.floor((periods[periods.length - 1] - 1) / 12) + 1
  const years = Array.from({ length: lastYear }, (_, i) => i + 1)

  return (
    <div style={{ overflowX: 'auto' }}>
      <table
        data-testid="fc-month-grid"
        style={{
          borderCollapse: 'collapse',
          fontFamily: typography.fontFamily,
          minWidth: '640px',
          width: '100%',
        }}
      >
        <thead>
          <tr>
            <th style={{ ...th, textAlign: 'left' }} />
            {MONTH_NAMES.map(m => (
              <th key={m} style={th}>{m}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {years.map(year => (
            <tr key={year} data-testid={`fc-grid-row-${year}`}>
              <th
                scope="row"
                style={{ ...td, textAlign: 'left', fontWeight: 700, color: colors.textSecondary }}
              >
                Y{year}
              </th>
              {MONTH_NAMES.map((_, mi) => {
                const period = (year - 1) * 12 + mi + 1
                const v = byPeriod.get(period)
                return (
                  <td key={mi} data-testid={`fc-grid-cell-${period}`} style={td}>
                    {v === undefined ? '' : v.toLocaleString()}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
