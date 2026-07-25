import { describe, it, expect } from 'vitest'
import { resumeIndex } from './resume'

// Resume is the one place an off-by-one puts a student on the wrong screen — or back
// through a KC question they already answered, which the server would then refuse
// (the per-question lock returns the stored verdict). Screen layout:
//   [KC 0…3] [loop at 4] [debrief at 5]  ⇒  6 means "everything is done".

const at = (kcAnswered: number, gameOver: boolean, debriefSubmitted: boolean) =>
  resumeIndex({ kcCount: 4, kcAnswered, gameOver, debriefSubmitted })

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

  it('sends a student whose game is over to the debrief', () => {
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

  it('handles a KC of any length (a future admin-defaults doc may change the count)', () => {
    expect(resumeIndex({ kcCount: 6, kcAnswered: 6, gameOver: false, debriefSubmitted: false })).toBe(6)
    expect(resumeIndex({ kcCount: 0, kcAnswered: 0, gameOver: false, debriefSubmitted: false })).toBe(0)
    expect(resumeIndex({ kcCount: 0, kcAnswered: 0, gameOver: true, debriefSubmitted: true })).toBe(2)
  })
})
