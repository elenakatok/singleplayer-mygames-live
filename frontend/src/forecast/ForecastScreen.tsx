import { useState } from 'react'
import { colors, typography } from '@mygames/game-ui'
import {
  forecastSubmitRound,
  type ForecastHistoryPoint, type ForecastParams, type ForecastPlayedRow,
  type ForecastRoundResult, type ForecastRunning,
} from './api'
import { DemandChartSVG } from './DemandChartSVG'
import { MonthYearGrid } from './MonthYearGrid'
import { HistoryTable } from './HistoryTable'
import { DataExport } from './DataExport'
import {
  formatUnits, formatBig, formatMetric, formatPercent, formatMoney, formatSigned,
  METRIC_LABELS,
} from './format'

// ═══════════════════════════════════════════════════════════════════════════════
// The two halves of one month (spec §4): ENTER FORECAST, then MONTH RESULTS. They are
// the ASK and the DISPLAY of the shared sequence runner's loop screen — the same
// primitive PD, pricing and newsvendor use, so nothing about looping is implemented
// here.
//
// ⚠ NEITHER SCREEN SHOWS THE MODEL OR A BENCHMARK. Not because they are filtered out,
// but because neither is in the props: the server does not send them (api.ts), and the
// benchmark table belongs to the debrief, after the game is over (spec §9).
//
// ⚠ THE HORIZON IS SHOWN — "month 1 of 24" (spec §4, §15). A deliberate departure from
// PD and pricing, which hide their round counts: there is no strategic reason to hide
// it here, SoPHIE showed it, and a visible planning horizon is realistic.
// ═══════════════════════════════════════════════════════════════════════════════

const heading = {
  marginTop: 0, marginBottom: '0.35rem', fontSize: '1.35rem',
  color: colors.text, lineHeight: 1.35,
} as const

const subheading = {
  marginTop: 0, marginBottom: '1.25rem', fontSize: '0.95rem',
  color: colors.textSecondary,
} as const

const card = {
  background: colors.white,
  border: `1px solid ${colors.borderMid}`,
  borderRadius: 8,
  padding: '1rem 1.1rem',
  marginBottom: '1.25rem',
} as const

const primaryButton = (enabled: boolean) => ({
  padding: '0.7rem 1.75rem', fontSize: '1rem', fontWeight: 600,
  cursor: enabled ? 'pointer' : 'not-allowed',
  backgroundColor: enabled ? colors.text : colors.disabledBtnBg,
  color: colors.white, border: 'none', borderRadius: 6,
})

const statRow = {
  display: 'flex', justifyContent: 'space-between', gap: '1rem',
  padding: '0.3rem 0', fontSize: typography.sizeSm,
} as const

const tnum = { fontVariantNumeric: 'tabular-nums' as const }

/** The metric definitions and the objective, restated on every entry screen (spec §4:
 *  "A short reminder of the metric definitions and the objective"). */
function MetricReminder() {
  return (
    <section data-testid="fc-metric-reminder" style={{ ...card, background: '#f8fafc' }}>
      <h2 style={{ fontSize: '0.9rem', margin: '0 0 0.5rem' }}>How your forecasts are measured</h2>
      <ul style={{ margin: 0, paddingLeft: '1.1rem', fontSize: '0.82rem', color: colors.textSecondary, lineHeight: 1.6 }}>
        <li><strong>Error</strong> = actual demand − your forecast.</li>
        <li><strong>{METRIC_LABELS.mae}</strong> = the average of your absolute errors so far.</li>
        <li>
          <strong>{METRIC_LABELS.mse}</strong> = the average of your <em>squared</em> errors so far.
          {' '}<strong style={{ color: colors.text }}>This is your objective — lower is better.</strong>
          {' '}Squaring means a few large misses cost far more than many small ones.
        </li>
        <li><strong>{METRIC_LABELS.standardError}</strong> = √{METRIC_LABELS.mse}, in units of demand.</li>
        <li>
          <strong>{METRIC_LABELS.mape}</strong> = the average of |error| ÷ actual, as a percentage;
          {' '}<strong>{METRIC_LABELS.accuracy}</strong> = 100% − {METRIC_LABELS.mape}.
        </li>
      </ul>
    </section>
  )
}

