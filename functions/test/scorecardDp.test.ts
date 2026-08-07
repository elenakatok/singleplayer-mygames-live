import { describe, it, expect } from 'vitest'
import {
  solve, policyGrid, formatGrid, optimalProfile, deadStateShare, highEffortOptimal,
  type GridCell,
} from '../src/scorecard/dp'
import {
  SLIDE6_HIGH, SLIDE6_LOW, SLIDE6_PROFILE_HIGH, SPEC_BENCHMARKS,
  SPEC_DEAD_STATE_SHARE_HIGH, type FixtureRow,
} from '../src/scorecard/fixtures'
import {
  DEFAULT_CONFIG, DEFAULT_RELIABILITY_HIGH, DEFAULT_RELIABILITY_LOW,
  marginalThreshold, type ScorecardRules,
} from '../src/scorecard/config'

// ═══════════════════════════════════════════════════════════════════════════════
// THE SOLVER against spec §6.2's slide-6 fixtures and §6.3's benchmark table.
//
// ⚠ Every assertion here names how it was calibrated (T1). The fixture comparison's
// calibration — perturbing pAcceptableLow to 0.25 — is not described, it is RUN, at the
// bottom of the first block: a fixture test that has never been seen to fail is not known
// to compare anything.
// ═══════════════════════════════════════════════════════════════════════════════

const RULES: ScorecardRules = DEFAULT_CONFIG

/** Compare a solved grid against a committed fixture, cell by cell. */
function diffGrid(rules: ScorecardRules, reliability: number, fixture: readonly FixtureRow[]) {
  const mine = policyGrid(rules, reliability)
  const diffs: string[] = []
  expect(mine).toHaveLength(fixture.length)
  for (let i = 0; i < fixture.length; i++) {
    expect(mine[i].score, 'row order must match the fixture').toBe(fixture[i].score)
    for (let p = 0; p < fixture[i].cells.length; p++) {
      if (mine[i].cells[p] !== fixture[i].cells[p]) {
        diffs.push(`score ${fixture[i].score}, period ${p + 1}: fixture='${fixture[i].cells[p]}' solver='${mine[i].cells[p]}'`)
      }
    }
  }
  return diffs
}

