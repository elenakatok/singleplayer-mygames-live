import type { PricingEquilibrium, PricingLabels, PricingMarket, PricingPricePoint } from './api'
import { formatPrice } from './format'
import { RoundSeriesChartSVG, type ReferenceLine } from '../shared/RoundSeriesChartSVG'

// ═══════════════════════════════════════════════════════════════════════════════
// Tier 3 (spec §10) — THE SLIDE-19 CHART: class average POSTED price per round, the
// competitor's average posted price beside it, and the equilibrium as a dashed
// reference.
//
// The drawing is RoundSeriesChartSVG's; this file is the configuration that makes it
// a price chart. What is specific here:
//
//   • THE Y-AXIS IS THE INSTANCE'S OWN PRICE BAND, not the data's range. The whole
//     point is where the class sits BETWEEN the floor and the ceiling, and an
//     auto-scaled axis would hide a class hugging the ceiling by filling the plot
//     with it. (The profit chart is the opposite case and scales to its data.)
//
//   • PMG DRAWS ONE reference line, not two: any equal price is an equilibrium, so
//     the ceiling is drawn and the label says exactly that.
//
// This is the chart Elena projects next lecture, twice: the Standard instance's and
// the PMG instance's side by side. Standard's student line walks DOWN toward the
// dashed Nash line as the class discovers undercutting; PMG's walks UP toward the
// ceiling once they discover undercutting buys nothing.
// ═══════════════════════════════════════════════════════════════════════════════

export function PriceChartSVG({
  points,
  equilibrium,
  market,
  labels,
}: {
  points: PricingPricePoint[]
  equilibrium: PricingEquilibrium
  market: PricingMarket
  labels: PricingLabels
}) {
  const refLines: ReferenceLine[] = equilibrium.singleLine
    ? [{ key: 'pmg', value: equilibrium.student, label: equilibrium.label }]
    : [
        { key: 'student', value: equilibrium.student, label: `${labels.student} equilibrium ${formatPrice(equilibrium.student)}` },
        { key: 'competitor', value: equilibrium.competitor, label: `${labels.competitor} equilibrium ${formatPrice(equilibrium.competitor)}` },
      ]

  return (
    <RoundSeriesChartSVG
      points={points}
      refLines={refLines}
      yDomain={[market.minPrice, market.maxPrice]}
      formatValue={formatPrice}
      seriesLabels={{ student: `${labels.student} (class avg)`, competitor: labels.competitor }}
      ids={{
        root: 'pricing-price-chart',
        line: 'pricing-line',
        ref: 'pricing-eq-line',
        count: 'pricing-chart-n',
      }}
      ariaLabel="Class average posted price per round, against the equilibrium reference"
      caption={
        <>
          Average <strong>posted</strong> price each round. The denominator is the students
          who had <strong>played</strong> that round — shown as <code>n=</code> under the
          axis — so the later rounds average over fewer students while the class is still
          mid-week. A wobble at the tail is usually who is left, not what they did.
        </>
      }
    />
  )
}
