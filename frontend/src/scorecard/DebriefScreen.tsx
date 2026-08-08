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

export function DebriefScreen({
  step, question, params, onDone,
}: {
  /** ⚠ `noticing` comes BEFORE the reveal and its submit RETURNS it; `linking` after. */
  step: 'noticing' | 'linking'
  question: { id: string; prompt: string; followUps: string[] }
  params: ScorecardParams
  onDone: (reveal: ScorecardReveal | null) => void
}) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit() {
    if (text.trim().length === 0) return
    setBusy(true)
    setError(null)
    try {
      const r = await scorecardSubmitDebrief(step, text)
      onDone(r.reveal)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not record your answer.')
      setBusy(false)
    }
  }

  return (
    <div>
      <h3 style={{ marginTop: 0 }}>
        {step === 'noticing' ? 'Before you see your results' : 'One last question'}
      </h3>
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
        data-testid="sc-freetext"
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
        data-testid="sc-freetext-submit"
      >
        {busy ? 'Submitting…' : 'Submit'}
      </button>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// THE REVEAL (spec §10) — "their own two effort curves against each other and against
// the class average."
//
// ⚠⚠ NOT AGAINST THE DP (decided 08-07). This panel previously showed a §6.3 benchmark
// table and an optimal-effort reference. Both are DELETED, not softened — spec §5.
//
// Elena's reason: **students are not asked to solve a dynamic program and must not be
// framed as having failed to.** The lesson is the DIRECTION — low reliability produces
// low effort — not the gap from optimal. Comparing against the room instead makes the
// reliability effect visible as a shared pattern rather than a personal shortfall, which
// is both kinder and more honest: a student who barely responded sees that the room
// barely responded either, and THAT is the finding.
//
// ⚠ Spec §5 also fixes the tone of the headline: "one sentence, no interpretation, no
// verdict." State the two percentages and stop. Do not add "you should have…".
// ═══════════════════════════════════════════════════════════════════════════════

/** Two effort curves on shared axes — yours solid, the class dashed. */
function EffortCurves({ cond }: { cond: ScorecardReveal['high'] }) {
  const W = 320, H = 150, padL = 34, padB = 26, padT = 10, padR = 8
  const n = cond.yourEffortByPeriod.length
  const x = (i: number) => padL + (i * (W - padL - padR)) / Math.max(1, n - 1)
  const y = (v: number) => padT + (1 - v) * (H - padT - padB)

  // ⚠ Nulls BREAK the line rather than being read as zero — a period nobody played is
  // not a period nobody worked. Segments are drawn between consecutive defined points.
  const path = (series: (number | null)[]) => {
    const parts: string[] = []
    let open = false
    series.forEach((v, i) => {
      if (v === null) { open = false; return }
      parts.push(`${open ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`)
      open = true
    })
    return parts.join(' ')
  }

  return (
    <figure style={{ margin: 0, flex: '1 1 20rem' }}>
      <figcaption style={{ fontWeight: 600, fontSize: '0.9rem', marginBottom: '0.35rem' }}>
        {cond.label}
      </figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img"
        aria-label={`High-effort rate by period, ${cond.label}`}>
        {[0, 0.5, 1].map(g => (
          <g key={g}>
            <line x1={padL} x2={W - padR} y1={y(g)} y2={y(g)} stroke="#e6e6e6" />
            <text x={padL - 6} y={y(g) + 3} textAnchor="end" fontSize="9" fill="#777">
              {Math.round(g * 100)}%
            </text>
          </g>
        ))}
        {/* R10 — axis labels 1…N, not 0…N−1. */}
        {cond.yourEffortByPeriod.map((_, i) => (
          (i === 0 || i === n - 1 || (i + 1) % 5 === 0) && (
            <text key={i} x={x(i)} y={H - padB + 14} textAnchor="middle" fontSize="9" fill="#777">
              {i + 1}
            </text>
          )
        ))}
        <path d={path(cond.classEffortByPeriod)} fill="none" stroke="#9aa4b0"
          strokeWidth="2" strokeDasharray="5 4" />
        <path d={path(cond.yourEffortByPeriod)} fill="none" stroke="#1f4e79" strokeWidth="2.5" />
      </svg>
    </figure>
  )
}

export function RevealPanel({
  reveal, params, compact = false,
}: {
  reveal: ScorecardReveal
  params: ScorecardParams
  /** Trimmed for the linking step, where the student has already read it in full. */
  compact?: boolean
}) {
  const rate = (v: number | null) => (v === null ? '—' : pct(v))

  return (
    <div>
      <h3 style={{ marginTop: 0 }} data-testid="sc-reveal">What was actually going on</h3>
      {!compact && <p style={{ color: '#444' }}>
        Your {params.contractNoun}s alternated between two kinds of {params.scorecardNoun}.
        On one, working hard really moved your rating. On the other it barely did — the
        {' '}{params.scorecardNoun} was mostly noise, and no amount of effort changed that much.
      </p>}

      {/* ⚠ SPEC §5's HEADLINE, VERBATIM IN SHAPE: two percentages, one sentence, no
          verdict. There is deliberately nothing here about what they "should" have done. */}
      <div style={{ ...card, background: '#eef4ff', borderColor: '#b9cdf0' }}>
        <p style={{ margin: 0, fontSize: '1.02rem' }}>
          You used high effort <strong>{rate(reveal.high.yourHighEffortRate)}</strong> of the
          time under the {pct(reveal.high.reliability)} {params.scorecardNoun}, and{' '}
          <strong>{rate(reveal.low.yourHighEffortRate)}</strong> under the{' '}
          {pct(reveal.low.reliability)} one.
        </p>
        <p style={{ margin: '0.5rem 0 0', color: '#444', fontSize: '0.92rem' }}>
          Across the {reveal.classSize === 1 ? 'class' : `${reveal.classSize} people in this class`},
          the averages were <strong>{rate(reveal.high.classHighEffortRate)}</strong> and{' '}
          <strong>{rate(reveal.low.classHighEffortRate)}</strong>.
        </p>
      </div>

      <div style={{ display: 'flex', gap: '1.5rem', flexWrap: 'wrap', margin: '1.25rem 0' }}>
        <EffortCurves cond={reveal.high} />
        <EffortCurves cond={reveal.low} />
      </div>
      <p style={{ fontSize: '0.8rem', color: '#666', marginTop: '-0.5rem' }}>
        Solid line: you. Dashed: the class. Both show the share of {params.periodNoun}s
        using high effort, by {params.periodNoun} within a {params.contractNoun}.
      </p>

      <p style={{ fontSize: '0.85rem', color: '#555' }}>
        You played {reveal.contractsPerCondition.high} and {reveal.contractsPerCondition.low}
        {' '}{params.contractNoun}s in the two situations. Your grade for this exercise is for
        completing it — not for what you earned.
      </p>
    </div>
  )
}
