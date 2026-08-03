import { describe, it, expect } from 'vitest'
import {
  procurementResumeIndex, procurementScreenCount, procurementStartIteration,
  type ProcurementResumeInput,
} from './resume'

// ═══════════════════════════════════════════════════════════════════════════════
// RESUME — the flow is KC → prep → the round loop → final results → debrief, and a
// student must land on the right one after a reload at ANY point.
//
// ⚠ Every case below is expressed in SERVER FACTS, because that is all resume gets.
// ═══════════════════════════════════════════════════════════════════════════════

const base: ProcurementResumeInput = {
  kcCount: 3,
  kcAnswered: 0,
  prepEnabled: true,
  prepAnswered: false,
  debriefEnabled: true,
  debriefAnswered: false,
  gameOver: false,
  roundsPlayed: 0,
}

// Screens for `base`: [0,1,2]=KC, [3]=prep, [4]=loop, [5]=results, [6]=debrief → 7
const TOTAL = procurementScreenCount({ kcCount: 3, prepEnabled: true, debriefEnabled: true })
const at = (over: Partial<ProcurementResumeInput>) => procurementResumeIndex({ ...base, ...over })

describe('the screen count', () => {
  it('is KC + prep? + the loop + results + debrief?', () => {
    expect(TOTAL).toBe(7)
    expect(procurementScreenCount({ kcCount: 3, prepEnabled: false, debriefEnabled: false })).toBe(5)
    expect(procurementScreenCount({ kcCount: 0, prepEnabled: false, debriefEnabled: false })).toBe(2)
  })
})

describe('resume walks the flow in order', () => {
  it('a fresh student starts at the first KC question', () => {
    expect(at({})).toBe(0)
  })

  it('mid-KC, it lands on the first UNANSWERED question', () => {
    expect(at({ kcAnswered: 1 })).toBe(1)
    expect(at({ kcAnswered: 2 })).toBe(2)
  })

  it('KC done → the prep paragraph', () => {
    expect(at({ kcAnswered: 3 })).toBe(3)
  })

  it('prep done → the round loop, whatever round they are on', () => {
    expect(at({ kcAnswered: 3, prepAnswered: true })).toBe(4)
    expect(at({ kcAnswered: 3, prepAnswered: true, roundsPlayed: 5 })).toBe(4)
  })

  it('the game over → final results', () => {
    expect(at({ kcAnswered: 3, prepAnswered: true, gameOver: true, roundsPlayed: 8 })).toBe(5)
  })

  it('results read and the debrief answered → past the end', () => {
    const idx = at({
      kcAnswered: 3, prepAnswered: true, gameOver: true, roundsPlayed: 8, debriefAnswered: true,
    })
    expect(idx).toBe(TOTAL)
  })
})

describe('the parts an instance may not have', () => {
  it('KC off: a fresh student starts at the prep paragraph, not at index 0 of nothing', () => {
    expect(procurementResumeIndex({ ...base, kcCount: 0, kcAnswered: 0 })).toBe(0)
    // …and that index 0 IS the prep screen, because the KC block is empty.
    expect(procurementScreenCount({ kcCount: 0, prepEnabled: true, debriefEnabled: true })).toBe(4)
  })

  it('no prep: KC done goes straight to the loop', () => {
    expect(at({ kcAnswered: 3, prepEnabled: false })).toBe(3)
  })

  it('no debrief: the game over lands on results, and results is the LAST screen', () => {
    const i = { ...base, kcAnswered: 3, prepAnswered: true, gameOver: true, roundsPlayed: 8, debriefEnabled: false }
    const total = procurementScreenCount({ kcCount: 3, prepEnabled: true, debriefEnabled: false })
    // ⚠ Past the end — the caller shows the TERMINAL results view. Results has no stored
    // completion fact, so with no debrief behind it there is nothing left to advance to.
    expect(procurementResumeIndex(i)).toBe(total)
  })

  it('nothing but the loop: a finished student is past the end', () => {
    const i: ProcurementResumeInput = {
      kcCount: 0, kcAnswered: 0, prepEnabled: false, prepAnswered: false,
      debriefEnabled: false, debriefAnswered: false, gameOver: true, roundsPlayed: 8,
    }
    expect(procurementResumeIndex(i)).toBe(
      procurementScreenCount({ kcCount: 0, prepEnabled: false, debriefEnabled: false }),
    )
  })
})

describe('the awkward states a real instance produces', () => {
  it('⚠ a stale kcAnswered larger than the asked set does NOT skip past the KC block', () => {
    // The instructor hid a question after this student answered it. Clamped, so the
    // student lands on the prep paragraph rather than being thrown into the loop with
    // an index that overshot.
    expect(at({ kcCount: 3, kcAnswered: 5 })).toBe(3)
  })

  it('a student who somehow answered the debrief mid-game still resumes into the loop', () => {
    // Play is not finished, so nothing downstream can claim them. gameOver is the gate.
    expect(at({ kcAnswered: 3, prepAnswered: true, debriefAnswered: true, roundsPlayed: 4 })).toBe(4)
  })

  it('gameOver is what ends the loop, NOT a round count the client computed', () => {
    // roundsPlayed at the configured total but the server has not said done: still the
    // loop. The server is the only thing that ends it.
    expect(at({ kcAnswered: 3, prepAnswered: true, roundsPlayed: 8, gameOver: false })).toBe(4)
  })
})

describe('the loop resumes at the right iteration', () => {
  it('is simply the rounds already stored', () => {
    expect(procurementStartIteration(0)).toBe(0)
    expect(procurementStartIteration(5)).toBe(5)
  })

  it('never goes negative on a malformed count', () => {
    expect(procurementStartIteration(-3)).toBe(0)
  })
})
