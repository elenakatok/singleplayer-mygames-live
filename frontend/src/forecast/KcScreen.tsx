import { useState } from 'react'
import { colors, typography } from '@mygames/game-ui'
import { forecastSubmitKcAnswer, type ForecastKcQuestionClient } from './api'

// ═══════════════════════════════════════════════════════════════════════════════
// One knowledge-check question (spec §8). Graded — it is this game's ASSESSED
// component — and NOT A GATE.
//
// ⚠ THE DEMAND HISTORY IS DELIBERATELY *NOT* ON THIS SCREEN, and neither is anything
// else from the game. The KC runs BEFORE play (spec §4) and checks the LECTURE: Q4 and
// Q5 are read straight off slide 14, and the questions carry their own numbers. Showing
// the game's own data beside them would invite a student to answer from the chart
// instead of from the method — and the method is what the next twenty-four months
// require.
//
// WRONG ANSWERS DO NOT BLOCK. The answer is recorded and scored, the student is told
// whether it was right and why, and then they continue. There is no retry (the server
// locks the question on first answer) and no pass mark to clear.
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

export function KcScreen({
  question,
  index,
  total,
  onDone,
  /** ⚠ The stage's own heading and final-button label. Defaulted to the BEFORE-PLAY
   *  wording this screen has always shown, so the pre stage is byte-identical; the
   *  after-play stage passes its own, because "Start the game" is false there. */
  heading,
  lastLabel = 'Start the game',
}: {
  question: ForecastKcQuestionClient
  index: number
  total: number
  onDone: () => void
  heading?: string
  lastLabel?: string
}) {
  const [value, setValue] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [verdict, setVerdict] = useState<{ correct: boolean; graded: boolean; explanation: string } | null>(null)

  // Instructor-added questions may be free text; the authored nine are always mc.
  const isText = question.type === 'text'
  const canSubmit = !submitting && (isText ? (value ?? '').trim() !== '' : value !== null)
  const answered = verdict !== null

  const handleSubmit = async () => {
    if (!canSubmit || value === null) return
    setSubmitting(true)
    setError(null)
    try {
      const res = await forecastSubmitKcAnswer(question.field, value)
      setVerdict({ correct: res.correct, graded: res.graded, explanation: res.explanation })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div>
      <p style={{ color: colors.textSecondary, marginBottom: '0.3rem', fontSize: typography.sizeSm }}>
        {heading ?? 'Knowledge check'} — question {index + 1} of {total}
      </p>
      <h1 data-testid="fc-kc-prompt" style={{ marginTop: 0, marginBottom: '1.25rem', fontSize: '1.15rem', lineHeight: 1.45 }}>
        {question.prompt}
      </h1>

      <section style={card}>
        {isText ? (
          <textarea
            data-testid="fc-kc-text"
            rows={4}
            value={value ?? ''}
            disabled={answered || submitting}
            onChange={e => setValue(e.target.value)}
            style={{
              width: '100%', boxSizing: 'border-box', fontFamily: typography.fontFamily,
              fontSize: '0.95rem', padding: '0.6rem', borderRadius: 4,
              border: `1px solid ${colors.inputBorder}`,
            }}
          />
        ) : (
          question.options.map(opt => (
            <label
              key={opt.value}
              data-testid={`fc-kc-option-${opt.value}`}
              style={{
                display: 'flex', gap: '0.6rem', alignItems: 'flex-start',
                padding: '0.5rem 0.4rem', cursor: answered ? 'default' : 'pointer',
                borderRadius: 4, lineHeight: 1.45,
                opacity: answered && value !== opt.value ? 0.55 : 1,
              }}
            >
              <input
                type="radio"
                name={question.field}
                value={opt.value}
                checked={value === opt.value}
                disabled={answered || submitting}
                onChange={() => setValue(opt.value)}
                style={{ marginTop: '0.2rem' }}
              />
              <span style={{ fontSize: '0.92rem' }}>{opt.label}</span>
            </label>
          ))
        )}
      </section>

      {error && (
        <p role="alert" style={{ color: colors.errorAction, fontSize: typography.sizeSm, marginBottom: '0.75rem' }}>
          {error}
        </p>
      )}

      {/* The verdict and the explanation — EARNED by answering. Neither is in the
          bundle before this point: the server returns them from the submit callable. */}
      {answered && (
        <section
          data-testid="fc-kc-verdict"
          style={{
            ...card,
            background: verdict.graded ? (verdict.correct ? '#f0fdf4' : '#fef2f2') : '#f8fafc',
            borderColor: verdict.graded ? (verdict.correct ? '#bbf7d0' : '#fecaca') : colors.borderMid,
          }}
        >
          <p style={{ margin: '0 0 0.4rem', fontWeight: 600 }}>
            {verdict.graded ? (verdict.correct ? 'Correct.' : 'Not quite.') : 'Recorded.'}
          </p>
          {verdict.explanation && (
            <p style={{ margin: 0, fontSize: '0.88rem', lineHeight: 1.55, color: colors.textSecondary }}>
              {verdict.explanation}
            </p>
          )}
        </section>
      )}

      {answered ? (
        <button data-testid="fc-kc-continue" onClick={onDone} style={primaryButton(true)}>
          {index + 1 === total ? lastLabel : 'Next question'}
        </button>
      ) : (
        <button
          data-testid="fc-kc-submit"
          onClick={() => void handleSubmit()}
          disabled={!canSubmit}
          style={primaryButton(canSubmit)}
        >
          {submitting ? 'Submitting…' : 'Submit answer'}
        </button>
      )}
    </div>
  )
}
