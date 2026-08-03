import { colors, typography } from '@mygames/game-ui'
import { optimalBid } from './ScatterSVG'
import type { ProcurementReport } from './api'

// ═══════════════════════════════════════════════════════════════════════════════
// TIER 3 (§12) — the CLASS scatter. Every student's bid against their own cost, with the
// 45° line and the optimal line. This is the chart Elena presents in lecture.
//
// ⚠⚠ THE OPTIMAL LINE IS DERIVED FROM THIS INSTANCE'S OWN CONFIG, through the SAME
// `optimalBid` the student scatter uses. Two instances with a different `reserve`,
// `rivalCostMax` or `rivalCount` get different lines, correctly — a hardcoded
// `0.8c + 22` would still look like a plausible line while being wrong for every one of
// them, and this is the chart a room full of students is looking at.
//
// ⚠ ONE DERIVATION, TWO CHARTS. `optimalBid` is imported rather than reimplemented. A
// second copy here is how the lecture chart and the student chart come to disagree, in
// front of the class, about the very benchmark the lecture is explaining.
//
// ⚠ NO RIVAL COSTS ON THIS CHART, and none in its data (report.ts). §12 asks for
// students' bids against students' costs; the bots are the LINE, not points. Four bot
// points per student per round would outnumber the students 32:1 and bury the pattern
// the chart exists to show — and the report rows carry no rival figure to plot even if
// someone wanted to.
//
// ⚠ POINTS ARE SEMI-TRANSPARENT, NOT SOLID. With 40 students × 8 rounds the interesting
// feature is DENSITY — where the class clusters relative to the line — and solid dots at
// that count read as one dark smear.
// ═══════════════════════════════════════════════════════════════════════════════

const W = 640
const H = 440
const PAD = { top: 16, right: 16, bottom: 46, left: 56 }

export interface ClassScatterPoint {
  cost: number
  bid: number
}

/** Every (cost, bid) pair in the instance, flattened across students and rounds.
 *
 *  ⚠ RESOLVED ROUNDS ONLY, by construction: `rows[].rounds` is the stored history, and a
 *  round exists there only after it resolved. A student who is mid-game contributes the
 *  rounds they have finished and nothing else — there is no partial row to exclude. */
export function classScatterPoints(report: ProcurementReport): ClassScatterPoint[] {
  const out: ClassScatterPoint[] = []
  for (const row of report.rows) {
    for (const r of row.rounds) {
      if (r.yourBid === null) continue
      out.push({ cost: r.yourCost, bid: r.yourBid })
    }
  }
  return out
}

export function ClassScatterSVG({ report }: { report: ProcurementReport }) {
  const points = classScatterPoints(report)

  // Axes from CONFIG, not from the data: two instances of the same assignment must be
  // directly comparable, and a class that happened to draw no low costs must not silently
  // rescale the picture.
  const xMin = report.playerCostMin
  const xMax = report.playerCostMax
  const yMin = 0
  const yMax = Math.max(report.reserve, xMax)

  const px = (c: number) => PAD.left + ((c - xMin) / (xMax - xMin)) * (W - PAD.left - PAD.right)
  const py = (b: number) => H - PAD.bottom - ((b - yMin) / (yMax - yMin)) * (H - PAD.top - PAD.bottom)

  const line = { rivalCostMax: report.rivalCostMax, reserve: report.reserve, totalBidders: report.totalBidders }

  const optimalPts: string[] = []
  for (let c = xMin; c <= xMax; c += 1) {
    const b = optimalBid(c, line)
    if (b !== null) optimalPts.push(`${px(c)},${py(b)}`)
  }

  const ticks = (lo: number, hi: number) => {
    const step = Math.max(1, Math.ceil((hi - lo) / 5 / 10) * 10)
    const out: number[] = []
    for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) out.push(v)
    return out
  }

  const c = report.currencyLabel

  if (points.length === 0) {
    return (
      <p data-testid="proc-class-scatter-empty" style={{ color: colors.textSecondary, fontSize: '0.85rem' }}>
        No rounds have been played yet — the chart appears once students start bidding.
      </p>
    )
  }

  return (
    <div>
      <svg
        data-testid="proc-class-scatter"
        viewBox={`0 0 ${W} ${H}`}
        style={{ width: '100%', maxWidth: `${W}px`, height: 'auto', fontFamily: typography.fontFamily }}
        role="img"
        aria-label={`Every student's bid against their own cost, ${points.length} bids, with the 45 degree line and the optimal bidding line`}
      >
        <line x1={PAD.left} y1={H - PAD.bottom} x2={W - PAD.right} y2={H - PAD.bottom} stroke={colors.border} />
        <line x1={PAD.left} y1={PAD.top} x2={PAD.left} y2={H - PAD.bottom} stroke={colors.border} />

        {ticks(xMin, xMax).map(v => (
          <g key={`x${v}`}>
            <line x1={px(v)} y1={H - PAD.bottom} x2={px(v)} y2={H - PAD.bottom + 4} stroke={colors.border} />
            <text x={px(v)} y={H - PAD.bottom + 16} textAnchor="middle" fontSize="11" fill={colors.textSecondary}>{v}</text>
          </g>
        ))}
        {ticks(yMin, yMax).map(v => (
          <g key={`y${v}`}>
            <line x1={PAD.left - 4} y1={py(v)} x2={PAD.left} y2={py(v)} stroke={colors.border} />
            <text x={PAD.left - 8} y={py(v) + 4} textAnchor="end" fontSize="11" fill={colors.textSecondary}>{v}</text>
          </g>
        ))}

        <text x={(W + PAD.left) / 2} y={H - 8} textAnchor="middle" fontSize="12" fill={colors.textSecondary}>
          Student’s cost ({c})
        </text>
        <text x={16} y={(H - PAD.bottom + PAD.top) / 2} textAnchor="middle" fontSize="12" fill={colors.textSecondary}
          transform={`rotate(-90 16 ${(H - PAD.bottom + PAD.top) / 2})`}>
          Bid ({c})
        </text>

        {/* the 45° line — bid = cost, a guaranteed zero */}
        <path
          d={`M ${px(xMin)} ${py(xMin)} L ${px(xMax)} ${py(xMax)}`}
          stroke={colors.textFaint} strokeWidth={1.5} strokeDasharray="5 4" fill="none"
        />

        {/* the optimal line — from THIS instance's config */}
        <polyline
          data-testid="proc-class-scatter-optimal"
          points={optimalPts.join(' ')}
          stroke={colors.roleC} strokeWidth={2.5} fill="none"
        />

        {points.map((p, i) => (
          <circle
            key={i}
            data-testid="proc-class-scatter-point"
            cx={px(p.cost)} cy={py(p.bid)} r={4}
            fill={colors.roleA} fillOpacity={0.35}
          />
        ))}
      </svg>

      <div style={{
        display: 'flex', flexWrap: 'wrap', gap: '0.75rem 1.5rem',
        marginTop: '0.5rem', fontSize: '0.78rem', color: colors.textSecondary,
      }}>
        <span data-testid="proc-class-scatter-n">{points.length} bids from {report.rows.filter(r => r.roundsPlayed > 0).length} students</span>
        <span>● one bid</span>
        <span style={{ color: colors.roleC }}>— optimal bid at each cost</span>
        <span>- - bid = cost (no markup)</span>
      </div>
    </div>
  )
}
