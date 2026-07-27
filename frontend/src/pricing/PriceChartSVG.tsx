import type { PricingEquilibrium, PricingLabels, PricingMarket, PricingPricePoint } from './api'
import { formatPrice } from './format'

// ═══════════════════════════════════════════════════════════════════════════════
// Tier 3 (spec §10) — THE SLIDE-19 CHART: class average POSTED price per round, the
// competitor's average posted price beside it, and the equilibrium as a dashed
// reference. Hand-rolled inline SVG, the platform house pattern (JarHistogramSVG,
// PD's CooperationChartSVG); this family has no shared chart widget and this slice is
// not the place to invent one.
//
// This is the chart Elena projects next lecture, twice: the Standard instance's and
// the PMG instance's side by side. Standard's student line walks DOWN toward the
// dashed Nash line as the class discovers undercutting; PMG's walks UP toward the
// ceiling once they discover undercutting buys nothing. The dashed lines are what
// make either shape mean anything, which is why they are derived from the instance's
// own market rather than typed in (reportStats.equilibriumReference).
//
// ⚠ THE COUNT ROW IS NOT OPTIONAL. Horizons are per student and play is async, so
// round 14 averages over a handful of students while round 2 averages over the class.
// A thin `n=` row under the axis is what stops a late-round wobble reading as a
// finding rather than as three people being left. It is a row rather than a hover
// because Elena projects this: nobody hovers a projector.
//
// INSTRUCTOR-ONLY — reached only through the instructor-authenticated
// pricingGetReport.
// ═══════════════════════════════════════════════════════════════════════════════

