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

/** One series' value at one round, by strategy — the shape moved from four named
 *  fields to a list when the library went from two ids to seven. */
const at = (p: { series: { strategy: Strategy; rate: number | null; n: number }[] }, s: Strategy) =>
  p.series.find(x => x.strategy === s)

describe('cooperationByRound — Tier 3a, one series per ASSIGNED strategy', () => {
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
    expect(r1.series.length).toBe(2)
    expect(at(r1, 'tft')!.rate).toBe(1)      // both TFT students cooperated in round 1
    expect(at(r1, 'grim')!.rate).toBe(0.5)   // g1 cooperated, g2 defected
    expect(at(r2, 'tft')!.rate).toBe(0.5)
    expect(at(r3, 'tft')!.rate).toBe(0)      // both TFT students defected by round 3
    expect(at(r3, 'grim')!.rate).toBe(0.5)
  })

  it('⚠ ONLY ASSIGNED strategies get a series — a checked-but-undrawn one gets none', () => {
    // The pool is not the input; the DATA is. A strategy nobody drew has nothing to
    // plot, and a flat empty line plus a legend entry would read as a finding.
    const pts = cooperationByRound(rows, 3)
    expect(pts.length).toBe(3)
    for (const p of pts) {
      expect(p.series.length).toBe(2)
      expect(p.series.map(s => s.strategy)).toEqual(['tft', 'grim'])
    }
  })

  it('…and a strategy that IS assigned gets one, in library order', () => {
    const withMore = [
      ...rows,
      row('r1', 'random', 'CDC', [1, 1, 1]),
      row('a1', 'alternate', 'CCC', [1, 1, 1]),
    ]
    const pts = cooperationByRound(withMore, 3)
    expect(pts.length).toBe(3)
    // STRATEGIES order is tft, grim, random, always_first, always_second, alternate —
    // so the present four come out in that relative order.
    expect(pts[0].series.map(s => s.strategy)).toEqual(['tft', 'grim', 'random', 'alternate'])
  })

  it('pads out to the round count with empty points when nobody got that far', () => {
    const pts = cooperationByRound(rows, 5)
    expect(pts).toHaveLength(5)
    expect(pts[4].round).toBe(5)
    expect(pts[4].series.length).toBe(2)
    expect(pts[4].series.every(s => s.rate === null && s.n === 0)).toBe(true)
  })

  it('counts only students who PLAYED that round in the denominator', () => {
    // A student who stopped at round 1 must not drag round 2 toward 0%.
    const withQuitter = [row('t1', 'tft', 'CC', [1, 1]), row('t2', 'tft', 'C', [1])]
    const [r1, r2] = cooperationByRound(withQuitter, 2)
    expect(at(r1, 'tft')).toMatchObject({ rate: 1, n: 2 })
    expect(at(r2, 'tft')).toMatchObject({ rate: 1, n: 1 })   // 100% of the ONE who played it
  })

  it('ignores students with no strategy (never opened the game)', () => {
    const pts = cooperationByRound([...rows, row('never', null, '', [])], 1)
    expect(pts[0].series.length).toBe(2)
    expect(pts[0].series.reduce((a, s) => a + s.n, 0)).toBe(4)
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

  it('an EMPTY roster produces no cells — nobody was assigned anything', () => {
    // ⚠ IT USED TO RETURN FOUR EMPTY CELLS, because the strategy list was the hardcoded
    // pair. The cells are now (group × ASSIGNED strategy), and an empty roster has
    // assigned nothing. The chart already renders "No completed games yet." for this.
    expect(outcomeByFirstMove([])).toEqual([])
  })

  it('returns every (group × assigned strategy) cell in a stable order', () => {
    const out = outcomeByFirstMove(rows)
    expect(out.length).toBe(4)
    expect(out.map(o => `${o.firstMove}-${o.strategy}`)).toEqual(['C-tft', 'C-grim', 'D-tft', 'D-grim'])
  })

  it('⚠ a THIRD assigned strategy gets its own cells — the pair was hardcoded', () => {
    // With the two-id list baked in, a student assigned any of the five new strategies
    // appeared in Tier 1 and in the debrief grouping and had NO bar here at all.
    const out = outcomeByFirstMove([...rows, row('r1', 'random', 'CCC', [1, 1, 1])])
    expect(out.length).toBe(6)
    expect(out.map(o => `${o.firstMove}-${o.strategy}`)).toEqual([
      'C-tft', 'C-grim', 'C-random', 'D-tft', 'D-grim', 'D-random',
    ])
    expect(out.find(o => o.firstMove === 'C' && o.strategy === 'random'))
      .toMatchObject({ avgYearsPerRound: 1, n: 1 })
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
