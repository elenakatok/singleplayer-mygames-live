import type { ScorecardRoundPoint, ScorecardGapDistribution } from './api'

// ═══════════════════════════════════════════════════════════════════════════════
// TIER-3 CHARTS 1–3 (spec §11).
//
// ⚠ R8 — EVERY PERCENTAGE IS ROUNDED BEFORE IT REACHES THE SCREEN. 08-07 shipped
// `32.558139534884` to a display.
// ⚠ R10 — AXES ARE 1…N, NEVER 0…N−1. 08-07 shipped a chart labelled "contracts 0–4".
// ⚠ R6 — EXCLUDED POINTS ARE COUNTED FROM THE DATA AND RECONCILED IN THE LEGEND.
// ⚠ NULLS BREAK A LINE, they are never drawn as zero: a round nobody reached is not a
//   round nobody worked, and a flat line at zero is what CORRECT play under low
//   reliability looks like. Conflating the two would fake the finding.
// ═══════════════════════════════════════════════════════════════════════════════

const HIGH = '#1f4e79'
const LOW = '#b06a1f'
const pct = (x: number) => `${Math.round(x * 100)}%`

/** Shared line-chart frame. `series` may contain nulls, which break the path. */
function LineChart({
  series, xLabel, xTicks, width = 420, height = 210, yMax = 1,
}: {
  series: { name: string; color: string; dashed?: boolean; points: (number | null)[] }[]
  xLabel: string
  xTicks: number
  width?: number
  height?: number
  yMax?: number
}) {
  const padL = 38, padB = 34, padT = 8, padR = 10
  const n = xTicks
  const x = (i: number) => padL + (i * (width - padL - padR)) / Math.max(1, n - 1)
  const y = (v: number) => padT + (1 - v / yMax) * (height - padT - padB)

  const path = (pts: (number | null)[]) => {
    const parts: string[] = []
    let open = false
    pts.forEach((v, i) => {
      if (v === null) { open = false; return }
      parts.push(`${open ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`)
      open = true
    })
    return parts.join(' ')
  }

  return (
    <svg viewBox={`0 0 ${width} ${height}`} width="100%" role="img" aria-label={xLabel}>
      {[0, 0.25, 0.5, 0.75, 1].map(g => (
        <g key={g}>
          <line x1={padL} x2={width - padR} y1={y(g * yMax)} y2={y(g * yMax)} stroke="#ececec" />
          <text x={padL - 6} y={y(g * yMax) + 3.5} textAnchor="end" fontSize="10" fill="#777">
            {pct(g * yMax)}
          </text>
        </g>
      ))}
      {/* ⚠ R10 — 1-based tick labels. */}
      {Array.from({ length: n }, (_, i) => (
        (i === 0 || i === n - 1 || (i + 1) % 5 === 0) && (
          <text key={i} x={x(i)} y={height - padB + 15} textAnchor="middle" fontSize="10" fill="#777">
            {i + 1}
          </text>
        )
      ))}
      <text x={padL + (width - padL - padR) / 2} y={height - 6} textAnchor="middle"
        fontSize="10.5" fill="#555">{xLabel}</text>
      {series.map(s => (
        <path key={s.name} d={path(s.points)} fill="none" stroke={s.color}
          strokeWidth={s.dashed ? 2 : 2.5} strokeDasharray={s.dashed ? '5 4' : undefined} />
      ))}
    </svg>
  )
}

function Legend({ items }: { items: { name: string; color: string; dashed?: boolean }[] }) {
  return (
    <p style={{ fontSize: '0.8rem', color: '#555', margin: '0.35rem 0 0' }}>
      {items.map((it, i) => (
        <span key={it.name} style={{ marginRight: '1.2rem' }}>
          <svg width="22" height="8" style={{ verticalAlign: 'middle' }}>
            <line x1="0" y1="4" x2="22" y2="4" stroke={it.color} strokeWidth="2.5"
              strokeDasharray={it.dashed ? '5 4' : undefined} />
          </svg>{' '}
          {it.name}{i < items.length - 1 ? '' : ''}
        </span>
      ))}
    </p>
  )
}

