import { describe, it, expect } from 'vitest'
import {
  isContested, contestedEffortRate, contestedEffortGap, contestedPeriodCount,
  effortGap, highEffortRate, periodsPaidAfterDead, gapDistribution,
  type ParticipantContracts,
} from '../src/scorecard/stats'
import { splitPopulation, isBot } from '../src/scorecard/botFilter'
import { parseStoredContracts, type StoredContract } from '../src/scorecard/state'
import {
  DEFAULT_CONFIG, DEFAULT_TRUTH, type ScorecardConfig, type Condition,
} from '../src/scorecard/config'

const config: ScorecardConfig = DEFAULT_CONFIG
const T = config.periodsPerContract
const S = config.targetScore

// ═══════════════════════════════════════════════════════════════════════════════
// ⚠⚠ THE CONTESTED-PERIOD DENOMINATOR (spec §11).
//
// The claim being tested is strong and exact: a RELIABILITY-BLIND student — one whose
// action depends only on the state (dead / coasting / contested) and never on the
// reliability on screen — measures a gap of EXACTLY 0.000 over contested periods, while
// producing a large fake gap over all periods.
//
// These tests SIMULATE such students rather than asserting the property abstractly,
// because the artifact arises from the DISTRIBUTION of states differing between
// conditions, which only a simulation produces.
// ═══════════════════════════════════════════════════════════════════════════════

/** Deterministic uniform stream, so a simulated cohort cannot flake. */
function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

type Policy = (state: {
  score: number; periodsRemaining: number; reliability: number
}) => 'high' | 'low'

/** Play one contract under a policy, returning the stored shape. */
function playContract(
  index: number,
  condition: Condition,
  policy: Policy,
  draw: () => number,
): StoredContract {
  const reliability = condition === 'high' ? DEFAULT_TRUTH.reliabilityHigh : DEFAULT_TRUTH.reliabilityLow
  const periods: StoredContract['periods'] = []
  let score = 0
  let balance = config.endowmentPerContract
  for (let p = 1; p <= T; p++) {
    const action = policy({ score, periodsRemaining: T - p + 1, reliability })
    const q = action === 'high' ? reliability : config.pAcceptableLow
    const u = draw()
    const acceptable = u < q
    if (acceptable) score++
    balance -= action === 'high' ? config.highEffortCost : config.lowEffortCost
    periods.push({
      period: p, action, u, acceptable, reliability_used: q, score, balance,
    })
  }
  return { contract: index, condition, reliability, periods }
}

/** A full alternating session under one policy. */
function playSession(policy: Policy, seed: number, startsWith: Condition = 'high'): StoredContract[] {
  const draw = rng(seed)
  const out: StoredContract[] = []
  for (let k = 1; k <= config.contracts; k++) {
    const condition: Condition = (k - 1) % 2 === 0
      ? startsWith
      : (startsWith === 'high' ? 'low' : 'high')
    out.push(playContract(k, condition, policy, draw))
  }
  return out
}

const dead = (s: { score: number; periodsRemaining: number }) => s.score + s.periodsRemaining < S
const coasting = (s: { score: number }) => s.score >= S

/** ⚠ Every one of these reads `score` and `periodsRemaining` — and NEVER `reliability`. */
const BLIND: Record<string, Policy> = {
  'stops on dead contracts': s => (dead(s) ? 'low' : 'high'),
  'stops on dead + coasts at target': s => (dead(s) || coasting(s) ? 'low' : 'high'),
  'coasts at target only': s => (coasting(s) ? 'low' : 'high'),
}

/** ⚠ THIS one reads `reliability` — the genuine responder. */
const RESPONDER: Policy = s =>
  (s.reliability > 0.55 && !dead(s) && !coasting(s) ? 'high' : 'low')

