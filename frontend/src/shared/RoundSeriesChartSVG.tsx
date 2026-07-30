import type { ReactNode } from 'react'

// ═══════════════════════════════════════════════════════════════════════════════
// The Tier-3 chart SHELL: two class-average series against round number, with dashed
// reference lines and a per-round denominator row. Hand-rolled inline SVG, the
// platform house pattern (JarHistogramSVG, PD's CooperationChartSVG).
//
// ⚠ THIS IS A GENERALIZATION, NOT A NEW CHART. The price chart drew this exact
// picture already; the profit chart wanted the same picture of different numbers, so
// the picture moved here and both charts became configuration. What varies between
// them is small and explicit: the y-domain (a fixed price BAND vs a data-driven range
// that must include negatives), how a value is formatted, the series names, and the
// reference lines. Everything else — the axes, the tick thinning, the n= row, the
// composition footnote — is one implementation, so the two charts cannot drift into
// telling the same story two different ways.
//
// ⚠ IT LIVES IN shared/ BECAUSE IT IS SHARED. It began in pricing/ with two consumers
// and now has four across two games (Newsvendor draws its order-vs-demand and
// profit-vs-benchmark charts with it). Moving it was the parity rule applied
// literally: a general component is the SAME code every game uses, not a copy per
// game. Nothing about the drawing is pricing's — the only pricing-shaped thing left
// was the x-axis caption, which is now a prop.
//
// ⚠ THE COUNT ROW IS NOT OPTIONAL, in either chart. Horizons are per student and play
// is async, so the later rounds average over a handful while the early ones average
// over the class. A thin n= row under the axis is what stops a tail wobble reading as
// a finding rather than as three people being left. It is a row rather than a hover
// because Elena projects these: nobody hovers a projector.
//
// INSTRUCTOR-ONLY — reached only through the instructor-authenticated
// pricingGetReport.
// ═══════════════════════════════════════════════════════════════════════════════

export const STUDENT_COLOR = '#2563eb'    // blue
export const COMPETITOR_COLOR = '#dc2626' // red
const REF_COLOR = '#64748b'               // slate, dashed
const ZERO_COLOR = '#94a3b8'

/** One round: two class averages and the number of students they are over. */
export type RoundSeriesPoint = { round: number; student: number; competitor: number; n: number }

/** One dashed reference line. `key` becomes part of its test id. */
export type ReferenceLine = { key: string; value: number; label: string }

export type ChartIds = {
  /** The <svg> itself. */
  root: string
  /** `${line}-student` / `${line}-competitor`. */
  line: string
  /** `${ref}-${key}` per reference line. */
  ref: string
  /** `${count}-${round}` per printed denominator. */
  count: string
}