/**
 * CHART 1 — effort by CONTRACT ROUND, two series. Reproduces slide 7.
 *
 * ⚠ PLOTTED AGAINST CONTRACT ROUND, AND THE COUNTERBALANCING IS WHAT MAKES THAT LEGAL
 * (spec §11): under `alternating`, series "high" is the ODD contracts for half the class
 * and the EVEN contracts for the other half. Per-round `n` is shown on both series
 * because a reader must be able to see the two rest on comparable numbers of students.
 */
export function EffortByRoundChart({
  high, low, labelHigh, labelLow, caption,
}: {
  high: ScorecardRoundPoint[]
  low: ScorecardRoundPoint[]
  labelHigh: string
  labelLow: string
  caption: string
}) {
  const nHigh = high.map(p => p.n)
  const nLow = low.map(p => p.n)
  const minN = Math.min(...nHigh.filter(n => n > 0), ...nLow.filter(n => n > 0))
  const maxN = Math.max(...nHigh, ...nLow, 0)

  return (
    <figure style={{ margin: 0, flex: '1 1 26rem' }}>
      <figcaption style={{ fontWeight: 600, marginBottom: '0.3rem' }}>
        Effort by contract round
      </figcaption>
      <LineChart
        xLabel="Contract round"
        xTicks={high.length}
        series={[
          { name: labelHigh, color: HIGH, points: high.map(p => p.rate) },
          { name: labelLow, color: LOW, points: low.map(p => p.rate) },
        ]}
      />
      <Legend items={[{ name: labelHigh, color: HIGH }, { name: labelLow, color: LOW }]} />
      <p style={{ fontSize: '0.78rem', color: '#666', margin: '0.3rem 0 0' }}>
        {/* ⚠ R6 — the denominators are stated, not implied. */}
        Students per round: {minN === maxN ? minN : `${minN}–${maxN}`} on each series.{' '}
        {caption}
      </p>
    </figure>
  )
}

/**
 * CHART 2 — effort by PERIOD within a contract, two series.
 *
 * ⚠ THE DP OVERLAY IS OPTIONAL AND DEFAULT OFF (spec §11, 08-07). It is "useful in
 * lecture to show how far the low-reliability optimum sits (flat near zero), but it is a
 * rhetorical device for the room, not a standard students are held to." Never rendered
 * on a student screen — this component is imported by Reports.tsx only.
 */
export function EffortByPeriodChart({
  high, low, optimalHigh, optimalLow, showOptimal, labelHigh, labelLow, caption,
}: {
  high: (number | null)[]
  low: (number | null)[]
  optimalHigh: number[]
  optimalLow: number[]
  showOptimal: boolean
  labelHigh: string
  labelLow: string
  caption: string
}) {
  const series: { name: string; color: string; dashed?: boolean; points: (number | null)[] }[] = [
    { name: labelHigh, color: HIGH, points: high },
    { name: labelLow, color: LOW, points: low },
  ]
  if (showOptimal) {
    series.push(
      { name: `${labelHigh} — best play`, color: HIGH, dashed: true, points: optimalHigh },
      { name: `${labelLow} — best play`, color: LOW, dashed: true, points: optimalLow },
    )
  }
  return (
    <figure style={{ margin: 0, flex: '1 1 26rem' }}>
      <figcaption style={{ fontWeight: 600, marginBottom: '0.3rem' }}>
        Effort by period within a contract
      </figcaption>
      <LineChart xLabel="Period within a contract" xTicks={high.length} series={series} />
      <Legend items={series.map(s => ({ name: s.name, color: s.color, dashed: s.dashed }))} />
      <p style={{ fontSize: '0.78rem', color: '#666', margin: '0.3rem 0 0' }}>{caption}</p>
    </figure>
  )
}

