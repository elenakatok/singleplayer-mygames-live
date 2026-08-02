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

describe('forecastResumeIndex', () => {
  const base = {
    gameOver: false, kcCount: KC, kcAnswered: 0,
    debriefEnabled: true, debriefSubmitted: false,
  }

  it('starts a brand-new student at the first KC question', () => {
    expect(forecastResumeIndex(base)).toBe(0)
  })

  it('returns to the next unanswered KC question', () => {
    expect(forecastResumeIndex({ ...base, kcAnswered: 4 })).toBe(4)
    expect(forecastResumeIndex({ ...base, kcAnswered: KC - 1 })).toBe(KC - 1)
  })

  it('moves to the month loop once every KC question is answered', () => {
    expect(forecastResumeIndex({ ...base, kcAnswered: KC })).toBe(KC)
  })

  it('with the KC off, a fresh student starts in the loop', () => {
    expect(forecastResumeIndex({ ...base, kcCount: 0, kcAnswered: 0 })).toBe(0)
  })

  it('a finished student with an unanswered debrief lands on the final screen', () => {
    // The final screen, THEN the debrief — the student sees their results before being
    // asked to describe how they got them.
    expect(forecastResumeIndex({
      ...base, kcAnswered: KC, gameOver: true, debriefSubmitted: false,
    })).toBe(KC + 1)
  })

  it('a finished student who has written the debrief is PAST the end', () => {
    const idx = forecastResumeIndex({
      ...base, kcAnswered: KC, gameOver: true, debriefSubmitted: true,
    })
    expect(idx).toBe(KC + 3)
    expect(idx).toBeGreaterThanOrEqual(forecastScreenCount(KC, true))
  })

  it('a finished student on an instance with NO debrief is also past the end', () => {
    // ⚠ Not "sitting on the final screen": Play.tsx renders the same component as the
    // terminal state, so returning the final screen's index would show it twice with a
    // Continue button that leads nowhere.
    const idx = forecastResumeIndex({
      ...base, kcAnswered: KC, gameOver: true, debriefEnabled: false,
    })
    expect(idx).toBe(KC + 2)
    expect(idx).toBeGreaterThanOrEqual(forecastScreenCount(KC, false))
  })

  it('the KC comes FIRST — an unfinished game does not skip it', () => {
    // Spec §4's flow line is instructions → KC → loop. A student who has played
    // nothing and answered nothing must land on the KC, not on month 1.
    expect(forecastResumeIndex({ ...base, kcAnswered: 3, gameOver: false })).toBe(3)
  })
})

describe('forecastScreenCount', () => {
  it('counts the KC, the loop, the final screen and the debrief', () => {
    expect(forecastScreenCount(KC, true)).toBe(KC + 3)
    expect(forecastScreenCount(KC, false)).toBe(KC + 2)
    expect(forecastScreenCount(0, false)).toBe(2)
  })

  it('agrees with every "past the end" value forecastResumeIndex can return', () => {
    for (const debriefEnabled of [true, false]) {
      const done = forecastResumeIndex({
        gameOver: true, kcCount: KC, kcAnswered: KC,
        debriefEnabled, debriefSubmitted: true,
      })
      expect(done).toBe(forecastScreenCount(KC, debriefEnabled))
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
