import { useState } from 'react'
import { colors, typography } from '@mygames/game-ui'
import {
  newsvendorSubmitRound,
  type NewsvendorHistoryRow, type NewsvendorParams, type NewsvendorRoundResult,
} from './api'
import { ParameterBox, DemandBox, ServiceLevelCalculator, card } from './ParamsPanel'
import { HistoryTable } from './HistoryTable'
import { formatMoney, formatPercent, formatUnits } from './format'

// ═══════════════════════════════════════════════════════════════════════════════
// The two halves of one period (spec §7a, §7b): PLACE ORDER, then ROUND RESULTS.
// They are the ASK and the DISPLAY of the shared sequence runner's loop screen — the
// same primitive PD and pricing use, so nothing about looping is implemented here.
//
// ⚠ NEITHER SCREEN SHOWS THE BENCHMARK (spec §9.2). Q_opt and profitOpt exist for
// every period and are on the instructor's reports; they are not in the props of
// either component below, because they are not in the server's student responses.
// ═══════════════════════════════════════════════════════════════════════════════

const heading = {
  marginTop: 0, marginBottom: '1.25rem', fontSize: '1.35rem',
  color: colors.text, lineHeight: 1.35,
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

/** 7a — Place Order. */
export function PlaceOrder({
  periodNumber,
  params,
  history,
  onResult,
}: {
  periodNumber: number
  params: NewsvendorParams
  history: NewsvendorHistoryRow[]
  onResult: (result: NewsvendorRoundResult, done: boolean) => void
}) {
  const [text, setText] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const parsed = Number(text)
  // The same rule the server enforces (spec §3): a whole number inside the bounds.
  // Client-side validation is a convenience — the server is the authority, and it
  // re-checks every one of these.
  const valid = text.trim() !== ''
    && Number.isInteger(parsed)
    && parsed >= params.orderMin
    && parsed <= params.orderMax
  const canSubmit = valid && !submitting

  const handleSubmit = async () => {
    if (!canSubmit) return
    setSubmitting(true)
    setError(null)
    try {
      const res = await newsvendorSubmitRound(periodNumber, parsed)
      onResult(res, res.gameOver)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong. Please try again.')
      setSubmitting(false)
    }
  }

  return (
    <div>
      <h1 data-testid="nv-period-heading" style={heading}>
        Period {periodNumber} of {params.periods}
      </h1>

      <ParameterBox params={params} />
      <DemandBox params={params} />

      <section style={card}>
        <label
          htmlFor="nv-order"
          style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 600 }}
        >
          {params.dual ? 'How many units will you reserve?' : 'How many units will you order?'}
        </label>
        <input
          id="nv-order"
          data-testid="nv-order-input"
          type="number"
          inputMode="numeric"
          autoFocus
          min={params.orderMin}
          max={params.orderMax}
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
          A whole number between <span style={tnum}>{formatUnits(params.orderMin)}</span> and{' '}
          <span style={tnum}>{formatUnits(params.orderMax)}</span>.
        </p>
      </section>

      {error && (
        <p data-testid="nv-order-error" role="alert" style={{ color: colors.errorAction, fontSize: typography.sizeSm, marginBottom: '0.75rem' }}>
          {error}
        </p>
      )}

      <button
        data-testid="nv-submit-order"
        onClick={() => void handleSubmit()}
        disabled={!canSubmit}
        style={{ ...primaryButton(canSubmit), marginBottom: '1.5rem' }}
      >
        {submitting ? 'Placing order…' : 'Place order'}
      </button>

      {params.showCalculator && <ServiceLevelCalculator params={params} />}

      {/* From period 2 on, the history table sits below the form (spec §7a). */}
      {history.length > 0 && (
        <section style={{ marginTop: '1.5rem' }}>
          <h2 style={{ fontSize: '0.95rem', marginBottom: '0.5rem' }}>Your periods so far</h2>
          <HistoryTable history={history} showServiceLevel={params.showServiceLevel} dual={params.dual} />
        </section>
      )}
    </div>
  )
}