/**
 * CHART 3 — distribution of the per-student effort gap.
 *
 * ⚠ "A MASS AT ZERO IS THE FINDING" (spec §11), so the zero bucket is called out
 * explicitly rather than left for the eye.
 *
 * ⚠⚠ R6 — EXCLUSIONS ARE COUNTED FROM THE DATA AND RECONCILED IN THE LEGEND. Students
 * with only one condition played have an UNDEFINED gap, not a gap of nought, and are not
 * silently dropped: procurement shipped four "missing" scatter points that were correct
 * all along and only the legend was absent.
 */
export function GapDistributionChart({
  dist, caption,
}: {
  dist: ScorecardGapDistribution
  caption: string
}) {
  const W = 420, H = 210, padL = 32, padB = 40, padT = 8, padR = 8
  const maxCount = Math.max(1, ...dist.bins.map(b => b.count))
  const bw = (W - padL - padR) / dist.bins.length
  const y = (c: number) => padT + (1 - c / maxCount) * (H - padT - padB)

  // ⚠ `maxWidth` MATTERS HERE. The SVG's text is sized in USER UNITS, so a figure that
  // stretches to fill a row scales the axis labels with it — this chart sits alone in its
  // row and rendered at roughly double the size of charts 1 and 2, with 40px axis text.
  // Capping the width keeps all three legible at the same scale.
  return (
    <figure style={{ margin: 0, flex: '1 1 26rem', maxWidth: '34rem' }}>
      <figcaption style={{ fontWeight: 600, marginBottom: '0.3rem' }}>
        Per-student effort gap
      </figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Effort gap distribution">
        {[0, 0.5, 1].map(g => (
          <g key={g}>
            <line x1={padL} x2={W - padR} y1={y(g * maxCount)} y2={y(g * maxCount)} stroke="#ececec" />
            <text x={padL - 5} y={y(g * maxCount) + 3.5} textAnchor="end" fontSize="10" fill="#777">
              {Math.round(g * maxCount)}
            </text>
          </g>
        ))}
        {dist.bins.map((b, i) => {
          // The bucket containing exactly zero — the finding.
          const isZeroBin = b.from <= 0 && b.to > 0
          return (
            <rect key={i} x={padL + i * bw + 1} y={y(b.count)}
              width={Math.max(1, bw - 2)} height={Math.max(0, H - padB - y(b.count))}
              fill={isZeroBin ? '#b06a1f' : '#1f4e79'} opacity={b.count === 0 ? 0.15 : 0.85} />
          )
        })}
        {dist.bins.map((b, i) => (
          (b.from === -1 || b.from === 0 || Math.abs(b.from - 0.5) < 1e-9 || Math.abs(b.from + 0.5) < 1e-9) && (
            <text key={`t${i}`} x={padL + i * bw} y={H - padB + 14} textAnchor="middle"
              fontSize="10" fill="#777">{b.from.toFixed(1)}</text>
          )
        ))}
        <text x={padL + (W - padL - padR) / 2} y={H - 6} textAnchor="middle" fontSize="10.5" fill="#555">
          Effort gap (high-reliability rate − low-reliability rate)
        </text>
      </svg>
      <p style={{ fontSize: '0.78rem', color: '#666', margin: '0.3rem 0 0' }}>
        {/* ⚠⚠ R6 — every student is accounted for: plotted, or excluded with a reason. */}
        <strong>{dist.included}</strong> student{dist.included === 1 ? '' : 's'} plotted
        {dist.atZero > 0 && <> · <strong>{dist.atZero}</strong> with a gap of exactly zero (highlighted)</>}
        {dist.excludedUndefined > 0 && (
          <> · <strong>{dist.excludedUndefined}</strong> excluded — played only one of the two
            conditions, so their gap is undefined rather than zero</>
        )}
        {dist.excludedNoPlay > 0 && (
          <> · <strong>{dist.excludedNoPlay}</strong> excluded — never played</>
        )}
        . {caption}
      </p>
    </figure>
  )
}
