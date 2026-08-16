import { describe, it, expect } from 'vitest'
import {
  botMove, DEFAULT_RANDOM_FIRST_MOVE_PROBABILITY, type Move,
} from '../src/pd/strategy'
import { loadPdConfig, parseRandomFirstMoveProbability, DEFAULT_PD_CONFIG } from '../src/pd/config'
import { strategyRevealLine } from '../src/pd/strategyText'

// ═══════════════════════════════════════════════════════════════════════════════
// P(first move) for `random`, configurable (spec §5.2).
// ═══════════════════════════════════════════════════════════════════════════════

/** Draw one student's whole seeded sequence at probability `p`. */
function seq(p: number | undefined, n: number, seed = 's', pid = 'alice'): Move[] {
  return Array.from({ length: n }, (_, i) =>
    botMove('random', new Array(i).fill('C') as Move[], [],
      { seed, participantId: pid, randomFirstMoveProbability: p }))
}

/** How many first-moves in a sequence. */
const firsts = (xs: readonly Move[]) => xs.filter(m => m === 'C').length

describe('the config value', () => {
  it('an instance with no stored value reads as 0.5', () => {
    expect(parseRandomFirstMoveProbability(undefined)).toBe(0.5)
    expect(loadPdConfig({}).randomFirstMoveProbability).toBe(0.5)
    expect(DEFAULT_PD_CONFIG.randomFirstMoveProbability).toBe(0.5)
    expect(DEFAULT_RANDOM_FIRST_MOVE_PROBABILITY).toBe(0.5)
  })

  it('a stored value is honoured, including both endpoints', () => {
    expect(loadPdConfig({ random_first_move_probability: 0.25 }).randomFirstMoveProbability).toBe(0.25)
    expect(parseRandomFirstMoveProbability(0)).toBe(0)
    expect(parseRandomFirstMoveProbability(1)).toBe(1)
  })

  it('out-of-range and non-numeric fall back rather than throwing', () => {
    for (const bad of [-0.01, 1.01, 2, -1, NaN, Infinity, -Infinity, '0.5', null, undefined, {}, []]) {
      expect(parseRandomFirstMoveProbability(bad), String(bad)).toBe(0.5)
    }
  })

  it('⚠ NEGATIVE CONTROL — a VALID value is not swallowed by the fallback', () => {
    // Without this, "everything invalid becomes 0.5" is satisfiable by always
    // returning 0.5, which would silently discard every instructor's setting.
    expect(parseRandomFirstMoveProbability(0.25)).toBe(0.25)
    expect(parseRandomFirstMoveProbability(0.999)).toBe(0.999)
  })
})

describe('⚠⚠ MIGRATION — an unconfigured instance draws EXACTLY as it did before', () => {
  /** VERBATIM the pre-change seeded rule: parity of the raw hash, low bit. */
  function legacyHash32(s: string): number {
    let h = 0x811c9dc5
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i)
      h = Math.imul(h, 0x01000193)
    }
    h ^= h >>> 16
    h = Math.imul(h, 0x85ebca6b)
    h ^= h >>> 13
    h = Math.imul(h, 0xc2b2ae35)
    h ^= h >>> 16
    return h >>> 0
  }
  const legacyMove = (seed: string, pid: string, round: number): Move =>
    legacyHash32(`${seed}:bot:${pid}:${round}`) % 2 === 0 ? 'C' : 'D'

  it('the p = 0.5 sequence matches the old PARITY rule, draw for draw', () => {
    // ⚠ THE THRESHOLD DRAW READS THE HIGH BITS AND PARITY READS THE LOW BIT, so a naive
    // `hash/2^32 < p` would NOT agree at 0.5. The implementation rotates the low bit to
    // the top precisely so it does. This is that claim, over 400 draws and 4 students.
    let checked = 0
    for (const pid of ['alice', 'bob', 'carol', 'dave']) {
      for (let round = 1; round <= 100; round++) {
        const now = botMove('random', new Array(round - 1).fill('C') as Move[], [],
          { seed: 'mig', participantId: pid, randomFirstMoveProbability: 0.5 })
        expect(now).toBe(legacyMove('mig', pid, round))
        checked++
      }
    }
    expect(checked).toBe(400)
  })

  it('…and an ABSENT probability behaves the same as an explicit 0.5', () => {
    const absent = seq(undefined, 60)
    const explicit = seq(0.5, 60)
    expect(absent.length).toBe(60)
    expect(absent).toEqual(explicit)
  })

  it('⚠ NEGATIVE CONTROL — a DIFFERENT p does NOT match the legacy sequence', () => {
    // If the p = 0.5 identity held for every p it would prove nothing about the
    // rotation; it would only mean p was being ignored.
    const legacy = Array.from({ length: 100 }, (_, i) => legacyMove('mig', 'alice', i + 1))
    const biased = seq(0.25, 100, 'mig', 'alice')
    expect(biased.length).toBe(100)
    expect(biased).not.toEqual(legacy)
  })
})

