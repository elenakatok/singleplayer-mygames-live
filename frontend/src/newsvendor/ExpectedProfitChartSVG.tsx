import { useState } from 'react'
import { STUDENT_COLOR, COMPETITOR_COLOR } from '../shared/RoundSeriesChartSVG'
import {
  buildCurves, orderRange, regularOptimum, dualOptimum,
  type ExpectedProfitParams,
} from './expectedProfit'
import { formatMoneyCompact, formatUnits } from './format'

// ═══════════════════════════════════════════════════════════════════════════════
// EXPECTED PROFIT vs ORDER QUANTITY — the analytical comparison chart.
//
// ⚠ NOT the shared RoundSeriesChartSVG, and that is a considered call rather than a
// shortcut. That component plots a DISCRETE round index with a per-round denominator
// row, a point circle per round, and two fixed series; this plots a CONTINUOUS order
// quantity with no denominators, peak markers, and an interactive legend. Bending it to
// cover both would mean adding four new optional behaviours to a component pd and
// pricing — both LIVE — render from. So this is its own file, deliberately speaking the
// same visual language: the same two series colours (imported, not re-picked), the same
// padding, gridline, dashed-reference and caption treatment.
//
// ⚠ NO STUDENT DATA REACHES THIS CHART. Every point is a closed form in the instance's
// config (expectedProfit.ts), so it renders the moment parameters are set — before
// anyone has played, and identically whether the class is empty or finished.
//
// ⚠ INSTRUCTOR-ONLY. The curves peak at Q*, so this is the benchmark drawn in full.
// Reports.tsx is the only importer, and no student screen imports Reports.tsx.
//
// THE LEGEND IS A LECTURE CONTROL, not decoration. On load only the REGULAR line is
// drawn; the dual entry sits greyed and clickable. The instructor presents single
// sourcing, then clicks "Dual sourcing" to reveal that it peaks HIGHER while ordering
// LESS. State is component-local and deliberately NOT persisted — every fresh open
// starts regular-only, so the reveal works the same way in every class.
// ═══════════════════════════════════════════════════════════════════════════════

/** Which series are currently drawn. Local, transient, never persisted. */
type Shown = { regular: boolean; dual: boolean }

