import { colors, typography } from '@mygames/game-ui'
import type { NewsvendorHistoryRow, NewsvendorParams } from './api'
import { HistoryTable } from './HistoryTable'
import { formatAverageUnits, formatMoney, formatPercent } from './format'
import { card } from './ParamsPanel'

// ═══════════════════════════════════════════════════════════════════════════════
// Final Results (spec §7d). Shown TWICE, and deliberately by the same component:
// once as a step in the sequence (with a Continue button, before the knowledge check
// and the debrief) and once as the terminal screen a returning student lands on. One
// component means the totals a student is sent away with are the totals they were
// shown, character for character.
//
// ⚠ IT REPORTS THE AVERAGE PER PERIOD, NOT THE TOTAL. The total is a bigger, more
// satisfying number, and it is the wrong one: it scales with how many periods the
// instance happens to run, so it compares to nothing — not to another student on a
// different instance, not to the per-period figures the history table shows right
// underneath, and not to the Avg profit / period column the instructor is reading on
// the dashboard. The average is the one that means the same thing everywhere it
// appears. (The running total is still on the server and still in the reports; it is
// simply not the headline a student is sent away with.)
//
// ⚠⚠ WHAT THIS SCREEN DOES NOT SHOW, AND WHY IT IS THE MOST TEMPTING PLACE TO SHOW
// IT: the benchmark. Σ profitOpt and the optimality gap are computed and stored for
// every period, and the natural instinct on a results screen is to close the loop —
// "you earned $X, the optimal policy earned $Y". Spec §9.2 says no: the gap is for
// Elena's reports and the lecture that follows, not for a student alone with a
// scoreboard. The props below do not carry it, and the server never sent it.
// ═══════════════════════════════════════════════════════════════════════════════

const statBox = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(11rem, 1fr))',
  gap: '0.9rem',
} as const

const tnum = { fontVariantNumeric: 'tabular-nums' as const }

function Stat({ label, value, testId, negative }: {
  label: string; value: string; testId: string; negative?: boolean
}) {
  return (
    <div>
      <div style={{ fontSize: '0.78rem', color: colors.textSecondary, marginBottom: '0.15rem' }}>{label}</div>
      <div
        data-testid={testId}
        style={{ fontSize: '1.15rem', fontWeight: 700, ...tnum, color: negative ? colors.errorAction : colors.text }}
      >
        {value}
      </div>
    </div>
  )
}

export function EndScreen({
  params,
  history,
  averageProfit,
  averageOrder,
  averageServiceLevel,
  onContinue,
}: {
  params: NewsvendorParams
  history: NewsvendorHistoryRow[]
  /** ⚠ AVERAGE per period, not the total — see the header. */
  averageProfit: number
  averageOrder: number
  averageServiceLevel: number
  /** Present when this is a STEP in the sequence; absent on the terminal screen. */
  onContinue?: () => void
}) {
  return (
    <div>
      <h1 data-testid="nv-final-heading" style={{ marginTop: 0, marginBottom: '1rem', fontSize: '1.35rem', color: colors.text }}>
        Your final results
      </h1>
      <p style={{ marginTop: 0, marginBottom: '1.25rem', color: colors.textSecondary, fontSize: typography.sizeSm, lineHeight: 1.6 }}>
        You played all {params.periods} periods.
      </p>

      <section data-testid="nv-final-stats" style={{ ...card, ...statBox }}>
        <Stat
          label="Average profit per period"
          value={formatMoney(averageProfit)}
          testId="nv-final-avg-profit"
          negative={averageProfit < 0}
        />
        <Stat
          label="Average order"
          value={formatAverageUnits(averageOrder)}
          testId="nv-final-avg-order"
        />
        {params.showServiceLevel && (
          <Stat
            label="Average demand met"
            value={formatPercent(averageServiceLevel)}
            testId="nv-final-avg-sl"
          />
        )}
      </section>

      {onContinue && (
        <button
          data-testid="nv-final-continue"
          onClick={onContinue}
          style={{
            padding: '0.7rem 1.75rem', fontSize: '1rem', fontWeight: 600, cursor: 'pointer',
            backgroundColor: colors.text, color: colors.white, border: 'none', borderRadius: 6,
            marginBottom: '1.5rem',
          }}
        >
          Continue
        </button>
      )}

      {!onContinue && (
        <p data-testid="nv-all-done" style={{ margin: '0 0 1.5rem', fontSize: typography.sizeSm, color: colors.textSecondary }}>
          You&rsquo;re all done — you can close this window.
        </p>
      )}

      <section>
        <h2 style={{ fontSize: '0.95rem', marginBottom: '0.5rem' }}>Every period</h2>
        <HistoryTable history={history} showServiceLevel={params.showServiceLevel} />
      </section>
    </div>
  )
}
