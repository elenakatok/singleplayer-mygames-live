import { describe, it, expect } from 'vitest'
import {
  inducedBehaviour, MIN_SEPARATION_PERIODS, BONUS_PROBABILITY_BAND, type WarningId,
} from '../src/scorecard/validate'
import {
  DEFAULT_CONFIG, DEFAULT_TRUTH, renderLabel, marginalThreshold,
  type ScorecardConfig, type ScorecardTruth,
} from '../src/scorecard/config'

const cfg = (over: Partial<ScorecardConfig> = {}): ScorecardConfig => ({ ...DEFAULT_CONFIG, ...over })
const truth = (over: Partial<ScorecardTruth> = {}): ScorecardTruth => ({ ...DEFAULT_TRUTH, ...over })
const ids = (c: ScorecardConfig, t: ScorecardTruth): WarningId[] =>
  inducedBehaviour(c, t).warnings.map(w => w.id)

describe('the induced-behaviour panel (spec §3.1)', () => {
  it('shows the pair of thresholds the whole game turns on — 10 and 40', () => {
    const p = inducedBehaviour(cfg(), truth())
    expect(p.high.threshold).toBeCloseTo(10, 9)
    expect(p.low.threshold).toBeCloseTo(40, 9)
  })

  it('reports the separation at defaults — 8.12 periods', () => {
    expect(inducedBehaviour(cfg(), truth()).separation).toBeCloseTo(8.12, 2)
  })

  it('carries spec §6.3 benchmarks for BOTH conditions side by side', () => {
    const p = inducedBehaviour(cfg(), truth())
    expect(p.high.benchmarks.optimal).toBeCloseTo(94.12, 2)
    expect(p.low.benchmarks.optimal).toBeCloseTo(51.56, 2)
    expect(p.high.benchmarks.alwaysHigh).toBeCloseTo(87.95, 2)
    expect(p.low.benchmarks.alwaysHigh).toBeCloseTo(16.57, 2)
    expect(p.high.benchmarks.pBonusOptimal).toBeCloseTo(0.6427, 4)
    expect(p.low.benchmarks.pBonusOptimal).toBeCloseTo(0.0173, 4)
  })

  it('is silent at the shipped defaults', () => {
    // ⚠ The most important assertion in the file: if the SHIPPED configuration warns,
    // instructors learn to ignore the panel and it stops working as a control.
    expect(ids(cfg(), truth())).toEqual([])
  })
})

describe('the separation warning — the lesson-critical one (spec §3.1)', () => {
  it('fires when the two conditions induce similar behaviour', () => {
    // 0.70 vs 0.65: both conditions reward effort, so optimal play barely differs.
    const w = ids(cfg(), truth({ reliabilityLow: 0.65 }))
    expect(w).toContain('separation')
  })

  it('does NOT fire at the shipped gap', () => {
    expect(ids(cfg(), truth())).not.toContain('separation')
  })

  it('⚠ CALIBRATION: the boundary is exactly MIN_SEPARATION_PERIODS', () => {
    // Walk reliabilityLow until the warning appears, then assert the flip lands on the
    // documented threshold rather than somewhere nearby. A warning whose boundary is
    // untested is a warning nobody can reason about when tuning.
    let lastQuiet = 0
    let firstLoud = 0
    for (let rl = 0.30; rl <= 0.70; rl += 0.005) {
      const p = inducedBehaviour(cfg(), truth({ reliabilityLow: Number(rl.toFixed(3)) }))
      const fired = p.warnings.some(w => w.id === 'separation')
      if (!fired) lastQuiet = p.separation
      else if (firstLoud === 0) firstLoud = p.separation
    }
    expect(lastQuiet).toBeGreaterThanOrEqual(MIN_SEPARATION_PERIODS)
    expect(firstLoud).toBeLessThan(MIN_SEPARATION_PERIODS)
  })

  it('is marked severe — it is not a style note', () => {
    const w = inducedBehaviour(cfg(), truth({ reliabilityLow: 0.65 })).warnings
    expect(w.find(x => x.id === 'separation')?.level).toBe('severe')
  })

  it('names both numbers in the message, not just the complaint', () => {
    const w = inducedBehaviour(cfg(), truth({ reliabilityLow: 0.65 })).warnings
    const msg = w.find(x => x.id === 'separation')!.message
    expect(msg).toMatch(/\d\.\d\d/)
    expect(msg).toContain('effort-gap')
  })
})

