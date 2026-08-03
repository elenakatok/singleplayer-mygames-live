import { colors, typography } from '@mygames/game-ui'
import type { ForecastClassPoint } from './api'

// ═══════════════════════════════════════════════════════════════════════════════
// TIER 3, CHART 1 (spec §10) — the lecture asset.
//
//   Line 1  realized ACTUAL demand by month (an average only under perStudent)
//   Line 2  class average FORECAST by month
//   Dashed  the TRUE systematic component, a + b·p + H·holiday(p)
//   Band    ±1σ around it — "the range demand actually varied in" (spec §9)
//   Row     per-month n =, the denominator the FORECAST average is over
//
// ⚠⚠ THE ±1σ BAND IS NOT DECORATION, AND SHIPPING WITHOUT IT WAS A REAL GAP (Elena,
// 08-03). It is the element that separates "demand wandered off the line
// unpredictably" from "the line is wrong" — slide 2's systematic/unsystematic split,
// which is the entire point of the debrief. Without it the chart shows the deviation
// and gives the reader no scale to judge it against, so a class whose forecasts sit
// well inside the noise looks indistinguishable from one that missed the process.
//
// ⚠ AND THE DEMAND LINE IS NOT ALWAYS AN AVERAGE. Under the shipped `common` draw every
// student faced the identical series, so it is realized demand; the per-month n and the
// composition caveat apply to the FORECAST line only. Under `perStudent` both lines are
// averages. The wording follows the instance rather than being hardcoded, because a
// caption that says "class average" over a series nobody averaged is telling the reader
// the line moves with who was playing.
//
// ⚠ THE DASHED REFERENCE IS AUTO-DERIVED, NEVER HAND-ENTERED (spec §10). It arrives on
// the report payload, computed from the instance's own model, so an instructor who
// edits a parameter cannot leave a chart drawing the old process beside the new data.
//
// ⚠ THE COUNT ROW IS NOT OPTIONAL, AND IT BELONGS TO THE FORECAST LINE. Play is async
// across a week, so later months average over a handful of students while early ones
// average over the class. A thin n= row under the axis is what stops a tail wobble in
// the FORECAST line reading as a finding rather than as three people being left (spec
// §10 says this in as many words). Under the shipped `common` draw it says nothing about
// the demand line, which is one realized series regardless of who showed up. It is a row
// rather than a hover because Elena projects these, and nobody hovers a projector.
//
// INSTRUCTOR-ONLY — reached only through the instructor-authenticated forecastGetReport.
// ═══════════════════════════════════════════════════════════════════════════════

const ACTUAL_COLOR = '#2563eb'      // blue
const FORECAST_COLOR = '#dc2626'    // red
const REF_COLOR = '#64748b'         // slate, dashed
const BAND_COLOR = '#94a3b8'        // the ±1σ band, at low opacity
const AXIS_COLOR = '#94a3b8'

