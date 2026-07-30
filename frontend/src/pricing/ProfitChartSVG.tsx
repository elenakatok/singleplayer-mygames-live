import type { PricingLabels, PricingProfitEquilibrium, PricingProfitPoint } from './api'
import { formatProfitM } from './format'
import { RoundSeriesChartSVG, fitDomainIncludingZero, type ReferenceLine } from '../shared/RoundSeriesChartSVG'

// ═══════════════════════════════════════════════════════════════════════════════
// Tier 3, second chart (spec §10) — class average PROFIT per round, the competitor's
// beside it, against the profit each earns at the equilibrium prices.
//
// The exact sibling of the price chart, and the same drawing (RoundSeriesChartSVG):
// the price chart says what the class CHARGED, this one says what that EARNED them.
// Read together they are the whole Standard lesson — the price line walking down
// toward Nash while the profit line walks down with it — and the whole PMG lesson,
// where the price line walking UP takes the profit line with it at no cost in share.
//
// Two things are specific here, and both are about profit being a different kind of
// number from a price:
//
//   • THE Y-AXIS IS DATA-DRIVEN AND MUST HOLD NEGATIVES. Pricing below cost is legal,
//     common, and the point of KC Q4 — a class that undercuts into losses has to be
//     visible as losses, so the domain fits the data, always includes zero, and the
//     shell draws a zero line whenever zero is on the chart. (The price chart is the
//     opposite case: it pins its axis to the configured band.)
//
//   • PMG STILL DRAWS TWO reference lines where the price chart draws one. Any equal
//     price is an equilibrium under PMG, so there is one PRICE to draw — but the two
//     firms have different costs and different shares, so that one price earns them
//     two different amounts of money. The label keeps the price chart's "ceiling
//     shown" convention so the pair read as one story.
// ═══════════════════════════════════════════════════════════════════════════════

export function ProfitChartSVG({
  points,
  equilibrium,
  labels,
}: {
  points: PricingProfitPoint[]
  equilibrium: PricingProfitEquilibrium
  labels: PricingLabels
}) {
  const refLines: ReferenceLine[] = [
    {
      key: 'student',
      value: equilibrium.student,
      label: `${labels.student} ${formatProfitM(equilibrium.student)}`,
    },
    {
      key: 'competitor',
      value: equilibrium.competitor,
      label: `${labels.competitor} ${formatProfitM(equilibrium.competitor)}`,
    },
  ]

  // Everything that will be drawn, so nothing lands off the plot: both series, and
  // both dashed lines (which sit well above a class that has priced itself down).
  const yDomain = fitDomainIncludingZero([
    ...points.flatMap(p => [p.student, p.competitor]),
    equilibrium.student,
    equilibrium.competitor,
  ])

  return (
    <RoundSeriesChartSVG
      points={points}
      refLines={refLines}
      yDomain={yDomain}
      formatValue={formatProfitM}
      seriesLabels={{ student: `${labels.student} (class avg)`, competitor: labels.competitor }}
      ids={{
        root: 'pricing-profit-chart',
        line: 'pricing-profit-line',
        ref: 'pricing-profit-eq-line',
        count: 'pricing-profit-n',
      }}
      ariaLabel="Class average profit per round, against the profit earned at the equilibrium prices"
      caption={
        <>
          Average profit each round, in millions. The denominator is the students who had{' '}
          <strong>played</strong> that round — shown as <code>n=</code> under the axis — so
          the later rounds average over fewer students while the class is still mid-week. A
          wobble at the tail is usually who is left, not what they did. Below the zero line
          the class was <strong>losing money</strong>: a price under unit cost loses on every
          container, however much share it wins.
        </>
      }
    />
  )
}