describe('spec §6.2 — the slide-6 optimal policy grids', () => {
  it('reproduces the HIGH reliability (70%) panel cell for cell', () => {
    expect(diffGrid(RULES, DEFAULT_RELIABILITY_HIGH, SLIDE6_HIGH)).toEqual([])
  })

  it('reproduces the LOW reliability (40%) panel cell for cell', () => {
    expect(diffGrid(RULES, DEFAULT_RELIABILITY_LOW, SLIDE6_LOW)).toEqual([])
  })

  it('compares all 80 cells of each panel, not a subset', () => {
    // ⚠ Guards the comparison itself. A diffGrid that silently iterated zero columns
    // would return [] and both tests above would pass vacuously (T2: assert the size
    // before trusting an all-quantified result).
    expect(SLIDE6_HIGH).toHaveLength(8)
    expect(SLIDE6_LOW).toHaveLength(8)
    for (const row of [...SLIDE6_HIGH, ...SLIDE6_LOW]) {
      expect(row.cells).toHaveLength(10)
    }
  })

  // ── CALIBRATION (spec §13, T1) ────────────────────────────────────────────
  it('⚠ CALIBRATION: perturbing pAcceptableLow to 0.25 breaks BOTH panels', () => {
    const perturbed: ScorecardRules = { ...RULES, pAcceptableLow: 0.25 }

    const highDiffs = diffGrid(perturbed, DEFAULT_RELIABILITY_HIGH, SLIDE6_HIGH)
    const lowDiffs = diffGrid(perturbed, DEFAULT_RELIABILITY_LOW, SLIDE6_LOW)

    // The high panel moves in exactly one cell, the low panel in four. Pinning the
    // COUNTS (not merely "nonempty") is what makes this a calibration rather than a
    // smoke test: a change that broke the grid everywhere would also produce a nonempty
    // diff and would tell us nothing.
    expect(highDiffs).toEqual(['score 1, period 5: fixture=\'o\' solver=\'#\''])
    expect(lowDiffs).toEqual([
      "score 6, period 7: fixture='o' solver='#'",
      "score 4, period 6: fixture='o' solver='#'",
      "score 4, period 7: fixture='o' solver='#'",
      "score 3, period 4: fixture='o' solver='#'",
    ])
  })

  it('the noted cells carry the Δ values spec §6.2 quotes', () => {
    const sol = solve(RULES, DEFAULT_RELIABILITY_HIGH)
    const T = RULES.periodsPerContract
    // Δ = V(r−1, s+1) − V(r−1, s), at period p ⇒ r = T − p + 1.
    const deltaAt = (period: number, score: number) => {
      const r = T - period + 1
      return sol.V[r - 1][score + 1] - sol.V[r - 1][score]
    }
    // ⚠ The cell that makes the DP non-optional: one point from target, four periods
    // left, and optimal play takes the free draws first because 8.80 < 10.
    expect(deltaAt(7, 6)).toBeCloseTo(8.8, 2)
    expect(deltaAt(7, 6)).toBeLessThan(marginalThreshold(RULES, DEFAULT_RELIABILITY_HIGH))
    expect(highEffortOptimal(sol, T - 7 + 1, 6)).toBe(false)

    // Three failures out of the gate ⇒ written off with seven periods left.
    expect(deltaAt(4, 0)).toBeCloseTo(2.72, 2)
    expect(highEffortOptimal(sol, T - 4 + 1, 0)).toBe(false)
  })

  it('marks unreachable states, and only genuinely unreachable ones', () => {
    // At period p exactly p−1 periods have been played, so score ≤ p−1.
    for (const rel of [DEFAULT_RELIABILITY_HIGH, DEFAULT_RELIABILITY_LOW]) {
      for (const row of policyGrid(RULES, rel)) {
        row.cells.forEach((cell: GridCell, i) => {
          const period = i + 1
          expect(cell === '.', `score ${row.score} period ${period}`).toBe(row.score > period - 1)
        })
      }
    }
  })

  it('formats the grid in the shape spec §6.2 prints', () => {
    const block = formatGrid(RULES, DEFAULT_RELIABILITY_HIGH)
    expect(block.split('\n')).toHaveLength(9) // header + 8 score rows
    expect(block).toContain('score  period→')
    expect(block.split('\n')[1]).toMatch(/^\s+7\+/)
  })
})

