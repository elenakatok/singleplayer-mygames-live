import { describe, it, expect } from 'vitest'
import {
  payoff, yourPayoff, otherPayoff, parsePayoffs, DEFAULT_PAYOFFS, type PayoffConfig,
} from '../src/pd/payoff'

// Pure payoff tests (no emulator). Runs under `npm test`.

describe('payoff — all four cells, spec §2 (YEARS IN PRISON, lower is better)', () => {
  const cfg = DEFAULT_PAYOFFS

  it('CC → student 1, bot 1', () => {
    expect(payoff('C', 'C', cfg)).toEqual({ studentYears: 1, botYears: 1 })
  })

  it('CD (student C, bot D) → student 15, bot 0', () => {
    expect(payoff('C', 'D', cfg)).toEqual({ studentYears: 15, botYears: 0 })
  })

  it('DC (student D, bot C) → student 0, bot 15', () => {
    expect(payoff('D', 'C', cfg)).toEqual({ studentYears: 0, botYears: 15 })
  })

  it('DD → student 10, bot 10', () => {
    expect(payoff('D', 'D', cfg)).toEqual({ studentYears: 10, botYears: 10 })
  })
})

describe('the payoff structure that makes it a Prisoner’s Dilemma', () => {
  const cfg = DEFAULT_PAYOFFS

  it('defecting is dominant: it serves fewer years whatever the other does', () => {
    // Against a cooperator …
    expect(payoff('D', 'C', cfg).studentYears).toBeLessThan(payoff('C', 'C', cfg).studentYears)
    // … and against a defector.
    expect(payoff('D', 'D', cfg).studentYears).toBeLessThan(payoff('C', 'D', cfg).studentYears)
  })

  it('yet mutual cooperation beats mutual defection — the dilemma', () => {
    expect(payoff('C', 'C', cfg).studentYears).toBeLessThan(payoff('D', 'D', cfg).studentYears)
  })

  it('orders the cells Y(D,C) < Y(C,C) < Y(D,D) < Y(C,D) (losses)', () => {
    expect(cfg.you_dc).toBeLessThan(cfg.you_cc)
    expect(cfg.you_cc).toBeLessThan(cfg.you_dd)
    expect(cfg.you_dd).toBeLessThan(cfg.you_cd)
  })

  it('the SHIPPED DEFAULTS are symmetric — swapping the moves swaps the payoffs', () => {
    // ⚠ A PROPERTY OF THE DEFAULT MATRIX, NOT OF THE CODE. It used to be structural:
    // one lookup served both seats. It is now eight independent numbers that happen to
    // be a transpose, and an instructor may store a matrix for which this is false —
    // see the asymmetric test below, which is the negative control for this one.
    for (const a of ['C', 'D'] as const) {
      for (const b of ['C', 'D'] as const) {
        const p = payoff(a, b, cfg)
        const q = payoff(b, a, cfg)
        expect(p.studentYears).toBe(q.botYears)
        expect(p.botYears).toBe(q.studentYears)
      }
    }
  })

  it('an ASYMMETRIC matrix is expressible — the derive is gone, not hidden', () => {
    // The whole point of eight values. Under the old symmetric lookup this matrix could
    // not be stored at all: O(C,D) and O(D,C) were forced equal to Y(D,C) and Y(C,D).
    const asym: PayoffConfig = {
      you_cc: 1, you_cd: 2, you_dc: 3, you_dd: 4,
      other_cc: 5, other_cd: 6, other_dc: 7, other_dd: 8,
    }
    expect(payoff('C', 'D', asym)).toEqual({ studentYears: 2, botYears: 6 })
    expect(payoff('D', 'C', asym)).toEqual({ studentYears: 3, botYears: 7 })
    // …and it is NOT symmetric, which is what the test above would have demanded.
    expect(payoff('C', 'D', asym).studentYears).not.toBe(payoff('D', 'C', asym).botYears)
  })

  it('no cell is negative — every outcome is ≥ 0 years (spec §2)', () => {
    for (const a of ['C', 'D'] as const) {
      for (const b of ['C', 'D'] as const) {
        const p = payoff(a, b, cfg)
        expect(p.studentYears).toBeGreaterThanOrEqual(0)
        expect(p.botYears).toBeGreaterThanOrEqual(0)
      }
    }
  })
})

