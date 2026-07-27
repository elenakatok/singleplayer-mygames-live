import type { CSSProperties } from 'react'
import { colors, typography } from '@mygames/game-ui'
import type { PricingLabels, PricingMarket } from './api'
import { formatDemand, formatPrice, formatShare } from './format'

// ═══════════════════════════════════════════════════════════════════════════════
// The price-entry screen's reference panels (spec §4) — everything a student needs
// in front of them to choose a price, mirroring the SoPHIE screen the case came with:
//
//   MarketFacts   the market size, and BOTH firms' base share and unit cost
//   Formulas      how share and profit are computed, with this instance's numbers
//   PmgRules      the Price Matching Guarantee announcement (spec §6.2), PMG only
//
// Every number is rendered FROM CONFIG, never hardcoded (spec §2/§3, the never-stale
// principle): an instructor who edits the market gets a screen that agrees with the
// game they just changed, and a student is never shown a formula the server is not
// running.
//
// ⚠ COPY RULE (spec §1): the opponent is "your competitor", never "the bot". The
// FIRM has a name (WNS by default) and that name is fine to print; what may not
// appear is any word implying software. The bundle guard in pricing-playthrough.mjs
// §5 enforces this across the whole shipped artifact.
// ═══════════════════════════════════════════════════════════════════════════════

const card: CSSProperties = {
  border: `1px solid ${colors.border}`, borderRadius: 8, padding: '1rem 1.25rem', marginBottom: '1.25rem',
}

export const sectionTitle: CSSProperties = {
  margin: '0 0 0.6rem', fontSize: typography.sizeSm, fontWeight: 700,
  textTransform: 'uppercase', letterSpacing: '0.03em', color: colors.sectionMuted,
}

const th: CSSProperties = {
  padding: '0.35rem 0.6rem', textAlign: 'right', fontWeight: 600,
  borderBottom: `2px solid ${colors.borderLight}`, whiteSpace: 'nowrap',
}
const td: CSSProperties = {
  padding: '0.35rem 0.6rem', textAlign: 'right',
  borderBottom: `1px solid ${colors.borderMid}`, whiteSpace: 'nowrap',
}
const mineShade: CSSProperties = { background: colors.confirmBg }

/** The standing framing (spec §1/§3). Deliberately vague about length and silent
 *  about the competitor's rule — both by design, not by omission. The RANGE comes
 *  from config; the drawn count never reaches this component, or any other. */
export function Framing({
  labels, minRounds, maxRounds,
}: { labels: PricingLabels; minRounds: number; maxRounds: number }) {
  return (
    <div data-testid="pricing-framing" style={{ ...card, background: colors.infoBannerBg, borderColor: colors.infoBannerBorder }}>
      <p style={{ margin: 0, lineHeight: 1.6, color: colors.text }}>
        You are <strong>{labels.student}</strong>. Each round you post a price, and so does{' '}
        <strong>your competitor</strong>, <strong>{labels.competitor}</strong> — the same
        competitor every round, programmed to act realistically. Neither of you sees the
        other&rsquo;s price before posting.
      </p>
      <p style={{ margin: '0.6rem 0 0', lineHeight: 1.6, color: colors.text }}>
        You will play <strong>between {minRounds} and {maxRounds} rounds</strong> — you will
        not be told when the last one is. Your price is final once posted.
      </p>
    </div>
  )
}

/** The market: size, and both firms' base share and unit cost (spec §4). */
export function MarketFacts({ market, labels }: { market: PricingMarket; labels: PricingLabels }) {
  return (
    <section style={card}>
      <h2 style={sectionTitle}>The market</h2>
      <p data-testid="pricing-market-size" style={{ margin: '0 0 0.75rem', lineHeight: 1.6, color: colors.text }}>
        The market is <strong>{formatDemand(market.marketSize)} containers</strong>. Prices may
        be set anywhere from <strong>{formatPrice(market.minPrice)}</strong> to{' '}
        <strong>{formatPrice(market.maxPrice)}</strong>, in whole dollars.
      </p>
      <div style={{ overflowX: 'auto', maxWidth: '100%' }}>
        <table
          data-testid="pricing-market-table"
          style={{ borderCollapse: 'collapse', fontSize: typography.sizeTable, fontFamily: typography.fontFamily }}
        >
          <thead>
            <tr>
              <th style={{ ...th, textAlign: 'left' }}>Firm</th>
              <th style={th}>Base share</th>
              <th style={th}>Unit cost</th>
            </tr>
          </thead>
          <tbody>
            <tr data-testid="pricing-market-you">
              <td style={{ ...mineShade, ...td, textAlign: 'left' }}>{labels.student} (you)</td>
              <td style={{ ...mineShade, ...td }}>{formatShare(market.studentBaseShare)}</td>
              <td style={{ ...mineShade, ...td }}>{formatPrice(market.studentUnitCost)}</td>
            </tr>
            <tr data-testid="pricing-market-competitor">
              <td style={{ ...td, textAlign: 'left' }}>{labels.competitor} (your competitor)</td>
              <td style={td}>{formatShare(market.competitorBaseShare)}</td>
              <td style={td}>{formatPrice(market.competitorUnitCost)}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p style={{ fontSize: typography.sizeXs, color: colors.textSecondary, margin: '0.5rem 0 0' }}>
        Base share is the share you win when both firms post the same price.
      </p>
    </section>
  )
}

