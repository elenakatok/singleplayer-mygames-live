import { describe, it, expect } from 'vitest'
import { mixedEquilibrium, mixedEquilibriumText } from './mixedEquilibrium'
import type { PdPayoffs } from './api'

// ═══════════════════════════════════════════════════════════════════════════════
// The student's indifference probability (spec §5.5).
//
//   q = [ Y(D,D) − Y(C,D) ] / [ Y(C,C) − Y(C,D) − Y(D,C) + Y(D,D) ]
//
// ⚠ EVERY EXPECTED VALUE BELOW IS WORKED BY HAND FROM THAT EXPRESSION IN THE COMMENT
// ABOVE IT, never read back from the implementation.
// ═══════════════════════════════════════════════════════════════════════════════

const LABELS = { C: 'Zarquon', D: 'Blorptide' }

/** Battle of the Sexes. Y = 2,0,0,1 / O = 1,0,0,2. */
const BOS: PdPayoffs = {
  you_cc: 2, you_cd: 0, you_dc: 0, you_dd: 1,
  other_cc: 1, other_cd: 0, other_dc: 0, other_dd: 2,
}

/** pd's shipped default. Y = 1,15,0,10 / O = 1,0,15,10. */
const DEFAULTS: PdPayoffs = {
  you_cc: 1, you_cd: 15, you_dc: 0, you_dd: 10,
  other_cc: 1, other_cd: 0, other_dc: 15, other_dd: 10,
}

describe('q — a probability', () => {
  it('Battle of the Sexes → 1/3', () => {
    // num = Y(D,D) − Y(C,D) = 1 − 0 = 1
    // den = Y(C,C) − Y(C,D) − Y(D,C) + Y(D,D) = 2 − 0 − 0 + 1 = 3
    // q   = 1/3
    const eq = mixedEquilibrium(BOS)
    expect(eq.kind).toBe('probability')
    expect(eq.kind === 'probability' && eq.q).toBeCloseTo(1 / 3, 12)
  })

  it('…and the sentence states it in the instance wording', () => {
    const text = mixedEquilibriumText(BOS, LABELS)
    expect(text).toContain('Zarquon')
    expect(text).toContain('33.3%')
    expect(text).not.toContain('Blorptide')   // the sentence names one move, not both
    expect(text).not.toContain('Cooperate')
    expect(text).not.toContain('Defect')
  })

  it('a symmetric coordination matrix → 1/2', () => {
    // Y = 1,0,0,1 : num = 1 − 0 = 1 ; den = 1 − 0 − 0 + 1 = 2 ; q = 1/2
    const coord: PdPayoffs = {
      you_cc: 1, you_cd: 0, you_dc: 0, you_dd: 1,
      other_cc: 1, other_cd: 0, other_dc: 0, other_dd: 1,
    }
    const eq = mixedEquilibrium(coord)
    expect(eq.kind === 'probability' && eq.q).toBeCloseTo(0.5, 12)
  })
})

describe('⚠ q is UNDEFINED when it should be', () => {
  it('⚠⚠ THE SHIPPED DEFAULT MATRIX → dominant strategy, NOT a number', () => {
    // THE NEGATIVE CONTROL FOR THE WHOLE FEATURE. num = 10 − 15 = −5 ;
    // den = 1 − 15 − 0 + 10 = −4 ; q = 1.25, outside [0,1]. A build that always
    // displays a number fails right here, on the matrix pd actually ships.
    const eq = mixedEquilibrium(DEFAULTS)
    expect(eq.kind).toBe('dominant')
    expect(mixedEquilibriumText(DEFAULTS, LABELS)).toBe('Undefined — a dominant strategy exists')
  })

  it('a zero denominator → the other undefined state', () => {
    // Y = 2,1,1,0 : den = 2 − 1 − 1 + 0 = 0
    const degenerate: PdPayoffs = {
      you_cc: 2, you_cd: 1, you_dc: 1, you_dd: 0,
      other_cc: 5, other_cd: 6, other_dc: 7, other_dd: 8,
    }
    expect(mixedEquilibrium(degenerate).kind).toBe('undefined')
    expect(mixedEquilibriumText(degenerate, LABELS)).toBe('Undefined')
  })

  it('a flat matrix → zero denominator too', () => {
    // Y = 5,5,5,5 : den = 5 − 5 − 5 + 5 = 0
    const flat: PdPayoffs = {
      you_cc: 5, you_cd: 5, you_dc: 5, you_dd: 5,
      other_cc: 5, other_cd: 5, other_dc: 5, other_dd: 5,
    }
    expect(mixedEquilibrium(flat).kind).toBe('undefined')
  })

  it('the three states are distinguishable, and all three are reachable', () => {
    // ⚠ The zero-denominator fixture is Y = 2,1,1,0 (den = 2 − 1 − 1 + 0 = 0). My first
    // attempt used Y = 2,1,1,1, which gives den = 1 and q = 0 — a perfectly valid
    // PROBABILITY, not the undefined state. Worked by hand, not guessed.
    const zeroDen: PdPayoffs = { ...BOS, you_cc: 2, you_cd: 1, you_dc: 1, you_dd: 0 }
    const kinds = [BOS, DEFAULTS, zeroDen].map(m => mixedEquilibrium(m).kind)
    expect(kinds.length).toBe(3)
    expect(kinds).toEqual(['probability', 'dominant', 'undefined'])
    expect(new Set(kinds).size).toBe(3)
  })

  it('q = 0 and q = 1 are PROBABILITIES, not undefined — the boundary is inclusive', () => {
    // Y = 2,1,1,1 : num = 1 − 1 = 0 ; den = 2 − 1 − 1 + 1 = 1 ; q = 0
    const qZero: PdPayoffs = { ...BOS, you_cc: 2, you_cd: 1, you_dc: 1, you_dd: 1 }
    const a = mixedEquilibrium(qZero)
    expect(a.kind).toBe('probability')
    expect(a.kind === 'probability' && a.q).toBe(0)
    // Y = 1,0,1,1 : num = 1 − 0 = 1 ; den = 1 − 0 − 1 + 1 = 1 ; q = 1
    const qOne: PdPayoffs = { ...BOS, you_cc: 1, you_cd: 0, you_dc: 1, you_dd: 1 }
    const b = mixedEquilibrium(qOne)
    expect(b.kind).toBe('probability')
    expect(b.kind === 'probability' && b.q).toBe(1)
  })
})