describe('values come FROM CONFIG, not from code', () => {
  it('a custom matrix is used verbatim — no hardcoded 1/15/0/10 leaks through', () => {
    const custom: PayoffConfig = {
      you_cc: 2, you_cd: 30, you_dc: 1, you_dd: 20,
      other_cc: 2, other_cd: 1, other_dc: 30, other_dd: 20,
    }
    expect(payoff('C', 'C', custom)).toEqual({ studentYears: 2, botYears: 2 })
    expect(payoff('C', 'D', custom)).toEqual({ studentYears: 30, botYears: 1 })
    expect(payoff('D', 'C', custom)).toEqual({ studentYears: 1, botYears: 30 })
    expect(payoff('D', 'D', custom)).toEqual({ studentYears: 20, botYears: 20 })
  })

  it('yourPayoff reads Y(a,b) and otherPayoff reads O(a,b) — the SAME cell', () => {
    expect(yourPayoff('C', 'C', DEFAULT_PAYOFFS)).toBe(1)
    expect(yourPayoff('C', 'D', DEFAULT_PAYOFFS)).toBe(15)
    expect(yourPayoff('D', 'C', DEFAULT_PAYOFFS)).toBe(0)
    expect(yourPayoff('D', 'D', DEFAULT_PAYOFFS)).toBe(10)
    expect(otherPayoff('C', 'C', DEFAULT_PAYOFFS)).toBe(1)
    expect(otherPayoff('C', 'D', DEFAULT_PAYOFFS)).toBe(0)
    expect(otherPayoff('D', 'C', DEFAULT_PAYOFFS)).toBe(15)
    expect(otherPayoff('D', 'D', DEFAULT_PAYOFFS)).toBe(10)
  })

  it('⚠ otherPayoff is NOT the transpose of yourPayoff', () => {
    // The old symmetric derive was `yearsFor(other, you)`. On an asymmetric matrix that
    // reads the wrong cell entirely; this pins the difference so a "simplification"
    // back to a transpose fails here rather than in a student's history table.
    const asym: PayoffConfig = {
      you_cc: 1, you_cd: 2, you_dc: 3, you_dd: 4,
      other_cc: 5, other_cd: 6, other_dc: 7, other_dd: 8,
    }
    expect(otherPayoff('C', 'D', asym)).toBe(6)
    expect(yourPayoff('D', 'C', asym)).toBe(3)   // what the transpose would have given
  })
})

describe('parsePayoffs — defensive load', () => {
  it('absent / non-object config yields the shipped defaults', () => {
    expect(parsePayoffs(undefined)).toEqual(DEFAULT_PAYOFFS)
    expect(parsePayoffs(null)).toEqual(DEFAULT_PAYOFFS)
    expect(parsePayoffs('nonsense')).toEqual(DEFAULT_PAYOFFS)
  })

  it('a partial EIGHT-value config keeps the supplied values and defaults the rest', () => {
    expect(parsePayoffs({ you_cd: 20 })).toEqual({ ...DEFAULT_PAYOFFS, you_cd: 20 })
    expect(parsePayoffs({ other_dc: 20 })).toEqual({ ...DEFAULT_PAYOFFS, other_dc: 20 })
  })

  it('accepts 0 (the Y(D,C) cell is legitimately zero)', () => {
    expect(parsePayoffs({ you_dc: 0 }).you_dc).toBe(0)
    expect(parsePayoffs({ other_cd: 0 }).other_cd).toBe(0)
  })

  it('rejects invalid values rather than making a round unscoreable', () => {
    // ⚠ −1 IS NO LONGER INVALID. Payoffs may be any finite number (spec §2); the old
    // `>= 0` floor was inherited from the shipped prison-years matrix, never a rule.
    // Only non-numbers, NaN and ±Infinity fall back — see pdNegativePayoffs.test.ts.
    const bad = parsePayoffs({
      you_cc: NaN, you_cd: Infinity, you_dc: 'x', you_dd: null,
      other_cc: -Infinity, other_cd: undefined, other_dc: {}, other_dd: [],
    })
    expect(bad).toEqual(DEFAULT_PAYOFFS)
  })

  it('…and a negative value is NOT one of them', () => {
    expect(parsePayoffs({ you_cc: -1 }).you_cc).toBe(-1)
  })
})
