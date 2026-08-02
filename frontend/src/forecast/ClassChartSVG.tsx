import { colors, typography } from '@mygames/game-ui'
import type { ForecastClassPoint } from './api'

// ═══════════════════════════════════════════════════════════════════════════════
// TIER 3, CHART 1 (spec §10) — the lecture asset.
//
//   Line 1  class average ACTUAL demand by month
//   Line 2  class average FORECAST by month
//   Dashed  the TRUE systematic component, a + b·p + H·holiday(p)
//   Row     per-month n =, the denominator each average is over
//
// ⚠ THE DASHED REFERENCE IS AUTO-DERIVED, NEVER HAND-ENTERED (spec §10). It arrives on
// the report payload, computed from the instance's own model, so an instructor who
// edits a parameter cannot leave a chart drawing the old process beside the new data.
//
// ⚠ THE COUNT ROW IS NOT OPTIONAL. Play is async across a week, so later months average
// over a handful of students while early ones average over the class. A thin n= row
// under the axis is what stops a tail wobble reading as a finding rather than as three
// people being left (spec §10 says this in as many words). It is a row rather than a
// hover because Elena projects these, and nobody hovers a projector.
//
// INSTRUCTOR-ONLY — reached only through the instructor-authenticated forecastGetReport.
// ═══════════════════════════════════════════════════════════════════════════════

const ACTUAL_COLOR = '#2563eb'      // blue
const FORECAST_COLOR = '#dc2626'    // red
const REF_COLOR = '#64748b'         // slate, dashed
const AXIS_COLOR = '#94a3b8'

export function ClassChartSVG({ points }: { points: ForecastClassPoint[] }) {
  if (points.length === 0) {
    return (
      <p style={{ fontFamily: typography.fontFamily, color: colors.textSecondary, fontSize: '0.85rem' }}>
        No months have been played yet.
      </p>
    )
  }

  const W = 900
  const H = 340
  const PAD = { top: 16, right: 16, bottom: 64, left: 60 }
  const plotW = W - PAD.left - PAD.right
  const plotH = H - PAD.top - PAD.bottom

  const values = points.flatMap(p => [p.actual, p.forecast, p.systematic])
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
      aria-label="Class average actual demand and forecasts by month, against the true systematic component"
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

      {/* ── The dashed TRUE systematic component (spec §10) ────────────────── */}
      <path
        data-testid="fc-class-line-systematic"
        d={path(p => p.systematic)}
        fill="none" stroke={REF_COLOR} strokeWidth={1.5} strokeDasharray="6 4"
      />
      {/* ── Class average actual, and class average forecast ───────────────── */}
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
        <text x={24} y={0} fontSize={11} fill={colors.textSecondary}>Average actual demand</text>
        <line x1={190} x2={208} y1={-4} y2={-4} stroke={FORECAST_COLOR} strokeWidth={2} strokeDasharray="4 3" />
        <text x={214} y={0} fontSize={11} fill={colors.textSecondary}>Class average forecast</text>
        <line x1={380} x2={398} y1={-4} y2={-4} stroke={REF_COLOR} strokeWidth={1.5} strokeDasharray="6 4" />
        <text x={404} y={0} fontSize={11} fill={colors.textSecondary}>True systematic component</text>
      </g>
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
