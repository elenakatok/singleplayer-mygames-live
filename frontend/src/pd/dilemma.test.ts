import { describe, it, expect } from 'vitest'
import {
  warnNotADilemma, isDilemmaHigherIsBetter, isDilemmaLowerIsBetter, NOT_A_DILEMMA_WARNING,
} from './dilemma'
import type { PdPayoffs } from './api'

// The advisory not-a-dilemma check. Every case here names WHICH reading it exercises,
// because the whole design of the check is that there are two of them.

/** The shipped default matrix, in the eight-value shape: 1 / 15 / 0 / 10, prison-years,
 *  so it is a dilemma under LOWER-is-better. This is the negative control for the whole
 *  feature — if it ever warns, the check is wrong, not the matrix. */
const DEFAULTS: PdPayoffs = {
  you_cc: 1, you_cd: 15, you_dc: 0, you_dd: 10,
  other_cc: 1, other_cd: 0, other_dc: 15, other_dd: 10,
}

/** The same game written as GAINS — the textbook 3/0/5/1 payoff matrix. A dilemma under
 *  HIGHER-is-better. */
const GAINS: PdPayoffs = {
  you_cc: 3, you_cd: 0, you_dc: 5, you_dd: 1,
  other_cc: 3, other_cd: 5, other_dc: 0, other_dd: 1,
}

describe('the check is SILENT on a real dilemma, in either direction', () => {
  it('⚠ NEGATIVE CONTROL FOR THE WHOLE FEATURE — the shipped 1/15/0/10 matrix is silent', () => {
    expect(isDilemmaLowerIsBetter(DEFAULTS)).toBe(true)
    expect(isDilemmaHigherIsBetter(DEFAULTS)).toBe(false)
    expect(warnNotADilemma(DEFAULTS)).toBe(false)
  })

  it('a gains matrix (3/0/5/1) is silent under the higher-is-better reading', () => {
    expect(isDilemmaHigherIsBetter(GAINS)).toBe(true)
    expect(isDilemmaLowerIsBetter(GAINS)).toBe(false)
    expect(warnNotADilemma(GAINS)).toBe(false)
  })

  it('an ASYMMETRIC dilemma is silent — the check reads each side independently', () => {
    // Y and O satisfy their own three inequalities with different numbers.
    const asym: PdPayoffs = {
      you_cc: 3, you_cd: 0, you_dc: 5, you_dd: 1,
      other_cc: 4, other_cd: 9, other_dc: 1, other_dd: 2,
    }
    expect(isDilemmaHigherIsBetter(asym)).toBe(true)
    expect(warnNotADilemma(asym)).toBe(false)
  })
})

describe('the check WARNS when the numbers are a dilemma under neither reading', () => {
  it('a flat matrix — every value equal — warns', () => {
    const flat: PdPayoffs = {
      you_cc: 5, you_cd: 5, you_dc: 5, you_dd: 5,
      other_cc: 5, other_cd: 5, other_dc: 5, other_dd: 5,
    }
    expect(isDilemmaHigherIsBetter(flat)).toBe(false)
    expect(isDilemmaLowerIsBetter(flat)).toBe(false)
    expect(warnNotADilemma(flat)).toBe(true)
  })

  it('cooperation dominant for both sides — no dilemma either way', () => {
    const coopDominant: PdPayoffs = {
      you_cc: 5, you_cd: 4, you_dc: 1, you_dd: 0,
      other_cc: 5, other_cd: 1, other_dc: 4, other_dd: 0,
    }
    expect(warnNotADilemma(coopDominant)).toBe(true)
  })

  it('ONE SIDE ONLY is a dilemma — still warns, because both sides must hold', () => {
    // Your three inequalities hold under higher-is-better; the other player's do not,
    // and reversing the reading does not rescue your side.
    const oneSided: PdPayoffs = {
      you_cc: 3, you_cd: 0, you_dc: 5, you_dd: 1,
      other_cc: 3, other_cd: 3, other_dc: 3, other_dd: 3,
    }
    expect(isDilemmaHigherIsBetter(oneSided)).toBe(false)
    expect(isDilemmaLowerIsBetter(oneSided)).toBe(false)
    expect(warnNotADilemma(oneSided)).toBe(true)
  })

  it('MIXED DIRECTIONS do not count as a dilemma — the two sides must agree', () => {
    // Your side reads as a dilemma under higher-is-better and theirs under
    // lower-is-better. Neither whole reading holds, so it warns. A check that tested
    // the six inequalities independently rather than as two readings would pass this.
    const mixed: PdPayoffs = {
      you_cc: 3, you_cd: 0, you_dc: 5, you_dd: 1,
      other_cc: 1, other_cd: 15, other_dc: 0, other_dd: 10,
    }
    expect(warnNotADilemma(mixed)).toBe(true)
  })

  it('a NEAR-MISS on exactly one inequality warns — ties are not strict dominance', () => {
    // The defaults with Y(D,C) raised to equal Y(C,C): five of six still hold.
    const tie: PdPayoffs = { ...DEFAULTS, you_dc: DEFAULTS.you_cc }
    expect(warnNotADilemma(DEFAULTS)).toBe(false)   // control: one edit away from silent
    expect(warnNotADilemma(tie)).toBe(true)
  })
})

describe('the wording', () => {
  it('says students can still play, and never claims a direction', () => {
    expect(NOT_A_DILEMMA_WARNING).toContain('Students can still play')
    expect(NOT_A_DILEMMA_WARNING).toContain('either reading')
    // ⚠ "prisoner's dilemma" is the NAME OF THE GAME and is allowed. What is not
    // allowed is asserting a direction — that is the instructor's framing, not ours.
    for (const claim of ['lower is better', 'higher is better', 'years', 'points']) {
      expect(NOT_A_DILEMMA_WARNING.toLowerCase()).not.toContain(claim)
    }
  })
})
