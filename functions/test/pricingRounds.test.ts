import { describe, it, expect } from 'vitest'
import { Timestamp } from 'firebase-admin/firestore'
import {
  parseStoredRounds, studentPrices, totals, toClientHistory, type StoredRound,
} from '../src/pricing/rounds'
import { clientMarket, phaseOf } from '../src/pricing/clientState'
import { DEFAULT_MARKET } from '../src/pricing/market'

// ═══════════════════════════════════════════════════════════════════════════════
// The round record, the student-facing history, and the two shared client
// whitelists. The tests that matter here are the WHITELIST ones: a field added to
// storage later must not reach a student by accident (spec §4/§5).
// ═══════════════════════════════════════════════════════════════════════════════

const ts = Timestamp.fromMillis(1_700_000_000_000)

function round(n: number, over: Partial<StoredRound> = {}): StoredRound {
  return {
    round: n,
    student_price: 1500,
    competitor_price: 1600,
    effective_price: null,
    student_share: 0.45,
    competitor_share: 0.55,
    student_demand: 85_500,
    competitor_demand: 104_500,
    student_profit: 45_657_000,
    competitor_profit: 73_150_000,
    played_at: ts,
    ...over,
  }
}

describe('parseStoredRounds — a malformed doc degrades, never throws', () => {
  it('reads a well-formed array', () => {
    const parsed = parseStoredRounds([round(1), round(2)])
    expect(parsed).toHaveLength(2)
    expect(parsed[1].round).toBe(2)
  })

  it('a missing / non-array field is an empty history', () => {
    expect(parseStoredRounds(undefined)).toEqual([])
    expect(parseStoredRounds(null)).toEqual([])
    expect(parseStoredRounds('rounds')).toEqual([])
  })

  it('stops at the first bad element, keeping a CONTIGUOUS prefix', () => {
    // Every consumer assumes rounds 1..n with no hole, so a damaged element truncates
    // rather than leaving round 3 sitting where round 2 should be.
    const parsed = parseStoredRounds([round(1), { round: 2, student_price: 'high' }, round(3)])
    expect(parsed).toHaveLength(1)
    expect(parsed[0].round).toBe(1)
  })

  it('rejects an out-of-order round number', () => {
    expect(parseStoredRounds([round(1), round(3)])).toHaveLength(1)
    expect(parseStoredRounds([round(2)])).toHaveLength(0)
  })

  it('accepts a NULL effective price (Standard) and a numeric one (PMG)', () => {
    expect(parseStoredRounds([round(1, { effective_price: null })])[0].effective_price).toBeNull()
    expect(parseStoredRounds([round(1, { effective_price: 1500 })])[0].effective_price).toBe(1500)
  })

  it('reads an ABSENT effective price as null — a doc written before the field existed', () => {
    const legacy: Record<string, unknown> = { ...round(1) }
    delete legacy.effective_price
    expect(parseStoredRounds([legacy])[0].effective_price).toBeNull()
  })

  it('but rejects a WRONG-TYPED effective price', () => {
    expect(parseStoredRounds([round(1, { effective_price: 'min' as unknown as number })])).toHaveLength(0)
  })

  it('accepts a NEGATIVE profit — losing money is a legal outcome', () => {
    expect(parseStoredRounds([round(1, { student_profit: -12_540_000 })])[0].student_profit)
      .toBe(-12_540_000)
  })

  it('substitutes a zero timestamp rather than dropping a round over its stamp', () => {
    const parsed = parseStoredRounds([round(1, { played_at: 'yesterday' as unknown as Timestamp })])
    expect(parsed).toHaveLength(1)
    expect(parsed[0].played_at.toMillis()).toBe(0)
  })
})

