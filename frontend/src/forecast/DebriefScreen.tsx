import { useState } from 'react'
import { colors, typography } from '@mygames/game-ui'
import {
  forecastSubmitDebrief,
  type ForecastDebriefQuestionClient, type ForecastReveal,
} from './api'
import { formatBig, formatMetric, formatPercent, formatSigned } from './format'

// ═══════════════════════════════════════════════════════════════════════════════
// THE DEBRIEF (spec §9) — one free-text question, ungraded, and then the REVEAL:
// "the highest-value screen in the game, and every number is already computed."
//
// ⚠⚠ THE ORDER IS ENFORCED ON THE SERVER, NOT HERE. The paragraph is stored before the
// reveal is built (functions forecast/submitDebrief.ts), and forecastGetReveal refuses
// until the debrief is behind the student. This component renders that sequence; it
// does not implement it. A client that skipped straight to the reveal would be refused.
//
// Why the order matters: spec §9 asks the student to say how they ACTUALLY forecast. A
// reveal available first would turn every answer into a description of the right answer,
// and the Tier-2 export — which Elena reads to write the debrief slides — would become
// worthless.
// ═══════════════════════════════════════════════════════════════════════════════

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

const tnum = { fontVariantNumeric: 'tabular-nums' as const }

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December']

/** Joins month names the way a sentence does: "November and December". */
function monthList(months: number[]): string {
  const names = months.map(m => MONTH_NAMES[m - 1])
  if (names.length <= 1) return names[0] ?? ''
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

/**
 * The reveal (spec §9): the true process, the student's own MSE, and the §2.3
 * benchmark table with their result placed in it.
 */
export function RevealPanel({ reveal }: { reveal: ForecastReveal }) {
  const { process, yours, benchmarks, benchmarksAreRealized, lectureModelId } = reveal

  // Where the student's own MSE sits in the table — computed here rather than sent, so
  // the row order and the placement can never disagree.
  const rows = benchmarks.filter(b => b.mse !== null) as { id: string; label: string; mse: number; note?: string }[]
  const beaten = rows.filter(b => yours.mse < b.mse).length

  return (
    <div data-testid="fc-reveal">
      <h2 style={{ fontSize: '1.15rem', marginTop: 0, marginBottom: '0.75rem' }}>
        How demand was actually generated
      </h2>

      <section data-testid="fc-reveal-process" style={{ ...card, background: '#f8fafc' }}>
        <p style={{ margin: '0 0 0.6rem', fontSize: '0.92rem', lineHeight: 1.6 }}>
          Each month&rsquo;s demand was drawn from this process:
        </p>
        <p style={{ margin: '0 0 0.75rem', fontSize: '1rem', ...tnum, fontWeight: 600 }}>
          demand = {formatMetric(process.intercept, 0)}
          {' + '}{formatMetric(process.trend, 2)} × month
          {' + '}{formatMetric(process.highSeasonLift, 0)} in {monthList(process.highSeasonMonths)}
          {' + '}random noise
        </p>
        <ul style={{ margin: 0, paddingLeft: '1.1rem', fontSize: '0.86rem', color: colors.textSecondary, lineHeight: 1.65 }}>
          <li>
            A steady upward <strong>trend</strong> of {formatMetric(process.trend, 2)} units a month —
            about {formatMetric(process.trend * 12, 0)} a year.
          </li>
          <li>
            A <strong>high season</strong> in {monthList(process.highSeasonMonths)}, worth
            {' '}{formatMetric(process.highSeasonLift, 0)} extra units.
          </li>
          <li>
            <strong>Unsystematic variability</strong> with a standard deviation of
            {' '}{formatMetric(process.sigma, 0)} units. This part was <em>not</em> predictable — by
            you or by anyone.
          </li>
        </ul>
      </section>

      <section data-testid="fc-reveal-floor" style={card}>
        <p style={{ margin: 0, fontSize: '0.92rem', lineHeight: 1.6 }}>
          Because that last part is unpredictable, <strong>no forecast could have beaten an MSE
          of about <span style={tnum}>{formatBig(process.floorMse)}</span></strong> — the variance of
          the noise. Your MSE was <strong style={tnum} data-testid="fc-reveal-your-mse">{formatBig(yours.mse)}</strong>
          {' '}(Standard Error <span style={tnum}>{formatMetric(yours.standardError)}</span>, mean signed
          error <span style={tnum}>{formatSigned(yours.meanError, 1)}</span>).
        </p>
      </section>

      <section style={card}>
        <h3 style={{ fontSize: '0.95rem', margin: '0 0 0.5rem' }}>
          How other approaches would have done
        </h3>
        <p style={{ margin: '0 0 0.75rem', fontSize: '0.8rem', color: colors.textSecondary }}>
          {benchmarksAreRealized
            ? 'Each rule, scored against your own months.'
            : 'Expected MSE for each rule, on this demand process.'}
        </p>
        <table data-testid="fc-benchmark-table" style={{ borderCollapse: 'collapse', width: '100%', fontFamily: typography.fontFamily }}>
          <thead>
            <tr>
              <th style={{ textAlign: 'left', fontSize: '0.75rem', color: colors.textSecondary, padding: '0.3rem 0.4rem', borderBottom: `1px solid ${colors.borderMid}` }}>
                Forecasting rule
              </th>
              <th style={{ textAlign: 'right', fontSize: '0.75rem', color: colors.textSecondary, padding: '0.3rem 0.4rem', borderBottom: `1px solid ${colors.borderMid}` }}>
                MSE
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map(b => {
              const isLecture = b.id === lectureModelId
              return (
                <tr key={b.id} data-testid={`fc-benchmark-${b.id}`}>
                  <td style={{
                    padding: '0.35rem 0.4rem', fontSize: '0.85rem',
                    borderBottom: `1px solid ${colors.borderLight ?? '#eee'}`,
                    fontWeight: isLecture ? 700 : 400,
                  }}>
                    {b.label}
                    {isLecture && (
                      <span style={{ color: colors.textSecondary, fontWeight: 400, fontSize: '0.75rem' }}>
                        {' '}— the method from the lecture
                      </span>
                    )}
                    {b.note && (
                      <div style={{ fontSize: '0.74rem', color: colors.textSecondary, fontWeight: 400, lineHeight: 1.45, marginTop: '0.15rem' }}>
                        {b.note}
                      </div>
                    )}
                  </td>
                  <td style={{
                    padding: '0.35rem 0.4rem', textAlign: 'right', ...tnum, fontSize: '0.85rem',
                    borderBottom: `1px solid ${colors.borderLight ?? '#eee'}`,
                    fontWeight: isLecture ? 700 : 400,
                  }}>
                    {formatBig(b.mse)}
                  </td>
                </tr>
              )
            })}
            {/* The student's own row, placed in the same table so the comparison is
                read rather than explained. */}
            <tr data-testid="fc-benchmark-yours" style={{ background: '#eff6ff' }}>
              <td style={{ padding: '0.45rem 0.4rem', fontSize: '0.9rem', fontWeight: 700 }}>Your forecasts</td>
              <td style={{ padding: '0.45rem 0.4rem', textAlign: 'right', ...tnum, fontSize: '0.9rem', fontWeight: 700 }}>
                {formatBig(yours.mse)}
              </td>
            </tr>
          </tbody>
        </table>
        <p style={{ margin: '0.6rem 0 0', fontSize: '0.82rem', color: colors.textSecondary }}>
          You beat {beaten} of the {rows.length} rules above. Your Forecast Accuracy was
          {' '}{formatPercent(yours.accuracy)}.
        </p>
      </section>
    </div>
  )
}

