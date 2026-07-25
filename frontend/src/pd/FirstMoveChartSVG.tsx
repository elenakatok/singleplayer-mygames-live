import type { PdFirstMoveOutcome, PdMoveLabels } from './api'

// ═══════════════════════════════════════════════════════════════════════════════
// Tier 3b (spec §9) — OUTCOME BY FIRST DECISION, grouped by the bot faced.
// Hand-rolled inline SVG, same house pattern as the cooperation chart.
//
// Two groups on the x-axis (opened by cooperating / opened by defecting), two bars in
// each (tit-for-tat, GRIM). The bar height is the MEAN PAYOFF PER ROUND, so a student
// who stopped early is comparable to one who finished.
//
// NO DIRECTIONAL CLAIM (Slice 5): the unit is configurable, so the chart states what
// the bars measure and leaves whether taller is better to the instructor's framing.
// The contrast it exists to show is between the two strategies, not between good and
// bad: opening with defection lands differently against a bot that forgives than
// against one that never does.
//
// INSTRUCTOR-ONLY: it aggregates the assigned strategy.
// ═══════════════════════════════════════════════════════════════════════════════

const TFT_COLOR = '#2563eb'   // blue
const GRIM_COLOR = '#dc2626'  // red

export function FirstMoveChartSVG({
  outcomes,
  labels,
  unit = 'years',
}: {
  outcomes: PdFirstMoveOutcome[]
  labels: PdMoveLabels
  unit?: string
}) {
  const populated = outcomes.filter(o => o.n > 0 && o.avgYearsPerRound != null)
  if (populated.length === 0) {
    return <p style={{ color: '#94a3b8', margin: 0 }}>No completed games yet.</p>
  }

  const padL = 52, padR = 14, padT = 30, padB = 58
  const plotW = 360
  const plotH = 200
  const W = padL + plotW + padR
  const H = padT + plotH + padB

  // Round the axis up to a sensible tick so the tallest bar never touches the top.
  const maxVal = Math.max(...populated.map(o => o.avgYearsPerRound as number))
  const axisMax = Math.max(1, Math.ceil(maxVal))
  const yOf = (v: number) => padT + plotH - (v / axisMax) * plotH

  const groups: { firstMove: 'C' | 'D'; label: string }[] = [
    { firstMove: 'C', label: `Opened with ${labels.C}` },
    { firstMove: 'D', label: `Opened with ${labels.D}` },
  ]
  const groupW = plotW / groups.length
  const barW = Math.min(56, (groupW - 30) / 2)

  const series: { key: 'tft' | 'grim'; label: string; color: string }[] = [
    { key: 'tft', label: 'Tit-for-tat', color: TFT_COLOR },
    { key: 'grim', label: 'GRIM', color: GRIM_COLOR },
  ]

  const yTicks: number[] = []
  const step = axisMax <= 4 ? 1 : Math.ceil(axisMax / 5)
  for (let v = 0; v <= axisMax; v += step) yTicks.push(v)

  return (
    <figure style={{ margin: 0 }}>
      <svg
        viewBox={`0 0 ${W} ${H}`} width="100%" style={{ maxWidth: W, fontFamily: 'inherit' }}
        role="img" aria-label="Average payoff per round by first decision and opponent strategy"
        data-testid="pd-firstmove-chart"
      >
        {/* Legend */}
        <g transform={`translate(${padL}, 14)`} fontSize="12">
          {series.map((s, i) => (
            <g key={s.key} transform={`translate(${i * 110}, 0)`}>
              <rect x={0} y={-9} width={12} height={12} fill={s.color} />
              <text x={18} y={1} fill="#333">{s.label}</text>
            </g>
          ))}
        </g>

        {/* Y gridlines + ticks */}
        {yTicks.map(v => (
          <g key={`y${v}`}>
            <line x1={padL} y1={yOf(v)} x2={padL + plotW} y2={yOf(v)} stroke="#eee" />
            <text x={padL - 8} y={yOf(v) + 4} textAnchor="end" fontSize="11" fill="#888">{v}</text>
          </g>
        ))}
        <line x1={padL} y1={padT} x2={padL} y2={padT + plotH} stroke="#ccc" />
        <line x1={padL} y1={padT + plotH} x2={padL + plotW} y2={padT + plotH} stroke="#ccc" />

        {/* Bars */}
        {groups.map((g, gi) => {
          const cx = padL + gi * groupW + groupW / 2
          return (
            <g key={g.firstMove}>
              {series.map((s, si) => {
                const o = outcomes.find(x => x.firstMove === g.firstMove && x.strategy === s.key)
                const v = o?.avgYearsPerRound ?? null
                const x = cx - barW - 4 + si * (barW + 8)
                if (v == null) {
                  return (
                    <text key={s.key} x={x + barW / 2} y={padT + plotH - 6} textAnchor="middle" fontSize="10" fill="#bbb">
                      no data
                    </text>
                  )
                }
                return (
                  <g key={s.key}>
                    <rect
                      data-testid={`pd-firstmove-bar-${g.firstMove}-${s.key}`}
                      x={x} y={yOf(v)} width={barW} height={padT + plotH - yOf(v)} fill={s.color}
                    />
                    <text x={x + barW / 2} y={yOf(v) - 5} textAnchor="middle" fontSize="11" fill="#333">
                      {v.toFixed(1)}
                    </text>
                    <text x={x + barW / 2} y={padT + plotH + 14} textAnchor="middle" fontSize="10" fill="#999">
                      n={o?.n ?? 0}
                    </text>
                  </g>
                )
              })}
              <text x={cx} y={padT + plotH + 32} textAnchor="middle" fontSize="12" fill="#555">{g.label}</text>
            </g>
          )
        })}

        {/* Y axis title — what the bars measure. No direction claimed. */}
        <text
          transform={`translate(14, ${padT + plotH / 2}) rotate(-90)`}
          textAnchor="middle" fontSize="11" fill="#555"
        >
          {`Avg ${unit} / round`}
        </text>
      </svg>
      <figcaption style={{ fontSize: '0.78rem', color: '#555', marginTop: '0.4rem', lineHeight: 1.5 }}>
        Mean {unit} per round, grouped by the student&rsquo;s <strong>first</strong> move.
        Per-round means, so students who stopped early stay comparable with those who finished.
      </figcaption>
    </figure>
  )
}
