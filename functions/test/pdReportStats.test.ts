import { describe, it, expect } from 'vitest'
import {
  cooperationByRound, outcomeByFirstMove, cooperationRate, avgYearsPerRound, type PdGameRow,
} from '../src/pd/reportStats'
import type { Move, Strategy } from '../src/pd/strategy'

// Pure report-aggregation tests (no emulator). These are the numbers the instructor's
// Tier-3 charts draw, so they are asserted here rather than eyeballed on an SVG.

const row = (id: string, strategy: Strategy | null, moves: string, years: number[]): PdGameRow => ({
  participant_id: id,
  moves: [...moves] as Move[],
  years,
  strategy,
})

describe('cooperationRate / avgYearsPerRound — per-student normalization', () => {
  it('cooperation rate is over rounds PLAYED', () => {
    expect(cooperationRate(row('a', 'tft', 'CCDC', [1, 1, 0, 1]))).toBe(0.75)
    expect(cooperationRate(row('b', 'tft', 'DDDD', [10, 10, 10, 10]))).toBe(0)
  })

  it('is null for a student who never played, not 0 — absence is not defection', () => {
    expect(cooperationRate(row('c', 'grim', '', []))).toBeNull()
    expect(avgYearsPerRound(row('c', 'grim', '', []))).toBeNull()
  })

  it('avg years is per ROUND, so a quitter is comparable to a finisher', () => {
    const quitter = row('q', 'grim', 'CCC', [1, 1, 1])       // 3 years over 3 rounds
    const finisher = row('f', 'grim', 'CCCCCC', [1, 1, 1, 1, 1, 1]) // 6 over 6
    expect(avgYearsPerRound(quitter)).toBe(1)
    expect(avgYearsPerRound(finisher)).toBe(1)
    // A bare total would have called the quitter twice as good.
  })
})

describe('cooperationByRound — Tier 3a, two series', () => {
  const rows = [
    row('t1', 'tft', 'CCD', [1, 1, 0]),
    row('t2', 'tft', 'CDD', [1, 15, 10]),
    row('g1', 'grim', 'CCC', [1, 1, 1]),
    row('g2', 'grim', 'DDD', [0, 10, 10]),
  ]

  it('emits one point per round, up to the instance round count', () => {
    const pts = cooperationByRound(rows, 3)
    expect(pts.map(p => p.round)).toEqual([1, 2, 3])
  })

  it('computes each strategy group separately', () => {
    const [r1, r2, r3] = cooperationByRound(rows, 3)
    expect(r1.tft).toBe(1)      // both TFT students cooperated in round 1
    expect(r1.grim).toBe(0.5)   // g1 cooperated, g2 defected
    expect(r2.tft).toBe(0.5)
    expect(r3.tft).toBe(0)      // both TFT students defected by round 3
    expect(r3.grim).toBe(0.5)
  })

  it('pads out to the round count with empty points when nobody got that far', () => {
    const pts = cooperationByRound(rows, 5)
    expect(pts).toHaveLength(5)
    expect(pts[4]).toMatchObject({ round: 5, tft: null, grim: null, tftN: 0, grimN: 0 })
  })

  it('counts only students who PLAYED that round in the denominator', () => {
    // A student who stopped at round 1 must not drag round 2 toward 0%.
    const withQuitter = [row('t1', 'tft', 'CC', [1, 1]), row('t2', 'tft', 'C', [1])]
    const [r1, r2] = cooperationByRound(withQuitter, 2)
    expect(r1).toMatchObject({ tft: 1, tftN: 2 })
    expect(r2).toMatchObject({ tft: 1, tftN: 1 })   // 100% of the ONE who played it
  })

  it('ignores students with no strategy (never opened the game)', () => {
    const pts = cooperationByRound([...rows, row('never', null, '', [])], 1)
    expect(pts[0].tftN + pts[0].grimN).toBe(4)
  })

  it('returns nothing when the round count is unknown (0)', () => {
    expect(cooperationByRound(rows, 0)).toEqual([])
  })
})

describe('outcomeByFirstMove — Tier 3b, grouped bars', () => {
  const rows = [
    row('t-coop', 'tft', 'CCC', [1, 1, 1]),        // avg 1
    row('t-def', 'tft', 'DCC', [0, 15, 1]),        // avg 5.333…
    row('g-coop', 'grim', 'CCC', [1, 1, 1]),       // avg 1
    row('g-def', 'grim', 'DCC', [0, 15, 15]),      // avg 10
  ]

  it('always returns all four cells in a stable order — bars never move', () => {
    const out = outcomeByFirstMove([])
    expect(out.map(o => `${o.firstMove}-${o.strategy}`)).toEqual(['C-tft', 'C-grim', 'D-tft', 'D-grim'])
    expect(out.every(o => o.n === 0 && o.avgYearsPerRound === null)).toBe(true)
  })

  it('groups by the student’s FIRST move and the strategy they faced', () => {
    const out = outcomeByFirstMove(rows)
    const at = (m: string, s: string) => out.find(o => o.firstMove === m && o.strategy === s)!
    expect(at('C', 'tft')).toMatchObject({ avgYearsPerRound: 1, n: 1 })
    expect(at('C', 'grim')).toMatchObject({ avgYearsPerRound: 1, n: 1 })
    expect(at('D', 'grim')).toMatchObject({ avgYearsPerRound: 10, n: 1 })
    expect(at('D', 'tft')!.avgYearsPerRound).toBeCloseTo(16 / 3, 5)
  })

  it('shows the pedagogy: opening with defection costs more against GRIM than TFT', () => {
    const out = outcomeByFirstMove(rows)
    const dTft = out.find(o => o.firstMove === 'D' && o.strategy === 'tft')!.avgYearsPerRound!
    const dGrim = out.find(o => o.firstMove === 'D' && o.strategy === 'grim')!.avgYearsPerRound!
    expect(dGrim).toBeGreaterThan(dTft)   // the grudge never lifts
  })

  it('excludes students who never played from every cell', () => {
    const out = outcomeByFirstMove([...rows, row('never', 'tft', '', [])])
    expect(out.reduce((a, o) => a + o.n, 0)).toBe(4)
  })
})
