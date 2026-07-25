import type { CSSProperties } from 'react'
import { colors, typography } from '@mygames/game-ui'
import type { PdMoveLabels, PdPayoffs } from './api'

// ═══════════════════════════════════════════════════════════════════════════════
// The payoff matrix (spec §2), rendered FROM CONFIG. Every number on screen comes
// from the instance's four payoff values and every word from its two move labels —
// nothing here is hardcoded, so an instructor who changes the matrix changes what
// students read, with no code change.
//
// LAYOUT — the classic split-cell game-theory grid:
//
//                     The other player
//                 Cooperate    Defect
//              ┌────────────┬────────────┐
//              │         1  │         0  │   top-right, RED  = the other player
//    Cooperate │   ╲        │   ╲        │
//   Y          │  1         │ 15         │   bottom-left, BLUE = you
//   o          ├────────────┼────────────┤
//   u          │        15  │        10  │
//       Defect │   ╲        │   ╲        │
//              │  0         │ 10         │
//              └────────────┴────────────┘
//
// Your move picks the ROW, theirs picks the COLUMN, and the cell they meet in is
// split by a diagonal: your payoff below it, theirs above it. Reading your own
// outcome is therefore always the same motion — find your row, read the blue number.
//
// ⚠ NO DIRECTIONAL FRAMING (Slice 5). This component states WHICH NUMBER IS WHOSE and
// nothing else. It does not say whether a bigger number is better, because the game
// no longer knows: the unit is configurable and an instructor may run this with
// points, dollars, or prison years. Whether low is good is their framing to give in
// the room, not a caption the software asserts. The cell-reading explanation stays —
// that is about reading the grid, not about direction.
// ═══════════════════════════════════════════════════════════════════════════════

const YOU_COLOR = colors.roleA        // blue — you
const OTHER_COLOR = colors.errorAction // red  — the other player

/** One cell of the matrix: the years EACH side serves for that pair of moves. */
export interface MatrixCell {
  /** Your move (the row). */
  you: 'C' | 'D'
  /** Their move (the column). */
  other: 'C' | 'D'
  /** Years YOU serve. */
  yourYears: number
  /** Years THEY serve. */
  theirYears: number
}

/**
 * The four cells, in reading order (CC, CD, DC, DD).
 *
 * Pure, exported, and unit-tested: this is the only place the four config values are
 * mapped onto the grid, so a transposed cell is caught by a test rather than by a
 * student misreading the matrix mid-game. The matrix is SYMMETRIC — what a player
 * suffers depends only on (own move, other's move) — which is why `theirYears` is the
 * same lookup with the moves swapped, and cannot drift from `yourYears`.
 */
export function payoffCells(p: PdPayoffs): MatrixCell[] {
  const years = (own: 'C' | 'D', other: 'C' | 'D') =>
    own === 'C' ? (other === 'C' ? p.both_cooperate : p.sucker)
      : (other === 'C' ? p.temptation : p.both_defect)

  const moves: ('C' | 'D')[] = ['C', 'D']
  return moves.flatMap(you =>
    moves.map(other => ({ you, other, yourYears: years(you, other), theirYears: years(other, you) })),
  )
}

const CELL_BORDER = `1px solid ${colors.text}`

const cellStyle: CSSProperties = {
  border: CELL_BORDER,
  padding: 0,
  width: '5.5rem',
  height: '4.25rem',
  // The split — a hairline from top-left to bottom-right, drawn as a background so it
  // scales with the cell instead of needing an SVG overlay per cell.
  background: `linear-gradient(to bottom right, transparent calc(50% - 0.5px), ${colors.borderLight} calc(50% - 0.5px), ${colors.borderLight} calc(50% + 0.5px), transparent calc(50% + 0.5px))`,
}

const colHeadStyle: CSSProperties = {
  padding: '0.15rem 0.4rem',
  fontWeight: 600,
  fontSize: typography.sizeSm,
  color: OTHER_COLOR,
  textAlign: 'center',
}

const rowHeadStyle: CSSProperties = {
  padding: '0.15rem 0.4rem',
  fontWeight: 600,
  fontSize: typography.sizeSm,
  color: YOU_COLOR,
  // Rotated, as in the deck: keeps the row labels out of the horizontal budget so the
  // whole grid still fits a phone screen.
  writingMode: 'vertical-rl',
  transform: 'rotate(180deg)',
  whiteSpace: 'nowrap',
}

export function PayoffMatrix({
  payoffs,
  labels,
  unit = 'years',
}: {
  payoffs: PdPayoffs
  labels: PdMoveLabels
  /** The instance's unit word. Defaulted so existing call sites keep compiling. */
  unit?: string
}) {
  const cells = payoffCells(payoffs)
  const cell = (you: 'C' | 'D', other: 'C' | 'D') =>
    cells.find(c => c.you === you && c.other === other)!

  const renderCell = (you: 'C' | 'D', other: 'C' | 'D') => {
    const c = cell(you, other)
    return (
      <td key={`${you}${other}`} data-testid={`pd-matrix-${you}${other}`} style={cellStyle}>
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%', justifyContent: 'space-between' }}>
          {/* Above the diagonal, right-aligned — THEIR years. */}
          <div style={{ textAlign: 'right', padding: '0.2rem 0.45rem 0', color: OTHER_COLOR, fontWeight: 700 }}>
            {c.theirYears}
          </div>
          {/* Below the diagonal, left-aligned — YOUR years. */}
          <div style={{ textAlign: 'left', padding: '0 0.45rem 0.2rem', color: YOU_COLOR, fontWeight: 700 }}>
            {c.yourYears}
          </div>
        </div>
      </td>
    )
  }

  return (
    <figure data-testid="pd-payoff-matrix" style={{ margin: 0 }}>
      <div style={{ overflowX: 'auto', maxWidth: '100%' }}>
        <table style={{ borderCollapse: 'collapse', fontFamily: typography.fontFamily }}>
          <thead>
            <tr>
              <td />
              <td />
              <th colSpan={2} style={{ ...colHeadStyle, paddingBottom: '0.3rem' }}>The other player</th>
            </tr>
            <tr>
              <td />
              <td />
              <th style={colHeadStyle}>{labels.C}</th>
              <th style={colHeadStyle}>{labels.D}</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <th rowSpan={2} style={{ ...rowHeadStyle, fontSize: typography.sizeTable }}>You</th>
              <th style={rowHeadStyle}>{labels.C}</th>
              {renderCell('C', 'C')}
              {renderCell('C', 'D')}
            </tr>
            <tr>
              <th style={rowHeadStyle}>{labels.D}</th>
              {renderCell('D', 'C')}
              {renderCell('D', 'D')}
            </tr>
          </tbody>
        </table>
      </div>

      {/* Cell-reading only: which number belongs to whom. No claim about direction. */}
      <p style={{ fontSize: typography.sizeXs, color: colors.textSecondary, margin: '0.45rem 0 0', lineHeight: 1.5 }}>
        In each square, the <strong style={{ color: YOU_COLOR }}>blue number (lower left)</strong> is
        the {unit} <strong style={{ color: YOU_COLOR }}>you</strong> get; the{' '}
        <strong style={{ color: OTHER_COLOR }}>red number (upper right)</strong> is the {unit}{' '}
        <strong style={{ color: OTHER_COLOR }}>the other player</strong> gets.
      </p>
    </figure>
  )
}
