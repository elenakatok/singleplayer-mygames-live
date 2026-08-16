import { describe, it, expect } from 'vitest'
import { derivedKcRow, derivedKcExplanations, kcOptionLadder, KC_CELLS } from './derivedKc'
import type { PdPayoffs } from './api'

// ═══════════════════════════════════════════════════════════════════════════════
// The settings page's client-side mirror of the derived four.
//
// ⚠⚠ THE DRIFT PIN, HALF TWO OF TWO. Every literal string asserted here is asserted
// against the SERVER in functions/test/pdBattleOfTheSexes.test.ts, for the SAME
// fixture. Change either side's templates and one of the two suites fails.
// ═══════════════════════════════════════════════════════════════════════════════

/** The same two words the server-side suite uses. They appear nowhere else in the
 *  codebase, so a hit is never a coincidence. */
const OPERA = 'Zarquon'
const BOXING = 'Blorptide'

/** The same Battle of the Sexes fixture the server-side suite uses. */
const BOS: PdPayoffs = {
  you_cc: 2, you_cd: 0, you_dc: 0, you_dd: 1,
  other_cc: 1, other_cd: 0, other_dc: 0, other_dd: 2,
}
const LABELS = { C: OPERA, D: BOXING }

const rows = () => KC_CELLS.map(c => derivedKcRow(c.field, BOS, 'points', LABELS)!)

describe('DRIFT PIN — byte-identical to what the server resolves', () => {
  it('prompts', () => {
    const out = rows()
    expect(out.length).toBe(4)
    expect(out.map(r => r.prompt)).toEqual([
      `You choose ${OPERA} and the other player also chooses ${OPERA}. How many points do YOU get?`,
      `You choose ${OPERA} and the other player chooses ${BOXING}. How many points do YOU get?`,
      `You choose ${BOXING} and the other player chooses ${OPERA}. How many points do YOU get?`,
      `You choose ${BOXING} and the other player also chooses ${BOXING}. How many points do YOU get?`,
    ])
  })

  it('option ladder and correct answers', () => {
    const out = rows()
    expect(out.length).toBe(4)
    expect(out[0].options.map(o => o.label)).toEqual(['0 points', '1 point', '2 points'])
    expect(out.map(r => r.correctValue)).toEqual(['2', '0', '0', '1'])
  })

  it('explanations', () => {
    const e = derivedKcExplanations(BOS, 'points', LABELS)
    expect(Object.keys(e).length).toBe(4)
    expect(KC_CELLS.map(c => e[c.field])).toEqual([
      `When you both choose ${OPERA}, you each get 2 points.`,
      `Choosing ${OPERA} while they choose ${BOXING} gets you 0 points; they get 0 points.`,
      `Choosing ${BOXING} while they choose ${OPERA} gets you 0 points; they get 0 points.`,
      `When you both choose ${BOXING}, you each get 1 point.`,
    ])
  })
})

describe('⚠ the mirror carries the INSTANCE wording and nothing else', () => {
  const surface = JSON.stringify([rows(), derivedKcExplanations(BOS, 'points', LABELS)])

  it('the fixture actually reached the surface', () => {
    expect(rows().length).toBe(4)
    expect(surface).toContain(OPERA)
    expect(surface).toContain(BOXING)
  })

  it('⚠⚠ neither shipped default word appears ANYWHERE on it', () => {
    // THE POINT. A surface rendering both words would satisfy the presence assertion
    // above — which is exactly the defect this fix addresses.
    expect(surface).not.toContain('Cooperate')
    expect(surface).not.toContain('Defect')
  })

  it('every move name follows a rename, with no stale copy left behind', () => {
    const renamed = JSON.stringify(KC_CELLS.map(c => derivedKcRow(c.field, BOS, 'points',
      { C: 'Aaaa', D: 'Bbbb' })!))
    expect(renamed).toContain('Aaaa')
    expect(renamed).toContain('Bbbb')
    expect(renamed).not.toContain(OPERA)
    expect(renamed).not.toContain(BOXING)
  })
})

describe('the ladder does not assume four distinct values', () => {
  it('three distinct Y values → three options', () => {
    const l = kcOptionLadder(BOS, 'points')
    expect(l.length).toBe(3)
    expect(l.map(o => o.value)).toEqual(['0', '1', '2'])
  })

  it('two distinct Y values → two options', () => {
    const l = kcOptionLadder({ ...BOS, you_dd: 2 }, 'points')
    expect(l.length).toBe(2)
  })

  it('⚠ NEGATIVE CONTROL — pd’s default matrix still yields four', () => {
    const l = kcOptionLadder({
      you_cc: 1, you_cd: 15, you_dc: 0, you_dd: 10,
      other_cc: 1, other_cd: 0, other_dc: 15, other_dd: 10,
    }, 'years')
    expect(l.length).toBe(4)
    expect(l.map(o => o.value)).toEqual(['0', '1', '10', '15'])
  })

  it('negative payoffs sort correctly in the ladder', () => {
    const l = kcOptionLadder({
      you_cc: 3, you_cd: -5, you_dc: 4, you_dd: -1,
      other_cc: 3, other_cd: 4, other_dc: -5, other_dd: -1,
    }, 'points')
    expect(l.length).toBe(4)
    expect(l.map(o => o.value)).toEqual(['-5', '-1', '3', '4'])
  })
})