describe('studentPrices + totals', () => {
  it('studentPrices is the competitor rule’s ONLY input — the student’s own prices', () => {
    const rounds = [round(1, { student_price: 2000 }), round(2, { student_price: 1400 })]
    expect(studentPrices(rounds)).toEqual([2000, 1400])
  })

  it('totals sum both sides, and handle losses', () => {
    const rounds = [
      round(1, { student_profit: 10, competitor_profit: 100 }),
      round(2, { student_profit: -25, competitor_profit: 50 }),
    ]
    expect(totals(rounds)).toEqual({ student: -15, competitor: 150 })
    expect(totals([])).toEqual({ student: 0, competitor: 0 })
  })
})

describe('toClientHistory — the whitelist (spec §4)', () => {
  const rounds = [
    round(1, { student_profit: 100, student_price: 2000 }),
    round(2, { student_profit: 50, student_price: 1400, effective_price: 1400 }),
  ]
  const history = toClientHistory(rounds)

  it('carries a running total and a running AVERAGE per row', () => {
    expect(history[0].yourTotal).toBe(100)
    expect(history[0].yourAverage).toBe(100)
    expect(history[1].yourTotal).toBe(150)
    expect(history[1].yourAverage).toBe(75)
  })

  it('exposes exactly the twelve student-facing fields — no more', () => {
    expect(Object.keys(history[0]).sort()).toEqual([
      'competitorDemand', 'competitorPrice', 'competitorProfit', 'competitorShare',
      'effectivePrice', 'round',
      'yourAverage', 'yourDemand', 'yourPrice', 'yourProfit', 'yourShare', 'yourTotal',
    ])
  })

  it('⚠ does NOT spread the stored record — a new stored field cannot leak', () => {
    // The exact bug class this guards: someone stores the competitor rule beside the
    // round for a report, and a spread hands it to the student mid-game.
    const contaminated = [
      { ...round(1), competitor_strategy: 'standard-highstart-bestreply', rounds_total: 14 },
    ] as unknown as StoredRound[]
    const out = toClientHistory(contaminated)
    expect(JSON.stringify(out)).not.toContain('strategy')
    expect(JSON.stringify(out)).not.toContain('14')
  })

  it('carries no rounds-remaining and no round count — there is no such field', () => {
    const json = JSON.stringify(history).toLowerCase()
    for (const word of ['remaining', 'total_rounds', 'roundstotal', 'horizon', 'finished']) {
      expect(json).not.toContain(word)
    }
  })

  it('is empty for a student who has played nothing', () => {
    expect(toClientHistory([])).toEqual([])
  })
})

describe('clientMarket — the price-entry screen’s fields, and only those', () => {
  const m = clientMarket(DEFAULT_MARKET)

  it('sends both firms’ base shares and unit costs (the case gives students both)', () => {
    expect(m.studentBaseShare).toBe(0.35)
    expect(m.competitorBaseShare).toBe(0.65)
    expect(m.studentUnitCost).toBe(966)
    expect(m.competitorUnitCost).toBe(900)
  })

  it('⚠ OMITS gridStep — it exists only to parameterise the competitor’s rule', () => {
    expect(Object.keys(m).sort()).toEqual([
      'competitorBaseShare', 'competitorUnitCost', 'marketSize',
      'maxPrice', 'minPrice', 'slope', 'studentBaseShare', 'studentUnitCost',
    ])
    expect('gridStep' in m).toBe(false)
  })
})

describe('phaseOf — derived from the finish STAMP, never from counting rounds', () => {
  it('an unfinished student is in play', () => {
    expect(phaseOf({})).toBe('play')
    expect(phaseOf({ rounds_played: 9 })).toBe('play')
  })
  it('a finished student is in debrief', () => {
    expect(phaseOf({ finished_at: ts })).toBe('debrief')
  })
  it('rounds_played alone never ends the game — that comparison stays server-side', () => {
    // If phase were derived from rounds_played vs the drawn count, the count would
    // have to travel with it. It does not.
    expect(phaseOf({ rounds_played: 20 })).toBe('play')
  })
})
