import { colors, typography } from '@mygames/game-ui'
import type { ProcurementReport } from './api'

// ═══════════════════════════════════════════════════════════════════════════════
// TIER 3 — THE REVENUE-EQUIVALENCE CHART. Instructor-only, SEALED instances only.
//
// One point per AUCTION (one student, one round). Both axes are PRICES in the same
// units and over the same range, so the dashed diagonal renders at a true 45°.
//
//   x  the OPEN price this auction would have cleared at — the SECOND-LOWEST COST
//      among its active bidders. In a descending clock every bidder drops at their own
//      cost, so the last one standing is the cheapest supplier and the price is where
//      the second-cheapest left. That argument is a dominant-strategy one and holds
//      whatever distributions the costs came from.
//
//   y  (theory)   the SEALED price the same auction would have cleared at if every
//      bidder posted β — the lowest β-bid in the auction, which is β at the lowest cost
//      because β is increasing.
//
//   y  (realised) the student's ACTUAL winning bid, plotted only for auctions they won,
//      at the SAME x. The vertical distance between the two is the chart's whole point.
//
// ⚠⚠ THE DIAGONAL IS A NEUTRAL EQUAL-PRICE GUIDE, **NOT** A REVENUE-EQUIVALENCE LINE,
// AND THAT IS A DELIBERATE DECISION (Elena, 2026-08-12). Revenue equivalence is a
// theorem about a SYMMETRIC independent-private-values auction. This game is
// deliberately asymmetric — the student draws U(10,60) while the four simulated
// suppliers draw U(10,110), so that students win often enough to stay engaged — and the
// bots bid β as though everyone drew U(10,110). Under those settings the equality the
// diagonal would assert simply does not hold: simulated over 400k auctions against the
// shipped β, E[open] = 36.69 and E[sealed] = 40.19, a standing gap of +3.5 ECU (~9.5%).
// The same simulation with all five bidders on U(10,110) closes to 0.28, which is
// rounding — so the theorem is fine, this instance just is not the setting for it.
//
// Labelling the diagonal "revenue equivalence" would therefore put a reference on screen
// that this auction misses by a visible, systematic margin, in the one direction a
// reader would most naturally misread as student behaviour. The CLAIM this chart makes
// instead is the VERTICAL GAP, which is exactly as sound under asymmetry as under
// symmetry: it compares two prices for one auction at known costs and appeals to no
// theorem at all.
//
// ⚠ NOTHING HERE IS RE-DERIVED. Every number plotted is read off a stored field —
// `yourCost`, `yourBid`, `yourEquilibriumBid` and the rivals' `(cost, bid)` — all
// written when they were drawn or computed server-side. β is NOT recomputed on the
// client: a bot's stored `bid` IS β at its cost by construction (§5.1, the bots bid β
// exactly), and the student's β is the server's own `yourEquilibriumBid`, whose type
// says "the SERVER's number — never re-derived on the client". So this file contains no
// second implementation of β to drift against `auction/equilibrium.ts`.
//
// ⚠ SEALED ONLY. `Reports.tsx` gates the tile on the format. An open instance has no
// meaningful sealed counterfactual — what a descending auction would have fetched under
// sealed rules depends on the strategies bidders would have switched to, not on their
// costs alone — so the chart is absent there rather than drawn from numbers that happen
// to typecheck.
// ═══════════════════════════════════════════════════════════════════════════════

const W = 680
const H = 620
const PAD = { top: 18, right: 18, bottom: 52, left: 62 }

const SERIES = {
  /** Green, matching the "optimal / β" hue the sibling class chart already uses. */
  theory: colors.roleC,
  /** Dark blue — the sibling chart's "student won" hue, and these are wins. */
  realised: colors.roleA,
  gap: colors.textSecondary,
  fortyFive: colors.textFaint,
}

/** One auction: what it would have fetched open, and what it would have fetched sealed. */
export interface RevEquivPoint {
  participantId: string
  round: number
  /** x — second-lowest COST among the auction's active bidders. */
  openPrice: number
  /** y — the lowest β-bid in the auction (= β at the lowest cost). */
  sealedPrice: number
  /** y for the realised series — the student's actual winning bid, or null if they
   *  did not win this auction. */
  actualBid: number | null
}