export function ExpectedProfitChartSVG({ params }: { params: ExpectedProfitParams }) {
  // ⚠ REGULAR ONLY ON LOAD — the whole point of the toggle (see the header).
  const [shown, setShown] = useState<Shown>({ regular: true, dual: false })

  const points = buildCurves(params)
  if (points.length === 0) {
    return <p style={{ color: '#94a3b8', margin: 0 }}>These parameters produce no order range to plot.</p>
  }

  const reg = regularOptimum(params)
  const dual = dualOptimum(params)
  const { min: qMin, max: qMax } = orderRange(params)

  // ── Geometry, matching the sibling charts ─────────────────────────────────
  const padL = 84, padR = 20, padT = 34, padB = 58
  const plotW = 620, plotH = 260
  const W = padL + plotW + padR
  const H = padT + plotH + padB

  // ⚠ THE Y-DOMAIN SPANS ONLY THE VISIBLE SERIES. Scaling to both while one is hidden
  // would make the regular curve visibly shrink the moment dual is revealed, which
  // reads as the data changing rather than a line being added.
  const visible: number[] = [
    ...(shown.regular ? points.map(p => p.regular) : []),
    ...(shown.dual ? points.map(p => p.dual) : []),
  ]
  const lo = visible.length ? Math.min(...visible) : 0
  const hi = visible.length ? Math.max(...visible) : 1
  const pad = (hi - lo) * 0.08 || 1
  const yLo = lo - pad, yHi = hi + pad
  const ySpan = yHi - yLo || 1

  const xOf = (Q: number) => padL + ((Q - qMin) / (qMax - qMin || 1)) * plotW
  const yOf = (v: number) => padT + plotH - ((v - yLo) / ySpan) * plotH

  const path = (key: 'regular' | 'dual') =>
    points.map(p => `${xOf(p.Q)},${yOf(p[key])}`).join(' ')

  const yTicks = [0, 0.25, 0.5, 0.75, 1].map(f => yLo + f * ySpan)
  const xTickStep = Math.max(1, Math.round((qMax - qMin) / 6))
  const xTicks: number[] = []
  for (let q = qMin; q <= qMax; q += xTickStep) xTicks.push(Math.round(q))

  const toggle = (key: keyof Shown) => setShown(s => ({ ...s, [key]: !s[key] }))

  /** One series' peak marker: a dashed vertical to the curve, a dot, and a label.
   *  Rendered ONLY while its own line is shown — a hidden line leaves nothing behind. */
  const marker = (
    opt: { Qopt: number; peak: number } | null,
    colour: string,
    id: string,
    label: string,
    labelAbove: boolean,
  ) => {
    if (!opt || opt.Qopt < qMin || opt.Qopt > qMax) return null
    const x = xOf(opt.Qopt), y = yOf(opt.peak)
    return (
      <g data-testid={`nv-ep-marker-${id}`}>
        <line
          x1={x} y1={y} x2={x} y2={padT + plotH}
          stroke={colour} strokeWidth={1.5} strokeDasharray="5 4" opacity={0.75}
        />
        <circle cx={x} cy={y} r={4.5} fill={colour} />
        <text
          data-testid={`nv-ep-qopt-${id}`}
          x={x} y={labelAbove ? y - 10 : y + 18}
          textAnchor="middle" fontSize="11" fontWeight={600} fill={colour}
        >
          {label} Q* = {formatUnits(opt.Qopt)}
        </text>
      </g>
    )
  }

  /** A legend entry that toggles its series. Greyed while hidden, always clickable. */
  const legendEntry = (key: keyof Shown, colour: string, text: string, x: number) => {
    const on = shown[key]
    return (
      <g
        data-testid={`nv-ep-legend-${key}`}
        transform={`translate(${x}, 0)`}
        onClick={() => toggle(key)}
        style={{ cursor: 'pointer' }}
        role="button"
        aria-pressed={on}
      >
        {/* A transparent hit area, so the click target is the whole label, not the 2px line. */}
        <rect x={-6} y={-14} width={230} height={20} fill="transparent" />
        <line x1={0} y1={-4} x2={16} y2={-4} stroke={colour} strokeWidth={2.5} opacity={on ? 1 : 0.35} />
        <text x={22} y={0} fontSize="12" fill={on ? '#333' : '#9aa3ad'}>
          {text}{on ? '' : '  (click to show)'}
        </text>
      </g>
    )
  }

  return (
    <figure style={{ margin: 0 }} data-testid="nv-expected-profit">
      <svg
        viewBox={`0 0 ${W} ${H}`} width="100%" style={{ maxWidth: W, fontFamily: 'inherit' }}
        role="img" aria-label="Expected profit by order quantity, single source versus dual sourcing"
        data-testid="nv-ep-chart"
      >
        <g transform={`translate(${padL}, 16)`}>
          {legendEntry('regular', STUDENT_COLOR, 'Single source', 0)}
          {legendEntry('dual', COMPETITOR_COLOR, 'Dual sourcing', 250)}
        </g>

        {yTicks.map((t, i) => (
          <g key={`y${i}`}>
            <line x1={padL} y1={yOf(t)} x2={padL + plotW} y2={yOf(t)} stroke="#eee" />
            <text x={padL - 8} y={yOf(t) + 4} textAnchor="end" fontSize="11" fill="#888">
              {formatMoneyCompact(t)}
            </text>
          </g>
        ))}

        <line x1={padL} y1={padT} x2={padL} y2={padT + plotH} stroke="#ccc" />
        <line x1={padL} y1={padT + plotH} x2={padL + plotW} y2={padT + plotH} stroke="#ccc" />

        {xTicks.map(q => (
          <text key={`x${q}`} x={xOf(q)} y={padT + plotH + 16} textAnchor="middle" fontSize="11" fill="#888">
            {formatUnits(q)}
          </text>
        ))}
        <text x={padL + plotW / 2} y={H - 12} textAnchor="middle" fontSize="12" fill="#555">
          Order quantity Q
        </text>

        {shown.regular && (
          <polyline
            data-testid="nv-ep-line-regular"
            points={path('regular')} fill="none" stroke={STUDENT_COLOR} strokeWidth={2.5}
            strokeLinejoin="round" strokeLinecap="round"
          />
        )}
        {shown.dual && (
          <polyline
            data-testid="nv-ep-line-dual"
            points={path('dual')} fill="none" stroke={COMPETITOR_COLOR} strokeWidth={2.5}
            strokeLinejoin="round" strokeLinecap="round"
          />
        )}

        {shown.regular && marker(reg, STUDENT_COLOR, 'regular', 'Single', true)}
        {shown.dual && marker(dual, COMPETITOR_COLOR, 'dual', 'Dual', true)}
      </svg>

      <figcaption style={{ fontSize: '0.78rem', color: '#555', marginTop: '0.4rem', lineHeight: 1.55 }}>
        Expected profit for every order quantity, computed from this instance&rsquo;s
        parameters alone — no student data, so it is the same curve before and after the
        class plays. The dot on each line is that mode&rsquo;s optimal order Q*.{' '}
        <strong>Click a legend entry to show or hide its line.</strong> Dual sourcing
        starts hidden: present single sourcing first, then reveal it — it peaks{' '}
        <em>higher</em> while ordering <em>less</em>, because the expensive second source
        removes the cost of being caught short.
        {!params.isNormal && (
          <> Demand here is <strong>Uniform</strong>, so the expected shortage uses the
            uniform closed form rather than the normal loss function.</>
        )}
      </figcaption>
    </figure>
  )
}
