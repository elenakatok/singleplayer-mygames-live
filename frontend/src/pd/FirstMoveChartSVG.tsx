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

  // ⚠⚠ THE AXIS SPANS ZERO WHEN THE DATA DOES. Payoffs may be NEGATIVE (spec §2 — the
  // "all outcomes ≥ 0" line was a property of the shipped matrix, never a rule), so a
  // mean payoff per round can be below zero and the axis can no longer be assumed to
  // start at 0.
  //
  // ⚠ THIS WAS A REAL BUG, NOT A TIDY-UP. The old scale was `yOf(v) = top + plotH -
  // (v/axisMax)*plotH` with bars drawn as `height = baseline - yOf(v)`. A negative v put
  // yOf BELOW the baseline and made `height` NEGATIVE — and an SVG <rect> with a
  // negative height is invalid and simply does not render. The bar vanished silently:
  // no error, no warning, just a missing bar with its value label floating under the
  // axis. `charts.test.tsx` pins a negative bar's geometry.
  const vals = populated.map(o => o.avgYearsPerRound as number)
  const axisMax = Math.max(1, Math.ceil(Math.max(...vals)))
  const axisMin = Math.min(0, Math.floor(Math.min(...vals)))
  const span = axisMax - axisMin
  const yOf = (v: number) => padT + plotH - ((v - axisMin) / span) * plotH
  /** Where v = 0 sits. Bars grow from here, up or down. */
  const yZero = yOf(0)

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
  const step = span <= 4 ? 1 : Math.ceil(span / 5)
  // ⚠ Walk from axisMin, not from 0 — otherwise a chart whose data is entirely below
  // zero gets a single tick at the top and no gridlines at all.
  for (let v = axisMin; v <= axisMax; v += step) yTicks.push(v)

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
        {/* ⚠ THE ZERO LINE, drawn only when it is not already the baseline — with
            negative values present the bars hang from here, not from the frame. */}
        {axisMin < 0 && (
          <line
            data-testid="pd-firstmove-zeroline"
            x1={padL} y1={yZero} x2={padL + plotW} y2={yZero} stroke="#999" strokeDasharray="3 3"
          />
        )}

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
                // ⚠ ANCHORED AT ZERO, IN BOTH DIRECTIONS. `y` is the higher of the two
                // edges and `height` is their absolute difference, so a negative value
                // draws DOWNWARD from the zero line and the height is never negative.
                const yTop = Math.min(yOf(v), yZero)
                const yBot = Math.max(yOf(v), yZero)
                return (
                  <g key={s.key}>
                    <rect
                      data-testid={`pd-firstmove-bar-${g.firstMove}-${s.key}`}
                      x={x} y={yTop} width={barW} height={yBot - yTop} fill={s.color}
                    />
                    {/* The label sits clear of the bar on whichever side it grew. */}
                    <text x={x + barW / 2} y={v < 0 ? yBot + 13 : yTop - 5} textAnchor="middle" fontSize="11" fill="#333">
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
