import { useState } from 'react'
import type { CSSProperties } from 'react'
import { colors, typography } from '@mygames/game-ui'
import type { NewsvendorParams } from './api'
import { formatMoney, formatPercent, formatUnits } from './format'

// ═══════════════════════════════════════════════════════════════════════════════
// The parameter box, the demand box, and the optional service-level calculator
// (spec §7a). Shared by the place-order screen and the round-results screen, so the
// recap a student reads after ordering is literally the same panel they ordered
// against.
//
// ⚠ A LINE IS SUPPRESSED WHEN ITS VALUE IS ZERO (spec §7a, SoPHIE behaviour). An
// instance with no goodwill cost should not display "Shortage cost: $0" — a zero line
// reads as a cost the student has to account for. P and c are always shown; v, g and
// h appear only when they are non-zero.
//
// ⚠ NOTHING HERE SHOWS THE BENCHMARK. The panel prints the parameters the student was
// given, and the calculator answers "if I order Q, how often would I meet demand?" —
// a question the student poses. It never answers "what should I order?" (spec §9.2).
// ═══════════════════════════════════════════════════════════════════════════════

export const card: CSSProperties = {
  border: `1px solid ${colors.borderLight}`,
  borderRadius: 8,
  padding: '0.9rem 1rem',
  marginBottom: '1rem',
  background: colors.white,
}

const sectionTitle: CSSProperties = {
  margin: '0 0 0.5rem',
  fontSize: '0.78rem',
  fontWeight: 700,
  letterSpacing: '0.04em',
  textTransform: 'uppercase',
  color: colors.textSecondary,
}

const row: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  gap: '1rem',
  padding: '0.22rem 0',
  fontSize: typography.sizeSm,
}

const tnum = { fontVariantNumeric: 'tabular-nums' as const }

/** The cost/revenue recap (spec §7a, §7b). */
export function ParameterBox({ params }: { params: NewsvendorParams }) {
  // Only the non-zero optional lines — see the header. Each carries its own test id
  // so the suppression can be asserted on the ROW's existence rather than on whether
  // the word appears somewhere in the panel (the explanatory sentence below mentions
  // salvage in prose, which a text search would match even when the line is gone).
  // ⚠ THE MODE DECIDES WHICH LINES EXIST, not just their values.
  //   DUAL adds the second-supplier cost and REMOVES goodwill — spec §5: there is no
  //   shortage under dual sourcing, so a goodwill line would describe a penalty that
  //   can never be charged. It is dropped whatever its stored value.
  //   REGULAR has no second source, so that line does not exist either.
  const optional: [string, number, string][] = params.dual
    ? [
        ['Salvage value per leftover unit', params.v, 'nv-param-v'],
        ['Holding cost per leftover unit', params.h, 'nv-param-h'],
        ['Cost per unit from the second supplier', params.cL, 'nv-param-cl'],
      ]
    : [
        ['Salvage value per leftover unit', params.v, 'nv-param-v'],
        ['Holding cost per leftover unit', params.h, 'nv-param-h'],
        ['Shortage (goodwill) cost per unit short', params.g, 'nv-param-g'],
      ]
  return (
    <section data-testid="nv-parameters" style={card}>
      <h2 style={sectionTitle}>{params.dual ? 'Your costs and revenue' : 'Your costs and revenue'}</h2>
      <div style={row}>
        <span>Selling price per unit</span>
        <strong style={tnum} data-testid="nv-param-P">{formatMoney(params.P)}</strong>
      </div>
      <div style={row}>
        <span>{params.dual ? 'Cost per unit reserved' : 'Cost per unit ordered'}</span>
        <strong style={tnum} data-testid="nv-param-c">{formatMoney(params.c)}</strong>
      </div>
      {optional.filter(([, value]) => value !== 0).map(([label, value, testId]) => (
        <div key={label} style={row} data-testid={testId}>
          <span>{label}</span>
          <strong style={tnum}>{formatMoney(value)}</strong>
        </div>
      ))}
      <p style={{ margin: '0.5rem 0 0', fontSize: '0.78rem', color: colors.textSecondary, lineHeight: 1.5 }}>
        {params.dual ? (
          <>
            You reserve units before you know demand, at the cost above. Anything you
            reserved and did not sell is salvaged
            {params.h !== 0 ? ' (less the holding cost)' : ''}; any demand beyond what you
            reserved is still met — bought in from the second supplier at its higher cost.
            You never lose a sale.
          </>
        ) : (
          <>
            You order before you know demand. Unsold units are salvaged
            {params.h !== 0 ? ' (less the holding cost)' : ''}; unmet demand is a lost sale
            {params.g !== 0 ? ' plus the shortage cost' : ''}.
          </>
        )}
      </p>
    </section>
  )
}