export function RoundSeriesChartSVG({
  points,
  refLines,
  yDomain,
  formatValue,
  seriesLabels,
  ids,
  ariaLabel,
  caption,
  xAxisLabel = 'Round (n = students who had played it)',
}: {
  points: RoundSeriesPoint[]
  refLines: ReferenceLine[]
  /** [low, high] in the value's own units. The caller owns this: the price chart
   *  pins it to the instance's price band, the profit chart derives it from the data
   *  (and must include 0 and any negatives). */
  yDomain: [number, number]
  formatValue: (v: number) => string
  seriesLabels: { student: string; competitor: string }
  ids: ChartIds
  ariaLabel: string
  caption: ReactNode
  /** The x-axis caption. Defaults to pricing's original wording, so the two charts
   *  that predate the move render byte-identically without passing it. */
  xAxisLabel?: string
}) {
  if (points.length === 0) {
    return <p style={{ color: '#94a3b8', margin: 0 }}>No rounds played yet.</p>
  }

  const padL = 76, padR = 16, padT = 30, padB = 62
  const plotW = Math.max(260, Math.min(620, points.length * 34))
  const plotH = 240
  const W = padL + plotW + padR
  const H = padT + plotH + padB
  const maxRound = points[points.length - 1].round

  const [lo, hi] = yDomain
  // A degenerate domain (every value identical) would divide by zero; nudge it so the
  // flat line lands in the middle of the plot rather than on an axis.
  const span = hi - lo === 0 ? Math.max(1, Math.abs(hi) || 1) : hi - lo
  const base = hi - lo === 0 ? lo - span / 2 : lo

  const xOf = (round: number) =>
    padL + (maxRound === 1 ? plotW / 2 : ((round - 1) / (maxRound - 1)) * plotW)
  const yOf = (v: number) => padT + plotH - ((v - base) / span) * plotH

  const yTicks = [0, 0.25, 0.5, 0.75, 1].map(f => base + f * span)
  const xEvery = maxRound <= 10 ? 1 : maxRound <= 20 ? 2 : 5
  /** Is zero inside the plotted range? Then it gets its own line — the difference
   *  between making money and losing it should not be something you have to read off
   *  a tick. */
  const zeroVisible = base < 0 && base + span > 0

  const line = (key: 'student' | 'competitor') =>
    points.map(p => `${xOf(p.round)},${yOf(p[key])}`).join(' ')

  const labelled = (round: number) => round === 1 || round === maxRound || round % xEvery === 0

  return (
    <figure style={{ margin: 0 }}>
      <svg
        viewBox={`0 0 ${W} ${H}`} width="100%" style={{ maxWidth: W, fontFamily: 'inherit' }}
        role="img" aria-label={ariaLabel} data-testid={ids.root}
      >
        {/* Legend */}
        <g transform={`translate(${padL}, 14)`} fontSize="12">
          <g>
            <line x1={0} y1={-4} x2={16} y2={-4} stroke={STUDENT_COLOR} strokeWidth={2.5} />
            <text x={22} y={0} fill="#333">{seriesLabels.student}</text>
          </g>
          <g transform="translate(170, 0)">
            <line x1={0} y1={-4} x2={16} y2={-4} stroke={COMPETITOR_COLOR} strokeWidth={2.5} />
            <text x={22} y={0} fill="#333">{seriesLabels.competitor}</text>
          </g>
        </g>

        {/* Y gridlines + ticks */}
        {yTicks.map((t, i) => (
          <g key={`y${i}`}>
            <line x1={padL} y1={yOf(t)} x2={padL + plotW} y2={yOf(t)} stroke="#eee" />
            <text x={padL - 8} y={yOf(t) + 4} textAnchor="end" fontSize="11" fill="#888">
              {formatValue(t)}
            </text>
          </g>
        ))}

        {/* The zero line, when zero is on the chart at all. */}
        {zeroVisible && (
          <line
            data-testid={`${ids.root}-zero`}
            x1={padL} y1={yOf(0)} x2={padL + plotW} y2={yOf(0)}
            stroke={ZERO_COLOR} strokeWidth={1.5}
          />
        )}

        {/* The dashed reference line(s) — derived, never typed in. */}
        {refLines.map(r => (
          <g key={r.key}>
            <line
              data-testid={`${ids.ref}-${r.key}`}
              x1={padL} y1={yOf(r.value)} x2={padL + plotW} y2={yOf(r.value)}
              stroke={REF_COLOR} strokeWidth={1.5} strokeDasharray="6 4"
            />
            <text x={padL + 4} y={yOf(r.value) - 5} fontSize="10.5" fill={REF_COLOR}>{r.label}</text>
          </g>
        ))}

        {/* Axes */}
        <line x1={padL} y1={padT} x2={padL} y2={padT + plotH} stroke="#ccc" />
        <line x1={padL} y1={padT + plotH} x2={padL + plotW} y2={padT + plotH} stroke="#ccc" />

        {/* X ticks — round numbers, and the per-round denominator underneath. */}
        {points.filter(p => labelled(p.round)).map(p => (
          <text key={`x${p.round}`} x={xOf(p.round)} y={padT + plotH + 16} textAnchor="middle" fontSize="11" fill="#888">
            {p.round}
          </text>
        ))}
        {points.filter(p => labelled(p.round)).map(p => (
          <text
            key={`n${p.round}`} data-testid={`${ids.count}-${p.round}`}
            x={xOf(p.round)} y={padT + plotH + 31} textAnchor="middle" fontSize="10" fill="#aaa"
          >
            n={p.n}
          </text>
        ))}
        <text x={padL + plotW / 2} y={H - 10} textAnchor="middle" fontSize="12" fill="#555">
          {xAxisLabel}
        </text>

        {/* The two series */}
        <polyline
          data-testid={`${ids.line}-student`}
          points={line('student')} fill="none" stroke={STUDENT_COLOR} strokeWidth={2.5}
          strokeLinejoin="round" strokeLinecap="round"
        />
        <polyline
          data-testid={`${ids.line}-competitor`}
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
        {caption}
      </figcaption>
    </figure>
  )
}

/**
 * A y-domain that fits every value it is given, always includes zero, and leaves a
 * little headroom. Used by the PROFIT chart, where the range is data-driven and may
 * run negative; the price chart pins its own domain to the instance's price band
 * instead, because where the class sits BETWEEN the floor and the ceiling is the
 * finding there.
 */
export function fitDomainIncludingZero(values: number[]): [number, number] {
  const all = [0, ...values.filter(v => Number.isFinite(v))]
  const lo = Math.min(...all)
  const hi = Math.max(...all)
  const pad = (hi - lo) * 0.08 || 1
  return [lo - pad, hi + pad]
}
