import { useState } from 'react'
import { typography } from '@mygames/game-ui'
import { scorecardSubmitKcAnswer, type ScorecardKcQuestion } from './api'

// ═══════════════════════════════════════════════════════════════════════════════
// One knowledge-check question (spec §9). Graded, and NOT a gate — a wrong answer is
// recorded, scored, and the student continues regardless.
//
// ⚠ THE EXPLANATION IS EARNED. It arrives in the submit response and nowhere else; it is
// not part of the question payload (functions scorecard/questions.ts).
// ═══════════════════════════════════════════════════════════════════════════════

const card: React.CSSProperties = {
  border: '1px solid #dcdcdc', borderRadius: 8, padding: '1rem 1.25rem',
  background: '#fafafa', marginBottom: '1rem',
}

export function KcScreen({
  question, index, total, label, onDone,
}: {
  question: ScorecardKcQuestion
  index: number
  total: number
  /** ⚠ Names WHICH stage this is — "Before you start" / "Now that you have played".
   *  The split is the design (spec §9) and the student should see that it is one. */
  label: string
  onDone: () => void
}) {
  const [choice, setChoice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [verdict, setVerdict] = useState<{ correct: boolean; explanation: string } | null>(null)
  const [error, setError] = useState<string | null>(null)

  /** An added free-text question — the only kind that arrives with no options. */
  const isFreeText = question.options.length === 0
  const ready = isFreeText ? (choice ?? '').trim().length > 0 : choice !== null

  async function submit() {
    if (!ready || choice === null) return
    setBusy(true)
    setError(null)
    try {
      const r = await scorecardSubmitKcAnswer(question.id, choice)
      setVerdict({ correct: r.correct, explanation: r.explanation })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not record your answer.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <p style={{ color: '#666', fontSize: '0.85rem', margin: '0 0 0.5rem' }}>
        {label} — question {index + 1} of {total}
      </p>
      <div style={card}>
        <p style={{ margin: 0, fontSize: '1.02rem' }} data-testid="sc-kc-prompt">{question.prompt}</p>
      </div>

      {/* ⚠ NO OPTIONS ⇒ AN INSTRUCTOR'S FREE-TEXT QUESTION. Only added questions can be
          free text; all ten built-ins are multiple choice. Without this branch such a
          question would render as an empty card with a dead Submit button — answerable by
          nobody, and indistinguishable on screen from a loading failure. */}
      <div style={card}>
        {isFreeText ? (
          <textarea
            data-testid="sc-kc-text"
            value={choice ?? ''}
            disabled={busy || verdict !== null}
            onChange={e => setChoice(e.target.value)}
            rows={5}
            placeholder="Write your answer."
            style={{
              width: '100%', boxSizing: 'border-box', fontFamily: typography.fontFamily,
              fontSize: '0.95rem', padding: '0.5rem', border: '1px solid #ccc', borderRadius: 6,
            }}
          />
        ) : question.options.map(o => (
          <label key={o.id} data-testid={`sc-kc-option-${o.id}`}
            style={{ display: 'block', margin: '0.45rem 0', cursor: verdict ? 'default' : 'pointer' }}>
            <input
              type="radio" name={`kc-${question.id}`} value={o.id}
              checked={choice === o.id}
              disabled={busy || verdict !== null}
              onChange={() => setChoice(o.id)}
            />{' '}
            {o.text}
          </label>
        ))}
      </div>

      {error && <p style={{ color: '#c00' }}>{error}</p>}

      {verdict === null ? (
        <button
          style={{
            padding: '0.5rem 1.4rem', fontSize: '1rem', fontFamily: typography.fontFamily,
            cursor: ready && !busy ? 'pointer' : 'default',
          }}
          disabled={!ready || busy}
          onClick={submit}
          data-testid="sc-kc-submit"
        >
          {busy ? 'Submitting…' : 'Submit'}
        </button>
      ) : (
        <div>
          <div style={{
            ...card,
            background: isFreeText ? '#f2f2f2' : verdict.correct ? '#e8f7ec' : '#fdf0f0',
            borderColor: isFreeText ? '#d5d5d5' : verdict.correct ? '#a9d9b8' : '#e6bcbc',
          }}>
            {/* ⚠ AN UNGRADED QUESTION HAS NO VERDICT TO GIVE. A free-text answer comes
                back correct:false because there is no key — printing "Not quite." would
                mark a student wrong on a question that is not marked at all. */}
            <strong>{isFreeText ? 'Recorded.' : verdict.correct ? 'Correct.' : 'Not quite.'}</strong>
            <p style={{ margin: '0.4rem 0 0' }}>{verdict.explanation}</p>
          </div>
          <button
            style={{
              padding: '0.5rem 1.4rem', fontSize: '1rem', fontFamily: typography.fontFamily,
              cursor: 'pointer',
            }}
            onClick={onDone}
            data-testid="sc-kc-continue"
          >
            Continue
          </button>
        </div>
      )}
    </div>
  )
}
