import { colors, typography } from '@mygames/game-ui'

// ═══════════════════════════════════════════════════════════════════════════════
// THE EXIT-PRICE SCATTER (open §7) — the OPEN format's benchmark chart, and the open
// analogue of deck slide 35. Used by BOTH the student's own results screen (§5.3) and the
// instructor's Tier-3 class chart, so the two cannot disagree in front of a room.
//
// ⚠⚠ THE Y AXIS IS EXIT PRICE, NOT BID, AND THE BENCHMARK IS THE 45° LINE, NOT β.
// β is the SEALED first-price equilibrium. Drawing it here would judge rounds that were
// never played against it — which is exactly the live bug this chart replaces, where the
// sealed chart rendered for open instances and captioned itself "the rivals bid the
// optimal markup every time" over a cloud of early cascade bids that plainly did not.
//
// ⚠⚠ WINNERS AND LOSERS ARE SEPARATE SERIES, AND THE CAPTION SAYS WHY (§7). This is a
// statistical requirement, not a styling one:
//
//   • A LOSER's exit price is a REVEALED stopping point. They stood at that price and
//     declined to beat it. Directly observed.
//   • A WINNER's exit price is CENSORED. The auction ended before anybody pushed them to
//     their limit, so all that is known is that their limit was AT OR BELOW it.
//
// So a winner sits ABOVE the line even when playing perfectly, and pooling the two makes
// a class of good players look like a class of quitters. The flag comes from the server's
// record (`exitCensored`) and is never inferred here from where a point happens to fall.
//
// ⚠ THE 45° LINE IS VISUALLY IDENTICAL TO THE SEALED CHART'S — same dash, same weight,
// same grey (Elena, CP4b). It is the SAME LINE MEANING THE OPPOSITE THING: in the sealed
// chart it is a FLOOR (bid = cost earns nothing), here it is the TARGET (exit = cost is
// perfect play). That contrast is deliberate teaching material and it only works if the
// line looks the same in both.
//
// ⚠ BOTH AXES RUN OVER THE SAME RANGE, so the 45° line renders at a true 45°. On unequal
// axes "exit = cost" draws at some other angle and stops reading as the reference it is.
// ═══════════════════════════════════════════════════════════════════════════════

const W = 680
const H = 620
const PAD = { top: 18, right: 18, bottom: 52, left: 62 }

/** ⚠ Named once. Students are the BLUES — light = lost (revealed), dark = won (censored);
 *  the bots are the single grey-green of the benchmark, because that is what they are. */
const SERIES = {
  lost: colors.infoBannerBorder,   // light blue — revealed stopping points
  won: colors.roleA,               // dark blue  — censored, an upper bound only
  bots: colors.roleC,              // green      — the benchmark, shown being played
  fortyFive: colors.textFaint,
}

export interface ExitPoint {
  cost: number
  exitPrice: number
  /** ⚠ FROM THE RECORD (`exitCensored`), never inferred from the point's position. */
  censored: boolean
}

