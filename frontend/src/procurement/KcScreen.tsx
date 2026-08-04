import { useState } from 'react'
import { colors, typography } from '@mygames/game-ui'
import { procurementSubmitKcAnswer, type ProcurementKcQuestionClient } from './api'

// ═══════════════════════════════════════════════════════════════════════════════
// One knowledge-check question (§10). Graded, and NOT A GATE.
//
// ⚠ THIS FAMILY HAS NO GATE QUESTION, deliberately (§10 v2, resolved not flagged). A
// wrong answer is recorded, explained, and the student continues — into the next
// question and eventually into the game, regardless. There is no pass mark and no retry:
// the server locks each question on first answer.
//
// ⚠ THE PROGRESS LINE COUNTS THE QUESTIONS THIS STUDENT IS ASKED, and that number comes
// from the server's resolved set — never a constant, and never 17. An instructor who
// hides a question changes this count, because it is the same derivation the DENOMINATOR
// uses (`gradedFor`). There is no `/17` anywhere in this game and none may be added.
//
// ⚠⚠ THERE IS NO REFERENCE PANEL HERE, AND ADDING ONE BACK WOULD BREAK THE CHECK.
// CP3b briefly rendered `AuctionFacts` below the question as an "open book". It gave away
// the answers: the box states "the lowest bid wins the contract and is paid its own bid"
// (S1 and S2 verbatim), "if you win, you earn your bid minus your cost" (S5), "if you
// lose, you earn nothing — you also pay nothing" (S3), and the reserve (S4). That is
// essentially the whole graded set, three lines under the question asking for it.
//
// The KC needs no panel. It runs BEFORE play, and every v3 question is a SELF-CONTAINED
// hypothetical carrying its own numbers — "suppose your cost is 35", "suppose five
// suppliers bid 41, 47, 52, 66 and 71", "suppose a buyer sets a reserve of 110". None of
// them refers to this instance's configuration, so there is nothing for a panel to
// supply. The panel belongs on the BIDDING screen, where the numbers are live and the
// student is making a decision with them.
// ═══════════════════════════════════════════════════════════════════════════════

const card = {
  border: `1px solid ${colors.borderMid}`, borderRadius: 8,
  padding: '1rem 1.15rem', marginBottom: '1rem', background: colors.white,
}

export function KcScreen({
  question,
  index,
  total,
  onDone,
}: {
  question: ProcurementKcQuestionClient
  index: number
  /** How many questions THIS student is asked — server-resolved, never a constant. */
  total: number
  onDone: () => void
}) {
  const [value, setValue] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [verdict, setVerdict] = useState<{ correct: boolean; graded: boolean; explanation: string } | null>(null)

  const isText = question.kind === 'text'
  const canSubmit = !submitting && (isText ? (value ?? '').trim() !== '' : value !== null)

  const handleSubmit = async () => {
    if (!canSubmit || value === null) return
    setSubmitting(true)
    setError(null)
    try {
      const res = await procurementSubmitKcAnswer(question.field, value)
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
        Knowledge check — question {index + 1} of {total}
      </p>
      <h1
        data-testid="proc-kc-prompt"
        style={{ marginTop: 0, marginBottom: '1.25rem', fontSize: '1.35rem', color: colors.text, lineHeight: 1.35 }}
      >
        {question.prompt}
      </h1>

      <section style={card}>
        {isText ? (
          <textarea
            data-testid="proc-kc-text-input"
            value={value ?? ''}
            disabled={submitting || answered}
            onChange={e => setValue(e.target.value)}
            rows={4}
            placeholder={question.placeholder ?? 'Type your answer…'}
            style={{
              width: '100%', fontSize: '1rem', padding: '0.6rem 0.7rem', borderRadius: 4,
              border: `1px solid ${colors.inputBorder}`, boxSizing: 'border-box',
              resize: 'vertical', fontFamily: 'inherit',
            }}
          />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
            {/* ⚠ Rendered in the order the SERVER sent, which is shuffled per student.
                Never re-sorted here — and the stored answer is the option's stable
                `value`, never its position, so display order cannot affect a score. */}
            {question.options.map(opt => {
              const selected = value === opt.value
              return (
                <label
                  key={opt.value}
                  data-testid={`proc-kc-option-${opt.value}`}
                  style={{
                    display: 'flex', alignItems: 'center', gap: '0.7rem', padding: '0.7rem 0.9rem',
                    border: `1px solid ${selected ? colors.optionBorderSelected : colors.borderLight}`,
                    borderRadius: 4, cursor: (submitting || answered) ? 'default' : 'pointer',
                    fontWeight: selected ? 600 : 400,
                    background: selected ? colors.surfaceSubtle : colors.white,
                  }}
                >
                  <input
                    type="radio" name={`proc-kc-${question.field}`} value={opt.value} checked={selected}
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
        <p data-testid="proc-kc-error" role="alert" style={{ color: colors.errorAction, fontSize: typography.sizeSm, marginBottom: '0.75rem' }}>
          {error}
        </p>
      )}

      {answered && (
        <section
          data-testid={!verdict.graded ? 'proc-kc-recorded' : verdict.correct ? 'proc-kc-correct' : 'proc-kc-incorrect'}
          style={{
            ...card,
            background: !verdict.graded ? colors.surfaceSubtle : verdict.correct ? colors.kcCorrectBg : colors.kcIncorrectBg,
            borderColor: !verdict.graded ? colors.border : verdict.correct ? colors.kcCorrectBorder : colors.kcIncorrectBorder,
          }}
        >
          <p style={{
            margin: verdict.explanation ? '0 0 0.4rem' : 0, fontWeight: 700,
            color: !verdict.graded ? colors.text : verdict.correct ? colors.kcCorrectText : colors.kcIncorrectText,
          }}>
            {!verdict.graded ? 'Recorded' : verdict.correct ? 'Correct' : 'Not quite'}
          </p>
          {verdict.explanation && (
            <p style={{ margin: 0, lineHeight: 1.6, color: colors.text }}>{verdict.explanation}</p>
          )}
        </section>
      )}

      <button
        data-testid={answered ? 'proc-kc-continue' : 'proc-kc-submit'}
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
    </div>
  )
}
