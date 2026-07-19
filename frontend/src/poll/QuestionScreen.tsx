import { useState } from 'react'
import type { CSSProperties } from 'react'
import { colors, spacing } from '@mygames/game-ui'
import { pollSubmitAnswer, type PollQuestionClient } from './api'

// ═══════════════════════════════════════════════════════════════════════════════
// One poll question (spec §5). UNGRADED: no correctness, no explanation, NO feedback —
// after submitting, the student advances straight to the next question (onDone). Text →
// a free-text box; mc → radios in the option's DEFINED ORDER. The per-question one-shot
// lock is server-enforced (pollSubmitAnswer); the disabled button here is convenience.
// ═══════════════════════════════════════════════════════════════════════════════

const card: CSSProperties = { border: '1px solid #d0d7de', borderRadius: 8, padding: '1rem 1.25rem', marginBottom: '1rem' }

export function QuestionScreen({
  question,
  index,
  total,
  onDone,
}: {
  question: PollQuestionClient
  index: number
  total: number
  onDone: () => void
}) {
  const [value, setValue] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const isLast = index === total - 1
  const canSubmit = value.trim() !== '' && !submitting

  const handleSubmit = async () => {
    if (!canSubmit) return
    setSubmitting(true)
    setError(null)
    try {
      await pollSubmitAnswer(question.id, value)
      onDone() // advance immediately — no feedback, no echo
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong. Please try again.')
      setSubmitting(false)
    }
  }

  return (
    <div>
      <p style={{ color: colors.textSecondary, marginBottom: spacing.gapTiny }}>
        Question {index + 1} of {total}
      </p>
      <h1 style={{ marginTop: 0, marginBottom: '1.25rem', fontSize: '1.4rem', color: colors.text, lineHeight: 1.35 }}>
        {question.prompt}
      </h1>

      <section style={card}>
        {question.type === 'text' ? (
          <textarea
            data-testid="poll-text-input"
            value={value}
            disabled={submitting}
            onChange={e => setValue(e.target.value)}
            rows={5}
            placeholder="Type your answer…"
            style={{ width: '100%', fontSize: '1rem', padding: '0.6rem 0.7rem', borderRadius: 4, border: `1px solid ${colors.inputBorder ?? '#cbd5e1'}`, boxSizing: 'border-box', resize: 'vertical', fontFamily: 'inherit' }}
          />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
            {(question.options ?? []).map(opt => {
              const selected = value === opt.value
              return (
                <label
                  key={opt.value}
                  style={{
                    display: 'flex', alignItems: 'center', gap: '0.7rem', padding: '0.7rem 0.9rem',
                    border: `1px solid ${selected ? colors.optionBorderSelected : colors.borderLight}`,
                    borderRadius: 4, cursor: submitting ? 'default' : 'pointer', fontWeight: selected ? 600 : 400,
                  }}
                >
                  <input
                    type="radio" name={`poll-${question.id}`} value={opt.value} checked={selected}
                    disabled={submitting}
                    onChange={() => setValue(opt.value)}
                    style={{ accentColor: colors.text, width: '1rem', height: '1rem', flexShrink: 0 }}
                  />
                  {opt.label}
                </label>
              )
            })}
          </div>
        )}
      </section>

      {error && <p data-testid="poll-error" role="alert" style={{ color: '#c5221f', fontSize: '0.9rem', marginBottom: '0.75rem' }}>{error}</p>}

      <button
        data-testid="poll-next"
        onClick={() => void handleSubmit()}
        disabled={!canSubmit}
        style={{
          padding: '0.7rem 1.75rem', fontSize: '1rem', fontWeight: 600,
          cursor: canSubmit ? 'pointer' : 'not-allowed',
          backgroundColor: canSubmit ? colors.text : (colors.textMuted ?? '#999'),
          color: colors.white, border: 'none', borderRadius: 6,
        }}
      >
        {submitting ? 'Saving…' : isLast ? 'Submit' : 'Next'}
      </button>
    </div>
  )
}
