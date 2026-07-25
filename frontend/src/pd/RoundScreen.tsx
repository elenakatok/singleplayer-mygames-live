import { useState } from 'react'
import type { CSSProperties } from 'react'
import { colors, typography } from '@mygames/game-ui'
import { pdSubmitRound, type Move, type PdHistoryRow, type PdMoveLabels, type PdPayoffs, type PdRoundResult } from './api'
import { PayoffMatrix } from './PayoffMatrix'
import { HistoryTable } from './HistoryTable'

// ═══════════════════════════════════════════════════════════════════════════════
// One round, as the two phases of the loop's iteration (spec §4):
//
//   ChooseRound  — the ASK phase: the matrix, the two moves, one submit.
//   RevealRound  — the DISPLAY phase: what both sides played and what it cost.
//
// The payoff matrix and the history table are on BOTH phases: a student deciding
// round 7 should be able to read the matrix and their own record without navigating,
// and a student reading the reveal should see it land in the table.
//
// WHAT THE COPY MAY SAY (spec §1, §3) — and this is the whole of it: the same
// automated player every round, programmed to act realistically, and the configured
// round RANGE. Never which strategy it is (the student infers that — it is the
// pedagogy), and never the actual round count or how many are left.
//
// NO DIRECTIONAL FRAMING (Slice 5): payoffs are rendered as a number plus the
// instance's configured unit, and nothing on this screen says whether more is better.
// ═══════════════════════════════════════════════════════════════════════════════

const card: CSSProperties = {
  border: `1px solid ${colors.border}`, borderRadius: 8, padding: '1rem 1.25rem', marginBottom: '1.25rem',
}

const sectionTitle: CSSProperties = {
  margin: '0 0 0.6rem', fontSize: typography.sizeSm, fontWeight: 700,
  textTransform: 'uppercase', letterSpacing: '0.03em', color: colors.sectionMuted,
}

/** The standing framing (spec §1). Deliberately vague about length and silent about
 *  the opponent's rule — both by design, not by omission. The RANGE comes from config
 *  (Slice 5); the drawn count still never reaches this component, or any other. */
export function Framing({ minRounds, maxRounds }: { minRounds: number; maxRounds: number }) {
  return (
    <div data-testid="pd-framing" style={{ ...card, background: colors.infoBannerBg, borderColor: colors.infoBannerBorder }}>
      <p style={{ margin: 0, lineHeight: 1.6, color: colors.text }}>
        You are playing against <strong>the same automated player every round</strong>. It is
        programmed to act realistically. You will play{' '}
        <strong>between {minRounds} and {maxRounds} rounds</strong> — you will not be told when
        the last one is.
      </p>
      <p style={{ margin: '0.6rem 0 0', lineHeight: 1.6, color: colors.text }}>
        Each round you both choose at the same time, without seeing the other&rsquo;s choice.
        Your choices are final — a round cannot be changed once it is played.
      </p>
    </div>
  )
}

// ── ASK phase ──────────────────────────────────────────────────────────────────

export function ChooseRound({
  roundNumber,
  labels,
  payoffs,
  unit,
  minRounds,
  maxRounds,
  history,
  onResult,
}: {
  /** 1-based; shown on its own. NEVER "round N of M" (spec §3). */
  roundNumber: number
  labels: PdMoveLabels
  payoffs: PdPayoffs
  unit: string
  minRounds: number
  maxRounds: number
  history: PdHistoryRow[]
  onResult: (result: PdRoundResult, done: boolean) => void
}) {
  // Nothing pre-selected: the first move must be a choice, not an acceptance of a
  // default that would quietly bias the class's round-1 cooperation rate.
  const [choice, setChoice] = useState<Move | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const canSubmit = choice !== null && !submitting

  const handleSubmit = async () => {
    if (!canSubmit || choice === null) return
    setSubmitting(true)
    setError(null)
    try {
      const res = await pdSubmitRound(roundNumber, choice)
      onResult(res, res.gameOver)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong. Please try again.')
      setSubmitting(false)
    }
  }

  const option = (move: Move) => {
    const selected = choice === move
    return (
      <label
        key={move}
        data-testid={`pd-choice-${move}`}
        style={{
          display: 'flex', alignItems: 'center', gap: '0.7rem', padding: '0.8rem 1rem',
          border: `1px solid ${selected ? colors.optionBorderSelected : colors.borderLight}`,
          borderRadius: 6, cursor: submitting ? 'default' : 'pointer',
          fontWeight: selected ? 600 : 400, background: selected ? colors.surfaceSubtle : colors.white,
        }}
      >
        <input
          type="radio" name={`pd-round-${roundNumber}`} value={move} checked={selected}
          disabled={submitting}
          onChange={() => setChoice(move)}
          style={{ accentColor: colors.text, width: '1rem', height: '1rem', flexShrink: 0 }}
        />
        {move === 'C' ? labels.C : labels.D}
      </label>
    )
  }

  return (
    <div>
      <h1 data-testid="pd-round-heading" style={{ marginTop: 0, marginBottom: '1rem', fontSize: '1.5rem', color: colors.text }}>
        Round {roundNumber}
      </h1>

      <Framing minRounds={minRounds} maxRounds={maxRounds} />

      <section style={card}>
        <h2 style={sectionTitle}>The payoffs</h2>
        <PayoffMatrix payoffs={payoffs} labels={labels} unit={unit} />
      </section>

      <section style={card}>
        <h2 style={sectionTitle}>Your choice this round</h2>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem', marginBottom: '1rem' }}>
          {option('C')}
          {option('D')}
        </div>

        {error && (
          <p data-testid="pd-error" role="alert" style={{ color: colors.errorAction, fontSize: typography.sizeSm, marginBottom: '0.75rem' }}>
            {error}
          </p>
        )}

        <button
          data-testid="pd-submit-round"
          onClick={() => void handleSubmit()}
          disabled={!canSubmit}
          style={{
            padding: '0.7rem 1.75rem', fontSize: '1rem', fontWeight: 600,
            cursor: canSubmit ? 'pointer' : 'not-allowed',
            backgroundColor: canSubmit ? colors.text : colors.disabledBtnBg,
            color: colors.white, border: 'none', borderRadius: 6,
          }}
        >
          {submitting ? 'Submitting…' : 'Submit this round'}
        </button>
        <p style={{ fontSize: typography.sizeXs, color: colors.textSecondary, margin: '0.5rem 0 0' }}>
          Once submitted, this round is final.
        </p>
      </section>

      <section style={card}>
        <h2 style={sectionTitle}>Your history</h2>
        <HistoryTable history={history} labels={labels} unit={unit} />
      </section>
    </div>
  )
}