/** "Demand is Normal, mean …, SD …" or "Demand is Uniform between … and …" (spec §7a). */
export function DemandBox({ params }: { params: NewsvendorParams }) {
  return (
    <section data-testid="nv-demand-box" style={card}>
      <h2 style={sectionTitle}>Demand</h2>
      <p style={{ margin: 0, fontSize: typography.sizeSm, lineHeight: 1.6 }}>
        {params.isNormal ? (
          <>
            Demand each period is <strong>Normal</strong>, with mean{' '}
            <strong style={tnum}>{formatUnits(params.mean)}</strong> and standard deviation{' '}
            <strong style={tnum}>{formatUnits(params.sd)}</strong>.
          </>
        ) : (
          <>
            Demand each period is <strong>Uniform</strong>, anywhere between{' '}
            <strong style={tnum}>{formatUnits(params.minD)}</strong> and{' '}
            <strong style={tnum}>{formatUnits(params.maxD)}</strong> units.
          </>
        )}{' '}
        It is drawn fresh each period and does not depend on what you ordered.
      </p>
    </section>
  )
}

// ── The optional calculator (spec §7a) ─────────────────────────────────────────

/** Φ(x) — Abramowitz & Stegun 7.1.26 through erf. Display-only precision: this feeds
 *  a percentage rounded to one decimal, and the approximation is good to ~1e-7. */
function normalCdf(x: number): number {
  const sign = x < 0 ? -1 : 1
  const z = Math.abs(x) / Math.SQRT2
  const t = 1 / (1 + 0.3275911 * z)
  // erf(z), Horner form of A&S 7.1.26.
  const erf = 1 - (((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t
    + 0.254829592) * t) * Math.exp(-z * z)
  return 0.5 * (1 + sign * erf)
}

/**
 * The chance that an order of Q covers demand entirely — P(D ≤ Q).
 *
 * ⚠ THIS IS THE STUDENT'S OWN QUESTION, NOT THE ANSWER TO THE GAME. It takes a Q the
 * student types and reports what that Q implies; it never runs the inverse and it
 * never names the critical ratio. Handing back Q* would be spec §9.2's benchmark by
 * another route.
 */
export function inStockProbability(Q: number, params: NewsvendorParams): number {
  if (params.isNormal) {
    if (params.sd <= 0) return Q >= params.mean ? 1 : 0
    return Math.min(1, Math.max(0, normalCdf((Q - params.mean) / params.sd)))
  }
  const span = Math.round(params.maxD) - Math.round(params.minD) + 1
  const covered = Math.round(Q) - Math.round(params.minD) + 1
  return Math.min(1, Math.max(0, covered / span))
}

/** A small display-only widget: type a trial order, see how often it would cover
 *  demand (spec §7a). No effect on play; nothing is submitted. */
export function ServiceLevelCalculator({ params }: { params: NewsvendorParams }) {
  const [text, setText] = useState('')
  const parsed = Number(text)
  const valid = text.trim() !== '' && Number.isFinite(parsed) && parsed >= 0

  return (
    <section data-testid="nv-calculator" style={{ ...card, background: colors.surfaceSubtle }}>
      <h2 style={sectionTitle}>Try a quantity</h2>
      <p style={{ margin: '0 0 0.6rem', fontSize: '0.8rem', color: colors.textSecondary, lineHeight: 1.5 }}>
        Type a quantity to see how often it would cover demand entirely. This is a
        scratchpad — nothing here is submitted.
      </p>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.7rem', flexWrap: 'wrap' }}>
        <input
          data-testid="nv-calc-input"
          type="number"
          inputMode="numeric"
          value={text}
          onChange={e => setText(e.target.value)}
          style={{
            width: '9rem', fontSize: '1rem', padding: '0.45rem 0.6rem', borderRadius: 4,
            border: `1px solid ${colors.inputBorder}`, ...tnum,
          }}
        />
        <span data-testid="nv-calc-result" style={{ fontSize: typography.sizeSm }}>
          {valid
            ? <>covers demand about <strong>{formatPercent(inStockProbability(parsed, params))}</strong> of the time</>
            : <span style={{ color: colors.textSecondary }}>—</span>}
        </span>
      </div>
    </section>
  )
}