describe('spec §6.3 — the benchmark table (analytic, not simulated)', () => {
  const cases = [
    ['high', DEFAULT_RELIABILITY_HIGH, SPEC_BENCHMARKS.high],
    ['low', DEFAULT_RELIABILITY_LOW, SPEC_BENCHMARKS.low],
  ] as const

  for (const [name, reliability, spec] of cases) {
    it(`reproduces the ${name}-reliability column exactly`, () => {
      const b = solve(RULES, reliability).benchmarks
      expect(b.marginalThreshold).toBeCloseTo(spec.marginalThreshold, 6)
      expect(b.optimal).toBeCloseTo(spec.optimal, 2)
      expect(b.highUntilTarget).toBeCloseTo(spec.highUntilTarget, 2)
      expect(b.alwaysHigh).toBeCloseTo(spec.alwaysHigh, 2)
      expect(b.alwaysLow).toBeCloseTo(spec.alwaysLow, 2)
      expect(b.pBonusOptimal).toBeCloseTo(spec.pBonusOptimal, 4)
      expect(b.expectedHighEffortPeriods).toBeCloseTo(spec.expectedHighEffortPeriods, 2)
      expect(b.expectedScoreOptimal).toBeCloseTo(spec.expectedScoreOptimal, 2)
    })
  }

  it('⚠ always-low is IDENTICAL in both conditions — reliability never touches low effort', () => {
    // Spec §2.1: only the high-effort probability moves. A bug routing `reliability`
    // into the always-low roll-forward would make these differ, and the settings panel
    // would show two plausible numbers instead of one repeated one.
    const hi = solve(RULES, DEFAULT_RELIABILITY_HIGH).benchmarks
    const lo = solve(RULES, DEFAULT_RELIABILITY_LOW).benchmarks
    expect(hi.alwaysLow).toBe(lo.alwaysLow)
    expect(hi.alwaysLow).toBeCloseTo(51.27, 2)
  })

  it('⚠ the columns INVERT — working hard is the worst thing to do under low reliability', () => {
    // Spec §5/§6.3: this is the finding, and it is worth an assertion because it is the
    // single most counter-intuitive number in the game and the one a "sensible" edit
    // would quietly destroy.
    const hi = solve(RULES, DEFAULT_RELIABILITY_HIGH).benchmarks
    const lo = solve(RULES, DEFAULT_RELIABILITY_LOW).benchmarks
    expect(hi.alwaysHigh).toBeGreaterThan(hi.alwaysLow)        // 87.95 > 51.27
    expect(lo.alwaysHigh).toBeLessThan(lo.alwaysLow / 3)       // 16.57 < 51.27/3
  })

  it('optimal is weakly better than every heuristic, in both conditions', () => {
    for (const rel of [DEFAULT_RELIABILITY_HIGH, DEFAULT_RELIABILITY_LOW]) {
      const b = solve(RULES, rel).benchmarks
      expect(b.optimal).toBeGreaterThanOrEqual(b.highUntilTarget - 1e-9)
      expect(b.optimal).toBeGreaterThanOrEqual(b.alwaysHigh - 1e-9)
      expect(b.optimal).toBeGreaterThanOrEqual(b.alwaysLow - 1e-9)
    }
  })

  it('⚠ "high until target" is a BENCHMARK, not the policy — it loses 0.17 ECU', () => {
    // The build prompt's first named failure mode: the shortcut is nearly right, and
    // "nearly" is exactly what makes it dangerous. Pinning the gap means a future edit
    // that quietly replaced the DP with the shortcut would fail HERE.
    const b = solve(RULES, DEFAULT_RELIABILITY_HIGH).benchmarks
    expect(b.optimal - b.highUntilTarget).toBeGreaterThan(0)
    expect(b.optimal - b.highUntilTarget).toBeCloseTo(2.96, 1)
  })

  it('the binomial identities behind always-high hold', () => {
    // P(Binom(10,0.7) ≥ 7) = 0.6496, P(Binom(10,0.4) ≥ 7) = 0.0548 (spec §4 of the
    // build prompt). always-high = endowment − c·T + B·P.
    const hi = solve(RULES, DEFAULT_RELIABILITY_HIGH).benchmarks
    const lo = solve(RULES, DEFAULT_RELIABILITY_LOW).benchmarks
    expect((hi.alwaysHigh - 50 + 4 * 10) / 120).toBeCloseTo(0.6496, 4)
    expect((lo.alwaysHigh - 50 + 4 * 10) / 120).toBeCloseTo(0.0548, 4)
  })
})

describe('spec §6.3 — the effort profile under optimal play', () => {
  it('reproduces the high-reliability dashed reference, all ten periods', () => {
    const profile = optimalProfile(RULES, DEFAULT_RELIABILITY_HIGH)
    expect(profile).toHaveLength(10)
    profile.forEach((m, i) => {
      expect(m.period, 'periods are 1-based (R10)').toBe(i + 1)
      expect(m.pHigh).toBeCloseTo(SLIDE6_PROFILE_HIGH.pHigh[i], 2)
      expect(m.pCoasting).toBeCloseTo(SLIDE6_PROFILE_HIGH.pCoasting[i], 2)
      expect(m.pWrittenOff).toBeCloseTo(SLIDE6_PROFILE_HIGH.pWrittenOff[i], 2)
    })
  })

  it('the three categories partition every period', () => {
    for (const rel of [DEFAULT_RELIABILITY_HIGH, DEFAULT_RELIABILITY_LOW]) {
      for (const m of optimalProfile(RULES, rel)) {
        expect(m.pHigh + m.pCoasting + m.pWrittenOff).toBeCloseTo(1, 10)
      }
    }
  })

  it('⚠ the low-reliability optimum is flat near zero — the lecture in one picture', () => {
    const profile = optimalProfile(RULES, DEFAULT_RELIABILITY_LOW)
    const mean = profile.reduce((s, m) => s + m.pHigh, 0) / profile.length
    expect(mean).toBeLessThan(0.02)
    // And it agrees with the benchmark's E[#high] = 0.13 over ten periods.
    expect(mean * 10).toBeCloseTo(SPEC_BENCHMARKS.low.expectedHighEffortPeriods, 2)
  })
})

