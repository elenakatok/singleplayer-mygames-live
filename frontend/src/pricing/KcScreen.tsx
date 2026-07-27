import { useState } from 'react'
import { colors, typography } from '@mygames/game-ui'
import {
  pricingSubmitKcAnswer,
  type PricingKcQuestionClient, type PricingLabels, type PricingMarket,
} from './api'
import { MarketFacts, Formulas, card } from './MarketPanel'

// ═══════════════════════════════════════════════════════════════════════════════
// One knowledge-check question (spec §8). Graded, and NOT A GATE.
//
// THE MARKET IS ON THE SCREEN, ON PURPOSE. The questions are about reading the
// market — base share, the share formula, contribution — so the market facts and the
// formulas sit right below the question, rendered from the same config the question's
// numbers were derived from. This is an open-book check of comprehension, not a
// memory test.
//
// WRONG ANSWERS DO NOT BLOCK. The answer is recorded and scored, the student is told
// whether it was right and why, and then they continue — to the next question, and
// eventually into the game, regardless. There is no retry (the server locks the
// question on first answer), and there is no pass mark to clear.
// ═══════════════════════════════════════════════════════════════════════════════

export function KcScreen({
  question,
  index,
  total,
  market,
  labels,
  pmg,
  onDone,
}: {
  question: PricingKcQuestionClient
  index: number
  total: number
  market: PricingMarket
  labels: PricingLabels
  pmg: boolean
  onDone: () => void
}) {
  const [value, setValue] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [verdict, setVerdict] = useState<{ correct: boolean; graded: boolean; explanation: string } | null>(null)

  // Instructor-added questions may be free text; the derived ones are always mc.
  const isText = question.type === 'text'
  const canSubmit = !submitting && (isText ? (value ?? '').trim() !== '' : value !== null)

  const handleSubmit = async () => {
    if (!canSubmit || value === null) return
    setSubmitting(true)
    setError(null)
    try {
      const res = await pricingSubmitKcAnswer(question.field, value)
      setVerdict({ correct: res.correct, graded: res.graded, explanation: res.explanation })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  const answered = verdict !== null

  return (
    <div>
      <p style={{ color: colors.textSecondary, marginBottom: '0.3rem', fontSize: typography.sizeSm }}>
        {/* Safe to show N of M here: this is the KNOWLEDGE CHECK's own length, a
            client-side fact with nothing to do with the game's hidden round count. */}
        Knowledge check — question {index + 1} of {total}
      </p>
      <h1 data-testid="pricing-kc-prompt" style={{ marginTop: 0, marginBottom: '1.25rem', fontSize: '1.35rem', color: colors.text, lineHeight: 1.35 }}>
        {question.prompt}
      </h1>

      <section style={card}>
        {isText ? (
          <textarea
            data-testid="pricing-kc-text-input"
            value={value ?? ''}
            disabled={submitting || answered}
            onChange={e => setValue(e.target.value)}
            rows={4}
            placeholder="Type your answer…"
            style={{
              width: '100%', fontSize: '1rem', padding: '0.6rem 0.7rem', borderRadius: 4,
              border: `1px solid ${colors.inputBorder}`, boxSizing: 'border-box',
              resize: 'vertical', fontFamily: 'inherit',
            }}
          />
        ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
          {question.options.map(opt => {
            const selected = value === opt.value
            return (
              <label
                key={opt.value}
                data-testid={`pricing-kc-option-${opt.value}`}
                style={{
                  display: 'flex', alignItems: 'center', gap: '0.7rem', padding: '0.7rem 0.9rem',
                  border: `1px solid ${selected ? colors.optionBorderSelected : colors.borderLight}`,
                  borderRadius: 4, cursor: (submitting || answered) ? 'default' : 'pointer',
                  fontWeight: selected ? 600 : 400,
                  background: selected ? colors.surfaceSubtle : colors.white,
                }}
              >
                <input
                  type="radio" name={`pricing-kc-${question.field}`} value={opt.value} checked={selected}
                  disabled={submitting || answered}
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

      {error && (
        <p data-testid="pricing-kc-error" role="alert" style={{ color: colors.errorAction, fontSize: typography.sizeSm, marginBottom: '0.75rem' }}>
          {error}
        </p>
      )}

      {answered && (
        <section
          data-testid={!verdict.graded ? 'pricing-kc-recorded' : verdict.correct ? 'pricing-kc-correct' : 'pricing-kc-incorrect'}
          style={{
            ...card,
            background: !verdict.graded ? colors.surfaceSubtle : verdict.correct ? colors.kcCorrectBg : colors.kcIncorrectBg,
            borderColor: !verdict.graded ? colors.border : verdict.correct ? colors.kcCorrectBorder : colors.kcIncorrectBorder,
          }}
        >
          {/* An ungraded (free-text) added question is RECORDED, never marked wrong. */}
          <p style={{ margin: verdict.explanation ? '0 0 0.4rem' : 0, fontWeight: 700, color: !verdict.graded ? colors.text : verdict.correct ? colors.kcCorrectText : colors.kcIncorrectText }}>
            {!verdict.graded ? 'Recorded' : verdict.correct ? 'Correct' : 'Not quite'}
          </p>
          {verdict.explanation && (
            <p style={{ margin: 0, lineHeight: 1.6, color: colors.text }}>{verdict.explanation}</p>
          )}
        </section>
      )}

      <button
        data-testid={answered ? 'pricing-kc-continue' : 'pricing-kc-submit'}
        onClick={() => (answered ? onDone() : void handleSubmit())}
        disabled={!answered && !canSubmit}
        style={{
          padding: '0.7rem 1.75rem', fontSize: '1rem', fontWeight: 600,
          cursor: (answered || canSubmit) ? 'pointer' : 'not-allowed',
          backgroundColor: (answered || canSubmit) ? colors.text : colors.disabledBtnBg,
          color: colors.white, border: 'none', borderRadius: 6, marginBottom: '1.5rem',
        }}
      >
        {submitting ? 'Checking…' : answered ? 'Continue' : 'Submit answer'}
      </button>

      {/* The open book. Below the question so the question is what a student reads
          first, but on the same screen so nothing has to be remembered. */}
      <MarketFacts market={market} labels={labels} />
      <Formulas market={market} labels={labels} pmg={pmg} />
    </div>
  )
}
