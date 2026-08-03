import { colors, typography } from '@mygames/game-ui'
import type { ForecastHistoryPoint, ForecastPlayedRow } from './api'

// ═══════════════════════════════════════════════════════════════════════════════
// THE DEMAND CHART (spec §4). Hand-rolled inline SVG, the platform house pattern
// (JarHistogramSVG, PD's CooperationChartSVG, the shared RoundSeriesChartSVG).
//
// ⚠⚠ "THE CHART IS NOT DECORATION" (spec §4). A sixty-point line with no year
// boundaries and no month labels is unreadable, and the whole exercise fails at the
// first screen — a student who cannot SEE the season and the trend has nothing to
// model. Three things are therefore non-negotiable here, and each is asserted in the
// browser harness rather than left to look right:
//
//   1. YEAR BOUNDARIES — a vertical rule every twelve months, labelled Y1…Y7, so the
//      repeat is visible as a repeat rather than as a wave.
//   2. MONTH LABELS — the axis is thinned to quarters (Jan/Apr/Jul/Oct) rather than
//      dropped, because "the peak is in month 47" is not a finding a student can use;
//      "the peak is in November, every year" is.
//   3. THE HIGH SEASON IS *NOT* SHADED. Deliberate: spotting it is the exercise
//      (spec §4, §7). Highlighting Nov/Dec would do the noticing for them and delete
//      the observation the assignment is built around. The CSV codes the indicator
//      because slide 12's method needs the column; the CHART does not, because the
//      chart is where the student is supposed to look.
//
// ⚠ THE FORECAST LINE IS THE CHEAPEST LEARNING AID IN THE GAME (spec §4). From the
// round-results screen on, the student's own forecasts are drawn as a second series
// against the actuals, so the gap between prediction and outcome is visible every
// month. SoPHIE never showed this.
// ═══════════════════════════════════════════════════════════════════════════════

const ACTUAL_COLOR = '#2563eb'      // blue — realized demand
const FORECAST_COLOR = '#dc2626'    // red  — the student's own forecasts
const BOUNDARY_COLOR = '#cbd5e1'    // slate-300, the year rules
const AXIS_COLOR = '#94a3b8'
const REF_COLOR = '#64748b'    // slate, dashed — the instructor-only reference

const MONTH_TICKS = [1, 4, 7, 10]   // Jan, Apr, Jul, Oct
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export type DemandChartProps = {
  /** The COMMON history — always drawn. */
  history: ForecastHistoryPoint[]
  /** Months this student has played. Their actuals extend the demand line; their
   *  forecasts are drawn as the second series. Empty before the first month. */
  played?: ForecastPlayedRow[]
  /** Total months the chart's x-axis should span — history + rounds — so the axis does
   *  not rescale under the student every month as play proceeds. */
  totalPeriods: number
  height?: number
  /**
   * ⚠⚠ INSTRUCTOR-ONLY. The TRUE systematic component, drawn as a dashed reference.
   *
   * THIS IS THE ANSWER KEY. Passing it on a student screen would print the process the
   * whole exercise asks them to infer — the single worst leak available in this game.
   * It is optional and undefined everywhere on the student side; only the reports page
   * supplies it, and the browser harness asserts that the student's chart has no
   * reference line. Do not thread it through Play.tsx, ever.
   */
  reference?: { period: number; value: number }[]
}