// ── DISPLAY phase ──────────────────────────────────────────────────────────────

export function RevealRound({
  roundNumber,
  result,
  labels,
  payoffs,
  unit,
  onContinue,
}: {
  roundNumber: number
  result: PdRoundResult
  labels: PdMoveLabels
  payoffs: PdPayoffs
  unit: string
  onContinue: () => void
}) {
  const { studentMove, botMove, studentYears, botYears } = result.round
  const label = (m: Move) => (m === 'C' ? labels.C : labels.D)
  // Best-effort singularization of the configured unit — the same rule the server
  // uses for the KC option labels (questions.ts unitLabel).
  const amount = (n: number) =>
    `${n} ${n === 1 && unit.length > 1 && unit.endsWith('s') ? unit.slice(0, -1) : unit}`

  return (
    <div>
      <h1 style={{ marginTop: 0, marginBottom: '1rem', fontSize: '1.5rem', color: colors.text }}>
        Round {roundNumber} result
      </h1>

      <section data-testid="pd-reveal" style={{ ...card, background: colors.confirmBg, borderColor: colors.confirmBorder }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '1.5rem 2.5rem' }}>
          <div>
            <div style={{ fontSize: typography.sizeSm, color: colors.textSecondary, marginBottom: '0.2rem' }}>You chose</div>
            <div data-testid="pd-reveal-your-move" style={{ fontSize: '1.15rem', fontWeight: 700, color: colors.text }}>{label(studentMove)}</div>
            <div data-testid="pd-reveal-your-years" style={{ marginTop: '0.35rem', color: colors.text }}>
              You get <strong>{amount(studentYears)}</strong>
            </div>
          </div>
          <div>
            <div style={{ fontSize: typography.sizeSm, color: colors.textSecondary, marginBottom: '0.2rem' }}>The other player chose</div>
            <div data-testid="pd-reveal-their-move" style={{ fontSize: '1.15rem', fontWeight: 700, color: colors.text }}>{label(botMove)}</div>
            <div data-testid="pd-reveal-their-years" style={{ marginTop: '0.35rem', color: colors.text }}>
              They get <strong>{amount(botYears)}</strong>
            </div>
          </div>
        </div>
      </section>

      <button
        data-testid="pd-continue"
        onClick={onContinue}
        style={{
          padding: '0.7rem 1.75rem', fontSize: '1rem', fontWeight: 600, cursor: 'pointer',
          backgroundColor: colors.text, color: colors.white, border: 'none', borderRadius: 6,
          marginBottom: '1.5rem',
        }}
      >
        {/* No "last round" wording here: the button must read the same on every round,
            or its label would announce the round count one round early. */}
        Continue
      </button>

      <section style={card}>
        <h2 style={sectionTitle}>Your history</h2>
        <HistoryTable history={result.history} labels={labels} unit={unit} />
      </section>

      <section style={card}>
        <h2 style={sectionTitle}>The payoffs</h2>
        <PayoffMatrix payoffs={payoffs} labels={labels} unit={unit} />
      </section>
    </div>
  )
}
