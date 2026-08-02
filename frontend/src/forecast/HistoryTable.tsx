import { colors, typography } from '@mygames/game-ui'
import type { ForecastPlayedRow } from './api'
import { formatUnits, formatBig, formatPercent, formatSigned, formatMetric } from './format'

// ═══════════════════════════════════════════════════════════════════════════════
// The played-months table (spec §4).
//
// Columns, exactly as spec §4 lists them:
//   Month | Your forecast | Actual demand | Error (signed) | Absolute error |
//   Squared error | Absolute % error | MAE to date | MSE to date | MAPE to date
//
// ⚠ SIGNED ERROR IS SHOWN DELIBERATELY (spec §4) and is colour-coded by direction, not
// by "good/bad": a negative error is not a worse error than a positive one of the same
// size, it is the OTHER kind of mistake. Colouring it red-for-bad would teach exactly
// the wrong thing. The two directions get two neutral hues, and the column exists so a
// student can see a run of same-signed errors — which is what bias looks like.
// ═══════════════════════════════════════════════════════════════════════════════

const OVER_COLOR = '#b45309'    // amber-700 — demand came in ABOVE the forecast
const UNDER_COLOR = '#4338ca'   // indigo-700 — demand came in BELOW the forecast

const th = {
  padding: '0.35rem 0.5rem',
  fontSize: '0.72rem',
  fontWeight: 600,
  color: colors.textSecondary,
  borderBottom: `1px solid ${colors.borderMid}`,
  textAlign: 'right' as const,
  whiteSpace: 'nowrap' as const,
}

const td = {
  padding: '0.3rem 0.5rem',
  fontSize: '0.8rem',
  textAlign: 'right' as const,
  fontVariantNumeric: 'tabular-nums' as const,
  borderBottom: `1px solid ${colors.borderLight ?? '#eee'}`,
  whiteSpace: 'nowrap' as const,
}

export function HistoryTable({ history }: { history: ForecastPlayedRow[] }) {
  if (history.length === 0) return null

  return (
    <div style={{ overflowX: 'auto' }}>
      <table
        data-testid="fc-history-table"
        style={{
          borderCollapse: 'collapse',
          fontFamily: typography.fontFamily,
          minWidth: '760px',
          width: '100%',
        }}
      >
        <thead>
          <tr>
            <th style={{ ...th, textAlign: 'left' }}>Month</th>
            <th style={th}>Your forecast</th>
            <th style={th}>Actual demand</th>
            <th style={th}>Error</th>
            <th style={th}>Absolute error</th>
            <th style={th}>Squared error</th>
            <th style={th}>Absolute % error</th>
            <th style={th}>MAE to date</th>
            <th style={th}>MSE to date</th>
            <th style={th}>MAPE to date</th>
          </tr>
        </thead>
        <tbody>
          {history.map(r => (
            <tr key={r.round} data-testid={`fc-history-row-${r.round}`}>
              <td style={{ ...td, textAlign: 'left', fontWeight: 600 }}>{r.label}</td>
              <td style={td} data-testid={`fc-row-forecast-${r.round}`}>{formatUnits(r.forecast)}</td>
              <td style={td} data-testid={`fc-row-actual-${r.round}`}>{formatUnits(r.actual)}</td>
              <td
                style={{ ...td, color: r.error > 0 ? OVER_COLOR : r.error < 0 ? UNDER_COLOR : colors.text }}
                data-testid={`fc-row-error-${r.round}`}
              >
                {formatSigned(r.error)}
              </td>
              <td style={td}>{formatUnits(r.absoluteError)}</td>
              <td style={td}>{formatBig(r.squaredError)}</td>
              <td style={td}>{formatPercent(r.absolutePercentageError)}</td>
              <td style={td}>{formatMetric(r.maeToDate)}</td>
              <td style={td} data-testid={`fc-row-mse-${r.round}`}>{formatBig(r.mseToDate)}</td>
              <td style={td}>{formatPercent(r.mapeToDate)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
