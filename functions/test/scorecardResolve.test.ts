import { describe, it, expect } from 'vitest'
import {
  resolvePeriod, settleContract, isDead, periodsPaidAfterDead,
  type PeriodRecord, type EffortAction,
} from '../src/scorecard/resolve'
import { solve, isWrittenOff } from '../src/scorecard/dp'
import {
  DEFAULT_CONFIG, DEFAULT_RELIABILITY_HIGH, DEFAULT_RELIABILITY_LOW,
  type ScorecardRules, type Condition,
} from '../src/scorecard/config'

const RULES: ScorecardRules = DEFAULT_CONFIG

/** A deterministic draw source, so a test can place `u` exactly where it matters. */
function draws(...values: number[]): () => number {
  let i = 0
  return () => {
    if (i >= values.length) throw new Error('drew more times than the test supplied')
    return values[i++]
  }
}

function play(
  actions: EffortAction[],
  us: number[],
  reliability: number,
  condition: Condition = 'high',
  rules: ScorecardRules = RULES,
): PeriodRecord[] {
  const draw = draws(...us)
  const out: PeriodRecord[] = []
  let score = 0
  let balance = rules.endowmentPerContract
  actions.forEach((action, i) => {
    const rec = resolvePeriod(
      { period: i + 1, action, reliability, condition, score, balance, rules },
      draw,
    )
    score = rec.score
    balance = rec.balance
    out.push(rec)
  })
  return out
}

describe('resolvePeriod — the draw (S1, spec §14.1)', () => {
  it('⚠ RECORDS the draw itself, not just the outcome', () => {
    // S1: a value that is derived on read re-rolls, because classroom instances set no
    // seed and `makeRng` falls back to Math.random. The record must carry `u`.
    const rec = resolvePeriod(
      { period: 1, action: 'high', reliability: 0.7, condition: 'high', score: 0, balance: 50, rules: RULES },
      draws(0.42),
    )
    expect(rec.u).toBe(0.42)
    expect(rec.acceptable).toBe(true)
  })

  it('⚠ WRITES reliabilityUsed rather than leaving it to be re-derived', () => {
    const hi = resolvePeriod(
      { period: 1, action: 'high', reliability: 0.7, condition: 'high', score: 0, balance: 50, rules: RULES },
      draws(0.9),
    )
    expect(hi.reliabilityUsed).toBe(0.7)
    expect(hi.condition).toBe('high')

    const lo = resolvePeriod(
      { period: 1, action: 'high', reliability: 0.4, condition: 'low', score: 0, balance: 50, rules: RULES },
      draws(0.9),
    )
    expect(lo.reliabilityUsed).toBe(0.4)
    expect(lo.condition).toBe('low')
  })

  it('⚠ LOW effort records p_low in BOTH conditions — the mechanism (spec §2.1)', () => {
    // This is the tripwire cell. A condition-plumbing bug that routed `reliability`
    // into low effort would still produce a plausible game; only the paired 0.70/0.40
    // cells would separate, and both of these would silently move.
    for (const [condition, reliability] of [
      ['high', DEFAULT_RELIABILITY_HIGH],
      ['low', DEFAULT_RELIABILITY_LOW],
    ] as const) {
      const rec = resolvePeriod(
        { period: 1, action: 'low', reliability, condition, score: 0, balance: 50, rules: RULES },
        draws(0.5),
      )
      expect(rec.reliabilityUsed, `condition ${condition}`).toBe(RULES.pAcceptableLow)
    }
  })

  it('draws EXACTLY ONCE per period, whatever the action', () => {
    // ⚠ The positional-RNG convention (procurement BUILD_NOTES §4): the stream position
    // after a period must not depend on what the student chose. `draws()` throws on an
    // extra call, so a second draw fails loudly; the count assertion catches zero draws.
    for (const action of ['high', 'low'] as EffortAction[]) {
      let calls = 0
      resolvePeriod(
        { period: 1, action, reliability: 0.7, condition: 'high', score: 0, balance: 50, rules: RULES },
        () => { calls++; return 0.5 },
      )
      expect(calls, `action ${action}`).toBe(1)
    }
  })

  it('the acceptance boundary is u < p, so u = p is a MISS', () => {
    const at = (u: number) => resolvePeriod(
      { period: 1, action: 'high', reliability: 0.7, condition: 'high', score: 0, balance: 50, rules: RULES },
      draws(u),
    ).acceptable
    expect(at(0.6999)).toBe(true)
    expect(at(0.7)).toBe(false)
    expect(at(0.7001)).toBe(false)
    // ⚠ Calibrated: a `u <= p` implementation flips the middle case. The convention
    // matters because a uniform on [0,1) hits exactly 0 with positive probability under
    // some RNGs, and `u < p` keeps P(acceptable) = p exactly.
    expect(at(0)).toBe(true)
  })

  it('charges the right cost and carries score forward', () => {
    const recs = play(['high', 'low', 'high'], [0.1, 0.9, 0.9], 0.7)
    expect(recs.map(r => r.acceptable)).toEqual([true, false, false])
    expect(recs.map(r => r.score)).toEqual([1, 1, 1])
    expect(recs.map(r => r.balance)).toEqual([46, 46, 42])
  })
})

