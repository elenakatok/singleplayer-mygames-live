import { describe, it, expect } from 'vitest'
import {
  classSeries, classSummary, studentOutcome, mseHistogram, studentMonthRows,
  type ForecastGameRow,
} from '../src/forecast/reportStats'
import { runningMetrics, yearComparison, type ForecastPoint } from '../src/forecast/metrics'
import { DEFAULT_MODEL, systematic } from '../src/forecast/demand'
import { periodLabelShort } from '../src/forecast/history'
import { revealGate, buildReveal } from '../src/forecast/reveal'
import { DEFAULT_FORECAST_CONFIG } from '../src/forecast/config'
import { PUBLISHED_HISTORY } from '../src/forecast/history'
import { Timestamp } from 'firebase-admin/firestore'
import type { StoredRound } from '../src/forecast/rounds'

// ═══════════════════════════════════════════════════════════════════════════════
// Forecasting — the report aggregates (spec §10) and the reveal gate (spec §9).
//
// The gate tests are the security-relevant ones in this file: `revealGate` is the
// single definition of when the demand model may be handed to a student, and both the
// submit path and the read path call it. Every branch is covered here, and the harness
// drives the same conditions end-to-end through the real callables.
// ═══════════════════════════════════════════════════════════════════════════════

const pt = (period: number, forecast: number, actual: number): ForecastPoint =>
  ({ period, forecast, actual })

const row = (id: string, points: ForecastPoint[]): ForecastGameRow => ({ participant_id: id, points })

describe('classSeries — Tier 3, chart 1 (spec §10)', () => {
  const rows = [
    row('a', [pt(61, 800, 820), pt(62, 810, 800), pt(63, 820, 840)]),
    row('b', [pt(61, 900, 810), pt(62, 700, 790)]),
  ]

  it('averages actual and forecast over students who played that month', () => {
    const s = classSeries(rows, DEFAULT_MODEL, periodLabelShort)
    expect(s).toHaveLength(3)
    expect(s[0].actual).toBeCloseTo((820 + 810) / 2, 10)
    expect(s[0].forecast).toBeCloseTo((800 + 900) / 2, 10)
    expect(s[2].actual).toBe(840)                     // only student a reached month 3
  })

  it('carries a per-month denominator that thins as the class spreads', () => {
    const s = classSeries(rows, DEFAULT_MODEL, periodLabelShort)
    expect(s.map(p => p.n)).toEqual([2, 2, 1])
  })

  it('carries the TRUE systematic component, auto-derived from the model (spec §10)', () => {
    const s = classSeries(rows, DEFAULT_MODEL, periodLabelShort)
    s.forEach(p => expect(p.systematic).toBeCloseTo(systematic(DEFAULT_MODEL, p.period), 10))
  })

  it('labels each month, and skips months nobody reached', () => {
    const s = classSeries(rows, DEFAULT_MODEL, periodLabelShort)
    expect(s[0].label).toBe('Y6 Jan')
    // Nobody played month 64 — it is absent, not plotted as zero (which would draw a
    // cliff at the end of every mid-week chart).
    expect(s.some(p => p.period === 64)).toBe(false)
  })

  it('is empty when nobody has played', () => {
    expect(classSeries([], DEFAULT_MODEL, periodLabelShort)).toEqual([])
    expect(classSeries([row('a', [])], DEFAULT_MODEL, periodLabelShort)).toEqual([])
  })
})

