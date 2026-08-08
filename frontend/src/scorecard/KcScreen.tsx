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

  async function submit() {
    if (choice === null) return
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
        <p style={{ margin: 0, fontSize: '1.02rem' }}>{question.prompt}</p>
      </div>

      <div style={card}>
        {question.options.map(o => (
          <label key={o.id} style={{ display: 'block', margin: '0.45rem 0', cursor: verdict ? 'default' : 'pointer' }}>
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
            cursor: choice && !busy ? 'pointer' : 'default',
          }}
          disabled={choice === null || busy}
          onClick={submit}
        >
          {busy ? 'Submitting…' : 'Submit'}
        </button>
      ) : (
        <div>
          <div style={{
            ...card,
            background: verdict.correct ? '#e8f7ec' : '#fdf0f0',
            borderColor: verdict.correct ? '#a9d9b8' : '#e6bcbc',
          }}>
            <strong>{verdict.correct ? 'Correct.' : 'Not quite.'}</strong>
            <p style={{ margin: '0.4rem 0 0' }}>{verdict.explanation}</p>
          </div>
          <button
            style={{
              padding: '0.5rem 1.4rem', fontSize: '1rem', fontFamily: typography.fontFamily,
              cursor: 'pointer',
            }}
            onClick={onDone}
          >
            Continue
          </button>
        </div>
      )}
    </div>
  )
}