describe('spec §6.3 — the dead-state share behind §4.1', () => {
  it('27.8% of high-reliability contracts die with a period still to play', () => {
    expect(deadStateShare(RULES, DEFAULT_RELIABILITY_HIGH, 1))
      .toBeCloseTo(SPEC_DEAD_STATE_SHARE_HIGH, 3)
  })

  it('⚠ counts each contract once — dead is absorbing', () => {
    // Calibration for the double-count this replaced: a version that counted "dead now,
    // alive one period ago" without removing dead mass reports 35.6%, because a contract
    // that scores a point while already dead re-satisfies the test. A share can also
    // never exceed 1 — the naive version reports 136% under an always-low policy.
    for (const rel of [DEFAULT_RELIABILITY_HIGH, DEFAULT_RELIABILITY_LOW]) {
      for (const minLeft of [0, 1, 2, 3]) {
        const share = deadStateShare(RULES, rel, minLeft)
        expect(share).toBeGreaterThanOrEqual(0)
        expect(share).toBeLessThanOrEqual(1)
      }
    }
    // Monotone in the strictness of "still to play".
    const a = deadStateShare(RULES, DEFAULT_RELIABILITY_HIGH, 1)
    const b = deadStateShare(RULES, DEFAULT_RELIABILITY_HIGH, 2)
    expect(b).toBeLessThan(a)
  })

  it('dying by the end reconciles with P(bonus)', () => {
    // Every contract that ends below target was dead at some point, including with zero
    // periods left. 1 − 0.6427 = 0.3573.
    const byEnd = deadStateShare(RULES, DEFAULT_RELIABILITY_HIGH, 0)
    const b = solve(RULES, DEFAULT_RELIABILITY_HIGH).benchmarks
    expect(byEnd).toBeCloseTo(1 - b.pBonusOptimal, 6)
  })
})

