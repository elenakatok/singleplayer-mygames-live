import type { ScorecardPolicyPanel } from './api'

// ═══════════════════════════════════════════════════════════════════════════════
// TIER-3 CHART 4 — THE OPTIMAL POLICY GRID (spec §11, added 08-07). INSTRUCTOR ONLY.
//
// Reproduces lecture slide 6 from the instance's own parameters:
//   x-axis  Period 1…T          (R10 — 1-based, never 0…T−1)
//   y-axis  Score 0…T
//   ■       optimal play takes HIGH effort
//   ○       optimal play takes LOW effort
//   (blank) unreachable — `score > periods played` — simply absent, per spec
//
// ⚠⚠ PANEL ORDER IS LOW LEFT, HIGH RIGHT. The server returns them in that order and this
// component renders them in the order given — it does NOT sort. Spec §11: "Panel order
// matches the slide: low reliability LEFT, high reliability RIGHT. This is a lecture
// asset first; it should drop into the deck without rework." Do not "fix" it to match
// §6.2's text grid, which orders them the other way.
//
// ⚠ TITLES COME FROM THE SERVER, rendered from live config ("Reliability = 40%"). This
// component never composes one from a hardcoded percentage.
//
// ⚠ NEVER RENDERED ON A STUDENT SCREEN. This IS the DP, and spec §5/§10 removed the DP
// from everything students see. It is imported by Reports.tsx and Settings.tsx only.
// ═══════════════════════════════════════════════════════════════════════════════

export function PolicyGridSVG({
  panels, currency,
}: {
  panels: ScorecardPolicyPanel[]
  currency: string
}) {
  return (
    <div style={{ display: 'flex', gap: '2rem', flexWrap: 'wrap' }}>
      {/* ⚠ `.map` over the SERVER'S ORDER. No sort, no reverse. */}
      {panels.map(p => <OnePanel key={p.condition} panel={p} currency={currency} />)}
    </div>
  )
}

function OnePanel({ panel, currency }: { panel: ScorecardPolicyPanel; currency: string }) {
  const rows = panel.cells.length          // scores 0…T
  const cols = panel.cells[0]?.length ?? 0 // periods 1…T
  const cell = 24
  const padL = 28, padB = 26, padT = 4, padR = 4
  const W = padL + cols * cell + padR
  const H = padT + rows * cell + padB

  // Score 0 at the BOTTOM, like the slide.
  const cx = (col: number) => padL + col * cell + cell / 2
  const cy = (score: number) => padT + (rows - 1 - score) * cell + cell / 2

  return (
    <figure style={{ margin: 0 }}>
      <figcaption style={{ fontWeight: 600, marginBottom: '0.25rem' }}>
        {/* ⚠ Server-rendered from live config. */}
        {panel.title}
      </figcaption>
      <div style={{ fontSize: '0.78rem', color: '#666', marginBottom: '0.4rem' }}>
        one point must be worth more than{' '}
        {Number.isFinite(panel.threshold)
          ? `${Math.round(panel.threshold * 100) / 100} ${currency}`
          : '— (effort buys nothing)'}
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="img"
        aria-label={`Optimal policy grid, ${panel.title}`}>
        {/* y-axis: score */}
        {panel.cells.map((_, score) => (
          score % 2 === 0 && (
            <text key={score} x={padL - 6} y={cy(score) + 3.5} textAnchor="end"
              fontSize="10" fill="#777">{score}</text>
          )
        ))}
        {/* x-axis: period — R10, 1…T */}
        {Array.from({ length: cols }, (_, i) => (
          <text key={i} x={cx(i)} y={H - padB + 14} textAnchor="middle" fontSize="10" fill="#777">
            {i + 1}
          </text>
        ))}
        <text x={padL + (cols * cell) / 2} y={H - 2} textAnchor="middle" fontSize="10" fill="#555">
          Period
        </text>

        {panel.cells.map((row, score) =>
          row.map((c, col) => {
            // ⚠ Unreachable states are ABSENT, per spec — not greyed, not hatched.
            if (c === null) return null
            const key = `${score}-${col}`
            return c === 'high'
              ? <rect key={key} x={cx(col) - 7} y={cy(score) - 7} width={14} height={14}
                  fill="#1f4e79" rx={2} />
              : <circle key={key} cx={cx(col)} cy={cy(score)} r={6}
                  fill="none" stroke="#8a8a8a" strokeWidth={1.5} />
          }),
        )}
      </svg>
    </figure>
  )
}

/** The legend, rendered once beside the pair. */
export function PolicyGridLegend() {
  return (
    <p style={{ fontSize: '0.8rem', color: '#555', margin: '0.5rem 0 0' }}>
      <svg width="12" height="12" style={{ verticalAlign: 'middle' }}>
        <rect x="0" y="1" width="11" height="11" fill="#1f4e79" rx="2" />
      </svg>{' '}
      optimal play uses <strong>high effort</strong>
      {'   ·   '}
      <svg width="14" height="12" style={{ verticalAlign: 'middle' }}>
        <circle cx="6" cy="6.5" r="5" fill="none" stroke="#8a8a8a" strokeWidth="1.5" />
      </svg>{' '}
      optimal play uses <strong>low effort</strong>
      {'   ·   '}
      blank cells are scores that cannot have been reached by that period.
    </p>
  )
}