/** The running scorecard card (spec §4's round-results screen, §5's final screen). */
export function Scorecard({
  running,
  bonusAtPerfect,
  testId = 'fc-scorecard',
}: {
  running: ForecastRunning
  bonusAtPerfect: number
  testId?: string
}) {
  return (
    <section data-testid={testId} style={card}>
      <h2 style={{ fontSize: '0.9rem', margin: '0 0 0.6rem' }}>
        Your running scorecard <span style={{ fontWeight: 400, color: colors.textSecondary }}>
          (after {running.n} {running.n === 1 ? 'month' : 'months'})
        </span>
      </h2>

      {/* MSE first and emphasised — it is the objective (spec §5a). */}
      <div style={{ ...statRow, fontSize: '1rem', borderBottom: `1px solid ${colors.borderMid}`, paddingBottom: '0.5rem' }}>
        <span><strong>{METRIC_LABELS.mse}</strong> <span style={{ color: colors.textSecondary, fontSize: '0.8rem' }}>— your objective</span></span>
        <strong style={tnum} data-testid={`${testId}-mse`}>{formatBig(running.mse)}</strong>
      </div>

      <div style={statRow}>
        <span>{METRIC_LABELS.standardError} (√{METRIC_LABELS.mse})</span>
        <strong style={tnum} data-testid={`${testId}-se`}>{formatMetric(running.standardError)}</strong>
      </div>
      <div style={statRow}>
        <span>{METRIC_LABELS.mae}</span>
        <strong style={tnum} data-testid={`${testId}-mae`}>{formatMetric(running.mae)}</strong>
      </div>
      <div style={statRow}>
        <span>{METRIC_LABELS.bias}</span>
        <strong style={tnum} data-testid={`${testId}-bias`}>{formatSigned(running.meanError, 1)}</strong>
      </div>
      <div style={statRow}>
        <span>{METRIC_LABELS.mape}</span>
        <strong style={tnum} data-testid={`${testId}-mape`}>{formatPercent(running.mape)}</strong>
      </div>
      <div style={statRow}>
        <span>{METRIC_LABELS.accuracy}</span>
        <strong style={tnum} data-testid={`${testId}-accuracy`}>{formatPercent(running.accuracy)}</strong>
      </div>
      <div style={{ ...statRow, borderTop: `1px solid ${colors.borderMid}`, marginTop: '0.4rem', paddingTop: '0.5rem' }}>
        <span>Your bonus at this accuracy</span>
        <strong style={tnum} data-testid={`${testId}-bonus`}>{formatMoney(running.bonus)}</strong>
      </div>
      <p style={{ margin: '0.35rem 0 0', fontSize: '0.72rem', color: colors.textSecondary }}>
        Based on an annual bonus of {formatMoney(bonusAtPerfect)} × (1 − {METRIC_LABELS.mape}).
      </p>
    </section>
  )
}

/** §4 — Enter your forecast. */
export function EnterForecast({
  roundNumber,
  params,
  history,
  played,
  onResult,
}: {
  roundNumber: number
  params: ForecastParams
  history: ForecastHistoryPoint[]
  played: ForecastPlayedRow[]
  onResult: (result: ForecastRoundResult, done: boolean) => void
}) {
  const [text, setText] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const period = params.firstPlayPeriod + roundNumber - 1
  const year = Math.floor((period - 1) / 12) + 1
  const monthName = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ][((period - 1) % 12)]

  const parsed = Number(text)
  // The same rule the server enforces: a whole number inside the bounds. Client-side
  // validation is a convenience — the server is the authority and re-checks all of it.
  const valid = text.trim() !== ''
    && Number.isInteger(parsed)
    && parsed >= params.forecastMin
    && parsed <= params.forecastMax
  const canSubmit = valid && !submitting

  const handleSubmit = async () => {
    if (!canSubmit) return
    setSubmitting(true)
    setError(null)
    try {
      const res = await forecastSubmitRound(roundNumber, parsed)
      onResult(res, res.gameOver)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong. Please try again.')
      setSubmitting(false)
    }
  }

  return (
    <div>
      <h1 data-testid="fc-round-heading" style={heading}>
        Year {year}, {monthName}
      </h1>
      <p data-testid="fc-round-progress" style={subheading}>
        {params.periodLabel === 'month' ? 'Month' : params.periodLabel} {roundNumber} of {params.rounds}
      </p>

      <section style={{ ...card, padding: '0.75rem' }}>
        <DemandChartSVG
          history={history}
          played={played}
          totalPeriods={params.numHistory + params.rounds}
        />
      </section>

      <section style={card}>
        <label
          htmlFor="fc-forecast"
          style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 600 }}
        >
          Your forecast of demand for Year {year}, {monthName}
        </label>
        <input
          id="fc-forecast"
          data-testid="fc-forecast-input"
          type="number"
          inputMode="numeric"
          autoFocus
          min={params.forecastMin}
          max={params.forecastMax}
          step={1}
          value={text}
          disabled={submitting}
          onChange={e => setText(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') void handleSubmit() }}
          style={{
            width: '11rem', fontSize: '1.1rem', padding: '0.55rem 0.7rem', borderRadius: 4,
            border: `1px solid ${colors.inputBorder}`, ...tnum,
          }}
        />
        <p style={{ margin: '0.5rem 0 0', fontSize: '0.8rem', color: colors.textSecondary }}>
          A whole number of {params.unitLabel} between{' '}
          <span style={tnum}>{formatUnits(params.forecastMin)}</span> and{' '}
          <span style={tnum}>{formatUnits(params.forecastMax)}</span>.
        </p>
      </section>

      {error && (
        <p data-testid="fc-forecast-error" role="alert" style={{ color: colors.errorAction, fontSize: typography.sizeSm, marginBottom: '0.75rem' }}>
          {error}
        </p>
      )}

      <button
        data-testid="fc-submit-forecast"
        onClick={() => void handleSubmit()}
        disabled={!canSubmit}
        style={{ ...primaryButton(canSubmit), marginBottom: '1.5rem' }}
      >
        {submitting ? 'Submitting…' : 'Submit forecast'}
      </button>

      <MetricReminder />

      {/* The data export — spec §4 calls it load-bearing, and requires the in-play
          file be LABELLED as the five-year history. */}
      <section style={card}>
        <h2 style={{ fontSize: '0.9rem', margin: '0 0 0.5rem' }}>The demand data</h2>
        <p style={{ margin: '0 0 0.6rem', fontSize: '0.82rem', color: colors.textSecondary }}>
          Download the five years of history to analyse it in Excel. This file covers
          Years&nbsp;1–{Math.ceil(params.numHistory / 12)} and does not change as you play —
          the table below always shows every month revealed so far.
        </p>
        <DataExport kind="history" label="Download demand history (CSV)" />
      </section>

      <section style={{ marginTop: '1.5rem' }}>
        <h2 style={{ fontSize: '0.95rem', marginBottom: '0.5rem' }}>Demand by month and year</h2>
        <MonthYearGrid history={history} played={played} />
      </section>

      {played.length > 0 && (
        <section style={{ marginTop: '1.5rem' }}>
          <h2 style={{ fontSize: '0.95rem', marginBottom: '0.5rem' }}>Your months so far</h2>
          <HistoryTable history={played} />
        </section>
      )}
    </div>
  )
}

