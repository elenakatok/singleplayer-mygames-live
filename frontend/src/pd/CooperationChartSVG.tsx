import type { PdCooperationPoint, PdStrategy } from './api'
import { strategyColor } from './strategyColors'

// ═══════════════════════════════════════════════════════════════════════════════
// Tier 3a (spec §9) — CLASS COOPERATION RATE PER ROUND, split by the bot faced.
// Hand-rolled inline SVG, the platform house pattern (JarHistogramSVG, PieChartSVG,
// eBay's PriceOverTimeSVG); this family has no shared chart widget and this slice is
// not the place to invent one.
//
// This is THE debrief chart: the lines diverging is the whole lesson. Against
// tit-for-tat the class typically recovers after a defection (the bot forgives);
// against Grim it cannot (the bot never does), so the Grim line decays and stays down.
// Elena projects this next lecture.
//
// ⚠⚠ ONE SERIES PER STRATEGY **ACTUALLY ASSIGNED**, NOT PER STRATEGY IN THE POOL. The
// server decides that set (reportStats `assignedStrategies`) and this renders whatever
// it is handed: a strategy an instructor checked that nobody drew has nothing to plot,
// and giving it a flat empty line plus a legend entry would invite the reading that its
// students all did something. It was two hardcoded series before this pass.
//
// ⚠ EVERY SERIES CARRIES ITS OWN n= IN THE LEGEND, so a three-student series reads as
// thin rather than as a finding. With seven possible series that is the difference
// between a chart and a Rorschach test.
//
// INSTRUCTOR-ONLY — the x-axis IS the drawn round count, which no student may see.
// Reached only through the instructor-authenticated pdGetReport.
//
// A null point (nobody in that group had played that round yet) BREAKS the line
// rather than being drawn as 0%: "no data" and "everybody defected" must not look
// the same. Each series is therefore drawn as one polyline per contiguous run.
// ═══════════════════════════════════════════════════════════════════════════════

/** Contiguous runs of non-null points, so gaps break the line instead of faking a 0%. */
export function runsOf(
  points: readonly PdCooperationPoint[],
  key: PdStrategy,
): { round: number; value: number }[][] {
  const runs: { round: number; value: number }[][] = []
  let current: { round: number; value: number }[] = []
  for (const p of points) {
    const v = p.series.find(s => s.strategy === key)?.rate ?? null
    if (v == null) {
      if (current.length > 0) { runs.push(current); current = [] }
    } else {
      current.push({ round: p.round, value: v })
    }
  }
  if (current.length > 0) runs.push(current)
  return runs
}

/**
 * The series to draw, in server order, each with its label, colour and group size.
 *
 * ⚠ `n` IS THE ROUND-1 DENOMINATOR — the number of students assigned that strategy who
 * played at all. It is the largest n the series ever has (the count is monotone
 * non-increasing as students drop out mid-game), so the legend states the group's
 * size rather than whatever it had thinned to by the last round.
 */
export function seriesOf(
  points: readonly PdCooperationPoint[],
  labels: Record<string, string>,
): { key: PdStrategy; label: string; color: string; n: number }[] {
  if (points.length === 0) return []
  return points[0].series.map(s => ({
    key: s.strategy,
    label: labels[s.strategy] ?? s.strategy,
    color: strategyColor(s.strategy),
    n: s.n,
  }))
}

