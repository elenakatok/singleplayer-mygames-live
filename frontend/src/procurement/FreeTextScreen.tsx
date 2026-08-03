import { useState } from 'react'
import type { ReactNode } from 'react'
import { colors, typography } from '@mygames/game-ui'
import { procurementSubmitFreeText, type ProcurementKcQuestionClient } from './api'

// ═══════════════════════════════════════════════════════════════════════════════
// The PREP paragraph (S8, before round 1) and the DEBRIEF paragraph (S9, after the final
// results) — ONE component, because they are the same thing at two moments.
//
// ⚠⚠ THEY ARE POOL ENTRIES WITH A `stage` TAG, not a separate config key. One callable
// serves both (`procurementSubmitFreeText`, routed server-side by the tag), there is no
// `debriefPrompt` anywhere, and an instructor switches either off exactly as they switch
// off a graded question. A second component here would be the first step back toward two
// sources of wording.
//
// ⚠ UNGRADED, AND SAID SO ON THE SCREEN. Both are Tier-2 reported — Elena reads them —
// so a student who thinks they are being marked writes for the mark instead of writing
// what they think. The prep answer in particular is the BEFORE half of a before/after
// pair; it is worthless if it is written to look good.
//
// ⚠ NO SKIP CONTROL. An empty answer is not submittable, because an empty prep answer
// silently destroys the pair. The student may write one line.
// ═══════════════════════════════════════════════════════════════════════════════

const card = {
  border: `1px solid ${colors.borderMid}`, borderRadius: 8,
  padding: '1rem 1.15rem', marginBottom: '1rem', background: colors.white,
}

export function FreeTextScreen({
  question,
  eyebrow,
  intro,
  onDone,
}: {
  question: ProcurementKcQuestionClient
  /** "Before you start" / "One last question" — which moment this is. */
  eyebrow: string
  intro?: ReactNode
  onDone: () => void
}) {
  const [value, setValue] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const canSubmit = !submitting && value.trim() !== ''

  const handleSubmit = async () => {
    if (!canSubmit) return
    setSubmitting(true)
    setError(null)
    try {
      await procurementSubmitFreeText(question.field, value.trim())
      onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong. Please try again.')
      setSubmitting(false)
    }
  }

  return (
    <div>
      <p style={{ color: colors.textSecondary, marginBottom: '0.3rem', fontSize: typography.sizeSm }}>
        {eyebrow}
      </p>
      <h1
        data-testid="proc-freetext-prompt"
        style={{ marginTop: 0, marginBottom: '1rem', fontSize: '1.35rem', color: colors.text, lineHeight: 1.35 }}
      >
        {question.prompt}
      </h1>

      {intro}

      <section style={card}>
        <textarea
          data-testid="proc-freetext-input"
          value={value}
          disabled={submitting}
          onChange={e => setValue(e.target.value)}
          rows={6}
          placeholder={question.placeholder ?? 'A few sentences is plenty.'}
          style={{
            width: '100%', fontSize: '1rem', padding: '0.6rem 0.7rem', borderRadius: 4,
            border: `1px solid ${colors.inputBorder}`, boxSizing: 'border-box',
            resize: 'vertical', fontFamily: 'inherit',
          }}
        />
        <p style={{ margin: '0.5rem 0 0', fontSize: typography.sizeXs, color: colors.textSecondary }}>
          This is not graded. Your instructor reads these — say what you actually think.
        </p>
      </section>

      {error && (
        <p data-testid="proc-freetext-error" role="alert" style={{ color: colors.errorAction, fontSize: typography.sizeSm, marginBottom: '0.75rem' }}>
          {error}
        </p>
      )}

      <button
        data-testid="proc-freetext-submit"
        onClick={() => void handleSubmit()}
        disabled={!canSubmit}
        style={{
          padding: '0.7rem 1.75rem', fontSize: '1rem', fontWeight: 600,
          cursor: canSubmit ? 'pointer' : 'not-allowed',
          backgroundColor: canSubmit ? colors.text : colors.disabledBtnBg,
          color: colors.white, border: 'none', borderRadius: 6,
        }}
      >
        {submitting ? 'Saving…' : 'Continue'}
      </button>
    </div>
  )
}