/**
 * Every auction in the instance, as (open price, sealed price, actual winning bid).
 *
 * ⚠ AN "AUCTION" IS ONE STUDENT'S ONE ROUND. Each student faces their own freshly drawn
 * suppliers, so a round number is not shared across students and the pairing is
 * (participantId, round). Flattening on round alone would merge unrelated auctions.
 *
 * ⚠ "SECOND-LOWEST" UNDER A TIE IS THE SECOND ELEMENT OF THE SORTED LIST, not the second
 * DISTINCT value. Two suppliers tied at the cheapest cost means the clock stops at that
 * cost — one of them is still there when the other leaves — so the open price is that
 * value and the auction is perfectly competitive. Taking the second distinct value would
 * invent a higher price than the auction would ever have reached.
 *
 * ⚠ AN AUCTION WITH FEWER THAN TWO ACTIVE BIDDERS IS EXCLUDED, not plotted at the
 * reserve. A bidder whose cost exceeds the reserve makes no bid at all and is absent
 * from `rivalPoints` (server: `toReportRivalPoints` drops a null bid), so at a LOWERED
 * reserve an auction can have one bidder or none. With nobody to undercut them there is
 * no second-lowest cost and no competitive price — the number would be the reserve, an
 * artifact of the setting rather than of the draws. Unreachable at the default reserve,
 * where every cost is at or below it.
 */
export function revenueEquivalencePoints(report: ProcurementReport): RevEquivPoint[] {
  const out: RevEquivPoint[] = []

  for (const row of report.rows) {
    // Index the rivals by round once per student rather than scanning per round.
    const byRound = new Map<number, { cost: number; bid: number }[]>()
    for (const p of row.rivalPoints ?? []) {
      const list = byRound.get(p.round) ?? []
      list.push({ cost: p.cost, bid: p.bid })
      byRound.set(p.round, list)
    }

    for (const r of row.rounds) {
      const rivals = byRound.get(r.round) ?? []

      // The student is a bidder iff they had a bid worth making — which is exactly the
      // condition under which the server computed a β for them.
      const studentActive = r.yourEquilibriumBid !== null
      const costs = [...(studentActive ? [r.yourCost] : []), ...rivals.map(p => p.cost)]
      const betas = [
        ...(studentActive ? [r.yourEquilibriumBid as number] : []),
        ...rivals.map(p => p.bid),
      ]
      if (costs.length < 2) continue

      const sorted = [...costs].sort((a, b) => a - b)
      out.push({
        participantId: row.participantId,
        round: r.round,
        openPrice: sorted[1],
        sealedPrice: Math.min(...betas),
        // ⚠ Only a WIN contributes a realised point. A round the student lost has an
        // actual bid, but it is not a price — nobody paid it.
        actualBid: r.won && r.yourBid !== null ? r.yourBid : null,
      })
    }
  }

  return out
}