describe('⚠⚠ contested periods zero the reliability-blind artifacts EXACTLY', () => {
  for (const [name, policy] of Object.entries(BLIND)) {
    it(`${name}: fake gap over all periods, EXACTLY 0 over contested`, () => {
      // Several seeds, because the all-period artifact is a sampling phenomenon and the
      // contested result must hold on every one of them.
      const raws: number[] = []
      for (let seed = 1; seed <= 8; seed++) {
        const contracts = playSession(policy, seed * 977)
        const raw = effortGap(contracts, config)
        const contested = contestedEffortGap(contracts, config)

        expect(raw, 'the raw gap must be defined').not.toBeNull()
        expect(contested, 'the contested gap must be defined').not.toBeNull()
        // ⚠ EXACTLY zero — not "close to". The policy is constant on contested states, so
        // the rate is identical in both conditions by construction.
        expect(contested, `${name} @ seed ${seed} must have a contested gap of exactly 0`)
          .toBe(0)
        raws.push(raw as number)
      }
      // ⚠ And the raw gap is NOT zero — otherwise this test would pass on a policy that
      // simply never differed, and would be proving nothing.
      const meanRaw = raws.reduce((a, b) => a + b, 0) / raws.length
      expect(Math.abs(meanRaw), `${name}: the raw gap must be a real artifact, not noise`)
        .toBeGreaterThan(0.03)
    })
  }

  it('⚠ the artifacts point in BOTH directions — deadness up, coasting down', () => {
    // Recorded because it is why the raw gap cannot be "corrected" with an offset: the
    // bias depends on which stopping rule a student uses.
    const seeds = [11, 22, 33, 44, 55, 66, 77, 88]
    const mean = (policy: Policy) =>
      seeds.map(s => effortGap(playSession(policy, s * 613), config) as number)
        .reduce((a, b) => a + b, 0) / seeds.length

    expect(mean(BLIND['stops on dead contracts']),
      'stopping on dead contracts biases the gap UP').toBeGreaterThan(0.05)
    expect(mean(BLIND['coasts at target only']),
      'coasting biases the gap DOWN').toBeLessThan(0)
  })

  it('⚠ the genuine responder STRENGTHENS under the contested denominator', () => {
    for (let seed = 1; seed <= 5; seed++) {
      const contracts = playSession(RESPONDER, seed * 401)
      const raw = effortGap(contracts, config) as number
      const contested = contestedEffortGap(contracts, config) as number
      expect(contested).toBeGreaterThan(raw)
      // Works every contested high period and no contested low period ⇒ exactly 1.
      expect(contested).toBe(1)
    }
  })

  it('⚠ CALIBRATION: the raw gap would rank a blind student ABOVE a weak responder', () => {
    // The concrete harm the contested denominator prevents — a roster sorted on the raw
    // gap puts someone who never thought about reliability above someone who did.
    const blind = playSession(BLIND['stops on dead contracts'], 2024)
    // A GENUINELY WEAK responder — it reads reliability, but only acts on it late in a
    // contract, so its raw gap is small. (A responder that works every high period has a
    // raw gap near 1 and would not make the point.)
    const weakish = playSession(
      s => (s.reliability > 0.55 && s.periodsRemaining <= 3 ? 'high' : 'low'),
      2024,
    )
    const rawBlind = effortGap(blind, config) as number
    const rawWeak = effortGap(weakish, config) as number
    const conBlind = contestedEffortGap(blind, config) as number
    const conWeak = contestedEffortGap(weakish, config) as number

    expect(rawBlind, 'the blind student out-ranks the weak responder on the RAW gap')
      .toBeGreaterThan(rawWeak)
    expect(conWeak, 'and the contested gap puts them back in the right order')
      .toBeGreaterThan(conBlind)
    expect(conBlind).toBe(0)
  })
})

