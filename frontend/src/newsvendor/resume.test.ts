import { describe, it, expect } from 'vitest'
import { newsvendorResumeIndex, newsvendorScreenCount, newsvendorStartIteration } from './resume'

// ═══════════════════════════════════════════════════════════════════════════════
// Where a returning student re-enters the flow.
//
// This file exists because index arithmetic here produces silent off-by-ones: the two
// failure modes are invisible in a happy-path click-through — a student sent back through
// a question the server has already locked (they see it answered and disabled), or a
// finished student shown the final screen twice with a Continue button that leads nowhere.
//
// The screen layout under test:
//
//   [PRE stage 0…n−1]  [the loop]  [final results]  [POST stage 0…m−1]
//
// ⚠⚠ BOTH SEGMENTS ARE LISTS NOW. They were four booleans — prep on/off + submitted,
// debrief on/off + submitted — because each was one optional screen. Each stage can now
// hold its paragraph PLUS any question the instructor put there, so the input is one
// answered-flag per row. The old cases survive verbatim in MEANING: a pre stage of
// "10 KC + prep" is an 11-element array, and a post stage of "the debrief" is a 1-element
// one. Every assertion is written against newsvendorScreenCount rather than a literal, so
// the two functions cannot drift apart.
// ═══════════════════════════════════════════════════════════════════════════════

/** n flags, all the same. */
const flags = (n: number, v: boolean) => Array.from({ length: n }, () => v)

/** The shipped shape: ten graded questions + the prep row = 11 pre rows; 1 post row. */
const PRE = 11
const POST = 1
const COUNT = newsvendorScreenCount(PRE, POST)

const idx = (over: Partial<Parameters<typeof newsvendorResumeIndex>[0]> = {}) =>
  newsvendorResumeIndex({
    gameOver: false,
    preAnswered: flags(PRE, false),
    postAnswered: flags(POST, false),
    ...over,
  })

/** "k pre rows already done", the old `kcAnswered` in list form. */
const preDone = (k: number, total = PRE) =>
  Array.from({ length: total }, (_, i) => i < k)

describe('newsvendorScreenCount', () => {
  it('counts the pre stage + loop + final + the post stage', () => {
    expect(COUNT).toBe(11 + 1 + 1 + 1)
  })
  it('drops a screen when the prep row is hidden', () => {
    expect(newsvendorScreenCount(PRE - 1, POST)).toBe(COUNT - 1)
  })
  it('drops a screen when the debrief row is hidden', () => {
    expect(newsvendorScreenCount(PRE, 0)).toBe(COUNT - 1)
  })
  it('collapses the whole KC segment when the KC is off', () => {
    expect(newsvendorScreenCount(PRE - 10, POST)).toBe(COUNT - 10)
  })
  it('⚠ grows when the instructor ADDS a question to a stage', () => {
    expect(newsvendorScreenCount(PRE + 1, POST)).toBe(COUNT + 1)
    expect(newsvendorScreenCount(PRE, POST + 2)).toBe(COUNT + 2)
  })
})

describe('newsvendorResumeIndex — the pre stage comes FIRST', () => {
  it('sends a brand-new student to pre row 1', () => {
    expect(idx()).toBe(0)
  })

  it('sends a part-way student to the next UNANSWERED row', () => {
    expect(idx({ preAnswered: preDone(1) })).toBe(1)
    expect(idx({ preAnswered: preDone(7) })).toBe(7)
    expect(idx({ preAnswered: preDone(10) })).toBe(10)
  })

  it('never re-serves an answered row — the server has locked it', () => {
    for (let answered = 0; answered < PRE; answered++) {
      expect(idx({ preAnswered: preDone(answered) })).toBe(answered)
    }
  })

  it('⚠⚠ a GAP in the pre stage resumes AT the gap, not past it', () => {
    // MUTANT CAUGHT: treating the flags as a count. Only equivalent while the answered
    // rows are a solid prefix; on a gap it skips the unanswered row and leaves a question
    // permanently unanswerable with the denominator silently short.
    const gapped = preDone(PRE)          // all true…
    gapped[3] = false                    // …except row 3
    expect(idx({ preAnswered: gapped })).toBe(3)
  })

  it('goes to the loop once every pre row is done', () => {
    expect(idx({ preAnswered: flags(PRE, true) })).toBe(PRE)
  })

  it('puts the loop first when the whole pre stage is empty', () => {
    expect(idx({ preAnswered: [] })).toBe(0)
  })
})

