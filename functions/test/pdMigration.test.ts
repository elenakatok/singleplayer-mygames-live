import { describe, it, expect } from 'vitest'
import {
  payoff, yourPayoff, otherPayoff, parsePayoffs, type PayoffConfig,
} from '../src/pd/payoff'
import { botMove, type Move, type Strategy } from '../src/pd/strategy'
import { totals, toClientHistory, type StoredRound } from '../src/pd/rounds'
import { Timestamp } from 'firebase-admin/firestore'

// ═══════════════════════════════════════════════════════════════════════════════
// THE FOUR→EIGHT MIGRATION. This file is the whole reason the change is safe.
//
// An instance created before the payoff matrix became eight values stores FOUR, and
// nothing backfills it. The claim being tested is exact: such an instance must play
// IDENTICALLY to how it played before the change — same bot moves, same payoffs for
// both sides, same round records, same totals.
//
// ⚠ EXPECTED IS DERIVED FROM A DIFFERENT SOURCE THAN ACTUAL. `legacyPayoff` below is a
// VERBATIM transcription of the pre-change implementation (payoff.ts as it stood before
// this pass), kept here as the reference oracle. Comparing the new path against a
// re-derivation of the new path would prove nothing.
//
// ⚠ EVERY TEST HERE CARRIES A NEGATIVE CONTROL — a mutation that the same assertion
// must reject. A test never seen to fail is not known to work.
// ═══════════════════════════════════════════════════════════════════════════════

// ── The reference oracle: payoff.ts, exactly as it was before eight values ──────

interface LegacyPayoffs {
  both_cooperate: number
  sucker: number
  temptation: number
  both_defect: number
}

/** VERBATIM the old `yearsFor`. Do not "improve" it — its value is that it is stale. */
function legacyYearsFor(own: Move, other: Move, cfg: LegacyPayoffs): number {
  if (own === 'C') return other === 'C' ? cfg.both_cooperate : cfg.sucker
  return other === 'C' ? cfg.temptation : cfg.both_defect
}

/** VERBATIM the old `payoff` — note the SYMMETRIC DERIVE for the bot's side. */
function legacyPayoff(studentMove: Move, botMove_: Move, cfg: LegacyPayoffs) {
  return {
    studentYears: legacyYearsFor(studentMove, botMove_, cfg),
    botYears: legacyYearsFor(botMove_, studentMove, cfg),
  }
}

/** The legacy stored doc used throughout. Deliberately NOT the shipped defaults —
 *  four distinct values, so a transposition has somewhere to show up. */
const LEGACY: LegacyPayoffs = { both_cooperate: 2, sucker: 9, temptation: 1, both_defect: 6 }

const MOVES: Move[] = ['C', 'D']

// ═══════════════════════════════════════════════════════════════════════════════
// (a) DERIVED-EIGHT IDENTITY
// ═══════════════════════════════════════════════════════════════════════════════

