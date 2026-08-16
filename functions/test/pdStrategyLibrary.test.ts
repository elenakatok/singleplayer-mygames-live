import { describe, it, expect } from 'vitest'
import { botMove, STRATEGIES, type Move, type Strategy } from '../src/pd/strategy'
import { parseStoredRounds, botMoves, studentMoves, type StoredRound } from '../src/pd/rounds'
import { payoff, DEFAULT_PAYOFFS } from '../src/pd/payoff'
import { Timestamp } from 'firebase-admin/firestore'

// ═══════════════════════════════════════════════════════════════════════════════
// THE FIVE NEW STRATEGIES (spec §5). tft and grim keep their own suite, unchanged —
// that file is the no-behaviour-change control for this whole pass.
//
// Every expected sequence below is WRITTEN OUT BY HAND from the rule, never generated
// by running the code under test.
// ═══════════════════════════════════════════════════════════════════════════════

/** Build a history from a compact string: h('CCD') → ['C','C','D']. */
const h = (s: string): Move[] => [...s] as Move[]

/**
 * Drive one strategy over a whole student sequence, threading BOTH histories forward.
 *
 * ⚠ THE BOT HISTORY IS ACCUMULATED FROM WHAT WAS ACTUALLY PLAYED, exactly as the real
 * compute step accumulates it from the stored round records — never re-derived.
 */
function drive(
  strategy: Strategy,
  studentSeq: readonly Move[],
  ctx?: { seed: string | null; participantId: string },
): Move[] {
  const student: Move[] = []
  const bot: Move[] = []
  for (const m of studentSeq) {
    bot.push(botMove(strategy, student, bot, ctx))
    student.push(m)
  }
  return bot
}

// ═══════════════════════════════════════════════════════════════════════════════
// ALWAYS FIRST / ALWAYS SECOND
// ═══════════════════════════════════════════════════════════════════════════════