describe('classSummary — the Tier-3 summary box (spec §10)', () => {
  const rows = [
    row('a', [pt(61, 800, 900), pt(62, 800, 900)]),   // every error 100 ⇒ MSE 10,000
    row('b', [pt(61, 800, 820), pt(62, 800, 820)]),   // every error  20 ⇒ MSE    400
  ]

  it('counts only students who played', () => {
    expect(classSummary([...rows, row('c', [])], runningMetrics).students).toBe(2)
  })

  it('⚠ the class Standard Error is √(MEAN MSE), not the mean of the students’ √MSE', () => {
    // The two differ (Jensen), and only the first is comparable with the §2.3 benchmark
    // column, which is √(expected MSE). Averaging the students' own Standard Errors
    // would sit systematically BELOW the benchmark table beside it and flatter the class.
    const s = classSummary(rows, runningMetrics)
    expect(s.meanMse).toBeCloseTo((10000 + 400) / 2, 6)
    expect(s.standardError!).toBeCloseTo(Math.sqrt(5200), 6)
    const meanOfRoots = (Math.sqrt(10000) + Math.sqrt(400)) / 2   // = 60
    expect(s.standardError!).not.toBeCloseTo(meanOfRoots, 1)
    expect(s.standardError!).toBeGreaterThan(meanOfRoots)
  })

  it('reports mean MAE, bias and MAPE', () => {
    const s = classSummary(rows, runningMetrics)
    expect(s.meanMae).toBeCloseTo((100 + 20) / 2, 10)
    expect(s.meanBias).toBeCloseTo((100 + 20) / 2, 10)
    expect(s.meanMape).not.toBeNull()
  })

  it('is all-null when nobody has played', () => {
    const s = classSummary([], runningMetrics)
    expect(s).toEqual({
      students: 0, meanMae: null, meanMse: null, standardError: null,
      meanBias: null, meanMape: null,
    })
  })
})

describe('studentOutcome — the Tier-1 columns (spec §10)', () => {
  it('is all-null for a student who played nothing — a dash, not a zero', () => {
    const o = studentOutcome([], runningMetrics, yearComparison)
    expect(o.monthsPlayed).toBe(0)
    expect(o.mse).toBeNull()
    expect(o.improved).toBeNull()
  })

  it('matches an independent recomputation', () => {
    const points = [pt(61, 900, 950), pt(62, 900, 870)]
    const o = studentOutcome(points, runningMetrics, yearComparison)
    expect(o.mse).toBe(1700)
    expect(o.mae).toBe(40)
    expect(o.monthsPlayed).toBe(2)
  })

  it('leaves the second year null until it is reached', () => {
    const twelve = Array.from({ length: 12 }, (_, i) => pt(61 + i, 800, 820))
    const o = studentOutcome(twelve, runningMetrics, yearComparison)
    expect(o.firstYearMse).not.toBeNull()
    expect(o.secondYearMse).toBeNull()
    expect(o.improved).toBeNull()
  })
})

describe('mseHistogram — Tier 3, chart 2 (spec §10)', () => {
  it('bins every student exactly once', () => {
    const mses = [900, 1200, 4000, 9000, 38000]
    const h = mseHistogram(mses)!
    expect(h.bins.reduce((s, b) => s + b.count, 0)).toBe(mses.length)
    expect(h.min).toBe(900)
    expect(h.max).toBe(38000)
  })

  it('⚠ bins on a LOG scale, so the benchmark range separates rather than smearing', () => {
    // The lesson lives between 900 and 40,000 — a 40× range. On linear bins the first
    // bucket would swallow everything competent.
    const h = mseHistogram([900, 40000], 4)!
    // Log-spaced: each bin's ratio hi/lo is the same, so widths GROW to the right.
    const ratios = h.bins.map(b => b.hi / b.lo)
    ratios.forEach(r => expect(r).toBeCloseTo(ratios[0], 6))
    expect(h.bins[3].hi - h.bins[3].lo).toBeGreaterThan(h.bins[0].hi - h.bins[0].lo)
  })

  it('puts the maximum in the LAST bin, not past the end', () => {
    const h = mseHistogram([900, 5000, 40000], 6)!
    expect(h.bins[h.bins.length - 1].count).toBeGreaterThanOrEqual(1)
    expect(h.bins.reduce((s, b) => s + b.count, 0)).toBe(3)
  })

  it('survives a degenerate spread (one student, or all identical)', () => {
    const one = mseHistogram([1234])!
    expect(one.bins.reduce((s, b) => s + b.count, 0)).toBe(1)
    const same = mseHistogram([900, 900, 900])!
    expect(same.bins.reduce((s, b) => s + b.count, 0)).toBe(3)
  })

  it('is null when nobody has an MSE, and ignores non-positive values', () => {
    expect(mseHistogram([])).toBeNull()
    expect(mseHistogram([0, -5])).toBeNull()
  })
})

