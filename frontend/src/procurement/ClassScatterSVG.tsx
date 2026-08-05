import { colors, typography } from '@mygames/game-ui'
import { optimalBid } from './ScatterSVG'
import type { ProcurementReport } from './api'

// ═══════════════════════════════════════════════════════════════════════════════
// TIER 3 (§12) — the CLASS scatter. This is the chart Elena presents in lecture.
//
// FOUR POINT SERIES plus TWO REFERENCE LINES:
//
//   students, lost   light blue    the bids that did not win
//   students, won    dark blue     the bids that took the contract
//   rivals, lost     pink          the simulated bidders who were undercut
//   rivals, won      red           the simulated bidders who took the contract
//   optimal line     green         β at each cost, FROM THIS INSTANCE'S CONFIG
//   45° line         dashed grey   bid = cost, which earns nothing
//
// ⚠⚠ THE OPTIMAL LINE IS DERIVED FROM THIS INSTANCE'S OWN CONFIG, through the SAME
// `optimalBid` the student scatter uses. Two instances with a different `reserve`,
// `rivalCostMax` or `rivalCount` get different lines, correctly — a hardcoded
// `0.8c + 22` would still look like a plausible line while being wrong for every one of
// them, in front of a room.
//
// ⚠ THE RIVALS SIT ON THE GREEN LINE BY CONSTRUCTION — they bid β exactly (§5.1). That is
// the chart's whole argument: the benchmark is not asserted, it is where the other
// bidders actually bid. If the red and pink points ever drift off that line, either β or
// the bot rule has changed and one of them is wrong.
//
// ⚠ RIVALS OUTNUMBER STUDENTS FOUR TO ONE, so they are drawn SMALLER and BEHIND. At 16
// students × 8 rounds that is 512 rival points against 128 student ones; drawn at equal
// weight the students disappear into them, and the students are the subject.
//
// ⚠ BOTH AXES RUN 10–110 (Elena, 08-03) — the full rival cost range, on both. Equal
// ranges are what make the 45° line a true 45°: on unequal axes "bid = cost" renders at
// some other angle and stops reading as the reference it is.
// ═══════════════════════════════════════════════════════════════════════════════

const W = 680
const H = 620
const PAD = { top: 18, right: 18, bottom: 52, left: 62 }

/** ⚠ The four series' colours, named once. Students are the BLUES (light = lost, dark =
 *  won), rivals the REDS (pink = lost, red = won) — so the eye separates the two
 *  populations by hue before it reads the legend, and outcome by depth within each. */
const SERIES = {
  studentLost: colors.infoBannerBorder,   // light blue
  studentWon: colors.roleA,               // dark blue
  rivalLost: colors.errorBorder,          // pink
  rivalWon: colors.errorAction,           // red
  optimal: colors.roleC,                  // green
  fortyFive: colors.textFaint,
}

export interface ClassScatterPoint { cost: number; bid: number; won: boolean }

/** Every student bid in the instance, flattened across students and rounds.
 *
 *  ⚠ RESOLVED ROUNDS ONLY, by construction: `rows[].rounds` is the stored history, and a
 *  round is only there once it resolved. A mid-game student contributes what they have
 *  finished — there is no partial row to exclude. */
export function classScatterPoints(report: ProcurementReport): ClassScatterPoint[] {
  const out: ClassScatterPoint[] = []
  for (const row of report.rows) {
    for (const r of row.rounds) {
      if (r.yourBid === null) continue
      out.push({ cost: r.yourCost, bid: r.yourBid, won: r.won })
    }
  }
  return out
}

/** Every simulated rival bid in the instance. */
export function classRivalPoints(report: ProcurementReport): ClassScatterPoint[] {
  const out: ClassScatterPoint[] = []
  for (const row of report.rows) {
    for (const p of row.rivalPoints ?? []) out.push({ cost: p.cost, bid: p.bid, won: p.won })
  }
  return out
}

