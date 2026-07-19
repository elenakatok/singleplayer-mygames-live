import type { McSlice } from './api'

// ═══════════════════════════════════════════════════════════════════════════════
// Poll mc report — a donut chart (spec §7.2). One slice per option IN DEFINED ORDER,
// labeled with option text + count, total votes in the center, distinct colors +
// legend. Hand-rolled inline SVG (platform house pattern) using the SAA/Spectrum
// chart palette — no new palette, no chart library.
// ═══════════════════════════════════════════════════════════════════════════════

// SAA's LineChartSVG palette (games/saa/frontend/src/components/LineChartSVG.tsx).
const PALETTE = ['#1a73e8', '#137333', '#c5221f', '#8a6d00', '#8430ce', '#0b8043', '#d93025', '#e8710a']

const CX = 110, CY = 110, R = 100, RINNER = 62

function annularSector(startA: number, endA: number): string {
  const x1o = CX + R * Math.cos(startA), y1o = CY + R * Math.sin(startA)
  const x2o = CX + R * Math.cos(endA), y2o = CY + R * Math.sin(endA)
  const x1i = CX + RINNER * Math.cos(endA), y1i = CY + RINNER * Math.sin(endA)
  const x2i = CX + RINNER * Math.cos(startA), y2i = CY + RINNER * Math.sin(startA)
  const large = endA - startA > Math.PI ? 1 : 0
  return `M ${x1o} ${y1o} A ${R} ${R} 0 ${large} 1 ${x2o} ${y2o} L ${x1i} ${y1i} A ${RINNER} ${RINNER} 0 ${large} 0 ${x2i} ${y2i} Z`
}

export function PieChartSVG({ slices }: { slices: McSlice[] }) {
  const total = slices.reduce((s, x) => s + x.count, 0)
  const colored = slices.map((s, i) => ({ ...s, color: PALETTE[i % PALETTE.length] }))

  // Build the arcs (skip zero-count slices in the ring; they still appear in the legend).
  let angle = -Math.PI / 2 // start at top
  const arcs = colored.map(s => {
    const frac = total > 0 ? s.count / total : 0
    const start = angle
    const end = angle + frac * 2 * Math.PI
    angle = end
    return { ...s, frac, start, end }
  })
  const soleFull = arcs.find(a => a.frac >= 0.9999) // one option holds every vote

  return (
    <div style={{ display: 'flex', gap: '1.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
      <svg viewBox="0 0 220 220" width="220" height="220" role="img" aria-label="Poll results" style={{ flexShrink: 0 }}>
        {total === 0 ? (
          <>
            <circle cx={CX} cy={CY} r={R} fill="#eef0f2" />
            <circle cx={CX} cy={CY} r={RINNER} fill="#fff" />
          </>
        ) : soleFull ? (
          <>
            <circle cx={CX} cy={CY} r={R} fill={soleFull.color} />
            <circle cx={CX} cy={CY} r={RINNER} fill="#fff" />
          </>
        ) : (
          arcs.filter(a => a.frac > 0).map(a => <path key={a.value} d={annularSector(a.start, a.end)} fill={a.color} />)
        )}
        <text x={CX} y={CY - 4} textAnchor="middle" fontSize="26" fontWeight="700" fill="#111">{total}</text>
        <text x={CX} y={CY + 16} textAnchor="middle" fontSize="12" fill="#666">{total === 1 ? 'vote' : 'votes'}</text>
      </svg>

      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: '0.4rem', minWidth: 180 }}>
        {colored.map(s => (
          <li key={s.value} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.95rem' }}>
            <span style={{ width: 14, height: 14, borderRadius: 3, background: s.color, flexShrink: 0 }} />
            <span style={{ flex: 1 }}>{s.label}</span>
            <span style={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{s.count}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
