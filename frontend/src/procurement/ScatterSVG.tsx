import { useState } from 'react'
import { colors, typography } from '@mygames/game-ui'
import type { ProcurementParams, ProcurementPlayedRow, ProcurementRivalPoint } from './api'

// ═══════════════════════════════════════════════════════════════════════════════
// The §9 scatter — BID (y) against COST (x). Four series:
//
//   1. the 45° line, b = c            — bidding your cost: zero markup, zero profit
//   2. the optimal line, β(c)         — COMPUTED FROM THIS INSTANCE'S CONFIG
//   3. the student's own bids
//   4. the bots' bids                 — TOGGLEABLE, DEFAULT OFF
//
// ⚠⚠ THE OPTIMAL LINE IS COMPUTED FROM CONFIG, NEVER HARDCODED. The lecture's slide
// shows `b = 0.8c + 22`, which is β for the SHIPPED numbers only (θmax = 110, n = 5).
// Writing that constant here would silently falsify the line for every instructor who
// changes the rival range or the bidder count — and the falsification would be invisible,
// because the line would still look like a line. `optimalBid` below takes both from
// `params`.
//
// ⚠ THE BOT SERIES IS THE POINT OF THE CHART, AND IT DEFAULTS TO OFF. The bots bid β
// exactly, so their points land ON the optimal line — the plot DOCUMENTS its own
// benchmark instead of asking a student to take the line on trust. It starts hidden so a
// student reads their OWN pattern first; turning it on is the moment the lesson lands.
//
// ⚠ RIVAL COSTS ARE ON THE X-AXIS OF THAT SERIES, so it renders only when the server
// sent it — and the server sends it only after `finished_at` (getState.ts). `rivals` is
// null the whole time the game is live, and the toggle is simply absent then.
//
// Hand-rolled SVG, as every other chart in this family: no chart library in the bundle,
// and the geometry stays legible.
// ═══════════════════════════════════════════════════════════════════════════════

/** β(c) — the reserve-conditioned equilibrium bid (§5.1), from THIS instance's config.
 *
 *  ⚠ The second numerator term vanishes at the default reserve (r = θmax) and this
 *  collapses to the simple form. It is kept because the reserve is instructor-adjustable:
 *  drop it and the "Optimal" line quietly stops being optimal at every other setting,
 *  which is the one thing this chart exists to assert. See equilibrium.ts. */
export interface OptimalLineSettings {
  /** θmax — the top of the RIVAL cost range, always. Never the player's own max. */
  rivalCostMax: number
  reserve: number
  /** n = rivalCount + 1. Off-by-one here moves every reference line in the game. */
  totalBidders: number
}

export function optimalBid(c: number, params: OptimalLineSettings): number | null {
  const tMax = params.rivalCostMax
  const r = params.reserve
  const n = params.totalBidders
  if (c > r) return null
  if (c >= tMax) return c
  const num = Math.pow(tMax - c, n) - Math.pow(tMax - r, n)
  const den = n * Math.pow(tMax - c, n - 1)
  return c + num / den
}

const W = 520
const H = 400
const PAD = { top: 16, right: 16, bottom: 44, left: 52 }

