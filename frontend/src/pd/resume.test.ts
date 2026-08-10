import { describe, it, expect } from 'vitest'
import { resumeIndex, screenCount } from './resume'

// Resume is the one place an off-by-one puts a student on the wrong screen — or back
// through a KC question they already answered, which the server would then refuse
// (the per-question lock returns the stored verdict). Screen layout:
//   [KC 0…3] [loop at 4] [POST STAGE 5…]
//
// ⚠ THE POST SEGMENT IS A LIST NOW. It used to be "the debrief, if enabled" — one
// optional screen described by two booleans. The `post` stage can hold the debrief row
// PLUS any question the instructor put after play, so the input is one answered-flag per
// row, in served order. The single-debrief cases below are kept verbatim in meaning: a
// one-element array IS the old shape.

/** The old world, restated: 4 KC questions and exactly one post row (the debrief). */
const at = (kcAnswered: number, gameOver: boolean, debriefSubmitted: boolean) =>
  resumeIndex({ kcCount: 4, kcAnswered, gameOver, postAnswered: [debriefSubmitted] })

describe('resumeIndex — where the student re-enters the flow', () => {
  it('starts a brand-new student on the first KC question', () => {
    expect(at(0, false, false)).toBe(0)
  })

  it('returns a mid-KC student to their first UNANSWERED question', () => {
    expect(at(1, false, false)).toBe(1)
    expect(at(3, false, false)).toBe(3)
  })

  it('sends a student who finished the KC into the round loop', () => {
    expect(at(4, false, false)).toBe(4)
  })

  it('sends a student whose game is over to the first after-play question', () => {
    expect(at(4, true, false)).toBe(5)
  })

  it('sends a fully finished student past the last screen', () => {
    expect(at(4, true, true)).toBe(6)
  })

  it('never skips the KC just because the game is over', () => {
    // Defensive: a student cannot reach game-over with the KC unanswered, but if the
    // data ever said so, the KC is still the right place to put them — not the loop.
    expect(at(2, true, false)).toBe(2)
  })

  it('handles a KC of any length — added questions make the count instructor-set', () => {
    expect(resumeIndex({ kcCount: 6, kcAnswered: 6, gameOver: false, postAnswered: [false] })).toBe(6)
    expect(resumeIndex({ kcCount: 0, kcAnswered: 0, gameOver: false, postAnswered: [false] })).toBe(0)
    expect(resumeIndex({ kcCount: 0, kcAnswered: 0, gameOver: true, postAnswered: [true] })).toBe(2)
  })
})

describe('⚠⚠ resumeIndex — the AFTER-PLAY stage is a LIST', () => {
  it('lands on the FIRST UNANSWERED post-stage question, not the first one', () => {
    // MUTANT CAUGHT: always resuming at the start of the stage (`return kcCount + 1`).
    // A student who wrote the debrief and closed the tab before the added question would
    // be sent back through a paragraph the server has already stored — and pdSubmitDebrief
    // returns the stored answer rather than accepting a new one, so they would be stuck
    // re-reading their own text with no way forward.
    const post = (flags: boolean[]) =>
      resumeIndex({ kcCount: 4, kcAnswered: 4, gameOver: true, postAnswered: flags })

    expect(post([false, false, false])).toBe(5)   // nothing done → first row
    expect(post([true, false, false])).toBe(6)    // debrief done → second row
    expect(post([true, true, false])).toBe(7)     // two done → third row
    expect(post([true, true, true])).toBe(8)      // all done → past the end
  })

  it('⚠ a GAP resumes at the gap, not past it', () => {
    // MUTANT CAUGHT: treating the flags as a COUNT (`kcCount + 1 + answered.filter(Boolean).length`).
    // That is only equivalent while the answered rows are a solid prefix. A student with
    // row 2 stored but not row 1 must go back to row 1; a count would skip it and leave a
    // question permanently unanswered, silently short in the denominator.
    expect(resumeIndex({ kcCount: 4, kcAnswered: 4, gameOver: true, postAnswered: [false, true, true] }))
      .toBe(5)
    expect(resumeIndex({ kcCount: 4, kcAnswered: 4, gameOver: true, postAnswered: [true, false, true] }))
      .toBe(6)
  })

  it('an EMPTY post stage means finishing the game finishes the whole flow', () => {
    // The instructor hid the debrief AND every after-play addition.
    const idx = resumeIndex({ kcCount: 4, kcAnswered: 4, gameOver: true, postAnswered: [] })
    expect(idx).toBe(5)
    expect(idx).toBeGreaterThanOrEqual(screenCount(4, 0))
  })

  it('the post stage is never entered before the game is over', () => {
    // MUTANT CAUGHT: checking the post flags before `gameOver`. The after-play questions
    // are after play — serving one mid-game would ask a student to reflect on rounds they
    // have not played.
    expect(resumeIndex({ kcCount: 4, kcAnswered: 4, gameOver: false, postAnswered: [false, false] }))
      .toBe(4)
  })
})

describe('resumeIndex — the KC and the post stage can each be switched OFF', () => {
  it('with the KC off, a new student starts straight in the round loop', () => {
    expect(resumeIndex({ kcCount: 0, kcAnswered: 0, gameOver: false, postAnswered: [false] })).toBe(0)
    expect(screenCount(0, 1)).toBe(2)
  })

  it('with the debrief off and nothing added, finishing the game finishes the flow', () => {
    const idx = resumeIndex({ kcCount: 4, kcAnswered: 4, gameOver: true, postAnswered: [] })
    expect(idx).toBe(5)
    expect(idx).toBeGreaterThanOrEqual(screenCount(4, 0))
  })

  it('with both off, the whole flow is just the round loop', () => {
    expect(screenCount(0, 0)).toBe(1)
    expect(resumeIndex({ kcCount: 0, kcAnswered: 0, gameOver: false, postAnswered: [] })).toBe(0)
    expect(resumeIndex({ kcCount: 0, kcAnswered: 0, gameOver: true, postAnswered: [] })).toBe(1)
  })

  it('⚠ the debrief off but a question ADDED after play still gives a post stage', () => {
    // The two are independent: `debriefEnabled` governs one row, not the segment.
    expect(screenCount(4, 1)).toBe(6)
    expect(resumeIndex({ kcCount: 4, kcAnswered: 4, gameOver: true, postAnswered: [false] })).toBe(5)
  })

  it('screenCount matches the sequence the flow actually builds', () => {
    expect(screenCount(4, 1)).toBe(6)    // 4 KC + loop + debrief
    expect(screenCount(4, 0)).toBe(5)    // 4 KC + loop
    expect(screenCount(6, 1)).toBe(8)    // 4 derived + 2 added + loop + debrief
    expect(screenCount(4, 3)).toBe(8)    // 4 KC + loop + debrief + 2 after-play additions
  })
})