const STUDENT_COLOR = '#2563eb'    // blue
const COMPETITOR_COLOR = '#dc2626' // red
const REF_COLOR = '#64748b'        // slate, dashed

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
  if (points.length === 0) {
    return <p style={{ color: '#94a3b8', margin: 0 }}>No rounds played yet.</p>
  }

  const padL = 62, padR = 16, padT = 30, padB = 62
  const plotW = Math.max(260, Math.min(620, points.length * 34))
  const plotH = 240
  const W = padL + plotW + padR
  const H = padT + plotH + padB
  const maxRound = points[points.length - 1].round

  // The y-axis is the instance's own PRICE BAND, not the data's range: the whole point
  // is where the class sits BETWEEN the floor and the ceiling, and an auto-scaled axis
  // would hide a class hugging the ceiling by filling the plot with it.
  const lo = market.minPrice
  const hi = market.maxPrice
  const xOf = (round: number) =>
    padL + (maxRound === 1 ? plotW / 2 : ((round - 1) / (maxRound - 1)) * plotW)
  const yOf = (price: number) => padT + plotH - ((price - lo) / (hi - lo)) * plotH

  // Five ticks across the band, whatever the band is.
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map(f => lo + f * (hi - lo))
  const xEvery = maxRound <= 10 ? 1 : maxRound <= 20 ? 2 : 5

  const line = (key: 'student' | 'competitor') =>
    points.map(p => `${xOf(p.round)},${yOf(p[key])}`).join(' ')

  const refLines = equilibrium.singleLine
    ? [{ key: 'pmg', price: equilibrium.student, label: equilibrium.label }]
    : [
        { key: 'student', price: equilibrium.student, label: `${labels.student} equilibrium ${formatPrice(equilibrium.student)}` },
        { key: 'competitor', price: equilibrium.competitor, label: `${labels.competitor} equilibrium ${formatPrice(equilibrium.competitor)}` },
      ]

  return (
    <figure style={{ margin: 0 }}>
      <svg
        viewBox={`0 0 ${W} ${H}`} width="100%" style={{ maxWidth: W, fontFamily: 'inherit' }}
        role="img" aria-label="Class average posted price per round, against the equilibrium reference"
        data-testid="pricing-price-chart"
      >
        {/* Legend */}
        <g transform={`translate(${padL}, 14)`} fontSize="12">
          <g>
            <line x1={0} y1={-4} x2={16} y2={-4} stroke={STUDENT_COLOR} strokeWidth={2.5} />
            <text x={22} y={0} fill="#333">{labels.student} (class avg)</text>
          </g>
          <g transform="translate(150, 0)">
            <line x1={0} y1={-4} x2={16} y2={-4} stroke={COMPETITOR_COLOR} strokeWidth={2.5} />
            <text x={22} y={0} fill="#333">{labels.competitor}</text>
          </g>
        </g>

        {/* Y gridlines + price ticks */}
        {yTicks.map(t => (
          <g key={`y${t}`}>
            <line x1={padL} y1={yOf(t)} x2={padL + plotW} y2={yOf(t)} stroke="#eee" />
            <text x={padL - 8} y={yOf(t) + 4} textAnchor="end" fontSize="11" fill="#888">
              {formatPrice(t)}
            </text>
          </g>
        ))}

        {/* The dashed equilibrium reference(s) — derived, never typed in. */}
        {refLines.map(r => (
          <g key={r.key}>
            <line
              data-testid={`pricing-eq-line-${r.key}`}
              x1={padL} y1={yOf(r.price)} x2={padL + plotW} y2={yOf(r.price)}
              stroke={REF_COLOR} strokeWidth={1.5} strokeDasharray="6 4"
            />
            <text x={padL + 4} y={yOf(r.price) - 5} fontSize="10.5" fill={REF_COLOR}>{r.label}</text>
          </g>
        ))}

        {/* Axes */}
        <line x1={padL} y1={padT} x2={padL} y2={padT + plotH} stroke="#ccc" />
        <line x1={padL} y1={padT + plotH} x2={padL + plotW} y2={padT + plotH} stroke="#ccc" />

        {/* X ticks — round numbers, and the per-round denominator underneath. */}
        {points.map(p => (
          (p.round === 1 || p.round === maxRound || p.round % xEvery === 0) ? (
            <text key={`x${p.round}`} x={xOf(p.round)} y={padT + plotH + 16} textAnchor="middle" fontSize="11" fill="#888">
              {p.round}
            </text>
          ) : null
        ))}
        {points.map(p => (
          (p.round === 1 || p.round === maxRound || p.round % xEvery === 0) ? (
            <text
              key={`n${p.round}`}
              data-testid={`pricing-chart-n-${p.round}`}
              x={xOf(p.round)} y={padT + plotH + 31} textAnchor="middle" fontSize="10" fill="#aaa"
            >
              n={p.n}
            </text>
          ) : null
        ))}
        <text x={padL + plotW / 2} y={H - 10} textAnchor="middle" fontSize="12" fill="#555">
          Round (n = students who had played it)
        </text>

        {/* The two series */}
        <polyline
          data-testid="pricing-line-student"
          points={line('student')} fill="none" stroke={STUDENT_COLOR} strokeWidth={2.5}
          strokeLinejoin="round" strokeLinecap="round"
        />
        <polyline
          data-testid="pricing-line-competitor"
          points={line('competitor')} fill="none" stroke={COMPETITOR_COLOR} strokeWidth={2.5}
          strokeLinejoin="round" strokeLinecap="round"
        />
        {points.map(p => (
          <g key={`pt${p.round}`}>
            <circle cx={xOf(p.round)} cy={yOf(p.student)} r={3} fill={STUDENT_COLOR} />
            <circle cx={xOf(p.round)} cy={yOf(p.competitor)} r={3} fill={COMPETITOR_COLOR} />
          </g>
        ))}
      </svg>
      <figcaption style={{ fontSize: '0.78rem', color: '#555', marginTop: '0.4rem', lineHeight: 1.5 }}>
        Average <strong>posted</strong> price each round. The denominator is the students who
        had <strong>played</strong> that round — shown as <code>n=</code> under the axis — so
        the later rounds average over fewer students while the class is still mid-week. A
        wobble at the tail is usually who is left, not what they did.
      </figcaption>
    </figure>
  )
}