describe('always_first / always_second', () => {
  it('always_first plays the first move regardless of the student', () => {
    expect(drive('always_first', h('CDDCD')).join('')).toBe('CCCCC')
  })

  it('always_second plays the second move regardless of the student', () => {
    expect(drive('always_second', h('CDDCD')).join('')).toBe('DDDDD')
  })

  it('NEGATIVE CONTROL — they differ from each other on the same input', () => {
    const seq = h('CDDCD')
    expect(drive('always_first', seq)).not.toEqual(drive('always_second', seq))
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// ALTERNATE
// ═══════════════════════════════════════════════════════════════════════════════

describe('alternate — a function of the ROUND INDEX alone', () => {
  it('starts with the first move and switches every round', () => {
    // Written by hand: rounds 1..7 → C D C D C D C.
    expect(drive('alternate', h('CCCCCCC')).join('')).toBe('CDCDCDC')
  })

  it('⚠⚠ IGNORES THE STUDENT ENTIRELY — same output on two DIFFERENT histories', () => {
    // ⚠ THE NEGATIVE CONTROL IS THE SECOND HISTORY. Driving alternate against ONE
    // student sequence cannot distinguish it from a strategy that happens to alternate
    // in response to that particular sequence — which is exactly what tft does against
    // an alternating student. Two different histories OF EQUAL LENGTH is the only
    // fixture that proves independence.
    const a = h('CCCCCC')
    const b = h('DDCDCD')
    expect(a.length).toBe(b.length)
    expect(a).not.toEqual(b)
    const outA = drive('alternate', a)
    const outB = drive('alternate', b)
    expect(outA.length).toBe(6)
    expect(outA).toEqual(outB)
    expect(outA.join('')).toBe('CDCDCD')
  })

  it('…and the control really would catch a student-reading alternate', () => {
    // Proof the fixture has teeth: tft, driven over the same two histories, DIVERGES.
    // So "same output on both" is a property alternate has and a reactive rule does not.
    const a = h('CCCCCC')
    const b = h('DDCDCD')
    expect(drive('tft', a)).not.toEqual(drive('tft', b))
  })

  it('a single third history pins the exact sequence at an odd length', () => {
    expect(drive('alternate', h('DDD')).join('')).toBe('CDC')
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// RANDOM
// ═══════════════════════════════════════════════════════════════════════════════

describe('random — 50/50, independent, from the seedable path', () => {
  it('produces both moves over many seeded draws, near 50/50', () => {
    let c = 0
    const N = 2000
    for (let i = 0; i < N; i++) {
      const m = botMove('random', new Array(i % 40).fill('C') as Move[], [],
        { seed: `s${i}`, participantId: `p${i % 7}` })
      if (m === 'C') c++
    }
    // A different source than the code: a binomial 3σ band around N/2.
    const sigma = Math.sqrt(N * 0.25)
    expect(Math.abs(c - N / 2)).toBeLessThan(3 * sigma)
    expect(c).toBeGreaterThan(0)
    expect(c).toBeLessThan(N)
  })

  it('⚠ THE ROUND IS IN THE DRAW — a seeded game is not one move repeated', () => {
    // Without the round in the hash input every round of one student's game draws the
    // same move, which is a constant strategy wearing a coin's name.
    const seq = drive('random', new Array(40).fill('C') as Move[], { seed: 'fixed', participantId: 'p1' })
    expect(seq.length).toBe(40)
    expect(new Set(seq).size).toBe(2)
  })

  it('two different participants get different sequences under one seed', () => {
    const a = drive('random', new Array(30).fill('C') as Move[], { seed: 'x', participantId: 'alice' })
    const b = drive('random', new Array(30).fill('C') as Move[], { seed: 'x', participantId: 'bob' })
    expect(a.length).toBe(30)
    expect(a).not.toEqual(b)
  })

  it('⚠ NEEDS A CONTEXT, and says so loudly rather than guessing', () => {
    expect(() => botMove('random', [])).toThrow(/BotContext/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// ⚠⚠ THE RNG RULE — A DRAWN MOVE IS WRITTEN WHEN DRAWN AND NEVER RECOMPUTED
// ═══════════════════════════════════════════════════════════════════════════════

describe('the bot\'s past moves are READ FROM STORAGE, never re-derived', () => {
  /** Play a game and store it exactly as submitRound does. */
  function playAndStore(strategy: Strategy, studentSeq: readonly Move[], ctx?: { seed: string | null; participantId: string }): StoredRound[] {
    const rows: StoredRound[] = []
    for (let i = 0; i < studentSeq.length; i++) {
      const bot = botMove(strategy, studentMoves(rows), botMoves(rows), ctx)
      const p = payoff(studentSeq[i], bot, DEFAULT_PAYOFFS)
      rows.push({
        round: i + 1, student_move: studentSeq[i], bot_move: bot,
        student_years: p.studentYears, bot_years: p.botYears,
        played_at: Timestamp.fromMillis(0),
      })
    }
    return rows
  }

  it('⚠⚠ a stored bot move is read back as the STORED value, not a re-derivation', () => {
    // UNSEEDED random: re-deriving each move would be a fresh coin flip, so over 40
    // rounds the re-derivation disagrees with storage with probability 1 − 2^−40.
    const stored = playAndStore('random', new Array(40).fill('C') as Move[],
      { seed: null, participantId: 'p' })
    expect(stored.length).toBe(40)

    // What the round records actually hold — the only source any later reader may use.
    const fromStorage = botMoves(parseStoredRounds(stored))
    expect(fromStorage.length).toBe(40)
    expect(fromStorage).toEqual(stored.map(r => r.bot_move))

    // A re-derivation of the same game, which is what a "recompute the history"
    // implementation would produce.
    const reDerived = playAndStore('random', new Array(40).fill('C') as Move[],
      { seed: null, participantId: 'p' }).map(r => r.bot_move)
    expect(reDerived.length).toBe(40)
    expect(reDerived).not.toEqual(fromStorage)
  })

  it('⚠ NEGATIVE CONTROL — a DETERMINISTIC strategy cannot distinguish the rule', () => {
    // Replaying tft reproduces its history exactly, so a test using tft would pass
    // against a recompute-the-history implementation. This is why the assertion above
    // uses unseeded random.
    const seq = h('CDDCC')
    const a = playAndStore('tft', seq).map(r => r.bot_move)
    const b = playAndStore('tft', seq).map(r => r.bot_move)
    expect(a.length).toBe(5)
    expect(a).toEqual(b)
  })

  it('alternate threaded through STORED history keeps its round-index rule', () => {
    const stored = playAndStore('alternate', h('CDDCC'))
    expect(stored.length).toBe(5)
    expect(stored.map(r => r.bot_move).join('')).toBe('CDCDC')
    // …and the next move follows from the round count in the STORED history.
    expect(botMove('alternate', studentMoves(stored), botMoves(stored))).toBe('D')
  })

  it('botMoves reads the bot_move field and studentMoves the student_move field', () => {
    // Derived from a DIFFERENT source than the functions: a hand-built record whose
    // two move fields deliberately differ in every round.
    const rows: StoredRound[] = [
      { round: 1, student_move: 'C', bot_move: 'D', student_years: 0, bot_years: 0, played_at: Timestamp.fromMillis(0) },
      { round: 2, student_move: 'D', bot_move: 'C', student_years: 0, bot_years: 0, played_at: Timestamp.fromMillis(0) },
    ]
    expect(botMoves(rows)).toEqual(['D', 'C'])
    expect(studentMoves(rows)).toEqual(['C', 'D'])
  })
})

describe('the library is complete and every id is driveable', () => {
  it('all seven ids produce a legal move for a mid-game position', () => {
    expect(STRATEGIES.length).toBe(6)
    for (const s of STRATEGIES) {
      const m = botMove(s, h('CDC'), h('CCD'), { seed: 'z', participantId: 'p' })
      expect(['C', 'D']).toContain(m)
    }
  })
})
