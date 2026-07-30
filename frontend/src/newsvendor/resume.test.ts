import { describe, it, expect } from 'vitest'
import { newsvendorResumeIndex, newsvendorScreenCount, newsvendorStartIteration } from './resume'

// ═══════════════════════════════════════════════════════════════════════════════
// Where a returning student re-enters the flow, after the KC moved to the FRONT.
//
// This file exists because that move is exactly the kind of change that produces a
// silent off-by-one: every index downstream of the KC shifted, and the two failure
// modes are invisible in a happy-path click-through — a student sent back through a
// question the server has already locked (they see it answered and disabled), or a
// finished student shown the final screen twice with a Continue button that leads
// nowhere.
//
// The screen layout under test:
//
//   [KC 0…n−1]  [prep?]  [the loop]  [final results]  [debrief?]
//
// Every assertion is written against newsvendorScreenCount rather than a literal, so
// the two functions cannot drift apart.
// ═══════════════════════════════════════════════════════════════════════════════

/** The shipped shape: ten graded questions, prep on, debrief on. */
const FULL = { prepEnabled: true, kcCount: 10, debriefEnabled: true }
const idx = (over: Partial<Parameters<typeof newsvendorResumeIndex>[0]>) =>
  newsvendorResumeIndex({
    prepEnabled: true, prepSubmitted: false, gameOver: false,
    kcCount: 10, kcAnswered: 0, debriefEnabled: true, debriefSubmitted: false,
    ...over,
  })

const COUNT = newsvendorScreenCount(FULL.prepEnabled, FULL.kcCount, FULL.debriefEnabled)

describe('newsvendorScreenCount', () => {
  it('counts KC + prep + loop + final + debrief', () => {
    expect(COUNT).toBe(10 + 1 + 1 + 1 + 1)
  })
  it('drops the prep screen when the prep is off', () => {
    expect(newsvendorScreenCount(false, 10, true)).toBe(COUNT - 1)
  })
  it('drops the debrief screen when the debrief is off', () => {
    expect(newsvendorScreenCount(true, 10, false)).toBe(COUNT - 1)
  })
  it('collapses the whole KC segment when the KC is off', () => {
    expect(newsvendorScreenCount(true, 0, true)).toBe(COUNT - 10)
  })
})

describe('newsvendorResumeIndex — the knowledge check comes FIRST', () => {
  it('sends a brand-new student to KC question 1, not to the prep', () => {
    expect(idx({})).toBe(0)
  })

  it('sends a part-way student to the next UNANSWERED question', () => {
    expect(idx({ kcAnswered: 1 })).toBe(1)
    expect(idx({ kcAnswered: 7 })).toBe(7)
    expect(idx({ kcAnswered: 9 })).toBe(9)
  })

  it('never re-serves an answered question — the server has locked it', () => {
    for (let answered = 0; answered < 10; answered++) {
      expect(idx({ kcAnswered: answered })).toBe(answered)
    }
  })
})

describe('newsvendorResumeIndex — the prep sits between the KC and the loop', () => {
  it('lands on the prep once every question is answered', () => {
    expect(idx({ kcAnswered: 10 })).toBe(10)
  })

  it('skips straight to the loop when the prep is already written', () => {
    expect(idx({ kcAnswered: 10, prepSubmitted: true })).toBe(11)
  })

  it('skips the prep screen entirely when the instructor turned it off', () => {
    // No prep screen ⇒ the loop takes index 10, right after the KC.
    expect(idx({ kcAnswered: 10, prepEnabled: false })).toBe(10)
  })

  it('puts the loop first when the KC is off too', () => {
    expect(idx({ kcCount: 0, kcAnswered: 0, prepEnabled: false })).toBe(0)
  })
})

describe('newsvendorResumeIndex — after the game', () => {
  const finished = { kcAnswered: 10, prepSubmitted: true, gameOver: true }

  it('shows the final-results screen, then the debrief', () => {
    // 10 KC + 1 prep = 11 → the loop is 11, the final screen is 12, the debrief 13.
    expect(idx(finished)).toBe(12)
    expect(idx(finished)).toBeLessThan(COUNT)
  })

  it('is PAST THE END once the debrief is submitted', () => {
    // ⚠ The regression this guards: returning the debrief's own index here would
    // re-serve a paragraph the server has already stored.
    expect(idx({ ...finished, debriefSubmitted: true })).toBeGreaterThanOrEqual(COUNT)
  })

  it('is PAST THE END immediately when there is no debrief', () => {
    // ⚠ And this one: a finished student with no debrief must NOT land on the final
    // screen as a sequence step, because Play.tsx renders the same component as the
    // terminal state — they would see it twice, the second time with a Continue
    // button that leads nowhere.
    const noDebrief = newsvendorScreenCount(true, 10, false)
    expect(idx({ ...finished, debriefEnabled: false })).toBeGreaterThanOrEqual(noDebrief)
  })

  it('stays inside the sequence while the game is still running', () => {
    expect(idx({ kcAnswered: 10, prepSubmitted: true })).toBeLessThan(COUNT)
  })
})

describe('newsvendorResumeIndex — the index is always renderable', () => {
  // A resume index is only ever legal if it is a screen that exists, or exactly the
  // "past the end" sentinel. Sweeping the whole state space is cheap here and would
  // have caught the off-by-one this file was written for.
  it('never returns an index outside [0, screenCount] for any reachable state', () => {
    let checked = 0
    for (const prepEnabled of [true, false]) {
      for (const debriefEnabled of [true, false]) {
        for (const kcCount of [0, 1, 10]) {
          const total = newsvendorScreenCount(prepEnabled, kcCount, debriefEnabled)
          for (let kcAnswered = 0; kcAnswered <= kcCount; kcAnswered++) {
            for (const prepSubmitted of [true, false]) {
              for (const gameOver of [true, false]) {
                for (const debriefSubmitted of [true, false]) {
                  const v = newsvendorResumeIndex({
                    prepEnabled, prepSubmitted, gameOver, kcCount, kcAnswered,
                    debriefEnabled, debriefSubmitted,
                  })
                  expect(v).toBeGreaterThanOrEqual(0)
                  expect(v).toBeLessThanOrEqual(total)
                  checked++
                }
              }
            }
          }
        }
      }
    }
    // Assert the sweep actually ran rather than trusting an empty loop.
    // 2 prep × 2 debrief × (1 + 2 + 11 kcAnswered values) × 2 prepSubmitted
    //   × 2 gameOver × 2 debriefSubmitted = 448.
    expect(checked).toBe(448)
  })
})

describe('newsvendorStartIteration', () => {
  it('is the count of periods already played', () => {
    expect(newsvendorStartIteration(0)).toBe(0)
    expect(newsvendorStartIteration(7)).toBe(7)
  })
  it('never goes negative', () => {
    expect(newsvendorStartIteration(-3)).toBe(0)
  })
})