describe('studentMonthRows — the drill-down (spec §10)', () => {
  it('carries the per-month figures', () => {
    const rows = studentMonthRows([pt(61, 900, 950)])
    expect(rows[0]).toEqual({
      period: 61, forecast: 900, actual: 950,
      error: 50, absoluteError: 50, squaredError: 2500,
      absolutePercentageError: 50 / 950,
    })
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// ⚠⚠ THE REVEAL GATE (spec §9) — the single definition of when the demand model may
// be handed to a student. Both forecastSubmitDebrief and forecastGetReveal call it.
// ═══════════════════════════════════════════════════════════════════════════════

const CONFIG = { ...DEFAULT_FORECAST_CONFIG }
const NO_DEBRIEF = { ...DEFAULT_FORECAST_CONFIG, debriefEnabled: false }
const FINISHED = { finished_at: Timestamp.fromMillis(1) } as Record<string, unknown>
const WITH_DEBRIEF = {
  ...FINISHED,
  free_text_answers: { debrief_method: { answer: 'I fitted a trend.' } },
}

describe('revealGate', () => {
  it('REFUSES a student who has not finished', () => {
    const g = revealGate({}, CONFIG)
    expect(g.allowed).toBe(false)
    if (!g.allowed) expect(g.reason).toMatch(/every month/i)
  })

  it('REFUSES a student mid-play, even with months stored', () => {
    expect(revealGate({ rounds: [1, 2, 3] }, CONFIG).allowed).toBe(false)
  })

  it('⚠ REFUSES a FINISHED student who has not written the debrief', () => {
    // The case that keeps the paragraph a description of what they actually did.
    const g = revealGate(FINISHED, CONFIG)
    expect(g.allowed).toBe(false)
    if (!g.allowed) expect(g.reason).toMatch(/last question/i)
  })

  it('ALLOWS a finished student who has written the debrief', () => {
    expect(revealGate(WITH_DEBRIEF, CONFIG).allowed).toBe(true)
  })

  it('ALLOWS a finished student when the debrief is switched OFF for the instance', () => {
    // There is no paragraph to be waiting for.
    expect(revealGate(FINISHED, NO_DEBRIEF).allowed).toBe(true)
  })

  it('still REFUSES an unfinished student when the debrief is off', () => {
    expect(revealGate({}, NO_DEBRIEF).allowed).toBe(false)
  })

  it('is not fooled by an empty free_text_answers map', () => {
    expect(revealGate({ ...FINISHED, free_text_answers: {} }, CONFIG).allowed).toBe(false)
  })
})

describe('buildReveal (spec §9)', () => {
  const rounds: StoredRound[] = Array.from({ length: 24 }, (_, i) => ({
    round: i + 1, period: 61 + i, forecast: 850, actual: 860,
    played_at: Timestamp.fromMillis(0),
  }))

  it('reveals the true process and the floor', () => {
    const r = buildReveal(DEFAULT_MODEL, CONFIG, PUBLISHED_HISTORY, rounds)
    expect(r.process.intercept).toBe(560)
    expect(r.process.trend).toBe(4)
    expect(r.process.highSeasonLift).toBe(230)
    expect(r.process.floorMse).toBe(3600)
  })

  it('serves the PUBLISHED §2.3 table on a default instance', () => {
    const r = buildReveal(DEFAULT_MODEL, CONFIG, PUBLISHED_HISTORY, rounds)
    expect(r.benchmarksAreRealized).toBe(false)
    expect(r.benchmarks).toHaveLength(8)
    expect(r.benchmarks.find(b => b.id === 'reg_holiday')!.mse).toBe(3601)
    expect(r.lectureModelId).toBe('reg_holiday')
  })

  it('⚠ serves REALIZED benchmarks when the model has been edited', () => {
    // The published table would describe a game nobody played.
    const edited = { ...DEFAULT_MODEL, b: 9 }
    const r = buildReveal(edited, CONFIG, PUBLISHED_HISTORY, rounds)
    expect(r.benchmarksAreRealized).toBe(true)
    expect(r.benchmarks.length).toBeGreaterThan(0)
    expect(r.benchmarks.every(b => !('note' in b) || b.note === undefined)).toBe(true)
  })

  it('carries the student’s own scorecard and year split', () => {
    const r = buildReveal(DEFAULT_MODEL, CONFIG, PUBLISHED_HISTORY, rounds)
    expect(r.yours.n).toBe(24)
    expect(r.years.first?.year).toBe(6)
    expect(r.years.second?.year).toBe(7)
  })
})