describe('settleContract — the bonus lands at contract end (spec §1)', () => {
  it('pays the bonus at exactly the target score', () => {
    const seven = play(Array(10).fill('high'), [
      0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.9, 0.9, 0.9,
    ], 0.7)
    const r = settleContract(seven, RULES)
    expect(r.score).toBe(7)
    expect(r.metTarget).toBe(true)
    expect(r.highEffortPeriods).toBe(10)
    // 50 − 4×10 + 120 = 130
    expect(r.earnings).toBe(130)
  })

  it('pays nothing one point short', () => {
    const six = play(Array(10).fill('high'), [
      0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.9, 0.9, 0.9, 0.9,
    ], 0.7)
    const r = settleContract(six, RULES)
    expect(r.score).toBe(6)
    expect(r.metTarget).toBe(false)
    expect(r.earnings).toBe(10) // 50 − 40
  })

  it('matches the spec §1 formula on a mixed contract', () => {
    const actions: EffortAction[] = ['high', 'high', 'low', 'low', 'high', 'low', 'low', 'low', 'low', 'low']
    const us = [0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.9, 0.9, 0.9]
    const recs = play(actions, us, 0.7)
    const r = settleContract(recs, RULES)
    const expected =
      RULES.endowmentPerContract - RULES.highEffortCost * r.highEffortPeriods +
      (r.metTarget ? RULES.bonus : 0)
    expect(r.earnings).toBe(expected)
    expect(r.highEffortPeriods).toBe(3)
    expect(r.score).toBe(7)
    expect(r.earnings).toBe(158) // 50 − 12 + 120
  })

  it('charges lowEffortCost when it is not zero', () => {
    const rules: ScorecardRules = { ...RULES, lowEffortCost: 1 }
    const recs = play(['high', 'low'], [0.9, 0.9], 0.7, 'high', rules)
    expect(settleContract(recs, rules).earnings).toBe(50 - 4 - 1)
  })

  it('an empty contract is just the endowment', () => {
    expect(settleContract([], RULES)).toEqual({
      highEffortPeriods: 0, score: 0, metTarget: false, earnings: 50,
    })
  })
})

