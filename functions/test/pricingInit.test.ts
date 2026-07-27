import { describe, it, expect } from 'vitest'
import { hash32, drawRoundCount } from '../src/pricing/init'

// ═══════════════════════════════════════════════════════════════════════════════
// The hidden-horizon draw (spec §3) — the PURE half. The transactional once-only
// guarantee is in pricingInit.emulator.test.ts, which needs a real Firestore.
//
// ⚠ THE DRAW IS PER PARTICIPANT, not per instance (deliberately unlike PD). This
// game is played async over an assignment week: a per-instance horizon is a single
// shared secret that the first student to finish can tell the whole class. So the
// tests below check independence ACROSS STUDENTS as hard as they check reproducibility.
// ═══════════════════════════════════════════════════════════════════════════════

describe('hash32', () => {
  it('is deterministic', () => {
    expect(hash32('abc')).toBe(hash32('abc'))
  })
  it('returns an unsigned 32-bit integer', () => {
    for (const s of ['', 'a', 'participant-1', 'x'.repeat(200)]) {
      const h = hash32(s)
      expect(Number.isInteger(h)).toBe(true)
      expect(h).toBeGreaterThanOrEqual(0)
      expect(h).toBeLessThanOrEqual(0xffffffff)
    }
  })
  it('avalanches: near-identical ids do not land near each other', () => {
    // Without the fmix32 step the low bits of consecutive ids barely move, and the
    // modulus below reads exactly those bits.
    const lowBits = new Set<number>()
    for (let i = 0; i < 8; i++) lowBits.add(hash32(`stu-${i}`) % 11)
    expect(lowBits.size).toBeGreaterThan(3)
  })
})

describe('drawRoundCount — seeded', () => {
  it('is reproducible for the same (seed, participant)', () => {
    expect(drawRoundCount('s', 'stu-1', 10, 20)).toBe(drawRoundCount('s', 'stu-1', 10, 20))
  })

  it('stays inside the configured range, inclusive at both ends', () => {
    for (let i = 0; i < 500; i++) {
      const n = drawRoundCount('seed', `stu-${i}`, 10, 20)
      expect(n).toBeGreaterThanOrEqual(10)
      expect(n).toBeLessThanOrEqual(20)
      expect(Number.isInteger(n)).toBe(true)
    }
  })

  it('DIFFERS ACROSS STUDENTS under one seed — the whole point of a per-student draw', () => {
    const drawn = new Set<number>()
    for (let i = 0; i < 200; i++) drawn.add(drawRoundCount('seed', `stu-${i}`, 10, 20))
    // A per-instance draw would put every student on one number.
    expect(drawn.size).toBeGreaterThan(5)
  })

  it('spreads across the whole range rather than clustering', () => {
    const counts = new Map<number, number>()
    for (let i = 0; i < 2000; i++) {
      const n = drawRoundCount('seed', `stu-${i}`, 10, 20)
      counts.set(n, (counts.get(n) ?? 0) + 1)
    }
    expect(counts.size).toBe(11)                       // every value in [10,20] appears
    for (const c of counts.values()) expect(c).toBeGreaterThan(60)  // ~182 expected each
  })

  it('a different seed re-draws the same student', () => {
    const a = Array.from({ length: 40 }, (_, i) => drawRoundCount('seed-a', `stu-${i}`, 10, 20))
    const b = Array.from({ length: 40 }, (_, i) => drawRoundCount('seed-b', `stu-${i}`, 10, 20))
    expect(a).not.toEqual(b)
  })

  it('a single-value range is that value', () => {
    expect(drawRoundCount('s', 'stu-1', 7, 7)).toBe(7)
    expect(drawRoundCount(null, 'stu-1', 7, 7)).toBe(7)
  })
})

describe('drawRoundCount — unseeded (real randomness)', () => {
  it('stays inside the range', () => {
    for (let i = 0; i < 500; i++) {
      const n = drawRoundCount(null, 'stu-1', 10, 20)
      expect(n).toBeGreaterThanOrEqual(10)
      expect(n).toBeLessThanOrEqual(20)
      expect(Number.isInteger(n)).toBe(true)
    }
  })

  it('does not return one fixed number', () => {
    const drawn = new Set<number>()
    for (let i = 0; i < 200; i++) drawn.add(drawRoundCount(null, 'stu-1', 10, 20))
    expect(drawn.size).toBeGreaterThan(1)
  })
})
