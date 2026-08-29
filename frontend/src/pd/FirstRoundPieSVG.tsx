import type { PdFirstRoundSlice, PdMoveLabels } from './api'

// ═══════════════════════════════════════════════════════════════════════════════
// Tier 3c (spec §9) — WHAT THE CLASS CHOSE IN ROUND 1, as a donut.
//
// Hand-rolled inline SVG, the platform house pattern (poll's PieChartSVG, SAA's
// LineChartSVG, eBay's PriceOverTimeSVG). Game folders are independent here, so this
// is pd's own rather than an import across the boundary — the same call kcLock.ts
// records for its shared constant.
//
// ⚠⚠ WHY ROUND 1 DESERVES ITS OWN REPORT. It is the only round every student plays
// with zero information about their opponent: the bot has not moved and its strategy
// is never named. So this is prior disposition — what the class walked in believing —
// and it is the number the lecture's one-shot dominance argument is actually about.
// Tier 3a and 3b cover what happened once students had something to react to.
//
// ⚠⚠ NO RED, NO GREEN, AND THAT IS NOT AN AESTHETIC CHOICE. The game is
// DIRECTION-AGNOSTIC (spec §2): it does not know or state whether a bigger payoff is
// better, and the two moves are POSITIONS with instructor-set wording. Colouring one
// slice green and the other red would assert that one choice is the good one — a claim
// the software refuses to make everywhere else, on a chart Elena projects. Blue and
// amber are distinguishable without implying a verdict.
//
// ⚠ ONE CONSUMER, SO THE PALETTE IS LOCAL. `strategyColors.ts` is shared because two
// charts draw strategies; nothing else draws MOVES. If a second consumer appears, this
// pair moves to a shared module the way that one did — do not pre-emptively hoist it.
//
// INSTRUCTOR-ONLY, like every Tier-3 chart: reached through pdGetReport, which is
// instructor-authenticated.
// ═══════════════════════════════════════════════════════════════════════════════

/** The two move colours. Neutral by construction — see the note above. */
const MOVE_COLOR: Record<'C' | 'D', string> = {
  C: '#2563eb',  // blue
  D: '#d97706',  // amber
}

const CX = 110, CY = 110, R = 100, RINNER = 62

/** One ring segment, from `startA` to `endA` radians. */
function annularSector(startA: number, endA: number): string {
  const x1o = CX + R * Math.cos(startA), y1o = CY + R * Math.sin(startA)
  const x2o = CX + R * Math.cos(endA), y2o = CY + R * Math.sin(endA)
  const x1i = CX + RINNER * Math.cos(endA), y1i = CY + RINNER * Math.sin(endA)
  const x2i = CX + RINNER * Math.cos(startA), y2i = CY + RINNER * Math.sin(startA)
  const large = endA - startA > Math.PI ? 1 : 0
  return `M ${x1o} ${y1o} A ${R} ${R} 0 ${large} 1 ${x2o} ${y2o} `
    + `L ${x1i} ${y1i} A ${RINNER} ${RINNER} 0 ${large} 0 ${x2i} ${y2i} Z`
}

/** A share as a whole-number percentage. Exported for its unit test. */
export function sharePct(n: number, total: number): string {
  return total === 0 ? '—' : `${Math.round((n / total) * 100)}%`
}

export function FirstRoundPieSVG({
  slices,
  labels,
}: {
  slices: PdFirstRoundSlice[]
  labels: PdMoveLabels
}) {
  const total = slices.reduce((s, x) => s + x.n, 0)

  if (total === 0) {
    return <p style={{ color: '#94a3b8', margin: 0 }}>Nobody has played a round yet.</p>
  }

  const label = (m: 'C' | 'D') => (m === 'C' ? labels.C : labels.D)

  // Arcs from the top, clockwise, in the order the server sent — which is always
  // ['C','D'], so the slices never swap places between refreshes.
  let angle = -Math.PI / 2
  const arcs = slices.map((s) => {
    const frac = s.n / total
    const start = angle
    const end = angle + frac * 2 * Math.PI
    angle = end
    return { ...s, frac, start, end }
  })

  // ⚠⚠ THE WHOLE-CIRCLE CASE IS A REAL SVG TRAP, NOT A TIDINESS CONCERN. An arc of
  // exactly 360° has identical start and end points, so the path command draws
  // NOTHING and the chart silently renders empty — precisely when the finding is
  // strongest ("every single student opened the same way"). Drawn as a plain circle
  // instead. `charts.test.tsx` pins it.
  const soleFull = arcs.find(a => a.frac >= 0.9999)

  return (
    <div data-testid="pd-firstround-pie">
      <div style={{ display: 'flex', gap: '1.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
        <svg
          viewBox="0 0 220 220" width="220" height="220" style={{ flexShrink: 0 }}
          role="img" aria-label="Share of the class choosing each option in round 1"
        >
          {soleFull ? (
            <>
              <circle
                data-testid={`pd-firstround-slice-${soleFull.move}`}
                cx={CX} cy={CY} r={R} fill={MOVE_COLOR[soleFull.move]}
              />
              <circle cx={CX} cy={CY} r={RINNER} fill="#fff" />
            </>
          ) : (
            arcs.filter(a => a.frac > 0).map(a => (
              <path
                key={a.move}
                data-testid={`pd-firstround-slice-${a.move}`}
                d={annularSector(a.start, a.end)}
                fill={MOVE_COLOR[a.move]}
              />
            ))
          )}
          <text x={CX} y={CY - 4} textAnchor="middle" fontSize="26" fontWeight="700" fill="#111">
            {total}
          </text>
          <text x={CX} y={CY + 16} textAnchor="middle" fontSize="12" fill="#666">
            {total === 1 ? 'student' : 'students'}
          </text>
        </svg>

        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: '0.45rem', minWidth: 220 }}>
          {slices.map(s => (
            <li
              key={s.move}
              data-testid={`pd-firstround-legend-${s.move}`}
              style={{ display: 'flex', alignItems: 'center', gap: '0.55rem', fontSize: '0.95rem' }}
            >
              <span style={{ width: 14, height: 14, borderRadius: 3, background: MOVE_COLOR[s.move], flexShrink: 0 }} />
              <span style={{ flex: 1 }}>{label(s.move)}</span>
              <span style={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{s.n}</span>
              <span style={{ color: '#666', fontVariantNumeric: 'tabular-nums', minWidth: '3ch', textAlign: 'right' }}>
                {sharePct(s.n, total)}
              </span>
            </li>
          ))}
        </ul>
      </div>

      <p style={{ fontSize: '0.78rem', color: '#555', marginTop: '0.6rem', lineHeight: 1.5 }}>
        Every student&rsquo;s <strong>first</strong> choice, before the opponent had moved
        and before anything about it could be inferred. The denominator is the students
        who have played at least one round.
      </p>
    </div>
  )
}