/** §4 — Month results. */
export function MonthResults({
  result,
  params,
  history,
  onContinue,
}: {
  result: ForecastRoundResult
  params: ForecastParams
  history: ForecastHistoryPoint[]
  onContinue: () => void
}) {
  const r = result.round
  return (
    <div>
      <h1 data-testid="fc-results-heading" style={heading}>
        {r.label} — results
      </h1>
      <p style={subheading}>
        {params.periodLabel === 'month' ? 'Month' : params.periodLabel} {r.round} of {params.rounds}
      </p>

      {/* The chart, now with this month's actual added AND the forecasts as a second
          line (spec §4) — "the cheapest learning aid in the game". */}
      <section style={{ ...card, padding: '0.75rem' }}>
        <DemandChartSVG
          history={history}
          played={result.history}
          totalPeriods={params.numHistory + params.rounds}
        />
      </section>

      <section data-testid="fc-month-card" style={card}>
        <div style={statRow}>
          <span>Your forecast</span>
          <strong style={tnum} data-testid="fc-result-forecast">{formatUnits(r.forecast)}</strong>
        </div>
        <div style={statRow}>
          <span>Actual demand</span>
          <strong style={tnum} data-testid="fc-result-actual">{formatUnits(r.actual)}</strong>
        </div>
        <div style={statRow}>
          <span>Error <span style={{ color: colors.textSecondary, fontSize: '0.75rem' }}>(actual − forecast)</span></span>
          <strong style={tnum} data-testid="fc-result-error">{formatSigned(r.error)}</strong>
        </div>
        <div style={statRow}>
          <span>Absolute error</span>
          <strong style={tnum} data-testid="fc-result-ae">{formatUnits(r.absoluteError)}</strong>
        </div>
        <div style={{ ...statRow, borderTop: `1px solid ${colors.borderMid}`, marginTop: '0.4rem', paddingTop: '0.5rem' }}>
          <span><strong>Squared error</strong></span>
          <strong style={tnum} data-testid="fc-result-se">{formatBig(r.squaredError)}</strong>
        </div>
      </section>

      <Scorecard running={result.running} bonusAtPerfect={params.bonusAtPerfect} />

      <button
        data-testid="fc-continue"
        onClick={onContinue}
        style={{ ...primaryButton(true), marginBottom: '1.5rem' }}
      >
        {result.gameOver ? 'See your final results' : 'Continue'}
      </button>

      <section style={{ marginTop: '0.5rem' }}>
        <h2 style={{ fontSize: '0.95rem', marginBottom: '0.5rem' }}>Your months so far</h2>
        <HistoryTable history={result.history} />
      </section>
    </div>
  )
}