describe('(a) the normalizer reproduces the legacy matrix in all four cells, both sides', () => {
  it('every cell, both players, matches the pre-change implementation exactly', () => {
    const eight = parsePayoffs(LEGACY as unknown)
    let cells = 0
    for (const a of MOVES) {
      for (const b of MOVES) {
        const want = legacyPayoff(a, b, LEGACY)
        expect(yourPayoff(a, b, eight)).toBe(want.studentYears)
        expect(otherPayoff(a, b, eight)).toBe(want.botYears)
        cells++
      }
    }
    expect(cells).toBe(4)
  })

  it('NEGATIVE CONTROL — perturbing ONE legacy value breaks the identity', () => {
    // The same loop, with the stored doc changed in one place. If the assertions above
    // could pass for a matrix that is not the legacy one, they prove nothing.
    const perturbed: LegacyPayoffs = { ...LEGACY, sucker: LEGACY.sucker + 1 }
    const eight = parsePayoffs(perturbed as unknown)
    const mismatches: string[] = []
    for (const a of MOVES) {
      for (const b of MOVES) {
        const want = legacyPayoff(a, b, LEGACY)   // ← the UNperturbed oracle
        if (yourPayoff(a, b, eight) !== want.studentYears) mismatches.push(`Y(${a},${b})`)
        if (otherPayoff(a, b, eight) !== want.botYears) mismatches.push(`O(${a},${b})`)
      }
    }
    // `sucker` is Y(C,D) and, through the transpose, O(D,C) — so exactly two cells move.
    expect(mismatches.length).toBeGreaterThan(0)
    expect(mismatches.sort()).toEqual(['O(D,C)', 'Y(C,D)'])
  })

  it('the eight-value shape WINS over a legacy key that is also present', () => {
    // A doc that has been saved since the change carries both (merge:true leaves the old
    // keys behind). The eight must win, or an instructor's save would appear not to take.
    const eight = parsePayoffs({ ...LEGACY, you_cd: 99, other_cd: 98 })
    expect(eight.you_cd).toBe(99)
    expect(eight.other_cd).toBe(98)
    expect(eight.you_cc).toBe(LEGACY.both_cooperate)  // untouched keys still migrate
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// (b) PLAY IDENTITY — a whole seeded game, old path vs new path
// ═══════════════════════════════════════════════════════════════════════════════

/** A deterministic student move sequence. Not "random" — a fixed pseudo-random ladder,
 *  so the same 24 rounds are replayed by both paths and by every future run. */
function seededMoves(n: number, seed: number): Move[] {
  let x = seed >>> 0
  const out: Move[] = []
  for (let i = 0; i < n; i++) {
    // xorshift32 — the low bit picks the move.
    x ^= x << 13; x >>>= 0
    x ^= x >>> 17
    x ^= x << 5; x >>>= 0
    out.push((x & 1) === 0 ? 'C' : 'D')
  }
  return out
}

/** One full game's round records, built by whichever payoff function is passed in.
 *  Everything else — the strategy, the history threading, the record shape — is shared,
 *  so the ONLY difference between the two runs is the payoff lookup. */
function replay(
  moves: readonly Move[],
  strategy: Strategy,
  pay: (student: Move, bot: Move) => { studentYears: number; botYears: number },
) {
  const history: Move[] = []
  const rows: Omit<StoredRound, 'played_at'>[] = []
  for (let i = 0; i < moves.length; i++) {
    const bot = botMove(strategy, history)
    const p = pay(moves[i], bot)
    rows.push({
      round: i + 1,
      student_move: moves[i],
      bot_move: bot,
      student_years: p.studentYears,
      bot_years: p.botYears,
    })
    history.push(moves[i])
  }
  return rows
}

describe('(b) a full seeded game replays byte-identically through both paths', () => {
  const eight = parsePayoffs(LEGACY as unknown)

  for (const strategy of ['tft', 'grim'] as const) {
    it(`vs ${strategy.toUpperCase()} — 24 rounds, serialized records identical`, () => {
      const moves = seededMoves(24, 0x5eed01)
      expect(moves.length).toBe(24)
      expect(new Set(moves).size).toBe(2)   // the ladder actually varies

      const before = replay(moves, strategy, (s, b) => legacyPayoff(s, b, LEGACY))
      const after = replay(moves, strategy, (s, b) => payoff(s, b, eight))

      expect(after.length).toBe(before.length)
      expect(JSON.stringify(after)).toBe(JSON.stringify(before))
      // …and the game really did exercise both sides of the matrix.
      expect(new Set(before.map(r => `${r.student_move}${r.bot_move}`)).size).toBeGreaterThan(1)
    })
  }

  it('NEGATIVE CONTROL — swapping two stored values breaks the replay', () => {
    const moves = seededMoves(24, 0x5eed01)
    const swapped: LegacyPayoffs = {
      ...LEGACY, sucker: LEGACY.temptation, temptation: LEGACY.sucker,
    }
    const before = replay(moves, 'tft', (s, b) => legacyPayoff(s, b, swapped))
    const after = replay(moves, 'tft', (s, b) => payoff(s, b, eight))
    expect(after.length).toBe(before.length)
    expect(JSON.stringify(after)).not.toBe(JSON.stringify(before))
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// (c) TRANSPOSITION GUARD — eight DISTINCT values
//
// ⚠⚠ SWAPPING O(C,D) WITH O(D,C) IS THE SINGLE MOST LIKELY BUG IN THIS CHANGE, and it
// is INVISIBLE under any symmetric matrix — including the shipped defaults and every
// legacy instance, where the two are equal by construction. These tests use eight
// pairwise-distinct values precisely so that swap has somewhere to show.
// ═══════════════════════════════════════════════════════════════════════════════

/** Eight pairwise-distinct values. No two cells can be confused for one another. */
const DISTINCT: PayoffConfig = {
  you_cc: 11, you_cd: 12, you_dc: 13, you_dd: 14,
  other_cc: 21, other_cd: 22, other_dc: 23, other_dd: 24,
}

/** THE mutation this section exists to catch, applied to the config rather than the code
 *  so the assertions below can be pointed at it directly. */
const TRANSPOSED: PayoffConfig = {
  ...DISTINCT, other_cd: DISTINCT.other_dc, other_dc: DISTINCT.other_cd,
}

/** The four cells and what each must produce — written out by hand from the notation,
 *  NOT computed from the config object, so this table is an independent statement. */
const EXPECTED: { student: Move; bot: Move; student_years: number; bot_years: number }[] = [
  { student: 'C', bot: 'C', student_years: 11, bot_years: 21 },
  { student: 'C', bot: 'D', student_years: 12, bot_years: 22 },
  { student: 'D', bot: 'C', student_years: 13, bot_years: 23 },
  { student: 'D', bot: 'D', student_years: 14, bot_years: 24 },
]

/** All four cells as stored round records, played in EXPECTED's order. */
function fourCellRecords(cfg: PayoffConfig): StoredRound[] {
  return EXPECTED.map((e, i) => {
    const p = payoff(e.student, e.bot, cfg)
    return {
      round: i + 1,
      student_move: e.student,
      bot_move: e.bot,
      student_years: p.studentYears,
      bot_years: p.botYears,
      played_at: Timestamp.fromMillis(0),
    }
  })
}

describe('(c) every value lands in the right cell for the right player', () => {
  it('the pairwise-distinct fixture really is pairwise distinct', () => {
    const vals = Object.values(DISTINCT)
    expect(vals.length).toBe(8)
    expect(new Set(vals).size).toBe(8)
  })

  it('THE ROUND RECORD carries Y(a,b) to the student and O(a,b) to the bot', () => {
    const rows = fourCellRecords(DISTINCT)
    expect(rows.length).toBe(4)
    rows.forEach((r, i) => {
      expect(r.student_years).toBe(EXPECTED[i].student_years)
      expect(r.bot_years).toBe(EXPECTED[i].bot_years)
    })
  })

  it('THE HISTORY TABLE rows carry the same numbers, per round and cumulatively', () => {
    const client = toClientHistory(fourCellRecords(DISTINCT))
    expect(client.length).toBe(4)
    let sY = 0
    let sB = 0
    client.forEach((row, i) => {
      sY += EXPECTED[i].student_years
      sB += EXPECTED[i].bot_years
      expect(row.studentYears).toBe(EXPECTED[i].student_years)
      expect(row.botYears).toBe(EXPECTED[i].bot_years)
      expect(row.studentTotal).toBe(sY)
      expect(row.botTotal).toBe(sB)
    })
  })

  it('THE TOTALS sum the right column for each side', () => {
    // 11+12+13+14 = 50 and 21+22+23+24 = 90, stated as literals rather than as a
    // reduce over the same array the code reduces over.
    expect(totals(fourCellRecords(DISTINCT))).toEqual({ student: 50, bot: 90 })
  })

  it('NEGATIVE CONTROL — swapping O(C,D) with O(D,C) fails the round record', () => {
    const rows = fourCellRecords(TRANSPOSED)
    expect(rows.length).toBe(4)
    const cd = rows.find(r => r.student_move === 'C' && r.bot_move === 'D')!
    const dc = rows.find(r => r.student_move === 'D' && r.bot_move === 'C')!
    expect(cd.bot_years).not.toBe(22)
    expect(dc.bot_years).not.toBe(23)
    expect(cd.bot_years).toBe(23)
    expect(dc.bot_years).toBe(22)
  })

  it('NEGATIVE CONTROL — the swap is INVISIBLE on the history table totals, and visible per row', () => {
    // The swap moves two numbers between rounds, so the COLUMN TOTAL is unchanged: a
    // test that checked only totals would pass a transposed matrix. This is why the
    // per-row assertion above exists.
    expect(totals(fourCellRecords(TRANSPOSED))).toEqual({ student: 50, bot: 90 })
    const swapped = toClientHistory(fourCellRecords(TRANSPOSED))
    const straight = toClientHistory(fourCellRecords(DISTINCT))
    expect(swapped.map(r => r.botYears)).not.toEqual(straight.map(r => r.botYears))
  })

  it('⚠ THE OLD SYMMETRIC DERIVE IS INDISTINGUISHABLE ON MIGRATED DATA', () => {
    // The transposition that no legacy instance can expose: reading the other player's
    // number as `yourPayoff(b, a)` instead of `otherPayoff(a, b)`. On a migrated
    // four-value instance O IS the transpose of Y, so the two agree in every cell —
    // which is why a regression to the derive would pass every test that used only
    // legacy or default matrices, and why DISTINCT above is asymmetric.
    const migrated = parsePayoffs(LEGACY as unknown)
    for (const a of MOVES) {
      for (const b of MOVES) {
        expect(otherPayoff(a, b, migrated)).toBe(yourPayoff(b, a, migrated))
      }
    }
    // …and on an asymmetric matrix they disagree, which is what makes DISTINCT a test.
    const disagreements = MOVES.flatMap(a => MOVES.filter(b =>
      otherPayoff(a, b, DISTINCT) !== yourPayoff(b, a, DISTINCT)))
    expect(disagreements.length).toBe(4)
  })
})