export function ClassChartSVG({
  points,
  /** The instance's own σ — the band is ±1σ around the systematic component. Optional
   *  only so an older caller cannot crash; every real caller passes it. */
  sigma,
  /** `common` (shipped) means the demand line is realized demand, not an average. */
  demandDraw = 'common',
}: {
  points: ForecastClassPoint[]
  sigma?: number
  demandDraw?: 'perStudent' | 'common'
}) {
  if (points.length === 0) {
    return (
      <p style={{ fontFamily: typography.fontFamily, color: colors.textSecondary, fontSize: '0.85rem' }}>
        No months have been played yet.
      </p>
    )
  }

  const W = 900
  const H = 356
  const PAD = { top: 16, right: 16, bottom: 80, left: 60 }
  const plotW = W - PAD.left - PAD.right
  const plotH = H - PAD.top - PAD.bottom

  // ⚠ THE BAND ENTERS THE Y-DOMAIN. A band drawn outside the scale would be clipped at
  // the plot edge and read as a smaller band than it is — which is the one thing a
  // "range demand actually varied in" annotation must never do.
  const band = sigma !== undefined && sigma > 0 ? sigma : null
  const values = points.flatMap(p => [
    p.actual, p.forecast, p.systematic,
    ...(band === null ? [] : [p.systematic - band, p.systematic + band]),
  ])
  const dataMin = Math.min(...values)
  const dataMax = Math.max(...values)
  const pad = Math.max(20, (dataMax - dataMin) * 0.12)
  const yMin = Math.max(0, Math.floor((dataMin - pad) / 50) * 50)
  const yMax = Math.ceil((dataMax + pad) / 50) * 50

  const n = points.length
  const x = (i: number) => PAD.left + (n === 1 ? plotW / 2 : (i / (n - 1)) * plotW)
  const y = (v: number) => PAD.top + plotH - ((v - yMin) / Math.max(1, yMax - yMin)) * plotH

  const path = (pick: (p: ForecastClassPoint) => number) =>
    points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(pick(p)).toFixed(1)}`).join(' ')

  const yTicks: number[] = []
  const step = Math.max(50, Math.round((yMax - yMin) / 4 / 50) * 50)
  for (let v = yMin; v <= yMax; v += step) yTicks.push(v)

  // Thin the x labels so they never collide: at 24 months every other one is plenty.
  const labelEvery = Math.max(1, Math.ceil(n / 12))

  return (
    <svg
      data-testid="fc-class-chart"
      viewBox={`0 0 ${W} ${H}`}
      style={{ width: '100%', height: 'auto', display: 'block', fontFamily: typography.fontFamily }}
      role="img"
      aria-label="Actual demand and average class forecasts by month, against the true systematic component and its plus-or-minus one sigma band"
    >
      <line x1={PAD.left} x2={PAD.left} y1={PAD.top} y2={PAD.top + plotH} stroke={AXIS_COLOR} />
      <line x1={PAD.left} x2={PAD.left + plotW} y1={PAD.top + plotH} y2={PAD.top + plotH} stroke={AXIS_COLOR} />

      {yTicks.map(v => (
        <g key={`y-${v}`}>
          <line x1={PAD.left - 4} x2={PAD.left} y1={y(v)} y2={y(v)} stroke={AXIS_COLOR} />
          <text x={PAD.left - 8} y={y(v) + 4} fontSize={11} fill={colors.textSecondary} textAnchor="end">
            {v.toLocaleString()}
          </text>
        </g>
      ))}

      {points.map((p, i) => (
        i % labelEvery === 0 ? (
          <text
            key={`x-${p.period}`}
            data-testid={`fc-class-tick-${p.period}`}
            x={x(i)} y={PAD.top + plotH + 15}
            fontSize={10} fill={colors.textSecondary} textAnchor="middle"
          >
            {p.label}
          </text>
        ) : null
      ))}

      {/* ── ±1σ around the systematic component (spec §9) ──────────────────── */}
      {/* Drawn FIRST so every line sits on top of it: the band is context, and a band
          painted over the data would hide the very comparison it exists to enable. */}
      {band !== null && (
        <path
          data-testid="fc-class-band"
          // Forward along the upper edge, back along the lower, closed — one filled
          // ribbon rather than two lines the eye has to pair up.
          d={[
            ...points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.systematic + band).toFixed(1)}`),
            ...[...points].reverse().map((p, i) => `L${x(points.length - 1 - i).toFixed(1)},${y(p.systematic - band).toFixed(1)}`),
            'Z',
          ].join(' ')}
          fill={BAND_COLOR} fillOpacity={0.16} stroke="none"
        />
      )}

      {/* ── The dashed TRUE systematic component (spec §10) ────────────────── */}
      <path
        data-testid="fc-class-line-systematic"
        d={path(p => p.systematic)}
        fill="none" stroke={REF_COLOR} strokeWidth={1.5} strokeDasharray="6 4"
      />
      {/* ── Realized actual demand, and the class's average forecast ───────── */}
      <path data-testid="fc-class-line-actual" d={path(p => p.actual)} fill="none" stroke={ACTUAL_COLOR} strokeWidth={2} />
      <path data-testid="fc-class-line-forecast" d={path(p => p.forecast)} fill="none" stroke={FORECAST_COLOR} strokeWidth={2} strokeDasharray="4 3" />

      {/* ── The per-month denominator row ──────────────────────────────────── */}
      <text x={PAD.left - 8} y={PAD.top + plotH + 32} fontSize={9} fill={colors.textSecondary} textAnchor="end">
        n =
      </text>
      {points.map((p, i) => (
        i % labelEvery === 0 ? (
          <text
            key={`n-${p.period}`}
            data-testid={`fc-class-n-${p.period}`}
            x={x(i)} y={PAD.top + plotH + 32}
            fontSize={9} fill={colors.textSecondary} textAnchor="middle"
          >
            {p.n}
          </text>
        ) : null
      ))}

      <g transform={`translate(${PAD.left + 4}, ${PAD.top + plotH + 52})`}>
        <line x1={0} x2={18} y1={-4} y2={-4} stroke={ACTUAL_COLOR} strokeWidth={2} />
        <text data-testid="fc-class-legend-actual" x={24} y={0} fontSize={11} fill={colors.textSecondary}>
          {demandDraw === 'common' ? 'Actual demand' : 'Average actual demand'}
        </text>
        <line x1={150} x2={168} y1={-4} y2={-4} stroke={FORECAST_COLOR} strokeWidth={2} strokeDasharray="4 3" />
        <text x={174} y={0} fontSize={11} fill={colors.textSecondary}>Class average forecast</text>
        <line x1={330} x2={348} y1={-4} y2={-4} stroke={REF_COLOR} strokeWidth={1.5} strokeDasharray="6 4" />
        <text x={354} y={0} fontSize={11} fill={colors.textSecondary}>True systematic component</text>
      </g>

      {/* ⚠ THE BAND GETS ITS OWN ROW, not a fourth slot on the first. Spec §9 names the
          label — "the range demand actually varied in" — and that phrase is what makes
          the band mean something rather than being a grey smudge; crushed onto the end
          of a four-item row it would run off the 900-unit viewBox. */}
      {band !== null && (
        <g transform={`translate(${PAD.left + 4}, ${PAD.top + plotH + 68})`}>
          <rect x={0} y={-9} width={18} height={10} fill={BAND_COLOR} fillOpacity={0.16} />
          <text data-testid="fc-class-legend-band" x={24} y={0} fontSize={11} fill={colors.textSecondary}>
            ±1σ ({Math.round(band).toLocaleString()} units) — the range demand actually varied in
          </text>
        </g>
      )}
    </svg>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// TIER 3, CHART 2 (spec §10) — the MSE histogram, "BUILD IN v1".
