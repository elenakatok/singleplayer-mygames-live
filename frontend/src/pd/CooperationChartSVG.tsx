import type { PdCooperationPoint } from './api'

// ═══════════════════════════════════════════════════════════════════════════════
// Tier 3a (spec §9) — CLASS COOPERATION RATE PER ROUND, split by the bot faced.
// Hand-rolled inline SVG, the platform house pattern (JarHistogramSVG, PieChartSVG,
// eBay's PriceOverTimeSVG); this family has no shared chart widget and this slice is
// not the place to invent one.
//
// This is THE debrief chart: two lines diverging is the whole lesson. Against
// tit-for-tat the class typically recovers after a defection (the bot forgives);
// against GRIM it cannot (the bot never does), so the GRIM line decays and stays
// down. Elena projects this next lecture.
//
// INSTRUCTOR-ONLY — the x-axis IS the drawn round count, which no student may see.
// Reached only through the instructor-authenticated pdGetReport.
//
// A null point (nobody in that group had played that round yet) BREAKS the line
// rather than being drawn as 0%: "no data" and "everybody defected" must not look
// the same. Each series is therefore drawn as one polyline per contiguous run.
// ═══════════════════════════════════════════════════════════════════════════════

const TFT_COLOR = '#2563eb'   // blue
const GRIM_COLOR = '#dc2626'  // red

type Series = { key: 'tft' | 'grim'; label: string; color: string }
const SERIES: Series[] = [
  { key: 'tft', label: 'Tit-for-tat', color: TFT_COLOR },
  { key: 'grim', label: 'GRIM', color: GRIM_COLOR },
]

/** Contiguous runs of non-null points, so gaps break the line instead of faking a 0%. */
export function runsOf(
  points: readonly PdCooperationPoint[],
  key: 'tft' | 'grim',
): { round: number; value: number }[][] {
  const runs: { round: number; value: number }[][] = []
  let current: { round: number; value: number }[] = []
  for (const p of points) {
    const v = p[key]
    if (v == null) {
      if (current.length > 0) { runs.push(current); current = [] }
    } else {
      current.push({ round: p.round, value: v })
    }
  }
  if (current.length > 0) runs.push(current)
  return runs
}

export function CooperationChartSVG({ points }: { points: PdCooperationPoint[] }) {
  if (points.length === 0) {
    return <p style={{ color: '#94a3b8', margin: 0 }}>No rounds played yet.</p>
  }

  const padL = 46, padR = 14, padT = 30, padB = 42
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
        {/* Legend */}
        <g transform={`translate(${padL}, 14)`} fontSize="12">
          {SERIES.map((s, i) => (
            <g key={s.key} transform={`translate(${i * 110}, 0)`}>
              <line x1={0} y1={-4} x2={16} y2={-4} stroke={s.color} strokeWidth={2.5} />
              <text x={22} y={0} fill="#333">{s.label}</text>
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

        {/* The two series */}
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