const formulaLine: CSSProperties = {
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: typography.sizeSm, color: colors.text, margin: '0.3rem 0', lineHeight: 1.7,
}

/**
 * How share and profit are computed — the instance's own numbers substituted in, so
 * the formula on screen is the arithmetic the server actually ran (spec §4).
 * The PMG variant replaces both formulas outright (spec §6.1).
 */
export function Formulas({
  market, labels, pmg,
}: { market: PricingMarket; labels: PricingLabels; pmg: boolean }) {
  const you = labels.student
  const them = labels.competitor
  return (
    <section style={card}>
      <h2 style={sectionTitle}>How your share and profit are computed</h2>
      {pmg ? (
        <div data-testid="pricing-formulas-pmg">
          <p style={formulaLine}>price everyone pays = the LOWER of the two posted prices</p>
          <p style={formulaLine}>{you} share = {formatShare(market.studentBaseShare)} (fixed)</p>
          <p style={formulaLine}>{them} share = {formatShare(market.competitorBaseShare)} (fixed)</p>
          <p style={formulaLine}>
            your profit = {formatDemand(market.marketSize)} × {formatShare(market.studentBaseShare)}{' '}
            × (price paid − {formatPrice(market.studentUnitCost)})
          </p>
          <p style={{ fontSize: typography.sizeXs, color: colors.textSecondary, margin: '0.6rem 0 0' }}>
            Under the price-matching guarantee your share does not respond to price at all.
          </p>
        </div>
      ) : (
        <div data-testid="pricing-formulas-standard">
          <p style={formulaLine}>
            your share = {formatShare(market.studentBaseShare)} + (their price − your price) ÷{' '}
            {formatPrice(market.slope)}
          </p>
          <p style={formulaLine}>
            their share = {formatShare(market.competitorBaseShare)} + (your price − their price) ÷{' '}
            {formatPrice(market.slope)}
          </p>
          <p style={formulaLine}>
            your profit = {formatDemand(market.marketSize)} × your share × (your price −{' '}
            {formatPrice(market.studentUnitCost)})
          </p>
          <p style={{ fontSize: typography.sizeXs, color: colors.textSecondary, margin: '0.6rem 0 0' }}>
            Undercutting your competitor by {formatPrice(market.slope)} moves a full share point
            to you. Shares never go below 0% or above 100%.
          </p>
        </div>
      )}
    </section>
  )
}

/**
 * The Price Matching Guarantee announcement (spec §6.2) — the in-lecture rule change
 * from the in-person deck, on screen.
 *
 * Every number comes from config, including the WORKED EXAMPLE: the two example
 * prices are derived from the instance's own bounds rather than the case's $1,600 /
 * $1,500, so an instructor who narrows the price band can never leave an example on
 * screen that the game would reject.
 *
 * Spec §6.2 places this screen BEFORE the knowledge check. The knowledge check
 * arrives in a later slice; until it does, the panel rides on the price-entry screen,
 * where a student meets it before their first decision either way.
 */
export function PmgRules({ market, labels }: { market: PricingMarket; labels: PricingLabels }) {
  // Two in-bounds example prices, a $100 step apart, sitting near the middle of the
  // band so they read as ordinary choices rather than extremes.
  const mid = Math.round((market.minPrice + market.maxPrice) / 2 / 100) * 100
  const higher = Math.min(market.maxPrice, Math.max(market.minPrice + 100, mid + 100))
  const lower = Math.max(market.minPrice, higher - 100)

  return (
    <section
      data-testid="pricing-pmg-rules"
      style={{ ...card, background: colors.warnBannerBg, borderColor: colors.warnBannerBorder }}
    >
      {/* Deliberately NOT `sectionTitle`: that style uppercases, which turned the
          one announcement students must actually read into shouted small-caps. This
          is a rule change, so it reads as a sentence. */}
      <h2 style={{ margin: '0 0 0.6rem', fontSize: '1.05rem', fontWeight: 700, color: colors.text }}>
        New rule this game: Price Matching Guarantee (PMG)
      </h2>
      <p style={{ margin: '0 0 0.6rem', lineHeight: 1.6, color: colors.text }}>
        Both firms now enforce a price-matching policy. Customers <strong>always pay the lower
        of the two posted prices</strong>.
      </p>
      <p data-testid="pricing-pmg-example" style={{ margin: '0 0 0.6rem', lineHeight: 1.6, color: colors.text }}>
        Example: if you post {formatPrice(higher)} and your competitor posts {formatPrice(lower)},
        your customers pay {formatPrice(lower)} too.
      </p>
      <p style={{ margin: 0, lineHeight: 1.6, color: colors.text }}>
        Because both firms&rsquo; customers always pay the same price, market shares no longer
        respond to prices: your share is always{' '}
        <strong>{formatShare(market.studentBaseShare)}</strong> and{' '}
        {labels.competitor}&rsquo;s is always{' '}
        <strong>{formatShare(market.competitorBaseShare)}</strong>. Everything else is unchanged.
      </p>
    </section>
  )
}

export { card }
