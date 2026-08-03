import { describe, it, expect } from 'vitest'
import { drawCost, drawCosts, type CostDist } from '../src/procurement/auction/costs'
import { makeRng, hash32, randomInt, pick } from '../src/procurement/auction/rng'

// ═══════════════════════════════════════════════════════════════════════════════
// Cost draws and the seeded stream (sealed spec §3, §4).
// ═══════════════════════════════════════════════════════════════════════════════

const RIVAL: CostDist = { distribution: 'uniform', min: 10, max: 110, integer: true }
const PLAYER: CostDist = { distribution: 'uniform', min: 10, max: 60, integer: true }

describe('§4 the two cost ranges are different, and that is the design', () => {
  it('the player draws U[10,60]; the rivals draw U[10,110]', () => {
    // ⚠ DELIBERATE ASYMMETRY (§4, derivation §5.2). It raises the player's win rate from
    // ~20% to ~39% and costs nothing, because a bidder's own cost distribution does not
    // enter their optimization — the cost is realized BEFORE bidding, so only the
    // rivals' distribution matters. Students are told the rival range only.
    const rng = makeRng('range', 'k')
    for (let i = 0; i < 2000; i++) {
      const p = drawCost(rng, PLAYER)
      expect(p).toBeGreaterThanOrEqual(10)
      expect(p).toBeLessThanOrEqual(60)
      expect(Number.isInteger(p)).toBe(true)
    }
    for (let i = 0; i < 2000; i++) {
      const c = drawCost(rng, RIVAL)
      expect(c).toBeGreaterThanOrEqual(10)
      expect(c).toBeLessThanOrEqual(110)
    }
  })

  it('both endpoints are reachable — the range is inclusive', () => {
    const seen = new Set<number>()
    const rng = makeRng('ends', 'k')
    for (let i = 0; i < 20000; i++) seen.add(drawCost(rng, PLAYER))
    expect(seen.has(10)).toBe(true)
    expect(seen.has(60)).toBe(true)
    expect(seen.size).toBe(51)
  })
})

describe('§4 independence', () => {
  it('two students in one instance draw unrelated costs', () => {
    // No pre-generated per-instance sequence: nothing a classmate reports about round 7
    // tells you anything about your own.
    const a = drawCosts(makeRng('seed', 'stuA:r7'), RIVAL, 4)
    const b = drawCosts(makeRng('seed', 'stuB:r7'), RIVAL, 4)
    expect(a).not.toEqual(b)
  })

  it('the same student, same round, same seed reproduces exactly', () => {
    const a = drawCosts(makeRng('seed', 'stuA:r7'), RIVAL, 4)
    const b = drawCosts(makeRng('seed', 'stuA:r7'), RIVAL, 4)
    expect(a).toEqual(b)
  })

  it('consecutive rounds are not correlated — the avalanche is doing its job', () => {
    // Raw FNV-1a low bits are poorly mixed for inputs differing by one character, which
    // is exactly what consecutive round keys are. Without fmix32 these would trend.
    const first = []
    for (let r = 1; r <= 200; r++) first.push(drawCosts(makeRng('seed', `stu:r${r}`), RIVAL, 1)[0])
    const mean = first.reduce((a, b) => a + b, 0) / first.length
    expect(mean).toBeGreaterThan(50)
    expect(mean).toBeLessThan(70)
  })
})

describe('the seeded stream', () => {
  it('a null seed means real randomness — and the key is then IGNORED', () => {
    // ⚠ THE FORECAST TRAP, PINNED. `Math.random` ignores its key, so any future
    // "common draw across students" mode must resolve a deterministic fallback seed
    // rather than passing null through. Harmless here only because every draw in this
    // game is meant to be independent per student.
    const a = drawCosts(makeRng(null, 'same-key'), RIVAL, 8)
    const b = drawCosts(makeRng(null, 'same-key'), RIVAL, 8)
    expect(a).not.toEqual(b)
  })

  it('the stream advances — repeated draws differ', () => {
    const rng = makeRng('adv', 'k')
    const draws = new Set([rng(), rng(), rng(), rng(), rng()])
    expect(draws.size).toBe(5)
  })

  it('hash32 is stable across runs', () => {
    expect(hash32('procurement')).toBe(hash32('procurement'))
    expect(hash32('procurement')).not.toBe(hash32('procuremenu'))
  })

  it('randomInt covers its range inclusively', () => {
    const rng = makeRng('ri', 'k')
    const seen = new Set<number>()
    for (let i = 0; i < 5000; i++) seen.add(randomInt(rng, 3, 7))
    expect([...seen].sort()).toEqual([3, 4, 5, 6, 7])
  })

  it('pick reaches every element', () => {
    const rng = makeRng('pk', 'k')
    const seen = new Set<string>()
    for (let i = 0; i < 500; i++) seen.add(pick(rng, ['a', 'b', 'c']))
    expect([...seen].sort()).toEqual(['a', 'b', 'c'])
  })

  it('pick on an empty list raises rather than returning undefined', () => {
    expect(() => pick(makeRng('e', 'k'), [])).toThrow(/empty/)
  })
})