export function RevenueEquivalenceSVG({ report }: { report: ProcurementReport }) {
  const points = revenueEquivalencePoints(report)
  const wins = points.filter(p => p.actualBid !== null)

  // Same range on both axes, from the widest band a price can occupy — so the diagonal
  // is a true 45° and a point above it reads as "sealed fetched more" at a glance.
  const lo = report.rivalCostMin
  const hi = Math.max(report.rivalCostMax, report.reserve)

  const px = (v: number) => PAD.left + ((v - lo) / (hi - lo)) * (W - PAD.left - PAD.right)
  const py = (v: number) => H - PAD.bottom - ((v - lo) / (hi - lo)) * (H - PAD.top - PAD.bottom)

  const ticks: number[] = []
  for (let v = Math.ceil(lo / 10) * 10; v <= hi; v += 10) ticks.push(v)

  const c = report.currencyLabel

  // ── EMPTY STATE (no rounds played anywhere) ────────────────────────────────
  if (points.length === 0) {
    return (
      <p data-testid="proc-revequiv-empty" style={{ color: colors.textSecondary, fontSize: '0.85rem' }}>
        No auctions have been played yet — the chart appears once students start bidding.
      </p>
    )
  }

  return (
    <div>
      <svg
        data-testid="proc-revequiv"
        viewBox={`0 0 ${W} ${H}`}
        style={{ width: '100%', maxWidth: `${W}px`, height: 'auto', fontFamily: typography.fontFamily }}
        role="img"
        aria-label={
          `What each auction would have fetched open against sealed: ${points.length} auctions, `
          + `${wins.length} of them won by a student, with an equal-price diagonal`
        }
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
          Open price — second-lowest cost ({c})
        </text>
        <text x={18} y={(H - PAD.bottom + PAD.top) / 2} textAnchor="middle" fontSize="12" fill={colors.textSecondary}
          transform={`rotate(-90 18 ${(H - PAD.bottom + PAD.top) / 2})`}>
          Sealed price ({c})
        </text>

        {/* Equal prices. A GUIDE, not a claim — see the header. */}
        <path
          data-testid="proc-revequiv-diagonal"
          d={`M ${px(lo)} ${py(lo)} L ${px(hi)} ${py(hi)}`}
          stroke={SERIES.fortyFive} strokeWidth={1.5} strokeDasharray="5 4" fill="none"
        />

        {/* ⚠ THE GAP IS DRAWN FIRST AND UNDERNEATH, as a connector rather than a third
            series. It is the quantity the chart exists to show, so it must be visible as
            a LENGTH — two unconnected dots at the same x read as two facts, not as one
            distance. Behind the dots so the endpoints stay crisp. */}
        {wins.map((p, i) => (
          <line
            key={`gap${i}`}
            data-testid="proc-revequiv-gap"
            x1={px(p.openPrice)} y1={py(p.sealedPrice)}
            x2={px(p.openPrice)} y2={py(p.actualBid as number)}
            stroke={SERIES.gap} strokeWidth={1.25} strokeOpacity={0.55}
          />
        ))}

        {points.map((p, i) => (
          <circle
            key={`t${i}`}
            data-testid="proc-revequiv-theory"
            cx={px(p.openPrice)} cy={py(p.sealedPrice)}
            r={3.4} fill={SERIES.theory} fillOpacity={0.75}
          />
        ))}

        {wins.map((p, i) => (
          <circle
            key={`w${i}`}
            data-testid="proc-revequiv-realised"
            cx={px(p.openPrice)} cy={py(p.actualBid as number)}
            r={4.8} fill={SERIES.realised} fillOpacity={0.9}
          />
        ))}
      </svg>

      <div
        data-testid="proc-revequiv-legend"
        style={{
          display: 'flex', flexWrap: 'wrap', gap: '0.4rem 1.5rem',
          marginTop: '0.75rem', maxWidth: '100%',
          fontSize: '0.8rem', color: colors.text,
        }}
      >
        {/* ⚠ THE THEORY SERIES SAYS "WOULD HAVE" IN ITS OWN LABEL. Both series are prices
            on the same axes, so nothing but the wording stops a reader taking the green
            cloud for observed data. */}
        <Key kind="dot" color={SERIES.theory} label="What this auction would have fetched, sealed, if everyone bid β (computed)" />
        <Key kind="dot" color={SERIES.realised} label="What the student actually paid when they won (observed)" big />
        <Key kind="line" color={SERIES.gap} label="The student’s distance from the computed price" />
        <Key kind="dash" color={SERIES.fortyFive} label="Equal prices (open = sealed)" />
      </div>

      <p style={{ marginTop: '0.6rem', fontSize: '0.78rem', color: colors.textSecondary, maxWidth: '46rem' }}>
        <span data-testid="proc-revequiv-n">
          {points.length} auctions · {wins.length} won by a student
        </span>
        {/* ── SPARSE STATE: rounds played, but the student won nothing ────────────
            ⚠ ONE HUMAN AGAINST FOUR SUPPLIERS MEANS MOST AUCTIONS GO TO A BOT, so an
            empty blue series is the ORDINARY case, not a fault. Saying so is what stops
            the chart reading as broken on screen. */}
        {wins.length === 0 && (
          <> · <strong data-testid="proc-revequiv-nowins">
            No student has won an auction yet, so only the computed series is drawn.
          </strong></>
        )}
        {'. '}
        Each green point is one auction priced two ways from the same costs. The dashed
        line is where the two ways agree; it is a reference for reading the chart, not a
        prediction this instance makes — the students draw costs from a narrower range
        than the simulated suppliers, so the two prices are not expected to coincide here.
        {wins.length > 0 && (
          <> The blue points are the {wins.length === 1 ? 'one auction' : `${wins.length} auctions`}
            {' '}a student actually won, at the same open price, so the grey connector is how
            far their bid sat from the computed sealed price.</>
        )}
      </p>
    </div>
  )
}

function Key({ kind, color, label, big }: {
  kind: 'dot' | 'line' | 'dash'; color: string; label: string; big?: boolean
}) {
  return (
    <span style={{
      display: 'flex', alignItems: 'center', gap: '0.45rem',
      minWidth: 0, overflowWrap: 'anywhere',
    }}>
      <svg width="20" height="12" aria-hidden="true" style={{ flexShrink: 0 }}>
        {kind === 'dot'
          ? <circle cx="10" cy="6" r={big ? 4.8 : 3.4} fill={color} />
          : <line x1="0" y1="6" x2="20" y2="6" stroke={color} strokeWidth={kind === 'dash' ? 1.5 : 1.25}
              strokeDasharray={kind === 'dash' ? '5 4' : undefined} />}
      </svg>
      {label}
    </span>
  )
}