export function DemandChartSVG({
  history,
  played = [],
  totalPeriods,
  height = 300,
  reference,
}: DemandChartProps) {
  const W = 900
  const H = height
  const PAD = { top: 16, right: 16, bottom: 46, left: 56 }
  const plotW = W - PAD.left - PAD.right
  const plotH = H - PAD.top - PAD.bottom

  // ── Domains ────────────────────────────────────────────────────────────────
  // The x-domain is the WHOLE game (history + every playable month), fixed from the
  // first render. An axis that grew month by month would make the history visibly
  // shrink under the student mid-game, which reads as the data changing.
  const xMax = Math.max(totalPeriods, history.length)
  const values = [
    ...history.map(h => h.demand),
    ...played.map(p => p.actual),
    ...played.map(p => p.forecast),
    ...(reference ?? []).map(r => r.value),
  ]
  const dataMin = values.length ? Math.min(...values) : 0
  const dataMax = values.length ? Math.max(...values) : 1
  // A little headroom, and never a zero-height domain.
  const pad = Math.max(20, (dataMax - dataMin) * 0.1)
  const yMin = Math.max(0, Math.floor((dataMin - pad) / 50) * 50)
  const yMax = Math.ceil((dataMax + pad) / 50) * 50

  const x = (period: number) => PAD.left + ((period - 1) / Math.max(1, xMax - 1)) * plotW
  const y = (v: number) => PAD.top + plotH - ((v - yMin) / Math.max(1, yMax - yMin)) * plotH

  const path = (pts: { period: number; value: number }[]) =>
    pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.period).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ')

  // The demand line runs continuously from history into play: it is ONE series, and
  // drawing it as two would suggest the process changed at month 61.
  const demandPts = [
    ...history.map(h => ({ period: h.period, value: h.demand })),
    ...played.map(p => ({ period: p.period, value: p.actual })),
  ]
  const forecastPts = played.map(p => ({ period: p.period, value: p.forecast }))

  // ── Y ticks: five, on round numbers ────────────────────────────────────────
  const yTicks: number[] = []
  const step = Math.max(50, Math.round((yMax - yMin) / 4 / 50) * 50)
  for (let v = yMin; v <= yMax; v += step) yTicks.push(v)

  // ── Year boundaries (requirement 1) ────────────────────────────────────────
  const years: { year: number; startPeriod: number }[] = []
  for (let p = 1; p <= xMax; p += 12) years.push({ year: Math.floor((p - 1) / 12) + 1, startPeriod: p })

  return (
    <svg
      data-testid="fc-demand-chart"
      viewBox={`0 0 ${W} ${H}`}
      style={{ width: '100%', height: 'auto', display: 'block', fontFamily: typography.fontFamily }}
      role="img"
      aria-label="Monthly demand history, with year boundaries and month labels"
    >
      {/* ── Year boundaries + year labels ─────────────────────────────────── */}
      {years.map(({ year, startPeriod }) => (
        <g key={`yr-${year}`}>
          {startPeriod > 1 && (
            <line
              data-testid={`fc-year-boundary-${year}`}
              x1={x(startPeriod)} x2={x(startPeriod)}
              y1={PAD.top} y2={PAD.top + plotH}
              stroke={BOUNDARY_COLOR} strokeWidth={1}
            />
          )}
          <text
            data-testid={`fc-year-label-${year}`}
            x={x(startPeriod) + 4} y={PAD.top + 12}
            fontSize={11} fill={AXIS_COLOR} fontWeight={600}
          >
            Y{year}
          </text>
        </g>
      ))}

      {/* ── Axes ──────────────────────────────────────────────────────────── */}
      <line x1={PAD.left} x2={PAD.left} y1={PAD.top} y2={PAD.top + plotH} stroke={AXIS_COLOR} />
      <line
        x1={PAD.left} x2={PAD.left + plotW}
        y1={PAD.top + plotH} y2={PAD.top + plotH}
        stroke={AXIS_COLOR}
      />

      {yTicks.map(v => (
        <g key={`y-${v}`}>
          <line x1={PAD.left - 4} x2={PAD.left} y1={y(v)} y2={y(v)} stroke={AXIS_COLOR} />
          <text x={PAD.left - 8} y={y(v) + 4} fontSize={11} fill={colors.textSecondary} textAnchor="end">
            {v.toLocaleString()}
          </text>
        </g>
      ))}

      {/* ── Month labels (requirement 2), thinned to quarters ──────────────── */}
      {Array.from({ length: xMax }, (_, i) => i + 1)
        .filter(p => MONTH_TICKS.includes(((p - 1) % 12) + 1))
        .map(p => (
          <text
            key={`m-${p}`}
            data-testid={`fc-month-tick-${p}`}
            x={x(p)} y={PAD.top + plotH + 15}
            fontSize={10} fill={colors.textSecondary} textAnchor="middle"
          >
            {MONTH_NAMES[((p - 1) % 12)]}
          </text>
        ))}

      {/* ── The TRUE systematic component, instructor-only (see the prop doc) ── */}
      {reference && reference.length > 1 && (
        <path
          data-testid="fc-line-systematic"
          d={path(reference.map(r => ({ period: r.period, value: r.value })))}
          fill="none" stroke={REF_COLOR} strokeWidth={1.5} strokeDasharray="6 4"
        />
      )}

      {/* ── The demand series ──────────────────────────────────────────────── */}
      <path
        data-testid="fc-line-actual"
        d={path(demandPts)}
        fill="none" stroke={ACTUAL_COLOR} strokeWidth={1.75}
      />

      {/* ── The student's forecasts (spec §4) ──────────────────────────────── */}
      {forecastPts.length > 0 && (
        <path
          data-testid="fc-line-forecast"
          d={path(forecastPts)}
          fill="none" stroke={FORECAST_COLOR} strokeWidth={1.75} strokeDasharray="4 3"
        />
      )}
      {forecastPts.map(p => (
        <circle key={`f-${p.period}`} cx={x(p.period)} cy={y(p.value)} r={2.5} fill={FORECAST_COLOR} />
      ))}
      {played.map(p => (
        <circle key={`a-${p.period}`} cx={x(p.period)} cy={y(p.actual)} r={2.5} fill={ACTUAL_COLOR} />
      ))}

      {/* ── Legend ─────────────────────────────────────────────────────────── */}
      <g transform={`translate(${PAD.left + 8}, ${PAD.top + plotH + 34})`}>
        <line x1={0} x2={18} y1={-4} y2={-4} stroke={ACTUAL_COLOR} strokeWidth={2} />
        <text x={24} y={0} fontSize={11} fill={colors.textSecondary}>Actual demand</text>
        {forecastPts.length > 0 && (
          <>
            <line x1={130} x2={148} y1={-4} y2={-4} stroke={FORECAST_COLOR} strokeWidth={2} strokeDasharray="4 3" />
            <text x={154} y={0} fontSize={11} fill={colors.textSecondary}>Your forecasts</text>
          </>
        )}
        {reference && reference.length > 1 && (
          <>
            <line x1={130} x2={148} y1={-4} y2={-4} stroke={REF_COLOR} strokeWidth={1.5} strokeDasharray="6 4" />
            <text x={154} y={0} fontSize={11} fill={colors.textSecondary}>True systematic component</text>
          </>
        )}
      </g>
    </svg>
  )
}
