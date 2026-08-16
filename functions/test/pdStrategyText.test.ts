import { describe, it, expect } from 'vitest'
import { strategyDisplayName, strategyRevealLine } from '../src/pd/strategyText'
import { STRATEGIES } from '../src/pd/strategy'

// ═══════════════════════════════════════════════════════════════════════════════
// Strategy display names and debrief reveal lines.
//
// ⚠⚠ DRIFT PIN, HALF ONE OF TWO. `frontend/src/pd/strategyText.test.ts` asserts the
// settings page's client mirror produces the SAME display names for the SAME fixture.
// Edit either side and its own suite fails.
// ═══════════════════════════════════════════════════════════════════════════════

/** Two words used nowhere else in this repo, so a hit is never a coincidence. */
const OPERA = 'Zarquon'
const BOXING = 'Blorptide'
const LABELS = { C: OPERA, D: BOXING }

describe('display names', () => {
  it('DRIFT PIN — the exact strings the client mirror must reproduce', () => {
    expect(STRATEGIES.map(s => strategyDisplayName(s, LABELS))).toEqual([
      'Tit-for-tat',
      'Grim',
      'Random',
      `Always ${OPERA}`,
      `Always ${BOXING}`,
      'Alternating',
      'Match-and-stay',
    ])
  })

  it('every id has a name and no two share one', () => {
    const names = STRATEGIES.map(s => strategyDisplayName(s, LABELS))
    expect(names.length).toBe(7)
    expect(new Set(names).size).toBe(7)
    expect(names.every(n => n.trim().length > 0)).toBe(true)
  })
})

describe('⚠ the wording fields are interpolated everywhere a move is named', () => {
  const surface = JSON.stringify([
    STRATEGIES.map(s => strategyDisplayName(s, LABELS)),
    STRATEGIES.map(s => strategyRevealLine(s, LABELS)),
  ])

  it('the fixture actually reached the surface (guards the absence assertion)', () => {
    expect(surface).toContain(OPERA)
    expect(surface).toContain(BOXING)
  })

  it('⚠⚠ neither shipped default word appears ANYWHERE on it', () => {
    // THE POINT. Asserting only that the new words are present passes against a surface
    // showing both — the same failure the KC label fix guarded against.
    expect(surface).not.toContain('Cooperate')
    expect(surface).not.toContain('Defect')
  })

  it('a rename leaves no stale copy behind', () => {
    const renamed = JSON.stringify([
      STRATEGIES.map(s => strategyDisplayName(s, { C: 'Aaaa', D: 'Bbbb' })),
      STRATEGIES.map(s => strategyRevealLine(s, { C: 'Aaaa', D: 'Bbbb' })),
    ])
    expect(renamed).toContain('Aaaa')
    expect(renamed).toContain('Bbbb')
    expect(renamed).not.toContain(OPERA)
    expect(renamed).not.toContain(BOXING)
  })

  it('⚠ NOTHING IS CALLED PAVLOV', () => {
    expect(surface.toLowerCase()).not.toContain('pavlov')
  })
})

describe('the debrief reveal lines', () => {
  const reveal = (s: Parameters<typeof strategyRevealLine>[0]) => strategyRevealLine(s, LABELS)

  it('the five new lines are exactly as specified', () => {
    expect(reveal('random')).toBe(
      `This opponent chose ${OPERA} or ${BOXING} at random each round, with equal `
      + 'probability. Nothing you did changed what it played.')
    expect(reveal('always_first')).toBe(
      `This opponent chose ${OPERA} every round, whatever you did.`)
    expect(reveal('always_second')).toBe(
      `This opponent chose ${BOXING} every round, whatever you did.`)
    expect(reveal('alternate')).toBe(
      `This opponent switched between ${OPERA} and ${BOXING} every round, starting `
      + `with ${OPERA}. It never reacted to your choices.`)
    expect(reveal('match_stay')).toBe(
      'This opponent repeated its own previous choice whenever the two of you had '
      + 'chosen the same thing, and switched whenever you had chosen differently.')
  })

  it('every id has a reveal line, in the existing voice', () => {
    const lines = STRATEGIES.map(reveal)
    expect(lines.length).toBe(7)
    expect(new Set(lines).size).toBe(7)
    for (const l of lines) {
      expect(l.startsWith('This opponent ')).toBe(true)
      expect(l.endsWith('.')).toBe(true)
    }
  })
})
