import { useState } from 'react'
import { colors, typography } from '@mygames/game-ui'
import { newsvendorSubmitFreeText, type NewsvendorFreeTextQuestionClient } from './api'
import { card } from './ParamsPanel'

// ═══════════════════════════════════════════════════════════════════════════════
// One free-text paragraph (spec §8). Used TWICE, at opposite ends of the flow:
//
//   • the PREP, before the first period — "how will you decide how much to order?"
//   • the DEBRIEF, after the last — "how did you choose, and did it change?"
//
// One component, because they differ only in prompt and placement. Each is UNGRADED
// and each feeds its OWN Tier-2 report (spec §8, last line) — Elena reads the two
// side by side, which is the whole reason there are two.
//
// No feedback is shown after submitting: there is nothing to be right about, and a
// "Correct"-shaped response would misrepresent an ungraded reflection.
// ═══════════════════════════════════════════════════════════════════════════════

export function FreeTextScreen({
  question,
  title,
  submitLabel,
  onDone,
}: {
  question: NewsvendorFreeTextQuestionClient
  /** The small label above the prompt — "Before you start" / "One last question". */
  title: string
  submitLabel: string
  onDone: () => void
}) {
  const [text, setText] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const canSubmit = text.trim() !== '' && !submitting

  const handleSubmit = async () => {
    if (!canSubmit) return
    setSubmitting(true)
    setError(null)
    try {
      await newsvendorSubmitFreeText(question.field, text)
      onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong. Please try again.')
      setSubmitting(false)
    }
  }

  return (
    <div>
      <p style={{ color: colors.textSecondary, marginBottom: '0.3rem', fontSize: typography.sizeSm }}>
        {title}
      </p>
      <h1
        data-testid={`nv-freetext-prompt-${question.field}`}
        style={{ marginTop: 0, marginBottom: '1.25rem', fontSize: '1.2rem', color: colors.text, lineHeight: 1.5 }}
      >
        {question.prompt}
      </h1>

      <section style={card}>
        <textarea
          data-testid="nv-freetext-input"
          value={text}
          disabled={submitting}
          onChange={e => setText(e.target.value)}
          rows={6}
          placeholder={question.placeholder}
          autoFocus
          style={{
            width: '100%', fontSize: '1rem', padding: '0.7rem', borderRadius: 4,
            border: `1px solid ${colors.inputBorder}`, boxSizing: 'border-box',
            resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.6,
          }}
        />
      </section>

      {error && (
        <p data-testid="nv-freetext-error" role="alert" style={{ color: colors.errorAction, fontSize: typography.sizeSm, marginBottom: '0.75rem' }}>
          {error}
        </p>
      )}

      <button
        data-testid="nv-freetext-submit"
        onClick={() => void handleSubmit()}
        disabled={!canSubmit}
        style={{
          padding: '0.7rem 1.75rem', fontSize: '1rem', fontWeight: 600,
          cursor: canSubmit ? 'pointer' : 'not-allowed',
          backgroundColor: canSubmit ? colors.text : colors.disabledBtnBg,
          color: colors.white, border: 'none', borderRadius: 6, marginBottom: '1.5rem',
        }}
      >
        {submitting ? 'Saving…' : submitLabel}
      </button>
    </div>
  )
}
