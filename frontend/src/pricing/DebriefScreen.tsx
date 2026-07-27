import { useState } from 'react'
import { colors, typography } from '@mygames/game-ui'
import {
  pricingSubmitDebrief,
  type PricingDebriefQuestionClient, type PricingHistoryRow, type PricingLabels,
} from './api'
import { HistoryTable } from './HistoryTable'
import { card, sectionTitle } from './MarketPanel'
import { formatProfitM } from './format'

// ═══════════════════════════════════════════════════════════════════════════════
// The debrief (spec §9): ONE open-ended paragraph, ungraded, after the last round —
// and the moment the competitor is finally explained.
//
// ⚠ THE REVEAL IS THE POINT OF THIS SCREEN, and it is why the whole round loop
// withholds it. For the entire game the student has been inferring what their
// competitor was doing; here they are told, in plain language, and asked to explain
// what they did about it. The sentence comes from the SERVER
// (pricingGetQuestions → competitorReveal), which returns it only once the game is
// over — the client never holds the rule id and could not construct this itself.
//
// The reveal is placed ABOVE the question deliberately: a student who reads "your
// competitor was best-replying to your last price" will write a better answer to
// "how did you respond to what your competitor did" than one who is still guessing.
//
// The student's own history stays on screen while they write — they are being asked
// to explain what they did, and making them recall it from memory would produce worse
// answers than letting them read it. (Elena summarizes these for the next lecture, so
// the quality of the paragraph is the whole deliverable.)
//
// Ungraded, and SAID to be ungraded: students who think a reflection is graded write
// what they think is wanted rather than what they did.
// ═══════════════════════════════════════════════════════════════════════════════

export function DebriefScreen({
  question,
  competitorReveal,
  history,
  labels,
  pmg,
  totalProfit,
  averageProfit,
  onDone,
}: {
  question: PricingDebriefQuestionClient
  /** The server's reveal sentence, or null if it declined to send one. */
  competitorReveal: string | null
  history: PricingHistoryRow[]
  labels: PricingLabels
  pmg: boolean
  totalProfit: number
  averageProfit: number
  onDone: () => void
}) {
  const [value, setValue] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const canSubmit = value.trim() !== '' && !submitting

  const handleSubmit = async () => {
    if (!canSubmit) return
    setSubmitting(true)
    setError(null)
    try {
      await pricingSubmitDebrief(value)
      onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong. Please try again.')
      setSubmitting(false)
    }
  }

  return (
    <div>
      <h1 data-testid="pricing-debrief-heading" style={{ marginTop: 0, marginBottom: '0.5rem', fontSize: '1.5rem', color: colors.text }}>
        That was your last round
      </h1>
      <p style={{ margin: '0 0 1.25rem', lineHeight: 1.6, color: colors.text }}>
        Your game lasted <strong data-testid="pricing-debrief-rounds">{history.length}</strong>{' '}
        round{history.length === 1 ? '' : 's'}. You made{' '}
        <strong data-testid="pricing-debrief-total">{formatProfitM(totalProfit)}</strong> in total,{' '}
        <strong data-testid="pricing-debrief-average">{formatProfitM(averageProfit)}</strong> per round.
      </p>

      {/* ── The reveal ─────────────────────────────────────────────────────── */}
      {competitorReveal && (
        <section
          data-testid="pricing-competitor-reveal"
          style={{ ...card, background: colors.infoBannerBg, borderColor: colors.infoBannerBorder }}
        >
          <h2 style={sectionTitle}>What your competitor was doing</h2>
          <p style={{ margin: 0, lineHeight: 1.6, color: colors.text }}>{competitorReveal}</p>
        </section>
      )}

      <section style={card}>
        <h2 data-testid="pricing-debrief-prompt" style={{ marginTop: 0, marginBottom: '0.4rem', fontSize: '1.15rem', color: colors.text, lineHeight: 1.4 }}>
          {question.prompt}
        </h2>
        <p style={{ margin: '0 0 0.9rem', fontSize: typography.sizeSm, color: colors.textSecondary }}>
          This one is not graded — there is no right answer. Say what you actually did.
        </p>
        <textarea
          data-testid="pricing-debrief-input"
          value={value}
          disabled={submitting}
          onChange={e => setValue(e.target.value)}
          rows={7}
          placeholder={question.placeholder}
          style={{
            width: '100%', fontSize: '1rem', padding: '0.6rem 0.7rem', borderRadius: 4,
            border: `1px solid ${colors.inputBorder}`, boxSizing: 'border-box',
            resize: 'vertical', fontFamily: 'inherit',
          }}
        />
      </section>

      {error && (
        <p data-testid="pricing-debrief-error" role="alert" style={{ color: colors.errorAction, fontSize: typography.sizeSm, marginBottom: '0.75rem' }}>
          {error}
        </p>
      )}

      <button
        data-testid="pricing-debrief-submit"
        onClick={() => void handleSubmit()}
        disabled={!canSubmit}
        style={{
          padding: '0.7rem 1.75rem', fontSize: '1rem', fontWeight: 600,
          cursor: canSubmit ? 'pointer' : 'not-allowed',
          backgroundColor: canSubmit ? colors.text : colors.disabledBtnBg,
          color: colors.white, border: 'none', borderRadius: 6, marginBottom: '1.5rem',
        }}
      >
        {submitting ? 'Submitting…' : 'Submit'}
      </button>

      <section style={card}>
        <h2 style={sectionTitle}>Your game</h2>
        <HistoryTable history={history} labels={labels} pmg={pmg} />
      </section>
    </div>
  )
}
