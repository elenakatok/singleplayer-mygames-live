import { describe, it, expect } from 'vitest'
import { payoffCells } from './PayoffMatrix'
import type { PdPayoffs } from './api'

// The matrix is the one thing on the play screen a student must read correctly to
// play at all, and a transposed cell is invisible in a screenshot review. So the
// config → grid mapping is a pure function with a test, not JSX arithmetic.

const SPEC: PdPayoffs = { both_cooperate: 1, sucker: 15, temptation: 0, both_defect: 10 }

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

  it('is symmetric: your years in a cell are their years in its mirror', () => {
    for (const c of cells) {
      const mirror = at(c.other, c.you)
      expect(c.theirYears).toBe(mirror.yourYears)
    }
  })
})

describe('payoffCells — driven by CONFIG, never hardcoded', () => {
  it('renders whatever four values the instance carries', () => {
    const custom: PdPayoffs = { both_cooperate: 2, sucker: 9, temptation: 1, both_defect: 6 }
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
