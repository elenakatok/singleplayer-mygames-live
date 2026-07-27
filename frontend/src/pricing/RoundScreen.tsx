import { useState } from 'react'
import type { CSSProperties } from 'react'
import { colors, typography } from '@mygames/game-ui'
import {
  pricingSubmitPrice,
  type PricingHistoryRow, type PricingLabels, type PricingMarket, type PricingRoundResult,
} from './api'
import { Framing, MarketFacts, Formulas, PmgRules, card, sectionTitle } from './MarketPanel'
import { HistoryTable } from './HistoryTable'
import { formatDemand, formatPrice, formatProfitM, formatShare } from './format'

// ═══════════════════════════════════════════════════════════════════════════════
// One round, as the two phases of the loop's iteration (spec §4):
//
//   ChoosePrice  — the ASK phase: the market, the formulas, one price, one submit.
//   RevealRound  — the DISPLAY phase: both posted prices and what they earned.
//
// The market panels and the history table are on BOTH phases: a student deciding
// round 7 should be able to read the market and their own record without navigating,
// and a student reading the reveal should see it land in the table.
//
// WHAT THE COPY MAY SAY (spec §1, §3) — and this is the whole of it: the same
// competitor every round, programmed to act realistically, and the configured round
// RANGE. Never what rule the competitor follows (the student infers that — it is the
// pedagogy), and never the actual round count or how many are left. "Round N" stands
// alone; there is no "of M" anywhere, under any wording.
// ═══════════════════════════════════════════════════════════════════════════════

// ── ASK phase ──────────────────────────────────────────────────────────────────

export function ChoosePrice({
  roundNumber,
  labels,
  market,
  pmg,
  minRounds,
  maxRounds,
  history,
  onResult,
}: {
  /** 1-based; shown on its own. NEVER "round N of M" (spec §3). */
  roundNumber: number
  labels: PricingLabels
  market: PricingMarket
  pmg: boolean
  minRounds: number
  maxRounds: number
  history: PricingHistoryRow[]
  onResult: (result: PricingRoundResult, done: boolean) => void
}) {
  // Nothing pre-filled: the first price must be a decision, not an acceptance of a
  // default that would quietly bias the whole class's opening price.
  const [raw, setRaw] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Client-side validation is a HINT, not the gate: pricingSubmitPrice validates the
  // same three things server-side and rejects anything else (Slice 1). This exists so
  // a student learns about a typo before the round costs them a submit.
  const trimmed = raw.trim()
  const parsed = /^\d+$/.test(trimmed) ? Number(trimmed) : NaN
  const inBounds = Number.isInteger(parsed) && parsed >= market.minPrice && parsed <= market.maxPrice
  const hint = trimmed === '' ? null
    : !Number.isInteger(parsed) ? 'Enter a whole dollar amount — no cents, no symbols.'
    : !inBounds ? `Your price must be between ${formatPrice(market.minPrice)} and ${formatPrice(market.maxPrice)}.`
    : null

  const canSubmit = inBounds && !submitting

  const handleSubmit = async () => {
    if (!canSubmit) return
    setSubmitting(true)
    setError(null)
    try {
      const res = await pricingSubmitPrice(roundNumber, parsed)
      onResult(res, res.gameOver)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong. Please try again.')
      setSubmitting(false)
    }
  }

  return (
    <div>
      <h1 data-testid="pricing-round-heading" style={{ marginTop: 0, marginBottom: '1rem', fontSize: '1.5rem', color: colors.text }}>
        Round {roundNumber}
      </h1>

      <Framing labels={labels} minRounds={minRounds} maxRounds={maxRounds} />

      {/* The PMG rule change comes BEFORE the market facts it changes (spec §6.2). */}
      {pmg && <PmgRules market={market} labels={labels} />}

      <MarketFacts market={market} labels={labels} />
      <Formulas market={market} labels={labels} pmg={pmg} />

      <section style={card}>
        <h2 style={sectionTitle}>Your price this round</h2>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
          <span style={{ fontSize: '1.35rem', color: colors.text }}>$</span>
          <input
            data-testid="pricing-price-input"
            type="text"
            inputMode="numeric"
            autoComplete="off"
            value={raw}
            disabled={submitting}
            placeholder={String(market.minPrice)}
            onChange={e => setRaw(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && canSubmit) void handleSubmit() }}
            style={{
              width: '9rem', padding: '0.55rem 0.7rem', fontSize: '1.2rem',
              fontFamily: typography.fontFamily,
              border: `1px solid ${hint ? colors.errorBorder : colors.borderLight}`, borderRadius: 6,
            }}
          />
          <span style={{ fontSize: typography.sizeSm, color: colors.textSecondary }}>
            per container ({formatPrice(market.minPrice)}–{formatPrice(market.maxPrice)})
          </span>
        </div>

        {hint && (
          <p data-testid="pricing-price-hint" style={{ color: colors.errorAction, fontSize: typography.sizeSm, margin: '0 0 0.75rem' }}>
            {hint}
          </p>
        )}
        {error && (
          <p data-testid="pricing-error" role="alert" style={{ color: colors.errorAction, fontSize: typography.sizeSm, margin: '0 0 0.75rem' }}>
            {error}
          </p>
        )}

        <button
          data-testid="pricing-submit-round"
          onClick={() => void handleSubmit()}
          disabled={!canSubmit}
          style={{
            padding: '0.7rem 1.75rem', fontSize: '1rem', fontWeight: 600,
            cursor: canSubmit ? 'pointer' : 'not-allowed',
            backgroundColor: canSubmit ? colors.text : colors.disabledBtnBg,
            color: colors.white, border: 'none', borderRadius: 6,
          }}
        >
          {submitting ? 'Posting…' : 'Post this price'}
        </button>
        <p style={{ fontSize: typography.sizeXs, color: colors.textSecondary, margin: '0.5rem 0 0' }}>
          Once posted, this round is final.
        </p>
      </section>

      <section style={card}>
        <h2 style={sectionTitle}>Your history</h2>
        <HistoryTable history={history} labels={labels} pmg={pmg} />
      </section>
    </div>
  )
}

