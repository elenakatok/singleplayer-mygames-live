import { describe, it, expect } from 'vitest'
import { forecastResumeIndex, forecastScreenCount, forecastStartIteration } from './resume'

// ═══════════════════════════════════════════════════════════════════════════════
// Resume arithmetic (spec §4: "self-paced, closeable, resumable").
//
// An off-by-one here puts a student back through a KC question the server has already
// locked, or onto a month they have already forecast — and the server would refuse the
// resubmit, so the symptom is a stuck screen rather than a wrong answer. Every branch
// is covered, including the two "past the end" cases that differ only by whether the
// debrief is enabled.
// ═══════════════════════════════════════════════════════════════════════════════

const KC = 9      // spec §8 ships nine authored questions

/** `n` answered, then the rest outstanding — the ordinary prefix case. */
const pre = (answered: number, total = KC) =>
  Array.from({ length: total }, (_, i) => i < answered)

describe('forecastResumeIndex', () => {
  const base = { gameOver: false, preAnswered: pre(0), postAnswered: [false] }

  it('starts a brand-new student at the first KC question', () => {
    expect(forecastResumeIndex(base)).toBe(0)
  })

  it('returns to the next unanswered KC question', () => {
    expect(forecastResumeIndex({ ...base, preAnswered: pre(4) })).toBe(4)
    expect(forecastResumeIndex({ ...base, preAnswered: pre(KC - 1) })).toBe(KC - 1)
  })

  it('moves to the month loop once every pre-stage row is answered', () => {
    expect(forecastResumeIndex({ ...base, preAnswered: pre(KC) })).toBe(KC)
  })

  it('with an empty pre stage, a fresh student starts in the loop', () => {
    expect(forecastResumeIndex({ ...base, preAnswered: [] })).toBe(0)
  })

  it('a finished student with an unanswered debrief lands on the final screen', () => {
    // The final screen, THEN the post stage — the student sees their results before being
    // asked to describe how they got them.
    expect(forecastResumeIndex({ preAnswered: pre(KC), gameOver: true, postAnswered: [false] }))
      .toBe(KC + 1)
  })

  it('a finished student who has written the debrief is PAST the end', () => {
    const idx = forecastResumeIndex({ preAnswered: pre(KC), gameOver: true, postAnswered: [true] })
    expect(idx).toBe(KC + 3)
    expect(idx).toBeGreaterThanOrEqual(forecastScreenCount(KC, 1))
  })

  it('a finished student on an instance with NO post stage is also past the end', () => {
    // ⚠ Not "sitting on the final screen": Play.tsx renders the same component as the
    // terminal state, so returning the final screen's index would show it twice with a
    // Continue button that leads nowhere.
    const idx = forecastResumeIndex({ preAnswered: pre(KC), gameOver: true, postAnswered: [] })
    expect(idx).toBe(KC + 2)
    expect(idx).toBeGreaterThanOrEqual(forecastScreenCount(KC, 0))
  })

  it('the KC comes FIRST — an unfinished game does not skip it', () => {
    // Spec §4's flow line is instructions → KC → loop. A student who has played
    // nothing and answered nothing must land on the KC, not on month 1.
    expect(forecastResumeIndex({ ...base, preAnswered: pre(3), gameOver: false })).toBe(3)
  })

  // ── The multi-row post stage (this pass) ────────────────────────────────────

  it('⚠ PART-WAY THROUGH THE POST STAGE, the results screen is BEHIND them', () => {
    // MUTANT: return `preCount + 1` for any unanswered post row. → fails. Re-showing the
    // results screen every time a student returns mid-stage is a step backwards, and with
    // three rows it would be three steps backwards.
    expect(forecastResumeIndex({
      preAnswered: pre(KC), gameOver: true, postAnswered: [true, false, false],
    })).toBe(KC + 3)
    expect(forecastResumeIndex({
      preAnswered: pre(KC), gameOver: true, postAnswered: [true, true, false],
    })).toBe(KC + 4)
  })

  it('a finished multi-row post stage is past the end', () => {
    const idx = forecastResumeIndex({
      preAnswered: pre(KC), gameOver: true, postAnswered: [true, true, true],
    })
    expect(idx).toBe(forecastScreenCount(KC, 3))
  })

  it('⚠⚠ RESUMES ACROSS A GAP — a count would land on the wrong row', () => {
    // MUTANT: `postAnswered.filter(Boolean).length` instead of `findIndex(a => !a)`.
    // → fails on BOTH halves. The rows an instructor reorders are not answered in order,
    // so "how many are done" is not "where they are". Same for the pre stage.
    expect(forecastResumeIndex({
      preAnswered: [true, false, true, false], gameOver: false, postAnswered: [false],
    })).toBe(1)
    expect(forecastResumeIndex({
      preAnswered: pre(KC), gameOver: true, postAnswered: [false, true, true],
    })).toBe(KC + 1)   // nothing before it is answered ⇒ the results screen first
    expect(forecastResumeIndex({
      preAnswered: pre(KC), gameOver: true, postAnswered: [true, false, true],
    })).toBe(KC + 3)
  })

  it('⚠ an unfinished game keeps them out of the post stage entirely', () => {
    expect(forecastResumeIndex({
      preAnswered: pre(KC), gameOver: false, postAnswered: [false, false],
    })).toBe(KC)
  })
})

describe('forecastScreenCount', () => {
  it('counts the pre stage, the loop, the final screen and the post stage', () => {
    expect(forecastScreenCount(KC, 1)).toBe(KC + 3)
    expect(forecastScreenCount(KC, 0)).toBe(KC + 2)
    expect(forecastScreenCount(0, 0)).toBe(2)
    expect(forecastScreenCount(KC, 3)).toBe(KC + 5)
  })

  it('agrees with every "past the end" value forecastResumeIndex can return', () => {
    for (const postCount of [0, 1, 2, 3]) {
      const done = forecastResumeIndex({
        gameOver: true,
        preAnswered: pre(KC),
        postAnswered: Array.from({ length: postCount }, () => true),
      })
      expect(done).toBe(forecastScreenCount(KC, postCount))
    }
  })
})

describe('forecastStartIteration', () => {
  it('is the number of months already played', () => {
    expect(forecastStartIteration(0)).toBe(0)
    expect(forecastStartIteration(7)).toBe(7)
  })

  it('never goes negative on a malformed count', () => {
    expect(forecastStartIteration(-3)).toBe(0)
  })
})