describe('§4.1 — the dead state, server-side only', () => {
  it('is exactly score + periodsRemaining < targetScore', () => {
    expect(isDead(0, 7, 7)).toBe(false) // needs all seven — still alive
    expect(isDead(0, 6, 7)).toBe(true)
    expect(isDead(6, 1, 7)).toBe(false)
    expect(isDead(5, 1, 7)).toBe(true)
    expect(isDead(7, 0, 7)).toBe(false) // already met
  })

  it('⚠ is ABSORBING — a point scored while dead does not revive a contract', () => {
    // Relied on by deadStateShare's single-count. If s + r < S then after any period
    // s + r is unchanged (score +1, remaining −1) or falls.
    let score = 1
    for (let remaining = 4; remaining >= 1; remaining--) {
      expect(isDead(score, remaining, 7)).toBe(true)
      score += 1 // best case: every remaining period is acceptable
    }
  })

  it('counts periods paid for after the contract was already dead (spec §11)', () => {
    // Score stays 0 through period 4; from period 5 the contract is dead (0 + 6 < 7).
    // The student keeps paying high effort in periods 5–10: six wasted periods.
    const actions: EffortAction[] = Array(10).fill('high')
    const us = Array(10).fill(0.99) // every draw a miss
    const recs = play(actions, us, 0.7)
    expect(recs[recs.length - 1].score).toBe(0)
    expect(periodsPaidAfterDead(recs, RULES)).toBe(6)
  })

  it('counts nothing when the contract never dies', () => {
    const recs = play(Array(10).fill('high'), Array(10).fill(0.01), 0.7)
    expect(recs[recs.length - 1].score).toBe(10)
    expect(periodsPaidAfterDead(recs, RULES)).toBe(0)
  })

  it('⚠ counts only HIGH effort — low effort in a dead contract costs nothing', () => {
    const actions: EffortAction[] = [
      'high', 'high', 'high', 'high', 'low', 'low', 'low', 'low', 'low', 'low',
    ]
    const recs = play(actions, Array(10).fill(0.99), 0.7)
    expect(periodsPaidAfterDead(recs, RULES)).toBe(0)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// ⚠⚠ `isDead` AND `isWrittenOff` ARE TWO FUNCTIONS AND MUST STAY TWO (Elena, 08-07).
//
//   isWrittenOff — LOOSE. Optimal play has stopped paying, target unmet. Policy-dependent.
//                  Feeds spec §6.3's effort-profile row.
//   isDead       — STRICT. score + periodsRemaining < targetScore. Pure arithmetic.
//                  Feeds spec §4.1's silence and Tier 1's "periods paid after dead".
//
// If one served both, the Tier-1 column would count give-ups that were never impossible,
// and the effort-gap ranking built on it would order the class by divergence from the DP
// rather than by waste.
// ═══════════════════════════════════════════════════════════════════════════════
describe('⚠ the two write-off predicates are distinct', () => {
  const sol = solve(RULES, DEFAULT_RELIABILITY_HIGH)
  const T = RULES.periodsPerContract
  /** periodsRemaining at period p, INCLUDING p. */
  const remainingAt = (p: number) => T - p + 1

  it('⚠ THEY DISAGREE AT (period 4, score 0) — the cell spec §6.2 names', () => {
    const r = remainingAt(4)
    // Still reachable: 0 + 7 = 7 = targetScore. Every remaining period must land, but it
    // is not impossible.
    expect(isDead(0, r, RULES.targetScore)).toBe(false)
    // And yet the DP has already given up on it — Δ = 2.72 against a threshold of 10.
    expect(isWrittenOff(sol, r, 0, RULES.targetScore)).toBe(true)
  })

  it('they agree once the contract is genuinely impossible', () => {
    const r = remainingAt(5) // 0 + 6 < 7
    expect(isDead(0, r, RULES.targetScore)).toBe(true)
    expect(isWrittenOff(sol, r, 0, RULES.targetScore)).toBe(true)
  })

  it('⚠ isWrittenOff EXCLUDES coasting; isDead is false there too, for a different reason', () => {
    const r = remainingAt(8)
    // Target already met: the DP plays low, but this is coasting, not a write-off.
    expect(isWrittenOff(sol, r, 7, RULES.targetScore)).toBe(false)
    expect(isDead(7, r, RULES.targetScore)).toBe(false)
  })

  it('neither fires in the squeeze, where the DP is paying', () => {
    const r = remainingAt(8)
    expect(isWrittenOff(sol, r, 6, RULES.targetScore)).toBe(false)
    expect(isDead(6, r, RULES.targetScore)).toBe(false)
  })

  it('⚠ isWrittenOff is strictly WEAKER — dead always implies written off, never the reverse', () => {
    let strictlyLooser = 0
    for (let p = 1; p <= T; p++) {
      const r = remainingAt(p)
      for (let s = 0; s <= p - 1; s++) {
        const dead = isDead(s, r, RULES.targetScore)
        const off = isWrittenOff(sol, r, s, RULES.targetScore)
        if (dead) expect(off, `p${p} s${s}: dead but not written off`).toBe(true)
        if (off && !dead) strictlyLooser++
      }
    }
    // ⚠ Size-asserted (T2): if the two predicates ever coincided everywhere, the loop
    // above would pass vacuously and the distinction would be untested. At the shipped
    // defaults there are exactly three states where the DP gives up on a live contract —
    // (p4,s0), (p5,s1) and (p7,s6), the cells that make the DP non-optional.
    expect(strictlyLooser).toBe(3)
  })

  it('⚠ swapping isDead for isWrittenOff would inflate the Tier-1 column', () => {
    // The concrete cost of merging them, on a real transcript: a student who plays high
    // throughout and never scores. The strict count starts at period 5 (the contract
    // becomes impossible); the loose one would start at period 4, where the DP gives up
    // but the bonus is still reachable — one extra period charged to every such student.
    const recs = play(Array(10).fill('high'), Array(10).fill(0.99), 0.7)
    expect(periodsPaidAfterDead(recs, RULES)).toBe(6)

    const looseCount = recs.filter((_, i) =>
      isWrittenOff(sol, T - i, i === 0 ? 0 : recs[i - 1].score, RULES.targetScore),
    ).length
    expect(looseCount).toBe(7)
    expect(looseCount).toBeGreaterThan(periodsPaidAfterDead(recs, RULES))
  })
})

describe('the draw rate is action- AND condition-conditional (spec §13)', () => {
  // ⚠ ALL FOUR CELLS, EACH SIZE-ASSERTED FIRST (T2). An empty cohort makes `.every()`
  // and any mean vacuously agreeable; the 0.30-in-both cell is where a condition
  // -plumbing bug hides, because it is CORRECT under a collapsed treatment.
  const N = 40000

  /** Deterministic uniform stream — no RNG, so this test cannot flake. */
  function stream(n: number): number[] {
    return Array.from({ length: n }, (_, i) => (i + 0.5) / n)
  }

  const cells: [string, EffortAction, Condition, number, number][] = [
    ['high effort / high reliability', 'high', 'high', DEFAULT_RELIABILITY_HIGH, 0.70],
    ['high effort / low reliability', 'high', 'low', DEFAULT_RELIABILITY_LOW, 0.40],
    ['low effort / high reliability', 'low', 'high', DEFAULT_RELIABILITY_HIGH, 0.30],
    ['low effort / low reliability', 'low', 'low', DEFAULT_RELIABILITY_LOW, 0.30],
  ]

  for (const [name, action, condition, reliability, expected] of cells) {
    it(`${name} → ${expected}`, () => {
      const us = stream(N)
      let accepted = 0
      let n = 0
      for (const u of us) {
        const rec = resolvePeriod(
          { period: 1, action, reliability, condition, score: 0, balance: 50, rules: RULES },
          () => u,
        )
        if (rec.acceptable) accepted++
        n++
      }
      expect(n, 'cohort size — assert BEFORE the rate (T2)').toBe(N)
      expect(accepted / n).toBeCloseTo(expected, 3)
    })
  }

  it('⚠ the two 0.30 cells are IDENTICAL — and that is what makes them a tripwire', () => {
    const rate = (condition: Condition, reliability: number) => {
      const us = stream(N)
      let acc = 0
      for (const u of us) {
        if (resolvePeriod(
          { period: 1, action: 'low', reliability, condition, score: 0, balance: 50, rules: RULES },
          () => u,
        ).acceptable) acc++
      }
      return acc / us.length
    }
    expect(rate('high', DEFAULT_RELIABILITY_HIGH)).toBe(rate('low', DEFAULT_RELIABILITY_LOW))
  })

  it('⚠ the two HIGH-effort cells SEPARATE — which a collapsed treatment would not', () => {
    const rate = (reliability: number) => {
      const us = stream(N)
      let acc = 0
      for (const u of us) {
        if (resolvePeriod(
          { period: 1, action: 'high', reliability, condition: 'high', score: 0, balance: 50, rules: RULES },
          () => u,
        ).acceptable) acc++
      }
      return acc / us.length
    }
    const hi = rate(DEFAULT_RELIABILITY_HIGH)
    const lo = rate(DEFAULT_RELIABILITY_LOW)
    expect(hi - lo).toBeCloseTo(0.30, 3)
  })
})
