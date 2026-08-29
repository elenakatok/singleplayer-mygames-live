import { describe, it, expect } from 'vitest'
import {
  cooperationByRound, outcomeByFirstMove, firstRoundChoices, cooperationRate,
  avgYearsPerRound, type PdGameRow,
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

// ═══════════════════════════════════════════════════════════════════════════════
// Tier 3c — the class's ROUND 1 split (spec §9).
//
// ⚠ POOLED ACROSS STRATEGIES ON PURPOSE. Round 1 is played with zero information
// about the opponent, so the assignment cannot have influenced it — see the note on
// `firstRoundChoices`. These tests pin that pooling rather than treating it as an
// omission somebody should later "fix".
// ═══════════════════════════════════════════════════════════════════════════════

describe('firstRoundChoices — Tier 3c', () => {
  it('counts each move, from the FIRST round only', () => {
    // Hand-counted from the fixture: first moves are C, C, D, D, D → 2 and 3.
    const rows = [
      row('a', 'tft', 'CDD', [1, 1, 1]),
      row('b', 'grim', 'CCC', [1, 1, 1]),
      row('c', 'tft', 'DCC', [1, 1, 1]),
      row('d', 'random', 'D', [1]),
      row('e', 'alternate', 'DDDD', [1, 1, 1, 1]),
    ]
    const out = firstRoundChoices(rows)
    expect(out.length).toBe(2)
    expect(out).toEqual([{ move: 'C', n: 2 }, { move: 'D', n: 3 }])
  })

  it('⚠ LATER ROUNDS DO NOT COUNT — only moves[0]', () => {
    // Every student opens with C and then defects for the rest of the game. A count
    // over all moves would say 1 and 5; over round 1 it says 2 and 0.
    const rows = [
      row('a', 'tft', 'CDDD', [1, 1, 1, 1]),
      row('b', 'grim', 'CDD', [1, 1, 1]),
    ]
    const out = firstRoundChoices(rows)
    expect(out).toEqual([{ move: 'C', n: 2 }, { move: 'D', n: 0 }])
    // …and the fixture really does contain later D moves, so the assertion is not vacuous.
    expect(rows.flatMap(r => [...r.moves]).filter(m => m === 'D').length).toBe(5)
  })

  it('⚠ THE DENOMINATOR IS STUDENTS WHO PLAYED — a no-show counts as nothing', () => {
    const rows = [
      row('played', 'tft', 'C', [1]),
      row('never', 'grim', '', []),
      row('no-strategy-either', null, '', []),
    ]
    const out = firstRoundChoices(rows)
    expect(out.reduce((a, s) => a + s.n, 0)).toBe(1)
    expect(out).toEqual([{ move: 'C', n: 1 }, { move: 'D', n: 0 }])
  })

  it('⚠ POOLS ACROSS STRATEGIES — the split does not depend on who faced what', () => {
    // The same five first moves, reassigned to completely different strategies. Round 1
    // is played before the opponent has moved, so the totals must be identical.
    const moves = ['C', 'C', 'D', 'D', 'D']
    const asOne = moves.map((m, i) => row(`s${i}`, 'tft', m, [1]))
    const asMany = moves.map((m, i) =>
      row(`s${i}`, (['tft', 'grim', 'random', 'always_first', 'alternate'] as const)[i], m, [1]))
    expect(asOne.length).toBe(5)
    expect(firstRoundChoices(asMany)).toEqual(firstRoundChoices(asOne))
    expect(firstRoundChoices(asMany)).toEqual([{ move: 'C', n: 2 }, { move: 'D', n: 3 }])
  })

  it('⚠ BOTH MOVES ARE ALWAYS RETURNED, in a stable order, even at zero', () => {
    // The chart's slice order, colours and legend rows are fixed by this, so they never
    // move between refreshes during a live class.
    for (const rows of [[], [row('a', 'tft', 'C', [1])], [row('b', 'tft', 'D', [1])]]) {
      const out = firstRoundChoices(rows)
      expect(out.length).toBe(2)
      expect(out.map(s => s.move)).toEqual(['C', 'D'])
    }
  })

  it('an empty roster is two zeros, not an empty list', () => {
    expect(firstRoundChoices([])).toEqual([{ move: 'C', n: 0 }, { move: 'D', n: 0 }])
  })

  it('⚠ NEGATIVE CONTROL — the counts DO move when the first moves move', () => {
    // Without this, "always two slices in this order" is satisfiable by a constant.
    const allC = [row('a', 'tft', 'C', [1]), row('b', 'tft', 'C', [1])]
    const allD = [row('a', 'tft', 'D', [1]), row('b', 'tft', 'D', [1])]
    expect(firstRoundChoices(allC)).toEqual([{ move: 'C', n: 2 }, { move: 'D', n: 0 }])
    expect(firstRoundChoices(allD)).toEqual([{ move: 'C', n: 0 }, { move: 'D', n: 2 }])
    expect(firstRoundChoices(allC)).not.toEqual(firstRoundChoices(allD))
  })

  it('the total always equals the number of students who played a round', () => {
    const rows = [
      row('a', 'tft', 'CDD', [1, 1, 1]), row('b', 'grim', 'D', [1]),
      row('c', 'random', 'CC', [1, 1]), row('d', 'tft', '', []),
    ]
    const played = rows.filter(r => r.moves.length > 0).length
    expect(played).toBe(3)
    expect(firstRoundChoices(rows).reduce((a, s) => a + s.n, 0)).toBe(played)
  })
})
