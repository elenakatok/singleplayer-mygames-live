import { describe, it, expect } from 'vitest'
import { assignStartsWith, conditionFor, scheduleFor, other } from '../src/scorecard/schedule'
import type { Condition, ReliabilitySchedule } from '../src/scorecard/config'

// ═══════════════════════════════════════════════════════════════════════════════
// THE RELIABILITY SCHEDULE (spec §2.2).
//
// ⚠ The failure this guards against is SILENT: a schedule that collapses still produces
// ten contracts, a plausible effort curve and a full report. Nothing throws. So the
// assertions here are about STRUCTURE — alternation, exact balance, determinism — rather
// than about any single contract's condition.
// ═══════════════════════════════════════════════════════════════════════════════

const SCHEDULES: ReliabilitySchedule[] = ['alternating', 'blocked', 'betweenSubject']

describe('startsWith assignment (spec §2.2)', () => {
  it('alternates over the roster in join order, with no RNG', () => {
    const roster = Array.from({ length: 10 }, (_, i) => assignStartsWith(i))
    expect(roster).toEqual([
      'high', 'low', 'high', 'low', 'high', 'low', 'high', 'low', 'high', 'low',
    ])
  })

  it('is deterministic — the same ordinal always gives the same condition', () => {
    // ⚠ Calibrated against an RNG-based assignment: a `Math.random() < 0.5` version
    // passes an "is it high or low" test but fails this one roughly half the time per
    // call, which is what makes determinism assertable at all.
    for (let i = 0; i < 50; i++) {
      expect(assignStartsWith(i)).toBe(assignStartsWith(i))
    }
  })

  it('splits any even roster EXACTLY in half', () => {
    for (const n of [2, 10, 40, 200]) {
      const roster = Array.from({ length: n }, (_, i) => assignStartsWith(i))
      expect(roster.filter(c => c === 'high')).toHaveLength(n / 2)
      expect(roster.filter(c => c === 'low')).toHaveLength(n / 2)
    }
  })

  it('is off by at most one on an odd roster', () => {
    for (const n of [1, 7, 41]) {
      const roster = Array.from({ length: n }, (_, i) => assignStartsWith(i))
      const highs = roster.filter(c => c === 'high').length
      expect(Math.abs(highs - (n - highs))).toBe(1)
    }
  })
})

describe('alternating — the shipped schedule (spec §2.2)', () => {
  it('produces spec §2.2\'s two sequences verbatim', () => {
    expect(scheduleFor('high', 'alternating', 10)).toEqual(
      ['high', 'low', 'high', 'low', 'high', 'low', 'high', 'low', 'high', 'low'],
    )
    expect(scheduleFor('low', 'alternating', 10)).toEqual(
      ['low', 'high', 'low', 'high', 'low', 'high', 'low', 'high', 'low', 'high'],
    )
  })

  it('gives every student 5 of each condition over 10 contracts', () => {
    for (const startsWith of ['high', 'low'] as Condition[]) {
      const s = scheduleFor(startsWith, 'alternating', 10)
      expect(s.filter(c => c === 'high')).toHaveLength(5)
      expect(s.filter(c => c === 'low')).toHaveLength(5)
    }
  })

  it('strictly alternates — no two adjacent contracts share a condition', () => {
    for (const startsWith of ['high', 'low'] as Condition[]) {
      const s = scheduleFor(startsWith, 'alternating', 10)
      for (let i = 1; i < s.length; i++) expect(s[i]).toBe(other(s[i - 1]))
    }
  })

  it('⚠ the two arms are exact mirrors — which is what counterbalances the class', () => {
    const hi = scheduleFor('high', 'alternating', 10)
    const lo = scheduleFor('low', 'alternating', 10)
    // At every contract round, one arm is high and the other is low. This is the
    // property Tier-3 chart 1 depends on (spec §11): plotted against CONTRACT ROUND,
    // the two series are comparable only because the arms cancel.
    hi.forEach((c, i) => expect(lo[i]).toBe(other(c)))
  })

  it('over a whole class, every contract round is exactly half high', () => {
    const roster = Array.from({ length: 40 }, (_, i) =>
      scheduleFor(assignStartsWith(i), 'alternating', 10),
    )
    for (let round = 0; round < 10; round++) {
      const highs = roster.filter(s => s[round] === 'high').length
      expect(highs, `round ${round + 1}`).toBe(20)
    }
  })
})

describe('the non-shipped schedules (spec §15)', () => {
  it('blocked puts the first half in the starting condition', () => {
    expect(scheduleFor('high', 'blocked', 10)).toEqual(
      ['high', 'high', 'high', 'high', 'high', 'low', 'low', 'low', 'low', 'low'],
    )
    expect(scheduleFor('low', 'blocked', 10)).toEqual(
      ['low', 'low', 'low', 'low', 'low', 'high', 'high', 'high', 'high', 'high'],
    )
  })

  it('blocked rounds the first block up on an odd count', () => {
    expect(scheduleFor('high', 'blocked', 5)).toEqual(['high', 'high', 'high', 'low', 'low'])
  })

  it('betweenSubject holds one condition for the whole session', () => {
    expect(scheduleFor('high', 'betweenSubject', 10).every(c => c === 'high')).toBe(true)
    expect(scheduleFor('low', 'betweenSubject', 10).every(c => c === 'low')).toBe(true)
  })

  it('⚠ betweenSubject gives NO within-student contrast — the historical design', () => {
    // Recorded as an assertion because it is the thing spec §2.2 changed. A student in
    // this mode has one condition, so their effort gap is undefined rather than zero,
    // and the Tier-1 column must handle that (spec §11).
    const s = scheduleFor('high', 'betweenSubject', 10)
    expect(new Set(s).size).toBe(1)
  })
})

describe('conditionFor is pure and total', () => {
  it('agrees with scheduleFor at every index, under every schedule', () => {
    for (const schedule of SCHEDULES) {
      for (const startsWith of ['high', 'low'] as Condition[]) {
        const whole = scheduleFor(startsWith, schedule, 10)
        whole.forEach((c, i) => {
          expect(conditionFor(i, startsWith, schedule, 10)).toBe(c)
        })
      }
    }
  })

  it('⚠ depends on NOTHING but its four arguments', () => {
    // The invariant that makes resume safe (spec §13): a participant who returns
    // mid-session reconstructs their schedule from the stored `startsWith` alone.
    // Calibrated against a version keyed on a mutable participant document — that
    // version cannot satisfy this test, because there is no document here to read.
    for (let i = 0; i < 10; i++) {
      const a = conditionFor(i, 'low', 'alternating', 10)
      const b = conditionFor(i, 'low', 'alternating', 10)
      expect(a).toBe(b)
    }
  })

  it('handles contract counts other than ten', () => {
    for (const n of [1, 2, 3, 20]) {
      for (const schedule of SCHEDULES) {
        const s = scheduleFor('high', schedule, n)
        expect(s).toHaveLength(n)
        expect(s.every(c => c === 'high' || c === 'low')).toBe(true)
      }
    }
  })
})
