import { describe, it, expect } from 'vitest'
import { parsePayoffs, payoff, DEFAULT_PAYOFFS, type PayoffConfig } from '../src/pd/payoff'
import { loadPdConfig } from '../src/pd/config'
import { pdResolveKc } from '../src/pd/questions'
import { botMove, type Move } from '../src/pd/strategy'
import { totals, toClientHistory, type StoredRound } from '../src/pd/rounds'
import { avgYearsPerRound, outcomeByFirstMove } from '../src/pd/reportStats'
import { Timestamp } from 'firebase-admin/firestore'

// ═══════════════════════════════════════════════════════════════════════════════
// PAYOFFS MAY BE ANY FINITE NUMBER, INCLUDING NEGATIVE.
//
// The `>= 0` floor was inherited from the shipped prison-years matrix ("all outcomes
// ≥ 0", spec §2) and was never a rule of the game. The unit is the instructor's word;
// a payoff may be a cost, a penalty, or a loss. Only non-numbers, NaN and ±Infinity
// are refused.
//
// ⚠ THE FLOOR EXISTED IN TWO PLACES AND THE FORM HAD NEITHER: the callable's save
// validator and `parsePayoffs`. The settings page's number inputs carry no `min`, so a
// negative was typed, accepted by the form, and rejected on save. Both server rules are
// gone; the form is unchanged and now agrees with them.
// ═══════════════════════════════════════════════════════════════════════════════

/** A mixed-sign matrix: cooperating together pays, being exploited costs. */
const MIXED: PayoffConfig = {
  you_cc: 3, you_cd: -5, you_dc: 4, you_dd: -1,
  other_cc: 3, other_cd: 4, other_dc: -5, other_dd: -1,
}

describe('parsePayoffs accepts any finite number', () => {
  it('a negative value survives the load, sign intact', () => {
    const p = parsePayoffs(MIXED)
    expect(p).toEqual(MIXED)
    expect(p.you_cd).toBe(-5)
    expect(p.you_dd).toBe(-1)
  })

  it('fractions survive too — there is no integer requirement', () => {
    expect(parsePayoffs({ ...MIXED, you_cc: 2.5 }).you_cc).toBe(2.5)
    expect(parsePayoffs({ ...MIXED, other_dd: -0.25 }).other_dd).toBe(-0.25)
  })

  it('⚠ NEGATIVE CONTROL — the values a partial doc falls back to are unchanged', () => {
    // Removing the floor must not have widened what counts as MISSING. An absent key
    // still defaults; it does not become 0.
    expect(parsePayoffs({}).you_cd).toBe(DEFAULT_PAYOFFS.you_cd)
    expect(parsePayoffs({ you_cd: -5 }).you_dd).toBe(DEFAULT_PAYOFFS.you_dd)
  })

  it('still rejects the genuinely invalid: NaN, ±Infinity, text, null', () => {
    const bad = parsePayoffs({
      you_cc: NaN, you_cd: Infinity, you_dc: -Infinity, you_dd: 'x',
      other_cc: null, other_cd: undefined, other_dc: {}, other_dd: [],
    })
    expect(bad).toEqual(DEFAULT_PAYOFFS)
  })

  it('⚠ 0 is still a value, not a rejection — it borders the removed floor', () => {
    expect(parsePayoffs({ ...MIXED, you_cc: 0 }).you_cc).toBe(0)
  })
})

