import { describe, it, expect } from 'vitest'
import { payoff, yearsFor, parsePayoffs, DEFAULT_PAYOFFS, type PayoffConfig } from '../src/pd/payoff'

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

  it('orders the cells temptation < reward < punishment < sucker (losses)', () => {
    expect(cfg.temptation).toBeLessThan(cfg.both_cooperate)
    expect(cfg.both_cooperate).toBeLessThan(cfg.both_defect)
    expect(cfg.both_defect).toBeLessThan(cfg.sucker)
  })

  it('is symmetric — swapping the moves swaps the years', () => {
    for (const a of ['C', 'D'] as const) {
      for (const b of ['C', 'D'] as const) {
        const p = payoff(a, b, cfg)
        const q = payoff(b, a, cfg)
        expect(p.studentYears).toBe(q.botYears)
        expect(p.botYears).toBe(q.studentYears)
      }
    }
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
      both_cooperate: 2, sucker: 30, temptation: 1, both_defect: 20,
    }
    expect(payoff('C', 'C', custom)).toEqual({ studentYears: 2, botYears: 2 })
    expect(payoff('C', 'D', custom)).toEqual({ studentYears: 30, botYears: 1 })
    expect(payoff('D', 'C', custom)).toEqual({ studentYears: 1, botYears: 30 })
    expect(payoff('D', 'D', custom)).toEqual({ studentYears: 20, botYears: 20 })
  })

  it('yearsFor is the single source both perspectives are built from', () => {
    expect(yearsFor('C', 'C', DEFAULT_PAYOFFS)).toBe(1)
    expect(yearsFor('C', 'D', DEFAULT_PAYOFFS)).toBe(15)
    expect(yearsFor('D', 'C', DEFAULT_PAYOFFS)).toBe(0)
    expect(yearsFor('D', 'D', DEFAULT_PAYOFFS)).toBe(10)
  })
})

describe('parsePayoffs — defensive load', () => {
  it('absent / non-object config yields the shipped defaults', () => {
    expect(parsePayoffs(undefined)).toEqual(DEFAULT_PAYOFFS)
    expect(parsePayoffs(null)).toEqual(DEFAULT_PAYOFFS)
    expect(parsePayoffs('nonsense')).toEqual(DEFAULT_PAYOFFS)
  })

  it('a partial config keeps the supplied values and defaults the rest', () => {
    expect(parsePayoffs({ sucker: 20 })).toEqual({ ...DEFAULT_PAYOFFS, sucker: 20 })
  })

  it('accepts 0 (the temptation cell is legitimately zero)', () => {
    expect(parsePayoffs({ temptation: 0 }).temptation).toBe(0)
  })

  it('rejects invalid values rather than making a round unscoreable', () => {
    const bad = parsePayoffs({
      both_cooperate: -1, sucker: NaN, temptation: 'x', both_defect: null,
    })
    expect(bad).toEqual(DEFAULT_PAYOFFS)
  })
})