describe('⚠⚠ q USES Y AND NOT O — the point of this suite', () => {
  it('changing ONLY the four O values leaves q untouched', () => {
    // A player's mixing probability is fixed by the OTHER player's payoffs. The number
    // shown here is what the BOT would have to play to leave the STUDENT indifferent,
    // so it is built from the student's row alone. O sits right beside Y in the config
    // and in the eight-box grid, which is exactly why this is asserted.
    const base = mixedEquilibrium(BOS)
    const oChanged: PdPayoffs = {
      ...BOS, other_cc: 99, other_cd: -40, other_dc: 7.5, other_dd: 0,
    }
    // The O values really did change — guards the assertion below.
    expect([oChanged.other_cc, oChanged.other_cd, oChanged.other_dc, oChanged.other_dd])
      .not.toEqual([BOS.other_cc, BOS.other_cd, BOS.other_dc, BOS.other_dd])
    expect(mixedEquilibrium(oChanged)).toEqual(base)
    expect(mixedEquilibriumText(oChanged, LABELS)).toBe(mixedEquilibriumText(BOS, LABELS))
  })

  it('⚠ NEGATIVE CONTROL — changing a Y value DOES move q', () => {
    // Without this, "O does not matter" is satisfiable by an implementation where
    // nothing matters — a constant.
    const yChanged: PdPayoffs = { ...BOS, you_dd: 5 }
    // num = 5 − 0 = 5 ; den = 2 − 0 − 0 + 5 = 7 ; q = 5/7
    const eq = mixedEquilibrium(yChanged)
    expect(eq.kind === 'probability' && eq.q).toBeCloseTo(5 / 7, 12)
    expect(mixedEquilibrium(yChanged)).not.toEqual(mixedEquilibrium(BOS))
  })

  it('every one of the four Y values moves q — none is ignored', () => {
    const keys = ['you_cc', 'you_cd', 'you_dc', 'you_dd'] as const
    expect(keys.length).toBe(4)
    for (const k of keys) {
      const bumped: PdPayoffs = { ...BOS, [k]: BOS[k] + 3 }
      expect(mixedEquilibrium(bumped), `${k} must affect q`).not.toEqual(mixedEquilibrium(BOS))
    }
  })
})

describe('⚠⚠ q IS INVARIANT UNDER NEGATION — so no direction setting is needed', () => {
  const negate = (p: PdPayoffs): PdPayoffs => ({
    you_cc: -p.you_cc, you_cd: -p.you_cd, you_dc: -p.you_dc, you_dd: -p.you_dd,
    other_cc: -p.other_cc, other_cd: -p.other_cd, other_dc: -p.other_dc, other_dd: -p.other_dd,
  })

  it('negating all eight payoffs leaves q identical', () => {
    // Both numerator and denominator negate, so the ratio is unchanged. This is why the
    // game can stay direction-agnostic (§2) and still show this number: it is the same
    // under "bigger is better" and "smaller is better".
    for (const m of [BOS, { ...BOS, you_dd: 5 }]) {
      const a = mixedEquilibrium(m as PdPayoffs)
      const b = mixedEquilibrium(negate(m as PdPayoffs))
      expect(a.kind).toBe('probability')
      expect(b).toEqual(a)
    }
  })

  it('…including the undefined states', () => {
    expect(mixedEquilibrium(negate(DEFAULTS)).kind).toBe('dominant')
    expect(mixedEquilibrium(negate(DEFAULTS))).toEqual(mixedEquilibrium(DEFAULTS))
  })

  it('⚠ NEGATIVE CONTROL — the fixture is NOT symmetric under negation by accident', () => {
    // If the matrix happened to equal its own negation the invariance test would be
    // vacuous. It does not.
    expect(negate(BOS)).not.toEqual(BOS)
  })

  it('a negative-payoff matrix is handled like any other', () => {
    // Payoffs may be any finite number (§2). Y = -1,-5,-3,-2 :
    // num = -2 − (-5) = 3 ; den = -1 − (-5) − (-3) + (-2) = 5 ; q = 3/5
    const neg: PdPayoffs = {
      you_cc: -1, you_cd: -5, you_dc: -3, you_dd: -2,
      other_cc: 0, other_cd: 0, other_dc: 0, other_dd: 0,
    }
    const eq = mixedEquilibrium(neg)
    expect(eq.kind === 'probability' && eq.q).toBeCloseTo(0.6, 12)
  })
})