describe('the draw actually follows p', () => {
  it('⚠ p = 0.25 lands inside an independently computed binomial band', () => {
    // Expected and the band come from the binomial distribution, not from the code:
    // mean = Np, sd = sqrt(Np(1−p)), 4σ.
    const N = 4000
    const p = 0.25
    const drawn = Array.from({ length: N }, (_, i) =>
      botMove('random', [], [], { seed: `s${i}`, participantId: 'x', randomFirstMoveProbability: p }))
    expect(drawn.length).toBe(N)
    const c = firsts(drawn)
    const mean = N * p
    const sd = Math.sqrt(N * p * (1 - p))
    expect(Math.abs(c - mean)).toBeLessThan(4 * sd)
    // …and it is genuinely mixing, not stuck.
    expect(c).toBeGreaterThan(0)
    expect(c).toBeLessThan(N)
  })

  it('⚠⚠ NEGATIVE CONTROL — a p = 0.5 run sits OUTSIDE that same band', () => {
    // THE CONTROL THAT MATTERS. A build that ignores p and always draws 50/50 passes
    // the test above only if the band is wide enough to contain 0.5 — so this asserts
    // it is not. 0.5 is 4000·0.25 = 1000 above the 0.25 mean, versus a 4σ half-width of
    // about 110.
    const N = 4000
    const p = 0.25
    const at50 = Array.from({ length: N }, (_, i) =>
      botMove('random', [], [], { seed: `s${i}`, participantId: 'x', randomFirstMoveProbability: 0.5 }))
    expect(at50.length).toBe(N)
    const sd = Math.sqrt(N * p * (1 - p))
    expect(Math.abs(firsts(at50) - N * p)).toBeGreaterThan(4 * sd)
  })

  it('p = 0 is a constant second-move bot, p = 1 a constant first-move bot', () => {
    const none = seq(0, 200)
    const all = seq(1, 200)
    expect(none.length).toBe(200)
    expect(all.length).toBe(200)
    expect(new Set(none)).toEqual(new Set(['D']))
    expect(new Set(all)).toEqual(new Set(['C']))
  })

  it('the unseeded path follows p too', () => {
    const N = 4000
    const p = 0.8
    let c = 0
    for (let i = 0; i < N; i++) {
      if (botMove('random', [], [], { seed: null, participantId: 'x', randomFirstMoveProbability: p }) === 'C') c++
    }
    const sd = Math.sqrt(N * p * (1 - p))
    expect(Math.abs(c - N * p)).toBeLessThan(4 * sd)
  })

  it('⚠ THE RNG RULE STILL HOLDS AT p ≠ 0.5 — a seeded draw is reproducible', () => {
    // The stored-not-recomputed guarantee is enforced by submitRound writing the move;
    // this pins the other half, that the seeded derivation is a pure function of
    // (seed, participant, round, p) and does not drift between calls.
    const a = seq(0.3, 50)
    const b = seq(0.3, 50)
    expect(a.length).toBe(50)
    expect(a).toEqual(b)
  })
})

describe('⚠ the debrief reveal line states the ACTUAL probability', () => {
  const L = { C: 'Zarquon', D: 'Blorptide' }

  it('at 0.5 it says equal probability', () => {
    const line = strategyRevealLine('random', L, 0.5)
    expect(line).toContain('equal probability')
    expect(line).toContain('Zarquon')
    expect(line).toContain('Blorptide')
  })

  it('at 0.33 it states the numbers instead', () => {
    const line = strategyRevealLine('random', L, 0.33)
    expect(line).toContain('33%')
    expect(line).toContain('67%')
    expect(line).toContain('Zarquon')
    expect(line).toContain('Blorptide')
  })

  it('⚠⚠ THE TWO LINES DIFFER — "equal probability" is FALSE at p ≠ 0.5', () => {
    // The whole reason the line was rewritten: it is a statement to a student about
    // the game they just played.
    expect(strategyRevealLine('random', L, 0.33)).not.toBe(strategyRevealLine('random', L, 0.5))
    expect(strategyRevealLine('random', L, 0.33)).not.toContain('equal probability')
  })

  it('the endpoints read as constants rather than as a 0% coin', () => {
    expect(strategyRevealLine('random', L, 0)).toContain('played Blorptide every time')
    expect(strategyRevealLine('random', L, 1)).toContain('played Zarquon every time')
  })

  it('an omitted probability keeps the shipped sentence, so old callers are unchanged', () => {
    expect(strategyRevealLine('random', L)).toBe(strategyRevealLine('random', L, 0.5))
  })

  it('⚠ no shipped default word leaks into any of them', () => {
    for (const p of [0, 0.25, 0.5, 0.75, 1]) {
      const line = strategyRevealLine('random', L, p)
      expect(line).not.toContain('Cooperate')
      expect(line).not.toContain('Defect')
    }
  })
})
