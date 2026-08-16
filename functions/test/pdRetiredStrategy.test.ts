import { describe, it, expect } from 'vitest'
import {
  botMove, isStrategy, parseStoredStrategy, STRATEGIES, type Move, type Strategy,
} from '../src/pd/strategy'
import { parseStrategyPool } from '../src/pd/config'
import { payoff, DEFAULT_PAYOFFS } from '../src/pd/payoff'
import { studentMoves, botMoves, type StoredRound } from '../src/pd/rounds'
import { Timestamp } from 'firebase-admin/firestore'

// ═══════════════════════════════════════════════════════════════════════════════
// `match_stay`, RETIRED.
//
// It was never a distinct rule. Its condition — repeat my own last move if the two of
// us matched, switch it if we differed — collapses in a TWO-ACTION game: matched means
// my last move WAS the student's, so repeating plays theirs; mismatched means flipping
// mine ALSO lands on theirs, because there is nowhere else to land. Either way the
// output is the student's previous move, which is tit-for-tat. That was proven
// exhaustively over all 256 four-round histories before the id was deleted.
//
// TWO PLACES COULD STILL HOLD THE STRING, and they are handled differently on purpose:
//   • a CONFIG POOL is a MENU. An entry that no longer exists is simply not offered —
//     the parser drops it as unknown, and a pool that empties falls back.
//   • a TRUTH DOC is an ASSIGNMENT. A participant mid-game must keep playing what they
//     were given, so it maps to `tft`, which by the equivalence above is EXACT rather
//     than approximate — the same moves, against the same history, forever.
//
// ⚠ NO LIVE DOCUMENT HELD IT. Checked in `singleplayer-mygames-live` before removal:
// 2 pd instances, 13 truth documents, every one `tft` or `grim`, and neither instance
// had a `config/main` at all. The mapping is kept anyway — two lines, and it removes
// the failure mode rather than betting on the scan.
// ═══════════════════════════════════════════════════════════════════════════════

const h = (s: string): Move[] => [...s] as Move[]

describe('the id is gone from the library', () => {
  it('STRATEGIES has six entries and match_stay is not one', () => {
    expect(STRATEGIES.length).toBe(6)
    expect([...STRATEGIES]).not.toContain('match_stay')
  })

  it('isStrategy REJECTS it — it is not a strategy this build can run', () => {
    expect(isStrategy('match_stay')).toBe(false)
  })

  it('botMove has no case for it — an unknown id yields undefined, never a wrong move', () => {
    // Deliberately cast: the compiler already refuses this, and the runtime must not
    // quietly substitute some other rule if a stale caller gets past it.
    expect(botMove('match_stay' as Strategy, h('CD'), h('CC'))).toBeUndefined()
  })
})

describe('a stored POOL entry is dropped (a menu entry that no longer exists)', () => {
  it('the rest of the pool survives', () => {
    expect(parseStrategyPool(['tft', 'match_stay', 'alternate'])).toEqual(['tft', 'alternate'])
  })

  it('⚠⚠ a pool of ONLY retired ids falls back — the one unrecoverable state', () => {
    expect(parseStrategyPool(['match_stay'])).toEqual(['tft', 'grim'])
  })

  it('NEGATIVE CONTROL — a pool of only VALID ids is not replaced by the default', () => {
    // Without this the fallback assertion above is satisfiable by "always return the
    // default", which would silently discard every instructor's real selection.
    expect(parseStrategyPool(['alternate'])).toEqual(['alternate'])
  })
})

describe('⚠⚠ a stored ASSIGNMENT maps to tft — exactly, by the equivalence', () => {
  it('parseStoredStrategy maps it', () => {
    expect(parseStoredStrategy('match_stay')).toBe('tft')
  })

  it('…and passes every live id through untouched', () => {
    expect(STRATEGIES.length).toBe(6)
    for (const s of STRATEGIES) expect(parseStoredStrategy(s)).toBe(s)
  })

  it('…and still returns null for genuine rubbish', () => {
    for (const bad of ['pavlov', 'TFT', '', null, undefined, 7, {}, []]) {
      expect(parseStoredStrategy(bad)).toBeNull()
    }
  })

  it('⚠ END TO END — a truth doc holding match_stay plays as tit-for-tat', () => {
    // The whole point. `strategy` comes out of storage as the retired string; the play
    // path normalizes it and plays a real game with it.
    const storedField: unknown = 'match_stay'
    const strategy = parseStoredStrategy(storedField)
    expect(strategy).not.toBeNull()

    const studentSeq = h('CDDCDC')
    const rows: StoredRound[] = []
    for (let i = 0; i < studentSeq.length; i++) {
      const bot = botMove(strategy!, studentMoves(rows), botMoves(rows))
      const p = payoff(studentSeq[i], bot, DEFAULT_PAYOFFS)
      rows.push({
        round: i + 1, student_move: studentSeq[i], bot_move: bot,
        student_years: p.studentYears, bot_years: p.botYears,
        played_at: Timestamp.fromMillis(0),
      })
    }
    expect(rows.length).toBe(6)

    // ⚠ EXPECTED FROM A DIFFERENT SOURCE: tit-for-tat computed here from the definition
    // ("C first, then the student's previous move"), not by calling botMove('tft', …).
    const expectedTft: Move[] = studentSeq.map((_, i) => (i === 0 ? 'C' : studentSeq[i - 1]))
    expect(expectedTft.length).toBe(6)
    expect(expectedTft.join('')).toBe('CCDDCD')
    expect(rows.map(r => r.bot_move)).toEqual(expectedTft)
  })

  it('NEGATIVE CONTROL — the same fixture DISTINGUISHES a different rule', () => {
    // Proof the end-to-end assertion is not vacuous: grim over the same student
    // sequence produces a different bot sequence, so "equals tit-for-tat" is a real
    // claim about this fixture rather than something any strategy would satisfy.
    const studentSeq = h('CDDCDC')
    const grim: Move[] = []
    const seen: Move[] = []
    for (const m of studentSeq) { grim.push(botMove('grim', seen, [])); seen.push(m) }
    expect(grim.length).toBe(6)
    const expectedTft: Move[] = studentSeq.map((_, i) => (i === 0 ? 'C' : studentSeq[i - 1]))
    expect(grim).not.toEqual(expectedTft)
  })
})