describe('isContested — the predicate itself', () => {
  it('is score < target AND still reachable', () => {
    expect(isContested(0, T, S)).toBe(true)          // fresh contract
    expect(isContested(S, 3, S)).toBe(false)         // already won — coasting
    expect(isContested(S + 1, 3, S)).toBe(false)     // beyond target
    expect(isContested(0, S - 1, S)).toBe(false)     // dead
    expect(isContested(0, S, S)).toBe(true)          // exactly reachable
    expect(isContested(S - 1, 1, S)).toBe(true)      // the pivotal period
  })

  it('⚠ excludes BOTH ends — the coasting end and the dead end', () => {
    // The two exclusions are what make the denominator work: the mix of these two states
    // is what differs between conditions.
    expect(isContested(S, T, S)).toBe(false)
    expect(isContested(0, 1, S)).toBe(false)
  })

  it('counts contested periods over a whole contract', () => {
    // All-low, all misses: contested from period 1 until the contract dies at period 5
    // (score 0, 6 remaining, 0 + 6 < 7).
    const c = playContract(1, 'high', () => 'low', () => 0.99)
    expect(contestedPeriodCount([c], config)).toBe(4)
    expect(periodsPaidAfterDead([c], config)).toBe(0)   // never paid, it played low
  })

  it('a student with no contested periods has a NULL rate, never 0', () => {
    // Every period acceptable ⇒ target met at period 7, and periods 8-10 are coasting.
    // Periods 1-7 are contested, so build one that is contested nowhere: impossible at
    // T=10/S=7, so assert the null path directly on an empty set.
    expect(contestedEffortRate([], config)).toBeNull()
    expect(contestedEffortGap([], config)).toBeNull()
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// ⚠⚠ ONE BOT RULE — humans only, everywhere (spec §11, 08-07).
// ═══════════════════════════════════════════════════════════════════════════════
describe('the bot filter', () => {
  const doc = (id: string, extra: Record<string, unknown> = {}) => ({ id, data: extra })

  it('recognises both robot signals', () => {
    expect(isBot('robot-3', {})).toBe(true)
    expect(isBot('ROBOT-3', {})).toBe(true)
    expect(isBot('stu-chen', { is_robot: true })).toBe(true)
    expect(isBot('stu-chen', {})).toBe(false)
    // ⚠ A student legitimately named something containing "robot" mid-string is NOT a bot.
    expect(isBot('probotnik', {})).toBe(false)
  })

  it('splits humans from bots, and charts follow the HUMANS', () => {
    const split = splitPopulation(
      [doc('stu-a'), doc('robot-0'), doc('stu-b'), doc('stu-c', { is_robot: true })],
      config, parseStoredContracts,
    )
    expect(split.humanCount).toBe(2)
    expect(split.botCount).toBe(2)
    expect(split.isDemoCohort).toBe(false)
    expect(split.chartPopulation.map(p => p.participantId)).toEqual(['stu-a', 'stu-b'])
  })

  it('⚠ falls back to bot data ONLY when there are zero humans', () => {
    const split = splitPopulation([doc('robot-0'), doc('robot-1')], config, parseStoredContracts)
    expect(split.isDemoCohort).toBe(true)
    expect(split.chartPopulation.map(p => p.participantId)).toEqual(['robot-0', 'robot-1'])
  })

  it('⚠ one human is enough to switch the fallback OFF', () => {
    // "Zero humans", not "zero humans who played" — a roster of never-started students is
    // a real class, and showing them robot data under a demo banner would be a lie.
    const split = splitPopulation(
      [doc('robot-0'), doc('robot-1'), doc('stu-never-started')],
      config, parseStoredContracts,
    )
    expect(split.isDemoCohort).toBe(false)
    expect(split.chartPopulation.map(p => p.participantId)).toEqual(['stu-never-started'])
  })

  it('an empty instance is not a demo cohort', () => {
    expect(splitPopulation([], config, parseStoredContracts).isDemoCohort).toBe(false)
  })
})

describe('the gap distribution reconciles every student (R6)', () => {
  it('plotted + undefined + never-played = the population', () => {
    const played = playSession(RESPONDER, 99)
    const pop: ParticipantContracts[] = [
      { participantId: 'a', contracts: played },
      { participantId: 'b', contracts: played },
      // ⚠ One condition only — an UNDEFINED gap, not a zero.
      { participantId: 'c', contracts: played.filter(c => c.condition === 'high') },
      { participantId: 'd', contracts: [] },
    ]
    const d = gapDistribution(pop, config)
    expect(d.included + d.excludedUndefined + d.excludedNoPlay).toBe(pop.length)
    expect(d.excludedUndefined).toBe(1)
    expect(d.excludedNoPlay).toBe(1)
    expect(d.bins.reduce((a, b) => a + b.count, 0)).toBe(d.included)
  })

  it('⚠ the mass at zero counts BLIND students — the finding chart 3 shows', () => {
    const pop: ParticipantContracts[] = Object.values(BLIND).map((policy, i) => ({
      participantId: `blind-${i}`,
      contracts: playSession(policy, 500 + i),
    }))
    const d = gapDistribution(pop, config)
    expect(d.atZero).toBe(pop.length)
  })

  it('⚠ and under the RAW gap that mass would not exist', () => {
    // Spec §11: "Tier-3 chart 3's mass at zero only exists under this denominator. Under
    // the raw one the mass sits near +0.3 and the finding is invisible."
    const raws = Object.values(BLIND).map((policy, i) =>
      effortGap(playSession(policy, 500 + i), config) as number)
    expect(raws.every(r => r !== 0)).toBe(true)
  })
})

describe('highEffortRate stays null-safe (T2)', () => {
  it('returns null on an empty set, never 0', () => {
    expect(highEffortRate([])).toBeNull()
  })
})