describe('a negative payoff survives every hop of a played round', () => {
  /** Play `moves` against GRIM and return the stored records. */
  function play(moves: readonly Move[], p: PayoffConfig): StoredRound[] {
    const history: Move[] = []
    const rows: StoredRound[] = []
    for (let i = 0; i < moves.length; i++) {
      const bot = botMove('grim', history)
      const r = payoff(moves[i], bot, p)
      rows.push({
        round: i + 1, student_move: moves[i], bot_move: bot,
        student_years: r.studentYears, bot_years: r.botYears,
        played_at: Timestamp.fromMillis(0),
      })
      history.push(moves[i])
    }
    return rows
  }

  it('config → payoff → round record → history row → cumulative total → average', () => {
    const p = loadPdConfig({ payoffs: MIXED }).payoffs   // the config hop
    expect(p.you_cd).toBe(-5)

    // GRIM: C, C, then D forever after the first D. Student plays C D C.
    // Cells: (C,C) (D,C) (C,D)  →  Y = 3, 4, -5   O = 3, -5, 4
    const rows = play(['C', 'D', 'C'], p)
    expect(rows.length).toBe(3)
    expect(rows.map(r => r.bot_move).join('')).toBe('CCD')
    expect(rows.map(r => r.student_years)).toEqual([3, 4, -5])   // the round record hop
    expect(rows.map(r => r.bot_years)).toEqual([3, -5, 4])

    const client = toClientHistory(rows)                          // the history-row hop
    expect(client.length).toBe(3)
    expect(client.map(r => r.studentYears)).toEqual([3, 4, -5])
    expect(client.map(r => r.studentTotal)).toEqual([3, 7, 2])    // the cumulative hop
    expect(client.map(r => r.botTotal)).toEqual([3, -2, 2])

    expect(totals(rows)).toEqual({ student: 2, bot: 2 })
    // The average hop. 2/3 = 0.666…, and the sign is preserved on the bot's dip.
    expect(avgYearsPerRound({
      participant_id: 'x', moves: rows.map(r => r.student_move),
      years: rows.map(r => r.student_years), strategy: 'grim',
    })).toBeCloseTo(2 / 3, 10)
  })

  it('⚠ CUMULATIVE TOTALS CROSS ZERO — a sum that clamped would read 0 here', () => {
    // The bot's running total goes 3 → −2 → 2. A clamp at zero, anywhere along the
    // chain, shows −2 as 0 and then 5 instead of 2.
    const rows = play(['C', 'D', 'C'], MIXED)
    const client = toClientHistory(rows)
    expect(client.length).toBe(3)
    expect(client[1].botTotal).toBe(-2)
    expect(client[1].botTotal).toBeLessThan(0)
    expect(client[2].botTotal).toBe(2)
  })

  it('⚠ NEGATIVE CONTROL — an all-positive fixture cannot distinguish the fix', () => {
    // Run the identical assertions against the shipped defaults: every total is ≥ 0, so
    // a clamped implementation would pass. This is why the fixture above is mixed-sign.
    const rows = play(['C', 'D', 'C'], DEFAULT_PAYOFFS)
    const client = toClientHistory(rows)
    expect(client.length).toBe(3)
    expect(client.every(r => r.studentTotal >= 0 && r.botTotal >= 0)).toBe(true)
  })

  it('the KC option ladder sorts negatives correctly and keeps every answer', () => {
    const resolved = pdResolveKc(loadPdConfig({ payoffs: MIXED, unit: 'points' }))
    expect(resolved.length).toBe(4)
    // Y = 3, −5, 4, −1 → ascending −5, −1, 3, 4.
    expect((resolved[0].options ?? []).map(o => o.value)).toEqual(['-5', '-1', '3', '4'])
    expect(resolved.map(q => q.correct_value)).toEqual(['3', '-5', '4', '-1'])
    for (const q of resolved) {
      const values = (q.options ?? []).map(o => o.value)
      expect(values.length).toBe(4)
      expect(values).toContain(q.correct_value)
    }
  })

  it('the Tier-3 aggregation carries a negative mean through', () => {
    const out = outcomeByFirstMove([
      { participant_id: 'a', moves: ['C', 'C'], years: [-5, -1], strategy: 'tft' },
      { participant_id: 'b', moves: ['D'], years: [4], strategy: 'grim' },
    ])
    expect(out.length).toBe(4)
    const cTft = out.find(o => o.firstMove === 'C' && o.strategy === 'tft')!
    expect(cTft.n).toBe(1)
    expect(cTft.avgYearsPerRound).toBe(-3)
  })
})