export function CooperationChartSVG({
  points,
  strategyLabels = {},
}: {
  points: PdCooperationPoint[]
  /** strategy id → display name, resolved SERVER-SIDE against the instance wording.
   *  Defaulted so existing call sites keep compiling; a missing entry falls back to
   *  the raw id rather than to a hardcoded English name. */
  strategyLabels?: Record<string, string>
}) {
  if (points.length === 0) {
    return <p style={{ color: '#94a3b8', margin: 0 }}>No rounds played yet.</p>
  }

  const SERIES = seriesOf(points, strategyLabels)
  // ⚠ The legend wraps. Seven entries at 110px each is 770px, wider than the plot on
  // any screen this is projected on; two hardcoded entries never had to.
  const LEGEND_COLS = 3
  const legendRows = Math.ceil(SERIES.length / LEGEND_COLS)

  const padL = 46, padR = 14, padT = 30 + Math.max(0, legendRows - 1) * 16, padB = 42
  const plotW = Math.max(240, Math.min(560, points.length * 30))
  const plotH = 220
  const W = padL + plotW + padR
  const H = padT + plotH + padB
  const maxRound = points.length

  // x is spread across the rounds; a single round sits in the middle rather than at 0.
  const xOf = (round: number) =>
    padL + (maxRound === 1 ? plotW / 2 : ((round - 1) / (maxRound - 1)) * plotW)
  const yOf = (frac: number) => padT + plotH - frac * plotH

  const yTicks = [0, 0.25, 0.5, 0.75, 1]
  // Thin the x labels so they never collide on a 20-round instance.
  const xEvery = maxRound <= 10 ? 1 : maxRound <= 20 ? 2 : 5

  return (
    <figure style={{ margin: 0 }}>
      <svg
        viewBox={`0 0 ${W} ${H}`} width="100%" style={{ maxWidth: W, fontFamily: 'inherit' }}
        role="img" aria-label="Class cooperation rate per round, by opponent strategy"
        data-testid="pd-cooperation-chart"
      >
        {/* Legend — wrapped, and every entry states its own n=. */}
        <g transform={`translate(${padL}, 14)`} fontSize="12">
          {SERIES.map((s, i) => (
            <g
              key={s.key}
              data-testid={`pd-coop-legend-${s.key}`}
              transform={`translate(${(i % LEGEND_COLS) * 150}, ${Math.floor(i / LEGEND_COLS) * 16})`}
            >
              <line x1={0} y1={-4} x2={16} y2={-4} stroke={s.color} strokeWidth={2.5} />
              <text x={22} y={0} fill="#333">{s.label} (n={s.n})</text>
            </g>
          ))}
        </g>

        {/* Y gridlines + percentage ticks */}
        {yTicks.map(t => (
          <g key={`y${t}`}>
            <line x1={padL} y1={yOf(t)} x2={padL + plotW} y2={yOf(t)} stroke="#eee" />
            <text x={padL - 8} y={yOf(t) + 4} textAnchor="end" fontSize="11" fill="#888">
              {Math.round(t * 100)}%
            </text>
          </g>
        ))}

        {/* Axes */}
        <line x1={padL} y1={padT} x2={padL} y2={padT + plotH} stroke="#ccc" />
        <line x1={padL} y1={padT + plotH} x2={padL + plotW} y2={padT + plotH} stroke="#ccc" />

        {/* X ticks — round numbers */}
        {points.map(p => (
          (p.round === 1 || p.round === maxRound || p.round % xEvery === 0) ? (
            <text key={`x${p.round}`} x={xOf(p.round)} y={padT + plotH + 16} textAnchor="middle" fontSize="11" fill="#888">
              {p.round}
            </text>
          ) : null
        ))}
        <text x={padL + plotW / 2} y={H - 8} textAnchor="middle" fontSize="12" fill="#555">Round</text>

        {/* One polyline group per assigned strategy */}
        {SERIES.map(s => (
          <g key={s.key}>
            {runsOf(points, s.key).map((run, i) => (
              <polyline
                key={i}
                data-testid={`pd-coop-line-${s.key}`}
                points={run.map(p => `${xOf(p.round)},${yOf(p.value)}`).join(' ')}
                fill="none" stroke={s.color} strokeWidth={2.5}
                strokeLinejoin="round" strokeLinecap="round"
              />
            ))}
            {runsOf(points, s.key).flat().map(p => (
              <circle key={`${s.key}-${p.round}`} cx={xOf(p.round)} cy={yOf(p.value)} r={3} fill={s.color} />
            ))}
          </g>
        ))}
      </svg>
      <figcaption style={{ fontSize: '0.78rem', color: '#555', marginTop: '0.4rem', lineHeight: 1.5 }}>
        Share of each group cooperating in each round. The denominator is the students who
        had <strong>played</strong> that round, so a line thins rather than dips when students
        are still mid-game; a gap means nobody in that group had reached that round.
      </figcaption>
    </figure>
  )
}
