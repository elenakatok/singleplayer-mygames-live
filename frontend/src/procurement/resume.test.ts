import { describe, it, expect } from 'vitest'
import {
  procurementResumeIndex, procurementScreenCount,
  type ProcurementResumeInput,
} from './resume'

// ═══════════════════════════════════════════════════════════════════════════════
// RESUME — the flow is the PRE-PLAY stage → the round loop → final results → the DEBRIEF
// stage, and a student must land on the right screen after a reload at ANY point.
//
// ⚠ Every case below is expressed in SERVER FACTS, because that is all resume gets.
//
// ⚠⚠ THE STAGES ARE `boolean[]`, ONE FLAG PER SERVED ROW. They used to be counts, and the
// counts were correct only while the answered rows were guaranteed to be a PREFIX of the
// list. Reorder and hide end that guarantee, which is why the gap cases below exist.
// ═══════════════════════════════════════════════════════════════════════════════

/** `n` answered then the rest outstanding — the ordinary prefix case. */
const pre = (answered: number, total: number) =>
  Array.from({ length: total }, (_, i) => i < answered)

const base: ProcurementResumeInput = {
  preAnswered: pre(0, 4),
  debriefAnswered: [false],
  gameOver: false,
  roundsPlayed: 0,
}

// Screens for `base`: [0..3]=the pre stage, [4]=loop, [5]=results, [6]=debrief → 7
const TOTAL = procurementScreenCount({ preCount: 4, debriefCount: 1 })
const at = (over: Partial<ProcurementResumeInput>) => procurementResumeIndex({ ...base, ...over })

describe('the screen count', () => {
  it('is the pre stage + the loop + results + the debrief stage', () => {
    expect(TOTAL).toBe(7)
    expect(procurementScreenCount({ preCount: 0, debriefCount: 0 })).toBe(2)
    expect(procurementScreenCount({ preCount: 9, debriefCount: 3 })).toBe(14)
  })
})

describe('the pre-play stage', () => {
  it('a brand-new student starts at the first row', () => {
    expect(at({})).toBe(0)
  })

  it('returns to the next unanswered row', () => {
    expect(at({ preAnswered: pre(2, 4) })).toBe(2)
    expect(at({ preAnswered: pre(3, 4) })).toBe(3)
  })

  it('moves to the loop once every row is answered', () => {
    expect(at({ preAnswered: pre(4, 4) })).toBe(4)
  })

  it('an empty pre stage starts in the loop', () => {
    expect(at({ preAnswered: [] })).toBe(0)
  })

  it('⚠⚠ RESUMES ACROSS A GAP — a count would land on the wrong row', () => {
    // MUTANT: `preAnswered.filter(Boolean).length` instead of `findIndex(a => !a)`.
    // → fails. Rows an instructor reordered are not answered in order, so "how many are
    // done" is not "where they are": this student would be sent to row 2, skipping the
    // question they actually missed.
    expect(at({ preAnswered: [true, false, true, false] })).toBe(1)
    expect(at({ preAnswered: [false, true, true, true] })).toBe(0)
    expect(at({ preAnswered: [true, true, false, true] })).toBe(2)
  })
})

describe('the loop and the results screen', () => {
  it('stays in the loop until the server says the game is over', () => {
    expect(at({ preAnswered: pre(4, 4) })).toBe(4)
  })

  it('lands on the results screen when nothing in the debrief stage is done', () => {
    // ⚠ Arriving from the last round, a student reads their own outcome BEFORE being asked
    // to reflect on it.
    expect(at({ preAnswered: pre(4, 4), gameOver: true })).toBe(5)
  })

  it('⚠ an unfinished game keeps them out of the debrief stage entirely', () => {
    expect(at({ preAnswered: pre(4, 4), gameOver: false, debriefAnswered: [false, false] })).toBe(4)
  })
})

describe('the debrief stage', () => {
  it('a finished student with everything done is PAST the end', () => {
    const idx = at({ preAnswered: pre(4, 4), gameOver: true, debriefAnswered: [true] })
    expect(idx).toBe(TOTAL)
  })

  it('an instance with an EMPTY debrief stage is past the end once the game is over', () => {
    const idx = at({ preAnswered: pre(4, 4), gameOver: true, debriefAnswered: [] })
    expect(idx).toBe(procurementScreenCount({ preCount: 4, debriefCount: 0 }))
  })

  it('⚠ PART-WAY THROUGH THE STAGE, the results screen is BEHIND them', () => {
    // MUTANT: return `idx` (the results screen) for any unanswered debrief row. → fails.
    // Re-showing the results every time a student returns mid-stage is a step backwards,
    // and with three rows it would be three steps backwards.
    // Layout: [0..3] pre · [4] loop · [5] results · [6] debrief row 0 · [7] row 1 · [8] row 2.
    expect(at({ preAnswered: pre(4, 4), gameOver: true, debriefAnswered: [true, false, false] }))
      .toBe(7)
    expect(at({ preAnswered: pre(4, 4), gameOver: true, debriefAnswered: [true, true, false] }))
      .toBe(8)
  })

  it('⚠⚠ RESUMES ACROSS A GAP HERE TOO', () => {
    // MUTANT: the same count substitution on the debrief stage. → fails.
    expect(at({ preAnswered: pre(4, 4), gameOver: true, debriefAnswered: [true, false, true] }))
      .toBe(7)
    expect(at({ preAnswered: pre(4, 4), gameOver: true, debriefAnswered: [false, true, true] }))
      .toBe(5)   // nothing before it answered ⇒ the results screen first
  })

  it('every "past the end" value agrees with the screen count', () => {
    for (const debriefCount of [0, 1, 2, 3]) {
      const done = procurementResumeIndex({
        preAnswered: pre(4, 4),
        debriefAnswered: Array.from({ length: debriefCount }, () => true),
        gameOver: true,
        roundsPlayed: 5,
      })
      expect(done).toBe(procurementScreenCount({ preCount: 4, debriefCount }))
    }
  })
})

