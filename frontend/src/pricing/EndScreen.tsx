import { colors, typography } from '@mygames/game-ui'
import type { PricingHistoryRow, PricingLabels } from './api'
import { HistoryTable } from './HistoryTable'
import { formatProfitM } from './format'
import { card, sectionTitle } from './MarketPanel'

// ═══════════════════════════════════════════════════════════════════════════════
// The end screen — the student's game is over (spec §4).
//
// ⚠ THIS IS WHERE THE ROUND COUNT IS FINALLY REVEALED, and the only place it ever
// is. The hidden-horizon rule is a DURING-PLAY rule: its whole purpose is to stop a
// student reasoning backwards from a known last round, and once the last round is
// behind them there is nothing left to reason backwards from. The number is not
// fetched from anywhere — it is `history.length`, which the student could count off
// the table themselves.
//
// SLICE 2 ends here. The debrief paragraph (spec §9) and its reveal of what the
// competitor was actually doing are the next slice; the button below is the seam
// they attach to, deliberately visible now so the flow's shape is testable.
// ═══════════════════════════════════════════════════════════════════════════════

export function EndScreen({
  history,
  labels,
  pmg,
  totalProfit,
  averageProfit,
  onContinue,
}: {
  history: PricingHistoryRow[]
  labels: PricingLabels
  pmg: boolean
  totalProfit: number
  averageProfit: number
  onContinue?: () => void
}) {
  const rounds = history.length

  return (
    <div>
      <h1 data-testid="pricing-game-over" style={{ marginTop: 0, fontSize: '1.6rem', color: colors.text }}>
        That was your last round
      </h1>

      <p style={{ lineHeight: 1.6, color: colors.text }}>
        Your game lasted{' '}
        <strong data-testid="pricing-final-rounds">{rounds}</strong> round{rounds === 1 ? '' : 's'}.
        Every round you played is below.
      </p>

      <section style={{ ...card, background: colors.confirmBg, borderColor: colors.confirmBorder }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '1.5rem 3rem' }}>
          <div>
            <div style={{ fontSize: typography.sizeSm, color: colors.textSecondary, marginBottom: '0.15rem' }}>
              Total profit
            </div>
            <div
              data-testid="pricing-final-total"
              style={{ fontSize: '1.4rem', fontWeight: 700, color: totalProfit < 0 ? colors.errorAction : colors.text }}
            >
              {formatProfitM(totalProfit)}
            </div>
          </div>
          <div>
            <div style={{ fontSize: typography.sizeSm, color: colors.textSecondary, marginBottom: '0.15rem' }}>
              Average profit per round
            </div>
            <div
              data-testid="pricing-final-average"
              style={{ fontSize: '1.4rem', fontWeight: 700, color: averageProfit < 0 ? colors.errorAction : colors.text }}
            >
              {formatProfitM(averageProfit)}
            </div>
          </div>
        </div>
      </section>

      {/* The seam the debrief attaches to next slice. Until then it says what it is:
          a student who reaches it has finished everything that exists. */}
      <button
        data-testid="pricing-to-debrief"
        onClick={onContinue}
        disabled={!onContinue}
        style={{
          padding: '0.7rem 1.75rem', fontSize: '1rem', fontWeight: 600,
          cursor: onContinue ? 'pointer' : 'not-allowed',
          backgroundColor: onContinue ? colors.text : colors.disabledBtnBg,
          color: colors.white, border: 'none', borderRadius: 6, marginBottom: '0.5rem',
        }}
      >
        Continue to the debrief
      </button>
      <p data-testid="pricing-debrief-pending" style={{ fontSize: typography.sizeXs, color: colors.textSecondary, margin: '0 0 1.5rem' }}>
        The debrief is not open yet. Your game has been recorded — you can close this tab.
      </p>

      {rounds > 0 && (
        <section style={card}>
          <h2 style={sectionTitle}>Your game</h2>
          <HistoryTable history={history} labels={labels} pmg={pmg} />
        </section>
      )}
    </div>
  )
}
