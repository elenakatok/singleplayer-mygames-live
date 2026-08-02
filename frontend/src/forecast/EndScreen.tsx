import { colors, typography } from '@mygames/game-ui'
import type {
  ForecastHistoryPoint, ForecastParams, ForecastPlayedRow, ForecastRunning, ForecastYears,
} from './api'
import { DemandChartSVG } from './DemandChartSVG'
import { HistoryTable } from './HistoryTable'
import { DataExport } from './DataExport'
import { Scorecard } from './ForecastScreen'
import { formatBig, formatMoney, formatPercent } from './format'

// ═══════════════════════════════════════════════════════════════════════════════
// THE FINAL RESULTS SCREEN (spec §5).
//
// ⚠ NO CLASS COMPARISON HERE. The single-player family rule holds: a display screen
// shows only THIS student's own data plus instance config (architecture §2.2). The
// class chart is the instructor's Tier-3 report, and the benchmark table belongs to the
// debrief screen — which comes AFTER the student has written their paragraph, so that
// the paragraph describes what they actually did rather than what they now know they
// should have done (spec §9).
//
// ⚠ THE BONUS IS STATED IN THE SoPHIE FRAMING (spec §5) — "your holiday bonus would
// have been …" — and sits BESIDE the MSE rather than above it. Spec §5a is explicit
// that the bonus compresses the distinction the game teaches and that MSE is where the
// lesson lands, so the layout keeps MSE the headline and the bonus the flourish.
// ═══════════════════════════════════════════════════════════════════════════════

const heading = {
  marginTop: 0, marginBottom: '0.35rem', fontSize: '1.45rem',
  color: colors.text, lineHeight: 1.35,
} as const

const card = {
  background: colors.white,
  border: `1px solid ${colors.borderMid}`,
  borderRadius: 8,
  padding: '1rem 1.1rem',
  marginBottom: '1.25rem',
} as const

const primaryButton = {
  padding: '0.7rem 1.75rem', fontSize: '1rem', fontWeight: 600, cursor: 'pointer',
  backgroundColor: colors.text, color: colors.white, border: 'none', borderRadius: 6,
} as const

const tnum = { fontVariantNumeric: 'tabular-nums' as const }

/** Y6 vs Y7, side by side (spec §5: "did they improve?"). */
function YearComparison({ years }: { years: ForecastYears }) {
  const { first, second, improved } = years
  if (!first) return null

  const cell = (y: { year: number; n: number; mse: number }) => (
    <div style={{ flex: 1, minWidth: '9rem' }}>
      <div style={{ fontSize: '0.78rem', color: colors.textSecondary }}>
        Year {y.year} <span style={{ fontSize: '0.72rem' }}>({y.n} {y.n === 1 ? 'month' : 'months'})</span>
      </div>
      <div style={{ ...tnum, fontSize: '1.5rem', fontWeight: 700 }} data-testid={`fc-year-mse-${y.year}`}>
        {formatBig(y.mse)}
      </div>
      <div style={{ fontSize: '0.72rem', color: colors.textSecondary }}>MSE</div>
    </div>
  )

  return (
    <section data-testid="fc-year-comparison" style={card}>
      <h2 style={{ fontSize: '0.95rem', margin: '0 0 0.75rem' }}>Did you improve?</h2>
      <div style={{ display: 'flex', gap: '1.5rem', flexWrap: 'wrap', alignItems: 'flex-start' }}>
        {cell(first)}
        {second && cell(second)}
      </div>
      {improved !== null && (
        <p data-testid="fc-improved-verdict" style={{ margin: '0.75rem 0 0', fontSize: '0.85rem' }}>
          {improved
            ? `Your forecasts got better: Year ${second!.year}'s MSE is lower than Year ${first.year}'s.`
            : `Year ${second!.year}'s MSE is not lower than Year ${first.year}'s.`}
        </p>
      )}
    </section>
  )
}

export function EndScreen({
  params,
  history,
  played,
  running,
  years,
  onContinue,
}: {
  params: ForecastParams
  history: ForecastHistoryPoint[]
  played: ForecastPlayedRow[]
  running: ForecastRunning
  years: ForecastYears
  onContinue?: () => void
}) {
  return (
    <div>
      <h1 data-testid="fc-final-heading" style={heading}>Your final results</h1>
      <p style={{ marginTop: 0, marginBottom: '1.25rem', fontSize: '0.95rem', color: colors.textSecondary }}>
        You forecast {played.length} {played.length === 1 ? 'month' : 'months'} of demand
        for {params.productName}.
      </p>

      {/* Spec §5: the full chart — all 84 months of actual demand against the 24
          forecasts. Same component as the round screens, now with the whole series. */}
      <section style={{ ...card, padding: '0.75rem' }}>
        <DemandChartSVG
          history={history}
          played={played}
          totalPeriods={params.numHistory + params.rounds}
          height={340}
        />
      </section>

      <Scorecard running={running} bonusAtPerfect={params.bonusAtPerfect} testId="fc-final-scorecard" />

      {/* The bonus, in the SoPHIE framing (spec §5). */}
      <section data-testid="fc-bonus-statement" style={{ ...card, background: '#f8fafc' }}>
        <p style={{ margin: 0, fontSize: '0.95rem' }}>
          At a Forecast Accuracy of{' '}
          <strong style={tnum}>{formatPercent(running.accuracy)}</strong>, your holiday bonus
          would have been <strong style={tnum} data-testid="fc-final-bonus">{formatMoney(running.bonus)}</strong>.
        </p>
        <p style={{ margin: '0.5rem 0 0', fontSize: '0.78rem', color: colors.textSecondary }}>
          Your MSE of <strong style={tnum}>{formatBig(running.mse)}</strong> is the measure that
          matters for this assignment — we will compare it with the alternatives in the
          next lecture.
        </p>
      </section>

      <YearComparison years={years} />

      <section style={card}>
        <h2 style={{ fontSize: '0.95rem', margin: '0 0 0.5rem' }}>Take your data with you</h2>
        <p style={{ margin: '0 0 0.6rem', fontSize: '0.82rem', color: colors.textSecondary }}>
          This file covers all {params.numHistory + played.length} months — the five years of
          history plus every month you forecast, with your errors.
        </p>
        <DataExport
          kind="full"
          label="Download the full data (CSV)"
          testIdPrefix="fc-final-export"
        />
      </section>

      {onContinue && (
        <button data-testid="fc-final-continue" onClick={onContinue} style={{ ...primaryButton, marginBottom: '1.5rem' }}>
          Continue
        </button>
      )}

      <section style={{ marginTop: '0.5rem', fontFamily: typography.fontFamily }}>
        <h2 style={{ fontSize: '0.95rem', marginBottom: '0.5rem' }}>Every month you forecast</h2>
        <HistoryTable history={played} />
      </section>
    </div>
  )
}
