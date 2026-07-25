import { describe, it, expect } from 'vitest'
import { drawRoundCount, drawStrategy, hash32 } from '../src/pd/init'
import { DEFAULT_MIN_ROUNDS as MIN_ROUNDS, DEFAULT_MAX_ROUNDS as MAX_ROUNDS, loadPdConfig, DEFAULT_MOVE_LABELS } from '../src/pd/config'
import { DEFAULT_PAYOFFS } from '../src/pd/payoff'
import { STRATEGIES } from '../src/pd/strategy'

// Pure draw + config-load tests (no emulator). Runs under `npm test`.
// The TRANSACTIONAL once-only behaviour is covered in pdInit.emulator.test.ts,
// against a real Firestore — a fake transaction could not prove serializability.

describe('drawRoundCount — always a legal round count', () => {
  it('unseeded draws stay in [10, 20] inclusive, over many draws', () => {
    for (let i = 0; i < 5000; i++) {
      const n = drawRoundCount(null, `inst-${i}`, MIN_ROUNDS, MAX_ROUNDS)
      expect(Number.isInteger(n)).toBe(true)
      expect(n).toBeGreaterThanOrEqual(MIN_ROUNDS)
      expect(n).toBeLessThanOrEqual(MAX_ROUNDS)
    }
  })

  it('seeded draws stay in [10, 20] inclusive, over many instances', () => {
    for (let i = 0; i < 5000; i++) {
      const n = drawRoundCount('seed-1', `inst-${i}`, MIN_ROUNDS, MAX_ROUNDS)
      expect(n).toBeGreaterThanOrEqual(MIN_ROUNDS)
      expect(n).toBeLessThanOrEqual(MAX_ROUNDS)
    }
  })

  it('reaches BOTH endpoints — the range is inclusive, not off by one', () => {
    const seen = new Set<number>()
    for (let i = 0; i < 5000; i++) seen.add(drawRoundCount('endpoints', `inst-${i}`, MIN_ROUNDS, MAX_ROUNDS))
    expect(seen.has(MIN_ROUNDS)).toBe(true)
    expect(seen.has(MAX_ROUNDS)).toBe(true)
    expect(Math.min(...seen)).toBe(MIN_ROUNDS)
    expect(Math.max(...seen)).toBe(MAX_ROUNDS)
  })

  it('same seed + same instance → same draw (reproducible harness runs)', () => {
    for (const iid of ['a', 'b', 'instance-42']) {
      const first = drawRoundCount('fixed-seed', iid, MIN_ROUNDS, MAX_ROUNDS)
      for (let i = 0; i < 100; i++) expect(drawRoundCount('fixed-seed', iid, MIN_ROUNDS, MAX_ROUNDS)).toBe(first)
    }
  })

  it('different seeds generally give different draws for one instance', () => {
    const draws = new Set(Array.from({ length: 200 }, (_, i) => drawRoundCount(`seed-${i}`, 'inst-1', MIN_ROUNDS, MAX_ROUNDS)))
    expect(draws.size).toBeGreaterThan(1)
  })

  it('unseeded is NOT deterministic (real randomness when no seed is set)', () => {
    const draws = new Set(Array.from({ length: 500 }, () => drawRoundCount(null, 'inst-1', MIN_ROUNDS, MAX_ROUNDS)))
    expect(draws.size).toBeGreaterThan(1)
  })
})

describe('drawStrategy — ~50/50 between-students', () => {
  const share = (picks: string[]) => picks.filter(s => s === 'tft').length / picks.length

  it('always returns a strategy from the library', () => {
    for (let i = 0; i < 1000; i++) {
      expect(STRATEGIES).toContain(drawStrategy('s', `stu-${i}`))
      expect(STRATEGIES).toContain(drawStrategy(null, `stu-${i}`))
    }
  })

  it('splits ~50/50 across STUDENTS under one seed (the real classroom case)', () => {
    const picks = Array.from({ length: 2000 }, (_, i) => drawStrategy('class-seed', `stu-${i}`))
    expect(share(picks)).toBeGreaterThan(0.45)
    expect(share(picks)).toBeLessThan(0.55)
  })

  it('splits ~50/50 across SEEDS for one student', () => {
    const picks = Array.from({ length: 2000 }, (_, i) => drawStrategy(`seed-${i}`, 'stu-a'))
    expect(share(picks)).toBeGreaterThan(0.45)
    expect(share(picks)).toBeLessThan(0.55)
  })

  it('splits ~50/50 unseeded', () => {
    const picks = Array.from({ length: 4000 }, () => drawStrategy(null, 'stu-a'))
    expect(share(picks)).toBeGreaterThan(0.45)
    expect(share(picks)).toBeLessThan(0.55)
  })

  it('does not alternate for consecutive ids (the avalanche step earns its keep)', () => {
    // Without fmix32 the low bit tracks the input too closely and neighbouring ids
    // strictly alternate. Assert the sequence is not the alternating pattern.
    const picks = Array.from({ length: 40 }, (_, i) => drawStrategy('adjacent', `stu-${i}`))
    const alternating = picks.every((p, i) => (p === picks[0]) === (i % 2 === 0))
    expect(alternating).toBe(false)
  })

  it('same seed + same participant → same strategy', () => {
    for (const pid of ['stu-a', 'stu-b', 'x']) {
      const first = drawStrategy('fixed', pid)
      for (let i = 0; i < 100; i++) expect(drawStrategy('fixed', pid)).toBe(first)
    }
  })

  it('a seeded run assigns BOTH strategies across a realistic class', () => {
    const picks = Array.from({ length: 40 }, (_, i) => drawStrategy('one-class', `stu-${i}`))
    expect(new Set(picks).size).toBe(2)
  })
})

