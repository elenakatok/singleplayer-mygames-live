import { useState } from 'react'
import type { CSSProperties } from 'react'
import { colors, typography } from '@mygames/game-ui'
import { pdSubmitDebrief, type PdDebriefQuestionClient, type PdHistoryRow, type PdMoveLabels } from './api'
import { HistoryTable } from './HistoryTable'

// ═══════════════════════════════════════════════════════════════════════════════
// The debrief (spec §8): ONE open-ended paragraph, ungraded, after the last round.
//
// The student's own history stays on screen while they write — they are being asked
// to explain what they did, and making them recall it from memory would produce worse
// answers than letting them read it. (Elena summarizes these for the next lecture,
// so the quality of the paragraph is the whole deliverable.)
//
// Ungraded, and SAID to be ungraded: students who think a reflection is graded write
// what they think is wanted rather than what they did.
// ═══════════════════════════════════════════════════════════════════════════════

const card: CSSProperties = {
  border: `1px solid ${colors.border}`, borderRadius: 8, padding: '1rem 1.25rem', marginBottom: '1.25rem',
}

export function DebriefScreen({
  question,
  history,
  labels,
  unit = 'years',
  onDone,
}: {
  question: PdDebriefQuestionClient
  history: PdHistoryRow[]
  labels: PdMoveLabels
  unit?: string
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
      await pdSubmitDebrief(value)
      onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong. Please try again.')
      setSubmitting(false)
    }
  }

  return (
    <div>
      <h1 style={{ marginTop: 0, marginBottom: '0.5rem', fontSize: '1.5rem', color: colors.text }}>
        The game is over
      </h1>
      <p style={{ margin: '0 0 1.25rem', lineHeight: 1.6, color: colors.text }}>
        That was the last round. One last question before you go.
      </p>

      <section style={card}>
        <h2 data-testid="pd-debrief-prompt" style={{ marginTop: 0, marginBottom: '0.4rem', fontSize: '1.15rem', color: colors.text, lineHeight: 1.4 }}>
          {question.prompt}
        </h2>
        <p style={{ margin: '0 0 0.9rem', fontSize: typography.sizeSm, color: colors.textSecondary }}>
          This one is not graded — there is no right answer. Say what you actually did.
        </p>
        <textarea
          data-testid="pd-debrief-input"
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
        <p data-testid="pd-debrief-error" role="alert" style={{ color: colors.errorAction, fontSize: typography.sizeSm, marginBottom: '0.75rem' }}>
          {error}
        </p>
      )}

      <button
        data-testid="pd-debrief-submit"
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
        <h2 style={{ margin: '0 0 0.6rem', fontSize: typography.sizeSm, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.03em', color: colors.sectionMuted }}>
          Your history
        </h2>
        <HistoryTable history={history} labels={labels} unit={unit} />
      </section>
    </div>
  )
}
