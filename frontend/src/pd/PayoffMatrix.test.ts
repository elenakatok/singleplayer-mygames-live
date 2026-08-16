import { describe, it, expect } from 'vitest'
import { payoffCells } from './PayoffMatrix'
import type { PdPayoffs } from './api'

// The matrix is the one thing on the play screen a student must read correctly to
// play at all, and a transposed cell is invisible in a screenshot review. So the
// config → grid mapping is a pure function with a test, not JSX arithmetic.

const SPEC: PdPayoffs = {
  you_cc: 1, you_cd: 15, you_dc: 0, you_dd: 10,
  other_cc: 1, other_cd: 0, other_dc: 15, other_dd: 10,
}

describe('payoffCells — spec §2, in years of prison', () => {
  const cells = payoffCells(SPEC)
  const at = (you: 'C' | 'D', other: 'C' | 'D') => cells.find(c => c.you === you && c.other === other)!

  it('covers all four cells in reading order', () => {
    expect(cells.map(c => `${c.you}${c.other}`)).toEqual(['CC', 'CD', 'DC', 'DD'])
  })

  it('both cooperate → 1 each', () => {
    expect(at('C', 'C')).toMatchObject({ yourYears: 1, theirYears: 1 })
  })

  it('you cooperate, they defect → you 15 (the sucker), them 0', () => {
    expect(at('C', 'D')).toMatchObject({ yourYears: 15, theirYears: 0 })
  })

  it('you defect, they cooperate → you 0 (the temptation), them 15', () => {
    expect(at('D', 'C')).toMatchObject({ yourYears: 0, theirYears: 15 })
  })

  it('both defect → 10 each', () => {
    expect(at('D', 'D')).toMatchObject({ yourYears: 10, theirYears: 10 })
  })

  it('the SHIPPED DEFAULTS are symmetric: your value in a cell is theirs in its mirror', () => {
    // ⚠ A PROPERTY OF THIS MATRIX, NOT OF payoffCells. It used to be structural — one
    // lookup fed both halves of every cell. The asymmetric test below is the control.
    for (const c of cells) {
      const mirror = at(c.other, c.you)
      expect(c.theirYears).toBe(mirror.yourYears)
    }
  })
})

describe('⚠ payoffCells — the TRANSPOSITION GUARD, with eight DISTINCT values', () => {
  // Swapping O(C,D) with O(D,C) is the likeliest bug in the four→eight change and is
  // invisible whenever O is the transpose of Y — which it is on the defaults and on
  // every migrated legacy instance. Eight pairwise-distinct values give it somewhere
  // to show. Restoring the old derive (`theirYears: years(other, you)`) fails here.
  const DISTINCT: PdPayoffs = {
    you_cc: 11, you_cd: 12, you_dc: 13, you_dd: 14,
    other_cc: 21, other_cd: 22, other_dc: 23, other_dd: 24,
  }

  it('the fixture really is pairwise distinct', () => {
    const vals = Object.values(DISTINCT)
    expect(vals.length).toBe(8)
    expect(new Set(vals).size).toBe(8)
  })

  it('every value lands in the right half of the right cell', () => {
    const cells = payoffCells(DISTINCT)
    expect(cells.length).toBe(4)
    // Written out by hand from the notation, NOT read back off DISTINCT.
    expect(cells).toEqual([
      { you: 'C', other: 'C', yourYears: 11, theirYears: 21 },
      { you: 'C', other: 'D', yourYears: 12, theirYears: 22 },
      { you: 'D', other: 'C', yourYears: 13, theirYears: 23 },
      { you: 'D', other: 'D', yourYears: 14, theirYears: 24 },
    ])
  })

  it('NEGATIVE CONTROL — swapping O(C,D) with O(D,C) moves the two off-diagonal cells', () => {
    const swapped: PdPayoffs = { ...DISTINCT, other_cd: 23, other_dc: 22 }
    const cells = payoffCells(swapped)
    expect(cells.length).toBe(4)
    expect(cells.find(c => c.you === 'C' && c.other === 'D')!.theirYears).toBe(23)
    expect(cells.find(c => c.you === 'D' && c.other === 'C')!.theirYears).toBe(22)
  })
})

describe('payoffCells — driven by CONFIG, never hardcoded', () => {
  it('renders whatever values the instance carries', () => {
    const custom: PdPayoffs = {
      you_cc: 2, you_cd: 9, you_dc: 1, you_dd: 6,
      other_cc: 2, other_cd: 1, other_dc: 9, other_dd: 6,
    }
    const cells = payoffCells(custom)
    const at = (you: 'C' | 'D', other: 'C' | 'D') => cells.find(c => c.you === you && c.other === other)!
    expect(at('C', 'C').yourYears).toBe(2)
    expect(at('C', 'D').yourYears).toBe(9)
    expect(at('D', 'C').yourYears).toBe(1)
    expect(at('D', 'D').yourYears).toBe(6)
    // …and none of the shipped defaults leaked in.
    expect(cells.flatMap(c => [c.yourYears, c.theirYears])).not.toContain(15)
  })
})