export function ClassScatterSVG({ report }: { report: ProcurementReport }) {
  const students = classScatterPoints(report)
  const rivals = classRivalPoints(report)

  // ⚠ BOTH AXES 10–110, from the RIVAL range — the widest cost either population can
  // draw from, and the same on both axes so the 45° line renders at 45°.
  const lo = report.rivalCostMin
  const hi = Math.max(report.rivalCostMax, report.reserve)

  const px = (c: number) => PAD.left + ((c - lo) / (hi - lo)) * (W - PAD.left - PAD.right)
  const py = (b: number) => H - PAD.bottom - ((b - lo) / (hi - lo)) * (H - PAD.top - PAD.bottom)

  const line = {
    rivalCostMax: report.rivalCostMax,
    reserve: report.reserve,
    totalBidders: report.totalBidders,
  }
  const optimalPts: string[] = []
  for (let c = lo; c <= hi; c += 1) {
    const b = optimalBid(c, line)
    // Clipped to the plotted band — β above the top of the axis is off-chart, not zero.
    if (b !== null && b >= lo && b <= hi) optimalPts.push(`${px(c)},${py(b)}`)
  }

  const ticks: number[] = []
  for (let v = Math.ceil(lo / 10) * 10; v <= hi; v += 10) ticks.push(v)

  const c = report.currencyLabel

  if (students.length === 0) {
    return (
      <p data-testid="proc-class-scatter-empty" style={{ color: colors.textSecondary, fontSize: '0.85rem' }}>
        No rounds have been played yet — the chart appears once students start bidding.
      </p>
    )
  }

  const dot = (p: ClassScatterPoint, i: number, kind: 'student' | 'rival') => (
    <circle
      key={`${kind}${i}`}
      data-testid={kind === 'student' ? 'proc-class-scatter-point' : 'proc-class-scatter-rival'}
      cx={px(p.cost)} cy={py(p.bid)}
      r={kind === 'student' ? 4.5 : 2.6}
      fill={kind === 'student'
        ? (p.won ? SERIES.studentWon : SERIES.studentLost)
        : (p.won ? SERIES.rivalWon : SERIES.rivalLost)}
      fillOpacity={kind === 'student' ? 0.85 : 0.5}
    />
  )

  return (
    <div>
      <svg
        data-testid="proc-class-scatter"
        viewBox={`0 0 ${W} ${H}`}
        style={{ width: '100%', maxWidth: `${W}px`, height: 'auto', fontFamily: typography.fontFamily }}
        role="img"
        aria-label={`Every bid in the class against the bidder's own cost: ${students.length} student bids and ${rivals.length} simulated rival bids, with the 45 degree line and the optimal bidding line`}
      >
        <line x1={PAD.left} y1={H - PAD.bottom} x2={W - PAD.right} y2={H - PAD.bottom} stroke={colors.border} />
        <line x1={PAD.left} y1={PAD.top} x2={PAD.left} y2={H - PAD.bottom} stroke={colors.border} />

        {ticks.map(v => (
          <g key={`x${v}`}>
            <line x1={px(v)} y1={H - PAD.bottom} x2={px(v)} y2={H - PAD.bottom + 4} stroke={colors.border} />
            <text x={px(v)} y={H - PAD.bottom + 17} textAnchor="middle" fontSize="11" fill={colors.textSecondary}>{v}</text>
          </g>
        ))}
        {ticks.map(v => (
          <g key={`y${v}`}>
            <line x1={PAD.left - 4} y1={py(v)} x2={PAD.left} y2={py(v)} stroke={colors.border} />
            <text x={PAD.left - 8} y={py(v) + 4} textAnchor="end" fontSize="11" fill={colors.textSecondary}>{v}</text>
          </g>
        ))}

        <text x={(W + PAD.left) / 2} y={H - 10} textAnchor="middle" fontSize="12" fill={colors.textSecondary}>
          Bidder’s own cost ({c})
        </text>
        <text x={18} y={(H - PAD.bottom + PAD.top) / 2} textAnchor="middle" fontSize="12" fill={colors.textSecondary}
          transform={`rotate(-90 18 ${(H - PAD.bottom + PAD.top) / 2})`}>
          Bid ({c})
        </text>

        {/* bid = cost — a true 45° because both axes span the same range */}
        <path
          d={`M ${px(lo)} ${py(lo)} L ${px(hi)} ${py(hi)}`}
          stroke={SERIES.fortyFive} strokeWidth={1.5} strokeDasharray="5 4" fill="none"
        />

        {/* ⚠ RIVALS FIRST — behind the students, who are the subject of the chart. */}
        {rivals.map((p, i) => dot(p, i, 'rival'))}

        <polyline
          data-testid="proc-class-scatter-optimal"
          points={optimalPts.join(' ')}
          stroke={SERIES.optimal} strokeWidth={2.5} fill="none"
        />

        {students.map((p, i) => dot(p, i, 'student'))}
      </svg>

      {/* ── The legend ─────────────────────────────────────────────────────────
          ⚠ COMPLETE: every mark on the chart is here, including BOTH lines. A legend
          covering only the dot series leaves the reader to guess what the green line is,
          which is the one thing the chart is arguing.

          ⚠ IT MUST WRAP INSIDE THE MODAL. The first version used a `minmax(210px, 1fr)`
          auto-fit grid, which at the modal's width laid out three columns and pushed the
          longest label ("Bid = cost (no markup, earns nothing)") off the right edge,
          clipped mid-phrase and overlapping the entry beside it. A grid forces every
          column to one width whether the labels fit or not.

          A wrapping FLEX row is the right primitive here: items keep their natural width,
          break to the next line when they run out of room, and each entry stays whole.
          `minWidth: 0` + `overflowWrap` let a long label break rather than push. */}
      <div
        data-testid="proc-class-scatter-legend"
        style={{
          display: 'flex', flexWrap: 'wrap', gap: '0.4rem 1.5rem',
          marginTop: '0.75rem', maxWidth: '100%',
          fontSize: '0.8rem', color: colors.text,
        }}
      >
        <Key kind="dot" color={SERIES.studentWon} label="Student bid — won the contract" />
        <Key kind="dot" color={SERIES.studentLost} label="Student bid — did not win" />
        <Key kind="dot" color={SERIES.rivalWon} label="Simulated rival — won the contract" small />
        <Key kind="dot" color={SERIES.rivalLost} label="Simulated rival — did not win" small />
        <Key kind="line" color={SERIES.optimal} label="Optimal bid at each cost (β)" />
        <Key kind="dash" color={SERIES.fortyFive} label="Bid = cost (no markup, earns nothing)" />
      </div>

      <p style={{ marginTop: '0.6rem', fontSize: '0.78rem', color: colors.textSecondary, maxWidth: '46rem' }}>
        <span data-testid="proc-class-scatter-n">
          {students.length} student bids from {report.rows.filter(r => r.roundsPlayed > 0).length} students
        </span>
        {rivals.length > 0 && <> · {rivals.length} simulated rival bids</>}
        . The rivals bid the optimal markup for their own cost every time, which is why
        they lie along the green line — it is where the other bidders actually bid, not an
        opinion about what anyone should have done.
        {' '}<strong>Nothing sits below the dashed line:</strong> no bidder may bid below
        their own cost, so that region is unreachable by construction rather than empty by
        luck.
      </p>
    </div>
  )
}

function Key({ kind, color, label, small }: {
  kind: 'dot' | 'line' | 'dash'; color: string; label: string; small?: boolean
}) {
  return (
    <span style={{
      display: 'flex', alignItems: 'center', gap: '0.45rem',
      minWidth: 0, overflowWrap: 'anywhere',
    }}>
      <svg width="20" height="12" aria-hidden="true" style={{ flexShrink: 0 }}>
        {kind === 'dot'
          ? <circle cx="10" cy="6" r={small ? 3 : 4.5} fill={color} />
          : <line x1="0" y1="6" x2="20" y2="6" stroke={color} strokeWidth={kind === 'dash' ? 1.5 : 2.5}
              strokeDasharray={kind === 'dash' ? '5 4' : undefined} />}
      </svg>
      {label}
    </span>
  )
}