//
// ⚠ THE X-AXIS IS LOGARITHMIC, and that is what makes the chart legible rather than a
// smear. Student MSEs run from roughly 900 to 40,000 — a 40× range — and spec §10 wants
// the chart to "show the class spread and locate the chased-the-noise tail". On a linear
// axis every competent student lands in the first bucket and the benchmark reference
// lines pile up against the left edge; on a log axis they separate.
// ═══════════════════════════════════════════════════════════════════════════════

export function MseHistogramSVG({
  histogram,
  benchmarks,
}: {
  histogram: { bins: { lo: number; hi: number; count: number }[]; min: number; max: number }
  /** Spec §2.3's rows, drawn as vertical reference lines. Empty when the instance's
   *  model was edited and the published table no longer applies. */
  benchmarks: { id: string; label: string; mse: number | null }[]
}) {
  const W = 900
  const H = 260
  const PAD = { top: 16, right: 16, bottom: 58, left: 46 }
  const plotW = W - PAD.left - PAD.right
  const plotH = H - PAD.top - PAD.bottom

  const bins = histogram.bins
  const maxCount = Math.max(1, ...bins.map(b => b.count))

  // The axis spans the bins, extended to include any benchmark line that falls outside
  // them — a reference line clipped off the edge is worse than a slightly wider axis.
  const refValues = benchmarks.map(b => b.mse).filter((m): m is number => m !== null && m > 0)
  const lo = Math.log10(Math.min(bins[0].lo, ...(refValues.length ? refValues : [bins[0].lo])))
  const hi = Math.log10(Math.max(bins[bins.length - 1].hi, ...(refValues.length ? refValues : [bins[bins.length - 1].hi])))
  const span = hi - lo || 1

  const x = (v: number) => PAD.left + ((Math.log10(v) - lo) / span) * plotW
  const y = (count: number) => PAD.top + plotH - (count / maxCount) * plotH

  return (
    <svg
      data-testid="fc-mse-histogram"
      viewBox={`0 0 ${W} ${H}`}
      style={{ width: '100%', height: 'auto', display: 'block', fontFamily: typography.fontFamily }}
      role="img"
      aria-label="Distribution of student MSE, with benchmark reference lines"
    >
      <line x1={PAD.left} x2={PAD.left} y1={PAD.top} y2={PAD.top + plotH} stroke={AXIS_COLOR} />
      <line x1={PAD.left} x2={PAD.left + plotW} y1={PAD.top + plotH} y2={PAD.top + plotH} stroke={AXIS_COLOR} />

      {bins.map((b, i) => {
        const x0 = x(b.lo)
        const x1 = x(b.hi)
        return (
          <rect
            key={i}
            data-testid={`fc-hist-bin-${i}`}
            x={x0 + 1}
            y={y(b.count)}
            width={Math.max(1, x1 - x0 - 2)}
            height={PAD.top + plotH - y(b.count)}
            fill="#93c5fd"
            stroke="#3b82f6"
          />
        )
      })}

      {/* Spec §2.3's benchmarks as vertical reference lines — this is what turns a
          distribution into the debrief slide. */}
      {benchmarks.map(b => (
        b.mse === null || b.mse <= 0 ? null : (
          <g key={b.id}>
            <line
              data-testid={`fc-hist-ref-${b.id}`}
              x1={x(b.mse)} x2={x(b.mse)}
              y1={PAD.top} y2={PAD.top + plotH}
              stroke={REF_COLOR} strokeWidth={1} strokeDasharray="4 3"
            />
            <text
              x={x(b.mse)} y={PAD.top + plotH + 13}
              fontSize={8.5} fill={colors.textSecondary} textAnchor="middle"
            >
              {Math.round(b.mse).toLocaleString()}
            </text>
          </g>
        )
      ))}

      <text x={PAD.left} y={PAD.top + plotH + 34} fontSize={10} fill={colors.textSecondary}>
        Student MSE (log scale) — dashed lines are the benchmark rules
      </text>
      <text x={PAD.left - 8} y={PAD.top + 8} fontSize={10} fill={colors.textSecondary} textAnchor="end">
        {maxCount}
      </text>
    </svg>
  )
}