describe('hash32', () => {
  it('is a deterministic unsigned 32-bit value', () => {
    for (const s of ['', 'a', 'stu-1', 'a longer string with spaces']) {
      const h = hash32(s)
      expect(h).toBe(hash32(s))
      expect(Number.isInteger(h)).toBe(true)
      expect(h).toBeGreaterThanOrEqual(0)
      expect(h).toBeLessThanOrEqual(0xffffffff)
    }
  })

  it('separates similar inputs', () => {
    expect(hash32('stu-1')).not.toBe(hash32('stu-2'))
    expect(hash32('seed:rounds:a')).not.toBe(hash32('seed:rounds:b'))
  })
})

describe('loadPdConfig — stored over defaults', () => {
  it('an empty/absent config yields the shipped defaults with no seed', () => {
    for (const input of [undefined, {}]) {
      const c = loadPdConfig(input)
      expect(c.payoffs).toEqual(DEFAULT_PAYOFFS)
      expect(c.labels).toEqual(DEFAULT_MOVE_LABELS)
      expect(c.seed).toBeNull()
    }
  })

  it('a blank or whitespace seed means real randomness (null), not the string', () => {
    expect(loadPdConfig({ seed: '' }).seed).toBeNull()
    expect(loadPdConfig({ seed: '   ' }).seed).toBeNull()
  })

  it('a numeric seed normalizes to its string form — 7 and "7" draw alike', () => {
    expect(loadPdConfig({ seed: 7 }).seed).toBe('7')
    expect(loadPdConfig({ seed: '7' }).seed).toBe('7')
    expect(drawRoundCount(loadPdConfig({ seed: 7 }).seed, 'i', MIN_ROUNDS, MAX_ROUNDS))
      .toBe(drawRoundCount(loadPdConfig({ seed: '7' }).seed, 'i', MIN_ROUNDS, MAX_ROUNDS))
  })

  it('custom labels are kept; blank ones fall back', () => {
    expect(loadPdConfig({ labels: { C: 'Stay silent', D: 'Confess' } }).labels)
      .toEqual({ C: 'Stay silent', D: 'Confess' })
    expect(loadPdConfig({ labels: { C: '  ' } }).labels).toEqual(DEFAULT_MOVE_LABELS)
  })

  it('carries the payoff matrix through from config', () => {
    const c = loadPdConfig({ payoffs: { both_cooperate: 3 } })
    expect(c.payoffs.both_cooperate).toBe(3)
    expect(c.payoffs.sucker).toBe(DEFAULT_PAYOFFS.sucker)
  })
})

describe('drawRoundCount — the range is CONFIGURABLE (Slice 5)', () => {
  it('draws inside whatever range it is given, not the shipped default', () => {
    for (let i = 0; i < 500; i++) {
      const n = drawRoundCount(null, `inst-${i}`, 3, 5)
      expect(n).toBeGreaterThanOrEqual(3)
      expect(n).toBeLessThanOrEqual(5)
    }
  })

  it('reaches both endpoints of a custom range', () => {
    const seen = new Set<number>()
    for (let i = 0; i < 3000; i++) seen.add(drawRoundCount('custom', `inst-${i}`, 4, 7))
    expect([...seen].sort((a, b) => a - b)).toEqual([4, 5, 6, 7])
  })

  it('handles a single-value range (min === max) without dividing by zero', () => {
    for (let i = 0; i < 50; i++) expect(drawRoundCount(null, `i-${i}`, 12, 12)).toBe(12)
  })
})