export function ExitScatterSVG({
  points,
  botExits = [],
  showBots = false,
  min,
  max,
  currencyLabel,
  /** Instructor charts say "every student"; the student's own says "your rounds". */
  subjectLabel,
}: {
  points: ExitPoint[]
  /** Each bot's own cost. ⚠ See the legend note — a bot's LIMIT is its cost exactly. */
  botExits?: number[]
  showBots?: boolean
  min: number
  max: number
  currencyLabel: string
  subjectLabel: string
}) {
  const lo = Math.min(min, max)
  const hi = Math.max(min, max)
  const span = Math.max(1, hi - lo)

  const plotW = W - PAD.left - PAD.right
  const plotH = H - PAD.top - PAD.bottom
  const x = (v: number) => PAD.left + ((v - lo) / span) * plotW
  const y = (v: number) => PAD.top + plotH - ((v - lo) / span) * plotH

  const won = points.filter(p => p.censored)
  const lost = points.filter(p => !p.censored)

  const ticks: number[] = []
  const stepTick = span <= 60 ? 10 : 20
  for (let v = Math.ceil(lo / stepTick) * stepTick; v <= hi; v += stepTick) ticks.push(v)

  return (
    <div style={{ fontFamily: typography.fontFamily }}>
      <svg
        data-testid="proc-exit-scatter"
        viewBox={`0 0 ${W} ${H}`}
        style={{ width: '100%', height: 'auto', maxWidth: W }}
        role="img"
        aria-label={
          `${subjectLabel}: exit price against the bidder's own cost, ${points.length} points, ` +
          'with the 45 degree line where exit price equals cost'
        }
      >
        {/* axes */}
        <line x1={PAD.left} y1={PAD.top} x2={PAD.left} y2={PAD.top + plotH} stroke={colors.borderMid} />
        <line x1={PAD.left} y1={PAD.top + plotH} x2={PAD.left + plotW} y2={PAD.top + plotH} stroke={colors.borderMid} />

        {ticks.map(v => (
          <g key={`t${v}`}>
            <text x={x(v)} y={PAD.top + plotH + 18} textAnchor="middle"
              fontSize="11" fill={colors.textSecondary}>{v}</text>
            <text x={PAD.left - 10} y={y(v) + 4} textAnchor="end"
              fontSize="11" fill={colors.textSecondary}>{v}</text>
          </g>
        ))}

        {/* ⚠ exit = cost. VISUALLY IDENTICAL to the sealed chart's 45° line, deliberately —
            the same line meaning the opposite thing. */}
        <line
          data-testid="proc-exit-45"
          x1={x(lo)} y1={y(lo)} x2={x(hi)} y2={y(hi)}
          stroke={SERIES.fortyFive} strokeDasharray="5 4" strokeWidth={1.5}
        />

        {/* ⚠ The bots sit ON the line by construction — they stop precisely at cost (§7),
            so the benchmark is SHOWN BEING PLAYED rather than asserted. Default off. */}
        {showBots && botExits.map((cost, i) => (
          <circle key={`b${i}`} data-testid="proc-exit-bot"
            cx={x(cost)} cy={y(cost)} r={2.2} fill={SERIES.bots} opacity={0.55} />
        ))}

        {/* Losers first, winners on top: winners are the smaller, more surprising group. */}
        {lost.map((p, i) => (
          <circle key={`l${i}`} data-testid="proc-exit-lost"
            cx={x(p.cost)} cy={y(p.exitPrice)} r={3.6} fill={SERIES.lost} />
        ))}
        {won.map((p, i) => (
          <circle key={`w${i}`} data-testid="proc-exit-won"
            cx={x(p.cost)} cy={y(p.exitPrice)} r={3.6} fill={SERIES.won} />
        ))}

        <text x={PAD.left + plotW / 2} y={H - 8} textAnchor="middle"
          fontSize="12" fill={colors.textSecondary}>
          Own cost ({currencyLabel})
        </text>
        <text x={14} y={PAD.top + plotH / 2} textAnchor="middle" fontSize="12"
          fill={colors.textSecondary} transform={`rotate(-90 14 ${PAD.top + plotH / 2})`}>
          Exit price ({currencyLabel})
        </text>
      </svg>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '1rem', marginTop: '0.5rem' }}>
        <Key color={SERIES.lost} label={`Stopped bidding — ${lost.length}`} />
        <Key color={SERIES.won} label={`Won the contract — ${won.length}`} />
        {showBots && <Key color={SERIES.bots} label="Simulated suppliers" />}
        <Key kind="line" color={SERIES.fortyFive} label="Exit price = cost" />
      </div>
    </div>
  )
}

/**
 * ⚠⚠ THE CAPTION IS PART OF THE CHART, not decoration. §7 requires the report to SAY that
 * winners are censored; a reader who does not know it will read the dark points as the
 * class's worst quitters when they are its best bidders.
 *
 * Exported so the student screen and the instructor report print the same words.
 */
export function ExitScatterCaption({ subject }: { subject: 'class' | 'you' }) {
  const who = subject === 'class' ? 'A student' : 'You'
  const they = subject === 'class' ? 'they' : 'you'
  return (
    <div style={{ fontSize: '0.8rem', color: colors.textSecondary, marginTop: '0.6rem', maxWidth: '46rem' }}>
      <p style={{ margin: '0 0 0.4rem' }}>
        <strong>The dashed line is exit price = cost.</strong> Stopping exactly there is
        perfect play: {they} keep undercutting while the next legal bid still clears
        {subject === 'class' ? ' their' : ' your'} cost, and stop when it does not.
        Points <strong>above</strong> the line quit early and left money unclaimed.
        {' '}<strong>Nothing can sit below it:</strong> no bidder in this auction may bid
        below their own cost, so the region under the line is unreachable by construction
        rather than merely empty.
      </p>
      <p data-testid="proc-exit-censored-note" style={{ margin: 0 }}>
        ⚠ <strong>Winners are plotted separately because their exit price is not a
        stopping point.</strong> {who} who won the contract {subject === 'class' ? 'was' : 'were'}
        {' '}never pushed any lower — the auction ended first — so all the chart knows is that
        {subject === 'class' ? ' their' : ' your'} true limit was <em>at or below</em> the
        point shown. A winner therefore sits above the line even when playing perfectly, and
        pooling the two series would make good bidders look like quitters.
      </p>
    </div>
  )
}

function Key({ color, label, kind = 'dot' }: { color: string; label: string; kind?: 'dot' | 'line' }) {
  return (
    <span style={{
      display: 'flex', alignItems: 'center', gap: '0.45rem',
      fontSize: '0.78rem', color: colors.textSecondary,
    }}>
      {kind === 'dot'
        ? <svg width="12" height="12"><circle cx="6" cy="6" r="4" fill={color} /></svg>
        : <svg width="20" height="12"><line x1="0" y1="6" x2="20" y2="6" stroke={color} strokeDasharray="5 4" strokeWidth={1.5} /></svg>}
      {label}
    </span>
  )
}
