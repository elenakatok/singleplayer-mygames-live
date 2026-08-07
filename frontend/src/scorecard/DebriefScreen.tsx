import { useState } from 'react'
import { typography } from '@mygames/game-ui'
import { scorecardSubmitDebrief, type ScorecardReveal, type ScorecardParams } from './api'

// ═══════════════════════════════════════════════════════════════════════════════
// The debrief paragraph (spec §10), and the REVEAL that follows it.
//
// ⚠⚠ THE PROMPT DOES NOT NAME THE TREATMENT, and the reveal comes only AFTER submit
// (spec §10). Students who never acted on the reliability label are the most valuable
// data in the room; a prompt that said "you played under two different reliabilities"
// would retroactively let them claim they had noticed. The prompt text comes from the
// server for exactly this reason — it is not written here where it could drift.
// ═══════════════════════════════════════════════════════════════════════════════

const card: React.CSSProperties = {
  border: '1px solid #dcdcdc', borderRadius: 8, padding: '1rem 1.25rem',
  background: '#fafafa', marginBottom: '1rem',
}
const pct = (x: number) => `${Math.round(x * 100)}%`
const ecu = (x: number, c: string) => `${x.toFixed(2)} ${c}`

export function DebriefScreen({
  question, params, onDone,
}: {
  question: { id: string; prompt: string; followUps: string[] }
  params: ScorecardParams
  onDone: (reveal: ScorecardReveal) => void
}) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit() {
    if (text.trim().length === 0) return
    setBusy(true)
    setError(null)
    try {
      const r = await scorecardSubmitDebrief(text)
      onDone(r.reveal)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not record your answer.')
      setBusy(false)
    }
  }

  return (
    <div>
      <h3 style={{ marginTop: 0 }}>One last question</h3>
      <div style={card}>
        <p style={{ margin: 0, fontSize: '1.05rem', fontWeight: 600 }}>{question.prompt}</p>
        <ul style={{ margin: '0.6rem 0 0', paddingLeft: '1.2rem', color: '#444' }}>
          {question.followUps.map((f, i) => <li key={i} style={{ margin: '0.2rem 0' }}>{f}</li>)}
        </ul>
      </div>
      <textarea
        value={text}
        onChange={e => setText(e.target.value)}
        disabled={busy}
        rows={8}
        style={{
          width: '100%', fontFamily: typography.fontFamily, fontSize: '0.95rem',
          padding: '0.6rem', borderRadius: 6, border: '1px solid #ccc', boxSizing: 'border-box',
        }}
        placeholder={`Write a few sentences about how you worked these ${params.contractNoun}s.`}
      />
      {error && <p style={{ color: '#c00' }}>{error}</p>}
      <button
        style={{
          marginTop: '0.75rem', padding: '0.5rem 1.4rem', fontSize: '1rem',
          fontFamily: typography.fontFamily,
          cursor: text.trim() && !busy ? 'pointer' : 'default',
        }}
        disabled={text.trim().length === 0 || busy}
        onClick={submit}
      >
        {busy ? 'Submitting…' : 'Submit'}
      </button>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// THE REVEAL (spec §10) — "their own two effort curves against the DP-optimal curve for
// each condition, and the §6.3 table filled in at this instance's parameters".
//
// ⚠ THE FRAMING IS A FRICTIONLESS BENCHMARK, NOT A GRADE (spec §5). Earnings are never
// graded (spec §7) — correct play under low reliability EARNS LESS — and five contracts
// per condition is far too short for realised earnings to converge, which the screen
// says outright rather than leaving to inference.
// ═══════════════════════════════════════════════════════════════════════════════

export function RevealPanel({ reveal, params }: { reveal: ScorecardReveal; params: ScorecardParams }) {
  const rows: [string, (c: typeof reveal.high) => string][] = [
    ['One more point had to be worth', c => ecu(c.threshold, params.currency)],
    ['Best possible, per contract', c => ecu(c.benchmarks.optimal, params.currency)],
    ['Always working hard, per contract', c => ecu(c.benchmarks.alwaysHigh, params.currency)],
    ['Never working hard, per contract', c => ecu(c.benchmarks.alwaysLow, params.currency)],
    ['High-effort periods, best play', c => c.benchmarks.expectedHighEffortPeriods.toFixed(2)],
    ['— what YOU did', c => (c.yourHighEffortRate === null
      ? '—' : `${pct(c.yourHighEffortRate)} of periods`)],
    ['Your earnings, per contract', c => (c.yourMeanEarnings === null
      ? '—' : ecu(c.yourMeanEarnings, params.currency))],
  ]

  return (
    <div>
      <h3 style={{ marginTop: 0 }}>What was actually going on</h3>
      <p style={{ color: '#444' }}>
        Your {params.contractNoun}s alternated between two kinds of {params.scorecardNoun}.
        On one, working hard really moved your rating. On the other, it barely did —
        and the {params.scorecardNoun} was mostly noise.
      </p>

      <table style={{ borderCollapse: 'collapse', width: '100%', margin: '1rem 0' }}>
        <thead>
          <tr>
            <th style={{ textAlign: 'left', padding: '0.4rem 0.7rem', borderBottom: '2px solid #ddd' }} />
            <th style={{ textAlign: 'left', padding: '0.4rem 0.7rem', borderBottom: '2px solid #ddd' }}>
              {reveal.high.label}
            </th>
            <th style={{ textAlign: 'left', padding: '0.4rem 0.7rem', borderBottom: '2px solid #ddd' }}>
              {reveal.low.label}
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([label, get]) => (
            <tr key={label}>
              <td style={{ padding: '0.35rem 0.7rem', borderBottom: '1px solid #eee' }}>{label}</td>
              <td style={{ padding: '0.35rem 0.7rem', borderBottom: '1px solid #eee' }}>{get(reveal.high)}</td>
              <td style={{ padding: '0.35rem 0.7rem', borderBottom: '1px solid #eee' }}>{get(reveal.low)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* ⚠ THE HEADLINE. How far they pulled back, against how far they should have. */}
      <div style={{ ...card, background: '#eef4ff', borderColor: '#b9cdf0' }}>
        <strong>How much did you change?</strong>
        <p style={{ margin: '0.4rem 0 0' }}>
          You used high effort{' '}
          <strong>
            {reveal.yourEffortGap === null ? '—' : pct(Math.abs(reveal.yourEffortGap))}
          </strong>{' '}
          {reveal.yourEffortGap !== null && reveal.yourEffortGap < 0 ? 'more' : 'less'} often when
          the {params.scorecardNoun} was unreliable. Best play would have pulled back by{' '}
          <strong>{pct(reveal.optimalEffortGap)}</strong>.
        </p>
      </div>

      <p style={{ fontSize: '0.85rem', color: '#555' }}>
        The per-contract figures above are the <em>frictionless benchmark</em> — what each way
        of playing is worth on average, not a grade. You played{' '}
        {reveal.contractsPerCondition.high} and {reveal.contractsPerCondition.low} contracts in
        the two situations, which is far too few for what you actually earned to settle near
        any of them. Your grade for this exercise is for completing it.
      </p>
    </div>
  )
}