describe('the remaining §3.1 warnings', () => {
  it('⚠ no_treatment fires when both conditions are equal', () => {
    const w = ids(cfg(), truth({ reliabilityLow: 0.7 }))
    expect(w).toContain('no_treatment')
    expect(w).toContain('separation') // and the separation collapses too
  })

  it('degenerate_high fires when effort buys nothing in the high condition', () => {
    // Cost far above the bonus: never worth working, in either condition.
    const w = ids(cfg({ highEffortCost: 200 }), truth())
    expect(w).toContain('degenerate_high')
  })

  it('bonus_probability fires when the target is near-unreachable', () => {
    // Target 10 of 10 at 70%: optimal play wins the bonus 2.8% of the time.
    const w = ids(cfg({ targetScore: 10 }), truth())
    expect(w).toContain('bonus_probability')
  })

  it('bonus_probability fires when the target is nearly automatic', () => {
    const w = ids(cfg({ targetScore: 1 }), truth())
    expect(w).toContain('bonus_probability')
  })

  it('⚠ CALIBRATION: the band edges are the documented ones', () => {
    const pb = (targetScore: number) =>
      inducedBehaviour(cfg({ targetScore }), truth()).high.benchmarks.pBonusOptimal
    // Inside the band → quiet; outside → loud. Pinning the actual probabilities means
    // a change to the band is visible here rather than silently widening the gate.
    expect(pb(7)).toBeGreaterThan(BONUS_PROBABILITY_BAND.min)
    expect(pb(7)).toBeLessThan(BONUS_PROBABILITY_BAND.max)
    expect(pb(10)).toBeLessThan(BONUS_PROBABILITY_BAND.min)
    expect(pb(1)).toBeGreaterThan(BONUS_PROBABILITY_BAND.max)
  })

  it('odd_contracts fires only under alternating', () => {
    expect(ids(cfg({ contracts: 9 }), truth())).toContain('odd_contracts')
    expect(ids(cfg({ contracts: 9 }), truth({ reliabilitySchedule: 'blocked' })))
      .not.toContain('odd_contracts')
    expect(ids(cfg({ contracts: 10 }), truth())).not.toContain('odd_contracts')
  })

  it('⚠ target_score_rule follows round(T × reliabilityHigh), NOT the constant 7', () => {
    // Spec §3.1: seven is right at defaults BECAUSE round(10 × 0.7) = 7. The rule must
    // track T and reliabilityHigh, which is exactly when an instructor would not think
    // to re-check the target.
    expect(ids(cfg(), truth())).not.toContain('target_score_rule')

    // 20 periods at 70% implies 14, so the inherited 7 is now wrong.
    expect(ids(cfg({ periodsPerContract: 20 }), truth())).toContain('target_score_rule')
    expect(ids(cfg({ periodsPerContract: 20, targetScore: 14 }), truth()))
      .not.toContain('target_score_rule')

    // 10 periods at 90% implies 9.
    expect(ids(cfg(), truth({ reliabilityHigh: 0.9 }))).toContain('target_score_rule')
    expect(ids(cfg({ targetScore: 9 }), truth({ reliabilityHigh: 0.9 })))
      .not.toContain('target_score_rule')
  })
})

describe('⚠ warnings INFORM, never block (spec §3.1)', () => {
  it('returns a full panel even when every warning fires', () => {
    // A degenerate configuration must still produce numbers — the instructor is allowed
    // to build one deliberately, and a panel that threw would be a block by another name.
    const p = inducedBehaviour(
      cfg({ contracts: 9, targetScore: 10, highEffortCost: 500 }),
      truth({ reliabilityLow: 0.7 }),
    )
    expect(p.warnings.length).toBeGreaterThan(2)
    expect(Number.isFinite(p.high.benchmarks.optimal)).toBe(true)
    expect(Number.isFinite(p.low.benchmarks.optimal)).toBe(true)
    expect(Number.isFinite(p.separation)).toBe(true)
  })

  it('survives a condition that buys no probability at all', () => {
    // reliability == p_low ⇒ infinite threshold. The panel must say so, not crash.
    const p = inducedBehaviour(cfg(), truth({ reliabilityLow: 0.3 }))
    expect(p.low.threshold).toBe(Infinity)
    expect(marginalThreshold(cfg(), 0.3)).toBe(Infinity)
    expect(p.low.benchmarks.optimal).toBeCloseTo(p.low.benchmarks.alwaysLow, 6)
  })
})

describe('label interpolation (spec §3)', () => {
  it('⚠ renders {pct} from the LIVE config value, never a typed-in percentage', () => {
    expect(renderLabel(truth(), 'high')).toBe('High Reliability (70%)')
    expect(renderLabel(truth(), 'low')).toBe('Low Reliability (40%)')
    // The whole point: edit the probability, and the label follows.
    expect(renderLabel(truth({ reliabilityLow: 0.5 }), 'low')).toBe('Low Reliability (50%)')
    expect(renderLabel(truth({ reliabilityHigh: 0.85 }), 'high')).toBe('High Reliability (85%)')
  })

  it('rounds the percentage before display (R8)', () => {
    expect(renderLabel(truth({ reliabilityHigh: 0.325 }), 'high')).toBe('High Reliability (33%)')
    expect(renderLabel(truth({ reliabilityHigh: 1 / 3 }), 'high')).toBe('High Reliability (33%)')
  })

  it('leaves custom label text alone apart from the token', () => {
    expect(renderLabel(truth({ labelHigh: 'Reliable supplier rating — {pct} accurate' }), 'high'))
      .toBe('Reliable supplier rating — 70% accurate')
  })

  it('replaces every occurrence of the token', () => {
    expect(renderLabel(truth({ labelHigh: '{pct} / {pct}' }), 'high')).toBe('70% / 70%')
  })

  it('tolerates a label with no token at all', () => {
    // An instructor may legitimately want a label that names no number.
    expect(renderLabel(truth({ labelHigh: 'Condition A' }), 'high')).toBe('Condition A')
  })

  it('the panel renders its labels the same way', () => {
    const p = inducedBehaviour(cfg(), truth({ reliabilityLow: 0.55 }))
    expect(p.low.label).toBe('Low Reliability (55%)')
  })
})
