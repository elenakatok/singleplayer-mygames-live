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
// It is the LAST screen, after the debrief — a student reaches it once there is
// nothing left to do. The competitor reveal is repeated here (the debrief is where
// they first read it, and a student who closes the tab and comes back should not
// lose it).
// ═══════════════════════════════════════════════════════════════════════════════

export function EndScreen({
  history,
  labels,
  pmg,
  totalProfit,
  averageProfit,
  competitorReveal,
}: {
  history: PricingHistoryRow[]
  labels: PricingLabels
  pmg: boolean
  totalProfit: number
  averageProfit: number
  /** The server's reveal sentence (spec §9), or null if it declined to send one. */
  competitorReveal?: string | null
}) {
  const rounds = history.length

  return (
    <div>
      <h1 data-testid="pricing-game-over" style={{ marginTop: 0, fontSize: '1.6rem', color: colors.text }}>
        All done — thank you
      </h1>

      <p style={{ lineHeight: 1.6, color: colors.text }}>
        Your answers and your game have been recorded. Your game lasted{' '}
        <strong data-testid="pricing-final-rounds">{rounds}</strong> round{rounds === 1 ? '' : 's'}.
        You can close this tab.
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

      {competitorReveal && (
        <section
          data-testid="pricing-final-reveal"
          style={{ ...card, background: colors.infoBannerBg, borderColor: colors.infoBannerBorder }}
        >
          <h2 style={sectionTitle}>What your competitor was doing</h2>
          <p style={{ margin: 0, lineHeight: 1.6, color: colors.text }}>{competitorReveal}</p>
        </section>
      )}

      {rounds > 0 && (
        <section style={card}>
          <h2 style={sectionTitle}>Your game</h2>
          <HistoryTable history={history} labels={labels} pmg={pmg} />
        </section>
      )}
    </div>
  )
}