/** The debrief question, then the reveal (spec §9). */
export function DebriefScreen({
  question,
  onDone,
  initialReveal = null,
}: {
  question: ForecastDebriefQuestionClient
  onDone: () => void
  /** Supplied when a returning student has ALREADY answered — the reveal is fetched by
   *  Play.tsx through the gated forecastGetReveal and passed straight in, so a resumed
   *  session lands on the reveal rather than on a question it cannot re-answer. */
  initialReveal?: ForecastReveal | null
}) {
  const [text, setText] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [reveal, setReveal] = useState<ForecastReveal | null>(initialReveal)

  const canSubmit = text.trim() !== '' && !submitting

  const handleSubmit = async () => {
    if (!canSubmit) return
    setSubmitting(true)
    setError(null)
    try {
      const res = await forecastSubmitDebrief(text.trim())
      // ⚠⚠ NULL MEANS THE ANSWER WAS STORED AND THE REVEAL IS STILL OUTSTANDING — another
      // visible after-play row has not been answered yet. The paragraph is one ROW of that
      // stage now, and the server gates the reveal on ALL of it, so advancing here is
      // correct: the runner walks them through the rest and fetches the reveal at the end.
      // (In the shipped configuration the debrief is the only row and `reveal` is non-null,
      // so this screen behaves exactly as it always has.)
      if (res.reveal === null) { onDone(); return }
      setReveal(res.reveal)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong. Please try again.')
      setSubmitting(false)
    }
  }

  if (reveal !== null) {
    return (
      <div>
        <RevealPanel reveal={reveal} />
        <button data-testid="fc-debrief-finish" onClick={onDone} style={primaryButton(true)}>
          Finish
        </button>
      </div>
    )
  }

  return (
    <div>
      <h1 style={{ marginTop: 0, marginBottom: '0.75rem', fontSize: '1.25rem' }}>One last question</h1>
      <p data-testid="fc-debrief-prompt" style={{ marginTop: 0, marginBottom: '1rem', fontSize: '0.95rem', lineHeight: 1.6 }}>
        {question.prompt}
      </p>

      <section style={card}>
        <textarea
          data-testid="fc-debrief-text"
          rows={7}
          value={text}
          disabled={submitting}
          placeholder={question.placeholder}
          onChange={e => setText(e.target.value)}
          style={{
            width: '100%', boxSizing: 'border-box', fontFamily: typography.fontFamily,
            fontSize: '0.95rem', padding: '0.6rem', borderRadius: 4,
            border: `1px solid ${colors.inputBorder}`, lineHeight: 1.5,
          }}
        />
      </section>

      {error && (
        <p data-testid="fc-debrief-error" role="alert" style={{ color: colors.errorAction, fontSize: typography.sizeSm, marginBottom: '0.75rem' }}>
          {error}
        </p>
      )}

      <button
        data-testid="fc-debrief-submit"
        onClick={() => void handleSubmit()}
        disabled={!canSubmit}
        style={primaryButton(canSubmit)}
      >
        {submitting ? 'Submitting…' : 'Submit and see how demand was generated'}
      </button>
    </div>
  )
}