/** 7b — Round Results. */
export function PeriodResults({
  periodNumber,
  result,
  params,
  onContinue,
}: {
  periodNumber: number
  result: NewsvendorRoundResult
  params: NewsvendorParams
  onContinue: () => void
}) {
  const r = result.round
  return (
    <div>
      <h1 data-testid="nv-results-heading" style={heading}>
        Period {periodNumber} of {params.periods} — results
      </h1>

      <ParameterBox params={params} />

      <section data-testid="nv-results" style={card}>
        <div style={statRow}>
          <span>{params.dual ? 'You reserved' : 'Your order'}</span>
          <strong style={tnum} data-testid="nv-result-order">{formatUnits(r.yourOrder)}</strong>
        </div>
        <div style={statRow}>
          <span>Customer demand</span>
          <strong style={tnum} data-testid="nv-result-demand">{formatUnits(r.demand)}</strong>
        </div>
        {params.showServiceLevel && (
          <div style={statRow}>
            {/* ⚠ In DUAL every unit of demand is met — by the second source if not from
                the reserve — so "demand proportion met" would always read 100% and say
                nothing. The number is the same either way; the LABEL is what changes,
                to name the fraction covered from the cheap reserve. */}
            <span>{params.dual ? 'Demand covered from your reserve' : 'Your demand proportion met'}</span>
            <strong style={tnum} data-testid="nv-result-sl">{formatPercent(r.serviceLevel)}</strong>
          </div>
        )}
        <div style={statRow}>
          <span>Total sales</span>
          <strong style={tnum} data-testid="nv-result-sales">{formatUnits(r.sales)}</strong>
        </div>
        <div style={statRow}>
          <span>Units over (left unsold)</span>
          <strong style={tnum} data-testid="nv-result-over">{formatUnits(r.unitsOver)}</strong>
        </div>
        {/* ⚠ SPEC §7b: dual RELABELS this, and it is not cosmetic. Those units were not
            lost — they were SOLD, at the second supplier's higher cost. Calling them
            "short" would tell the student they failed when they merely paid more. */}
        {params.dual ? (
          <>
            <div style={statRow}>
              <span>Units bought from second source</span>
              <strong style={tnum} data-testid="nv-result-topup">
                {formatUnits(r.unitsFromSecondSource)}
              </strong>
            </div>
            <div style={statRow}>
              <span>…at the second-supplier cost of</span>
              <strong style={tnum} data-testid="nv-result-cl">{formatMoney(params.cL)}</strong>
            </div>
          </>
        ) : (
          <div style={statRow}>
            <span>Units short (demand you could not meet)</span>
            <strong style={tnum} data-testid="nv-result-short">{formatUnits(r.unitsShort)}</strong>
          </div>
        )}
        <div style={{ ...statRow, borderTop: `1px solid ${colors.borderMid}`, marginTop: '0.4rem', paddingTop: '0.5rem', fontSize: '1rem' }}>
          <span><strong>This period&rsquo;s profit</strong></span>
          <strong
            data-testid="nv-result-profit"
            style={{ ...tnum, color: r.profit < 0 ? colors.errorAction : colors.text }}
          >
            {formatMoney(r.profit)}
          </strong>
        </div>
      </section>

      <button
        data-testid="nv-continue"
        onClick={onContinue}
        style={{ ...primaryButton(true), marginBottom: '1.5rem' }}
      >
        {result.gameOver ? 'See your final results' : 'Continue'}
      </button>

      <section style={{ marginTop: '0.5rem' }}>
        <h2 style={{ fontSize: '0.95rem', marginBottom: '0.5rem' }}>Your periods so far</h2>
        <HistoryTable history={result.history} showServiceLevel={params.showServiceLevel} dual={params.dual} />
      </section>
    </div>
  )
}