// ── DISPLAY phase ──────────────────────────────────────────────────────────────

const figureLabel: CSSProperties = {
  fontSize: typography.sizeSm, color: colors.textSecondary, marginBottom: '0.15rem',
}

/** One firm's four figures. Built as a component so the two sides cannot drift into
 *  showing different things — spec §4 wants both, symmetrically. */
function FirmOutcome({
  who, price, share, demand, profit, mine, testPrefix,
}: {
  who: string
  price: number
  share: number
  demand: number
  profit: number
  mine: boolean
  testPrefix: string
}) {
  const loss = profit < 0
  return (
    <div
      data-testid={testPrefix}
      style={{
        flex: '1 1 14rem', padding: '0.85rem 1rem', borderRadius: 6,
        border: `1px solid ${mine ? colors.confirmBorder : colors.borderLight}`,
        background: mine ? colors.confirmBg : colors.white,
      }}
    >
      <div style={{ fontSize: '1.05rem', fontWeight: 700, color: colors.text, marginBottom: '0.6rem' }}>{who}</div>

      <div style={figureLabel}>Posted price</div>
      <div data-testid={`${testPrefix}-price`} style={{ fontSize: '1.2rem', fontWeight: 700, color: colors.text }}>
        {formatPrice(price)}
      </div>

      <div style={{ ...figureLabel, marginTop: '0.55rem' }}>Market share</div>
      <div data-testid={`${testPrefix}-share`} style={{ color: colors.text }}>{formatShare(share)}</div>

      <div style={{ ...figureLabel, marginTop: '0.55rem' }}>Containers</div>
      <div data-testid={`${testPrefix}-demand`} style={{ color: colors.text }}>{formatDemand(demand)}</div>

      <div style={{ ...figureLabel, marginTop: '0.55rem' }}>Profit</div>
      <div
        data-testid={`${testPrefix}-profit`}
        style={{ fontSize: '1.2rem', fontWeight: 700, color: loss ? colors.errorAction : colors.text }}
      >
        {formatProfitM(profit)}
      </div>
      {loss && (
        <div data-testid={`${testPrefix}-loss`} style={{ fontSize: typography.sizeXs, color: colors.errorAction, marginTop: '0.2rem' }}>
          a loss — the price was below unit cost
        </div>
      )}
    </div>
  )
}

export function RevealRound({
  roundNumber,
  result,
  labels,
  market,
  pmg,
  onContinue,
}: {
  roundNumber: number
  result: PricingRoundResult
  labels: PricingLabels
  market: PricingMarket
  pmg: boolean
  onContinue: () => void
}) {
  const r = result.round

  return (
    <div>
      <h1 data-testid="pricing-reveal-heading" style={{ marginTop: 0, marginBottom: '1rem', fontSize: '1.5rem', color: colors.text }}>
        Round {roundNumber} result
      </h1>

      {/* PMG: the price everyone actually paid, ABOVE the two firm cards — under PMG
          it is the number that decides both firms' profits, so it leads (spec §6.4). */}
      {pmg && r.effectivePrice !== null && (
        <section
          data-testid="pricing-effective-price"
          style={{ ...card, background: colors.warnBannerBg, borderColor: colors.warnBannerBorder }}
        >
          <div style={figureLabel}>Price every customer actually paid — the lower of the two posted</div>
          <div data-testid="pricing-effective-price-value" style={{ fontSize: '1.6rem', fontWeight: 700, color: colors.text }}>
            {formatPrice(r.effectivePrice)}
          </div>
        </section>
      )}

      <section data-testid="pricing-reveal" style={{ ...card, display: 'flex', flexWrap: 'wrap', gap: '1rem' }}>
        <FirmOutcome
          who={`${labels.student} (you)`}
          price={r.yourPrice} share={r.yourShare} demand={r.yourDemand} profit={r.yourProfit}
          mine testPrefix="pricing-you"
        />
        <FirmOutcome
          who={`${labels.competitor} (your competitor)`}
          price={r.competitorPrice} share={r.competitorShare} demand={r.competitorDemand} profit={r.competitorProfit}
          mine={false} testPrefix="pricing-them"
        />
      </section>

      <button
        data-testid="pricing-continue"
        onClick={onContinue}
        style={{
          padding: '0.7rem 1.75rem', fontSize: '1rem', fontWeight: 600, cursor: 'pointer',
          backgroundColor: colors.text, color: colors.white, border: 'none', borderRadius: 6,
          marginBottom: '1.5rem',
        }}
      >
        {/* No "last round" wording: the button must read the same on every round, or
            its label would announce the round count one round early. */}
        Continue
      </button>

      <section style={card}>
        <h2 style={sectionTitle}>Your history</h2>
        <HistoryTable history={result.history} labels={labels} pmg={pmg} />
      </section>

      <Formulas market={market} labels={labels} pmg={pmg} />
    </div>
  )
}
