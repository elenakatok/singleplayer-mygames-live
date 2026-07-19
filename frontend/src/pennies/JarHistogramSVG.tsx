// ═══════════════════════════════════════════════════════════════════════════════
// Frequency histogram of bids + estimates on a shared dollar axis (spec §8.2,
// Report 1). Hand-rolled inline SVG — the platform house pattern (eBay
// PriceOverTimeSVG, grays PriceHistogramSVG); no chart library. Whole-dollar bins
// (spec §11 open item — the reference shows integer $0–$23 bins). Two visually
// distinct series with a legend.
// ═══════════════════════════════════════════════════════════════════════════════

import { computeHistogram } from './histogram'

const BID_COLOR = '#2563eb'      // blue
const ESTIMATE_COLOR = '#f59e0b' // amber

export function JarHistogramSVG({ bids, estimates }: { bids: number[]; estimates: number[] }) {
  // Bins 0..floor(max) inclusive — the top whole-dollar bar is always included (see
  // histogram.ts; ceil(max) used to drop a value that fell exactly on a whole dollar).
  const { bins, bidCounts, estCounts, maxCount } = computeHistogram(bids, estimates)

  // Layout.
  const padL = 40, padR = 16, padT = 28, padB = 46
  const plotW = Math.max(360, bins.length * 34)
  const plotH = 220
  const W = padL + plotW + padR
  const H = padT + plotH + padB
  const binW = plotW / bins.length
  const barW = Math.max(3, (binW - 6) / 2)

  const xOf = (k: number) => padL + k * binW
  const yOf = (c: number) => padT + plotH - (c / maxCount) * plotH

  // Y ticks (integer counts).
  const yTicks: number[] = []
  const step = Math.max(1, Math.ceil(maxCount / 5))
  for (let c = 0; c <= maxCount; c += step) yTicks.push(c)

  // X tick spacing — avoid crowding when there are many bins.
  const xEvery = bins.length > 24 ? 5 : bins.length > 12 ? 2 : 1

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ maxWidth: W, fontFamily: 'inherit' }} role="img" aria-label="Histogram of bids and estimates">
      {/* Legend */}
      <g transform={`translate(${padL}, 12)`} fontSize="12">
        <rect x={0} y={-9} width={12} height={12} fill={BID_COLOR} />
        <text x={17} y={1} fill="#333">Bids</text>
        <rect x={70} y={-9} width={12} height={12} fill={ESTIMATE_COLOR} />
        <text x={87} y={1} fill="#333">Estimates</text>
      </g>

      {/* Y gridlines + ticks */}
      {yTicks.map(c => (
        <g key={`y${c}`}>
          <line x1={padL} y1={yOf(c)} x2={padL + plotW} y2={yOf(c)} stroke="#eee" />
          <text x={padL - 6} y={yOf(c) + 4} textAnchor="end" fontSize="11" fill="#888">{c}</text>
        </g>
      ))}

      {/* Bars — bids then estimates, side by side within each dollar bin */}
      {bins.map(k => (
        <g key={`b${k}`}>
          <rect x={xOf(k) + 3} y={yOf(bidCounts[k])} width={barW} height={padT + plotH - yOf(bidCounts[k])} fill={BID_COLOR} />
          <rect x={xOf(k) + 3 + barW} y={yOf(estCounts[k])} width={barW} height={padT + plotH - yOf(estCounts[k])} fill={ESTIMATE_COLOR} />
          {k % xEvery === 0 && (
            <text x={xOf(k) + binW / 2} y={padT + plotH + 16} textAnchor="middle" fontSize="10" fill="#888">${k}</text>
          )}
        </g>
      ))}

      {/* Axes */}
      <line x1={padL} y1={padT + plotH} x2={padL + plotW} y2={padT + plotH} stroke="#999" />
      <line x1={padL} y1={padT} x2={padL} y2={padT + plotH} stroke="#999" />
      <text x={padL + plotW / 2} y={H - 8} textAnchor="middle" fontSize="11" fill="#666">Dollars (whole-dollar bins)</text>
    </svg>
  )
}