describe('the solver holds up away from the defaults', () => {
  it('a degenerate condition (reliability ≤ p_low) never pays for effort', () => {
    const sol = solve(RULES, 0.3)
    expect(marginalThreshold(RULES, 0.3)).toBe(Infinity)
    for (let r = 1; r <= RULES.periodsPerContract; r++) {
      for (let s = 0; s <= RULES.periodsPerContract; s++) {
        expect(sol.policy[r][s]).toBe(false)
      }
    }
    expect(sol.benchmarks.optimal).toBeCloseTo(sol.benchmarks.alwaysLow, 6)
  })

  it('a free bonus is always worth working for', () => {
    // Zero cost ⇒ threshold 0 ⇒ high effort weakly dominates everywhere it can help.
    const free: ScorecardRules = { ...RULES, highEffortCost: 0 }
    const sol = solve(free, DEFAULT_RELIABILITY_HIGH)
    expect(sol.policy[1][free.targetScore - 1]).toBe(true)
  })

  it('respects lowEffortCost — the rule turns on the cost DIFFERENCE', () => {
    // ⚠ Spec §6.1 writes the threshold as c/(rel − p_low) because lowEffortCost is 0 at
    // defaults. It is a setting, so the implemented rule uses the difference. Raising
    // BOTH costs by the same amount must leave the policy untouched.
    const shifted: ScorecardRules = { ...RULES, highEffortCost: 9, lowEffortCost: 5 }
    const base = solve(RULES, DEFAULT_RELIABILITY_HIGH)
    const same = solve(shifted, DEFAULT_RELIABILITY_HIGH)
    expect(same.policy).toEqual(base.policy)
    expect(marginalThreshold(shifted, DEFAULT_RELIABILITY_HIGH))
      .toBeCloseTo(marginalThreshold(RULES, DEFAULT_RELIABILITY_HIGH), 9)
    // Earnings DO move — five extra ECU per period of a ten-period contract.
    expect(same.benchmarks.optimal).toBeCloseTo(base.benchmarks.optimal - 50, 6)
  })

  it('scales to a different horizon and target', () => {
    const small: ScorecardRules = { ...RULES, periodsPerContract: 5, targetScore: 4 }
    const sol = solve(small, DEFAULT_RELIABILITY_HIGH)
    expect(sol.V).toHaveLength(6)
    expect(policyGrid(small, DEFAULT_RELIABILITY_HIGH)[0].cells).toHaveLength(5)
    // Coasting still holds: at target with periods left, stop paying.
    expect(highEffortOptimal(sol, 1, 4)).toBe(false)
  })

  it('coasting and writing off are universal, not artefacts of the defaults', () => {
    for (const rel of [0.5, 0.6, 0.7, 0.9]) {
      const sol = solve(RULES, rel)
      // At or above target with anything left: never pay.
      expect(highEffortOptimal(sol, 3, RULES.targetScore)).toBe(false)
      // Mathematically dead: never pay.
      expect(highEffortOptimal(sol, 1, 0)).toBe(false)
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// MUTATION TESTING (procurement CP2 precedent; BUILD_NOTES §3).
//
// ⚠ "My test looks like it would catch this" is not evidence. Each mutation below is a
// plausible one-line edit to dp.ts; the assertion is that the fixture-and-benchmark suite
// ACTUALLY REJECTS it. A mutation that survives means the controls above are decorative.
//
// The mutants are applied to a re-implementation of the recursion rather than by patching
// the module, because the point is to prove the FIXTURES discriminate — the grids and the
// §6.3 table are the contract, and they must fail on a wrong policy whatever produced it.
// ═══════════════════════════════════════════════════════════════════════════════
describe('⚠ mutation testing — the fixtures must reject a wrong solver', () => {
  type Mutant = (rules: ScorecardRules, reliability: number) => boolean[][]

  /** The real recursion, parameterised so each mutant can break exactly one thing. */
  function build(
    rules: ScorecardRules,
    reliability: number,
    opts: {
      lowUsesReliability?: boolean   // low effort resolves at `reliability`
      tieToHigh?: boolean            // `>=` instead of `>`
      ignoreCost?: boolean           // drop the effort cost from the comparison
      greedyTarget?: boolean         // the "work until target" shortcut
      offByOneTarget?: boolean       // bonus at S*−1
    } = {},
  ): boolean[][] {
    const { periodsPerContract: T, targetScore: S, bonus: B, pAcceptableLow: pLow } = rules
    const V: number[][] = []
    const policy: boolean[][] = []
    const target = opts.offByOneTarget ? S - 1 : S
    V[0] = []
    for (let s = 0; s <= T; s++) V[0][s] = s >= target ? B : 0
    policy[0] = []
    for (let r = 1; r <= T; r++) {
      V[r] = []
      policy[r] = []
      for (let s = 0; s <= T; s++) {
        const up = V[r - 1][Math.min(s + 1, T)]
        const stay = V[r - 1][s]
        const pL = opts.lowUsesReliability ? reliability : pLow
        const low = -rules.lowEffortCost + pL * up + (1 - pL) * stay
        const cHigh = opts.ignoreCost ? 0 : rules.highEffortCost
        const high = -cHigh + reliability * up + (1 - reliability) * stay
        const takeHigh = opts.greedyTarget ? s < target : opts.tieToHigh ? high >= low : high > low
        policy[r][s] = takeHigh
        V[r][s] = takeHigh ? high : low
      }
    }
    return policy
  }

  /** Does a mutant's policy still reproduce both slide-6 panels? */
  function reproducesFixtures(mutant: Mutant): boolean {
    for (const [rel, fixture] of [
      [DEFAULT_RELIABILITY_HIGH, SLIDE6_HIGH],
      [DEFAULT_RELIABILITY_LOW, SLIDE6_LOW],
    ] as const) {
      const policy = mutant(RULES, rel)
      for (let i = 0; i < fixture.length; i++) {
        const score = fixture[i].score
        for (let p = 1; p <= RULES.periodsPerContract; p++) {
          if (score > p - 1) continue // unreachable — the fixture prints '.'
          const expected: GridCell = fixture[i].cells[p - 1]
          const got: GridCell = policy[RULES.periodsPerContract - p + 1][score] ? '#' : 'o'
          if (got !== expected) return false
        }
      }
    }
    return true
  }

  it('sanity: the UNMUTATED recursion does reproduce the fixtures', () => {
    // ⚠ Without this, every "killed" verdict below could be an artefact of a broken
    // harness rather than a working control (BUILD_NOTES §3: a control can appear to
    // fail correctly and still be worthless).
    expect(reproducesFixtures((r, rel) => build(r, rel))).toBe(true)
  })

  const mutants: [string, Mutant][] = [
    ['low effort resolves at `reliability` (the condition collapse)',
      (r, rel) => build(r, rel, { lowUsesReliability: true })],
    ['the effort cost is dropped from the comparison',
      (r, rel) => build(r, rel, { ignoreCost: true })],
    ['⚠ the "work until you hit the target" shortcut',
      (r, rel) => build(r, rel, { greedyTarget: true })],
    ['the bonus threshold is off by one',
      (r, rel) => build(r, rel, { offByOneTarget: true })],
  ]

  for (const [name, mutant] of mutants) {
    it(`KILLS: ${name}`, () => {
      expect(reproducesFixtures(mutant)).toBe(false)
    })
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ⚠⚠ A MUTANT THE SLIDE-6 FIXTURES DO **NOT** KILL — recorded, not hidden.
  //
  // Turning the comparison from `>` into `>=` (ties to high effort) leaves BOTH panels
  // untouched, because at the shipped parameters no state is ever an exact tie. This is
  // precisely BUILD_NOTES §3's lesson — a control that looks like it guards strictness
  // and does not — so the honest fix is not to delete the mutant but to build the
  // scenario that actually contains the condition.
  //
  // The tie is constructed rather than searched for: at the LAST period, Δ is exactly
  // `bonus` at score S*−1 and 0 elsewhere, so the comparison reduces to
  // (reliability − p_low) · bonus  vs  c. Choosing binary-exact values — reliability
  // 0.5, p_low 0.25, bonus 120, c 30 — makes both sides exactly 30.00 with no float
  // slack, which is the only way a tie test is not itself a rounding accident.
  // ═══════════════════════════════════════════════════════════════════════════
  it('⚠ SURVIVES the fixtures: ties-to-high (`>=` for `>`) — no state ever ties at defaults', () => {
    expect(reproducesFixtures((r, rel) => build(r, rel, { tieToHigh: true }))).toBe(true)
  })

  it('⚠ …and IS killed by a constructed exact tie', () => {
    // Binary-exact throughout: 0.5 − 0.25 = 0.25 exactly, and 0.25 × 120 = 30 exactly.
    const tie: ScorecardRules = {
      ...RULES, pAcceptableLow: 0.25, highEffortCost: 30, lowEffortCost: 0, bonus: 120,
    }
    const rel = 0.5
    const r = 1
    const s = tie.targetScore - 1

    // Prove the tie is genuine before asserting anything about it.
    const high = -tie.highEffortCost + rel * tie.bonus + (1 - rel) * 0
    const low = -tie.lowEffortCost + tie.pAcceptableLow * tie.bonus + (1 - tie.pAcceptableLow) * 0
    expect(high, 'the construction must be an EXACT tie, not a near one').toBe(low)

    // Strict `>` gives the tie to LOW (spec §6.1: worth strictly MORE than the
    // threshold). The mutant flips exactly this cell.
    expect(build(tie, rel)[r][s]).toBe(false)
    expect(build(tie, rel, { tieToHigh: true })[r][s]).toBe(true)
  })

  it('⚠ the naive shortcut disagrees in 24 cells; the DEAD-AWARE one in exactly 3', () => {
    // The build prompt's headline risk, pinned precisely — the two shortcuts are very
    // different mistakes and only one of them is subtle.
    //
    //   "work until target"                 loses 2.96 ECU — 24 cells, mostly paying
    //                                       for contracts the DP has already written off
    //   "work until target, stop when dead" loses 0.16 ECU — 3 cells, and THOSE THREE
    //                                       are the ones spec §6.2 says make the DP
    //                                       non-optional
    //
    // 0.16 is the figure that matters: it is far too small to notice on a screen, which
    // is exactly why a second policy implementation would survive review.
    const T = RULES.periodsPerContract
    const optimal = build(RULES, DEFAULT_RELIABILITY_HIGH)

    const disagreementsWith = (playsHigh: (r: number, s: number) => boolean): string[] => {
      const out: string[] = []
      for (let p = 1; p <= T; p++) {
        const r = T - p + 1
        for (let s = 0; s <= RULES.targetScore; s++) {
          if (s > p - 1) continue // unreachable
          if (playsHigh(r, s) !== optimal[r][s]) out.push(`p${p} s${s}`)
        }
      }
      return out
    }

    const naive = disagreementsWith((_r, s) => s < RULES.targetScore)
    expect(naive).toHaveLength(24)
    expect(naive).toContain('p7 s6')

    const deadAware = disagreementsWith(
      (r, s) => s < RULES.targetScore && s + r >= RULES.targetScore,
    )
    // ⚠ Two of these three are named in spec §6.2's own note: (period 7, score 6) at
    // Δ = 8.80, and (period 4, score 0) at Δ = 2.72.
    expect(deadAware).toEqual(['p4 s0', 'p5 s1', 'p7 s6'])
  })

  it('⚠ pins what each shortcut COSTS — 2.96 and 0.16 ECU per contract', () => {
    const T = RULES.periodsPerContract
    const optimal = build(RULES, DEFAULT_RELIABILITY_HIGH)

    /** Expected earnings of an arbitrary policy — NOT the optimal V. */
    const valueOf = (playsHigh: (r: number, s: number) => boolean): number => {
      const V: number[][] = [[]]
      for (let s = 0; s <= T; s++) V[0][s] = s >= RULES.targetScore ? RULES.bonus : 0
      for (let r = 1; r <= T; r++) {
        V[r] = []
        for (let s = 0; s <= T; s++) {
          const up = V[r - 1][Math.min(s + 1, T)]
          const stay = V[r - 1][s]
          V[r][s] = playsHigh(r, s)
            ? -RULES.highEffortCost + DEFAULT_RELIABILITY_HIGH * up + (1 - DEFAULT_RELIABILITY_HIGH) * stay
            : -RULES.lowEffortCost + RULES.pAcceptableLow * up + (1 - RULES.pAcceptableLow) * stay
        }
      }
      return RULES.endowmentPerContract + V[T][0]
    }

    const opt = valueOf((r, s) => optimal[r][s])
    expect(opt).toBeCloseTo(SPEC_BENCHMARKS.high.optimal, 2)
    expect(opt - valueOf((_r, s) => s < RULES.targetScore)).toBeCloseTo(2.962, 3)
    expect(
      opt - valueOf((r, s) => s < RULES.targetScore && s + r >= RULES.targetScore),
    ).toBeCloseTo(0.163, 3)
  })

  it('KILLS via the §6.3 table: a wrong cost survives the grid but not the benchmarks', () => {
    // ⚠ A mutation the GRIDS alone do not catch, which is why the benchmark table is a
    // second, independent control rather than a restatement of the first. Scaling both
    // costs leaves the policy identical (the rule turns on the difference) and moves
    // every earnings figure.
    const wrongCost: ScorecardRules = { ...RULES, highEffortCost: 6, lowEffortCost: 2 }
    expect(diffGrid(wrongCost, DEFAULT_RELIABILITY_HIGH, SLIDE6_HIGH)).toEqual([])
    const b = solve(wrongCost, DEFAULT_RELIABILITY_HIGH).benchmarks
    expect(b.optimal).not.toBeCloseTo(SPEC_BENCHMARKS.high.optimal, 2)
  })
})