export function ScatterSVG({
  params,
  history,
  rivals,
}: {
  params: ProcurementParams
  history: ProcurementPlayedRow[]
  /** null until the game is over — the server gates it, not this component. */
  rivals: ProcurementRivalPoint[] | null
}) {
  const [showBots, setShowBots] = useState(false)

  // ── Axes ──────────────────────────────────────────────────────────────────
  // x spans every cost that can appear: the player's range and, once the bots are
  // revealed, theirs. Fixed from CONFIG rather than from the data, so two students'
  // charts are directly comparable and a lucky draw does not rescale the picture.
  const xMin = Math.min(params.playerCostMin, params.rivalCostMin)
  const xMax = Math.max(params.playerCostMax, params.rivalCostMax)
  const yMin = 0
  const yMax = Math.max(params.reserve, xMax)

  const px = (c: number) => PAD.left + ((c - xMin) / (xMax - xMin)) * (W - PAD.left - PAD.right)
  const py = (b: number) => H - PAD.bottom - ((b - yMin) / (yMax - yMin)) * (H - PAD.top - PAD.bottom)

  // ── The two reference lines ───────────────────────────────────────────────
  const fortyFive = `M ${px(xMin)} ${py(xMin)} L ${px(xMax)} ${py(xMax)}`

  // β is a curve, not a straight line, at a lowered reserve — so it is sampled rather
  // than drawn from two endpoints. At the default reserve the samples are collinear and
  // it looks exactly like the straight line the slide shows.
  const optimalPts: string[] = []
  for (let c = xMin; c <= xMax; c += 1) {
    const b = optimalBid(c, params)
    if (b !== null) optimalPts.push(`${px(c)},${py(b)}`)
  }

  const ticks = (lo: number, hi: number) => {
    const step = Math.ceil((hi - lo) / 5 / 10) * 10
    const out: number[] = []
    for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) out.push(v)
    return out
  }

  const c = params.currencyLabel

  return (
    <div>
      <svg
        data-testid="proc-scatter"
        viewBox={`0 0 ${W} ${H}`}
        style={{ width: '100%', maxWidth: `${W}px`, height: 'auto', fontFamily: typography.fontFamily }}
        role="img"
        aria-label={`Your bid against your cost across ${history.length} rounds, with the 45 degree line and the optimal bidding line`}
      >
        {/* axes */}
        <line x1={PAD.left} y1={H - PAD.bottom} x2={W - PAD.right} y2={H - PAD.bottom} stroke={colors.border} />
        <line x1={PAD.left} y1={PAD.top} x2={PAD.left} y2={H - PAD.bottom} stroke={colors.border} />

        {ticks(xMin, xMax).map(v => (
          <g key={`x${v}`}>
            <line x1={px(v)} y1={H - PAD.bottom} x2={px(v)} y2={H - PAD.bottom + 4} stroke={colors.border} />
            <text x={px(v)} y={H - PAD.bottom + 16} textAnchor="middle" fontSize="10" fill={colors.textSecondary}>{v}</text>
          </g>
        ))}
        {ticks(yMin, yMax).map(v => (
          <g key={`y${v}`}>
            <line x1={PAD.left - 4} y1={py(v)} x2={PAD.left} y2={py(v)} stroke={colors.border} />
            <text x={PAD.left - 8} y={py(v) + 3} textAnchor="end" fontSize="10" fill={colors.textSecondary}>{v}</text>
          </g>
        ))}

        <text x={(W + PAD.left) / 2} y={H - 6} textAnchor="middle" fontSize="11" fill={colors.textSecondary}>
          Your cost ({c})
        </text>
        <text x={14} y={(H - PAD.bottom + PAD.top) / 2} textAnchor="middle" fontSize="11" fill={colors.textSecondary}
          transform={`rotate(-90 14 ${(H - PAD.bottom + PAD.top) / 2})`}>
          Bid ({c})
        </text>

        {/* 1 — the 45° line */}
        <path d={fortyFive} stroke={colors.textFaint} strokeWidth={1.5} strokeDasharray="4 3" fill="none" />

        {/* 2 — the optimal line, from config */}
        <polyline
          data-testid="proc-scatter-optimal"
          points={optimalPts.join(' ')}
          stroke={colors.roleC} strokeWidth={2} fill="none"
        />

        {/* 4 — the bots, BEHIND the player's points so they never obscure them */}
        {showBots && rivals !== null && rivals.map((p, i) => (
          <circle
            key={`bot${i}`}
            data-testid="proc-scatter-bot-point"
            cx={px(p.cost)} cy={py(p.bid)} r={3}
            fill={colors.roleD} fillOpacity={0.55}
          />
        ))}

        {/* 3 — the player */}
        {history.map(r => r.yourBid === null ? null : (
          <circle
            key={r.round}
            data-testid="proc-scatter-you-point"
            cx={px(r.yourCost)} cy={py(r.yourBid)} r={5}
            fill={colors.roleA} stroke={colors.white} strokeWidth={1.5}
          />
        ))}
      </svg>

      {/* ── legend ─────────────────────────────────────────────────────────── */}
      <div style={{
        display: 'flex', flexWrap: 'wrap', gap: '0.75rem 1.25rem', alignItems: 'center',
        marginTop: '0.5rem', fontSize: typography.sizeXs, color: colors.textSecondary,
      }}>
        <Key color={colors.roleA} shape="dot" label="Your bids" />
        <Key color={colors.roleC} shape="line" label="Optimal bid" />
        <Key color={colors.textFaint} shape="dash" label="Bid = your cost (no markup)" />
        {rivals !== null && (
          <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', cursor: 'pointer' }}>
            <input
              data-testid="proc-scatter-bot-toggle"
              type="checkbox"
              checked={showBots}
              onChange={e => setShowBots(e.target.checked)}
              style={{ accentColor: colors.roleD }}
            />
            Show the other suppliers’ bids
          </label>
        )}
      </div>

      {showBots && rivals !== null && (
        <p data-testid="proc-scatter-bot-note" style={{
          margin: '0.6rem 0 0', fontSize: typography.sizeXs, color: colors.textSecondary, maxWidth: '34rem',
        }}>
          Every other supplier bid the optimal markup for their own cost, which is why
          their points sit on the green line. The line is not an opinion about what you
          should have done — it is where they actually bid.
        </p>
      )}
    </div>
  )
}

function Key({ color, shape, label }: { color: string; shape: 'dot' | 'line' | 'dash'; label: string }) {
  return (
    <span style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
      <svg width="18" height="10" aria-hidden="true">
        {shape === 'dot'
          ? <circle cx="9" cy="5" r="4" fill={color} />
          : <line x1="0" y1="5" x2="18" y2="5" stroke={color} strokeWidth={2}
              strokeDasharray={shape === 'dash' ? '4 3' : undefined} />}
      </svg>
      {label}
    </span>
  )
}
