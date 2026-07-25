import { describe, it, expect } from 'vitest'
import { Timestamp } from 'firebase-admin/firestore'
import {
  isMove, parseStoredRounds, studentMoves, totals, toClientHistory, type StoredRound,
} from '../src/pd/rounds'

// Pure round-record tests (no emulator). Runs under `npm test`.

const ts = Timestamp.fromMillis(1_700_000_000_000)

const round = (
  round: number, student_move: 'C' | 'D', bot_move: 'C' | 'D',
  student_years: number, bot_years: number,
): StoredRound => ({ round, student_move, bot_move, student_years, bot_years, played_at: ts })

describe('toClientHistory — the student-facing history', () => {
  it('carries one row per round PLAYED, with running cumulative totals', () => {
    const history = toClientHistory([
      round(1, 'C', 'C', 1, 1),
      round(2, 'D', 'C', 0, 15),
      round(3, 'D', 'D', 10, 10),
    ])
    expect(history.map(h => [h.round, h.studentTotal, h.botTotal])).toEqual([
      [1, 1, 1],
      [2, 1, 16],
      [3, 11, 26],
    ])
  })

  it('emits EXACTLY the whitelisted fields — nothing from storage rides along', () => {
    // The load-bearing leak test (spec §3, §5): a field added to StoredRound later
    // must not appear on the wire just because it was stored.
    const stored = { ...round(1, 'C', 'D', 15, 0), strategy: 'grim', total_rounds: 13 }
    const [row] = toClientHistory([stored as StoredRound])
    expect(Object.keys(row).sort()).toEqual(
      ['botMove', 'botTotal', 'botYears', 'round', 'studentMove', 'studentTotal', 'studentYears'],
    )
    expect(JSON.stringify(row)).not.toContain('grim')
    expect(JSON.stringify(row)).not.toContain('13')
  })

  it('is empty for a student who has not played', () => {
    expect(toClientHistory([])).toEqual([])
  })
})

describe('parseStoredRounds — defensive read', () => {
  it('reads a well-formed array', () => {
    const raw = [round(1, 'C', 'C', 1, 1), round(2, 'D', 'D', 10, 10)]
    expect(parseStoredRounds(raw)).toHaveLength(2)
  })

  it('treats a missing / non-array field as no rounds played', () => {
    expect(parseStoredRounds(undefined)).toEqual([])
    expect(parseStoredRounds(null)).toEqual([])
    expect(parseStoredRounds('rounds')).toEqual([])
  })

  it('stops at the first malformed element, keeping a CONTIGUOUS prefix', () => {
    // A hole would make round n+1 sit at index n−1 and silently shift the whole
    // history; truncating keeps "round k is at index k−1" true for every consumer.
    const raw = [round(1, 'C', 'C', 1, 1), { round: 2, student_move: 'X' }, round(3, 'D', 'D', 10, 10)]
    const parsed = parseStoredRounds(raw)
    expect(parsed.map(r => r.round)).toEqual([1])
  })

  it('rejects an out-of-order round number', () => {
    expect(parseStoredRounds([round(2, 'C', 'C', 1, 1)])).toEqual([])
  })

  it('substitutes a placeholder stamp rather than dropping a round with a bad played_at', () => {
    const raw = [{ ...round(1, 'C', 'C', 1, 1), played_at: 'yesterday' }]
    const parsed = parseStoredRounds(raw)
    expect(parsed).toHaveLength(1)
    expect(parsed[0].played_at.toMillis()).toBe(0)
  })
})

describe('studentMoves + totals', () => {
  const played = [round(1, 'C', 'C', 1, 1), round(2, 'D', 'C', 0, 15), round(3, 'D', 'D', 10, 10)]

  it('studentMoves gives the strategy exactly the student’s own moves, in order', () => {
    expect(studentMoves(played)).toEqual(['C', 'D', 'D'])
  })

  it('totals sums both sides', () => {
    expect(totals(played)).toEqual({ student: 11, bot: 26 })
  })

  it('totals of nothing is zero, not NaN', () => {
    expect(totals([])).toEqual({ student: 0, bot: 0 })
  })
})

describe('isMove', () => {
  it('accepts C and D and nothing else', () => {
    expect(isMove('C')).toBe(true)
    expect(isMove('D')).toBe(true)
    for (const bad of ['c', 'd', '', 'CD', 0, 1, null, undefined, {}]) {
      expect(isMove(bad)).toBe(false)
    }
  })
})