describe('newsvendorResumeIndex — after the game', () => {
  const finished = { preAnswered: flags(PRE, true), gameOver: true }

  it('shows the final-results screen, then the post stage', () => {
    // 11 pre rows → the loop is 11, the final screen 12, the first post row 13.
    expect(idx(finished)).toBe(12)
    expect(idx(finished)).toBeLessThan(COUNT)
  })

  it('is PAST THE END once every post row is answered', () => {
    // ⚠ The regression this guards: returning a post row's own index here would re-serve a
    // paragraph the server has already stored.
    expect(idx({ ...finished, postAnswered: flags(POST, true) })).toBeGreaterThanOrEqual(COUNT)
  })

  it('is PAST THE END immediately when the post stage is empty', () => {
    // ⚠ And this one: a finished student with nothing left must NOT land on the final
    // screen as a sequence step, because Play.tsx renders the same component as the
    // terminal state — they would see it twice, the second time with a Continue button
    // that leads nowhere.
    const noPost = newsvendorScreenCount(PRE, 0)
    expect(idx({ ...finished, postAnswered: [] })).toBeGreaterThanOrEqual(noPost)
  })

  it('⚠⚠ lands on the FIRST UNANSWERED post row, not back on the results screen', () => {
    // MUTANT CAUGHT: always returning the results index while anything is unanswered — a
    // student part-way through the post stage would be walked back through their own
    // stored paragraph, which newsvendorSubmitFreeText returns rather than re-accepting.
    const three = { ...finished, postAnswered: [false, false, false] }
    expect(idx(three)).toBe(12)                                      // results first
    expect(idx({ ...three, postAnswered: [true, false, false] })).toBe(14)
    expect(idx({ ...three, postAnswered: [true, true, false] })).toBe(15)
    expect(idx({ ...three, postAnswered: [true, true, true] }))
      .toBe(newsvendorScreenCount(PRE, 3))
  })

  it('⚠ a GAP in the post stage resumes AT the gap', () => {
    expect(idx({ ...finished, postAnswered: [true, false, true] })).toBe(14)
  })

  it('stays inside the sequence while the game is still running', () => {
    expect(idx({ preAnswered: flags(PRE, true) })).toBeLessThan(COUNT)
  })

  it('⚠ the post stage is never entered before the game is over', () => {
    expect(idx({ preAnswered: flags(PRE, true), gameOver: false, postAnswered: [false, false] }))
      .toBe(PRE)
  })
})

describe('newsvendorResumeIndex — the index is always renderable', () => {
  // A resume index is only ever legal if it is a screen that exists, or exactly the
  // "past the end" sentinel. Sweeping the state space is cheap and would have caught the
  // off-by-one this file was written for.
  //
  // ⚠ The sweep now enumerates every ANSWER PATTERN, not just prefixes — 2^n over small
  // stages — because the gap cases are exactly what the boolean[] shape exists to handle.
  const patterns = (n: number): boolean[][] =>
    n === 0 ? [[]] : Array.from({ length: 1 << n }, (_, m) =>
      Array.from({ length: n }, (_, i) => (m & (1 << i)) !== 0))

  it('never returns an index outside [0, screenCount] for any reachable state', () => {
    let checked = 0
    for (const preCount of [0, 1, 3]) {
      for (const postCount of [0, 1, 3]) {
        const total = newsvendorScreenCount(preCount, postCount)
        for (const preAnswered of patterns(preCount)) {
          for (const postAnswered of patterns(postCount)) {
            for (const gameOver of [true, false]) {
              const v = newsvendorResumeIndex({ gameOver, preAnswered, postAnswered })
              expect(v).toBeGreaterThanOrEqual(0)
              expect(v).toBeLessThanOrEqual(total)
              checked++
            }
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(200)
  })

  it('⚠ and never points INTO the post stage before the game is over', () => {
    for (const preCount of [0, 1, 3]) {
      for (const postAnswered of patterns(3)) {
        const v = newsvendorResumeIndex({
          gameOver: false, preAnswered: Array.from({ length: preCount }, () => true), postAnswered,
        })
        expect(v).toBeLessThanOrEqual(preCount)
      }
    }
  })
})

describe('newsvendorStartIteration', () => {
  it('is the first period not yet played', () => {
    expect(newsvendorStartIteration(0)).toBe(0)
    expect(newsvendorStartIteration(7)).toBe(7)
  })
  it('never goes negative', () => {
    expect(newsvendorStartIteration(-3)).toBe(0)
  })
})
