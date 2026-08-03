import { describe, it, expect } from 'vitest'
import {
  PUBLISHED_HISTORY, PUBLISHED_HISTORY_LENGTH, monthOf, yearOf,
  periodLabelLong, periodLabelShort, DEFAULT_HIGH_SEASON_MONTHS,
} from '../src/forecast/history'
import {
  DEFAULT_MODEL, DEFAULT_SEED, systematic, isHighSeason, drawDemand,
  resolveHistory, resolveDrawSeed, usesPublishedHistory, hash32, type ForecastModel,
} from '../src/forecast/demand'

// ═══════════════════════════════════════════════════════════════════════════════
// Forecasting — the demand process (spec §2), checked against INDEPENDENT
// recomputation rather than against itself.
//
// The load-bearing assertions here are the ones about the PUBLISHED HISTORY. Spec §2.1
// makes two checkable claims about those sixty numbers — that fitting a time trend plus
// one holiday dummy recovers 564.7 / 3.95 / 227.5, and that Nov and Dec beat every
// other month of their own year in all five years — and the whole design leans on both:
// the §2.3 benchmark table (which the debrief and Tier 3 DISPLAY) is computed against
// this history, and "the high season reads as a rule, not a run of luck" is why seed 1
// was chosen. An accidental digit change would break the game quietly. It breaks the
// suite instead.
//
// The OLS below is written out longhand (normal equations, 3×3, Gaussian elimination)
// precisely so it is not the game's own arithmetic checking the game's own arithmetic.
// ═══════════════════════════════════════════════════════════════════════════════

/** Least squares for y ~ [1, p, holiday] by explicit normal equations. Independent of
 *  anything in src/ — this is the "recompute it another way" half of the test. */
function fitTrendHoliday(y: readonly number[], highMonths: readonly number[]) {
  const n = y.length
  const rows: number[][] = []
  for (let i = 0; i < n; i++) {
    const p = i + 1
    rows.push([1, p, highMonths.includes(((p - 1) % 12) + 1) ? 1 : 0])
  }
  // X'X (3×3) and X'y (3×1)
  const XtX = [[0, 0, 0], [0, 0, 0], [0, 0, 0]]
  const Xty = [0, 0, 0]
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < 3; j++) {
      Xty[j] += rows[i][j] * y[i]
      for (let k = 0; k < 3; k++) XtX[j][k] += rows[i][j] * rows[i][k]
    }
  }
  // Gaussian elimination with partial pivoting on the augmented 3×4.
  const M = XtX.map((r, i) => [...r, Xty[i]])
  for (let c = 0; c < 3; c++) {
    let piv = c
    for (let r = c + 1; r < 3; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r
    const t = M[c]; M[c] = M[piv]; M[piv] = t
    for (let r = 0; r < 3; r++) {
      if (r === c) continue
      const f = M[r][c] / M[c][c]
      for (let k = c; k < 4; k++) M[r][k] -= f * M[c][k]
    }
  }
  return { intercept: M[0][3] / M[0][0], trend: M[1][3] / M[1][1], holiday: M[2][3] / M[2][2] }
}

describe('the published history (spec §2.1)', () => {
  it('is sixty months', () => {
    expect(PUBLISHED_HISTORY_LENGTH).toBe(60)
    expect(PUBLISHED_HISTORY).toHaveLength(60)
  })

  it('recovers the coefficients spec §2.1 states: 564.7 / 3.95 / +227.5', () => {
    const fit = fitTrendHoliday(PUBLISHED_HISTORY, DEFAULT_HIGH_SEASON_MONTHS)
    expect(fit.intercept).toBeCloseTo(564.7, 1)
    expect(fit.trend).toBeCloseTo(3.95, 2)
    expect(fit.holiday).toBeCloseTo(227.5, 1)
  })

  it('recovers coefficients close to the TRUE parameters (spec §2.1: "almost perfectly")', () => {
    const fit = fitTrendHoliday(PUBLISHED_HISTORY, DEFAULT_HIGH_SEASON_MONTHS)
    // True values 560 / 4.00 / 230 — a student doing exactly what slide 12 demonstrates
    // lands here, and the game's pedagogy depends on that being true.
    expect(Math.abs(fit.intercept - 560)).toBeLessThan(10)
    expect(Math.abs(fit.trend - 4)).toBeLessThan(0.2)
    expect(Math.abs(fit.holiday - 230)).toBeLessThan(10)
  })

  it('has Nov AND Dec above every other month of their own year, all five years', () => {
    // Spec §2.1: this is WHY seed 1 was chosen — the high season must read as a rule,
    // not as a run of luck.
    for (let y = 0; y < 5; y++) {
      const block = PUBLISHED_HISTORY.slice(y * 12, (y + 1) * 12)
      const bestOther = Math.max(...block.slice(0, 10))
      expect(block[10], `Y${y + 1} Nov`).toBeGreaterThan(bestOther)
      expect(block[11], `Y${y + 1} Dec`).toBeGreaterThan(bestOther)
    }
  })

  it('rises year on year (spec §2.1: "every year sits above the last")', () => {
    const yearMeans = [0, 1, 2, 3, 4].map(y => {
      const b = PUBLISHED_HISTORY.slice(y * 12, (y + 1) * 12)
      return b.reduce((s, v) => s + v, 0) / 12
    })
    for (let i = 1; i < yearMeans.length; i++) {
      expect(yearMeans[i]).toBeGreaterThan(yearMeans[i - 1])
    }
  })
})

describe('the calendar', () => {
  it('maps period to month and year', () => {
    expect(monthOf(1)).toBe(1)
    expect(yearOf(1)).toBe(1)
    expect(monthOf(12)).toBe(12)
    expect(yearOf(12)).toBe(1)
    expect(monthOf(13)).toBe(1)
    expect(yearOf(13)).toBe(2)
    // The first PLAYED month (spec §2: p = 61…84 is play, Y6M1…Y7M12).
    expect(yearOf(61)).toBe(6)
    expect(monthOf(61)).toBe(1)
    expect(yearOf(84)).toBe(7)
    expect(monthOf(84)).toBe(12)
  })

  it('labels the first played month the way the header does (spec §4)', () => {
    expect(periodLabelLong(61)).toBe('Year 6, January')
    expect(periodLabelShort(61)).toBe('Y6 Jan')
    expect(periodLabelShort(84)).toBe('Y7 Dec')
  })
})

describe('the systematic component (spec §2)', () => {
  it('is a + b·p off season and adds H in the high season', () => {
    const m = DEFAULT_MODEL
    // Y6 Jan (p=61), low season.
    expect(systematic(m, 61)).toBeCloseTo(560 + 4 * 61, 10)
    expect(isHighSeason(m, 61)).toBe(false)
    // Y6 Nov (p=71), high season.
    expect(systematic(m, 71)).toBeCloseTo(560 + 4 * 71 + 230, 10)
    expect(isHighSeason(m, 71)).toBe(true)
    // Y6 Dec (p=72).
    expect(isHighSeason(m, 72)).toBe(true)
    expect(systematic(m, 72)).toBeCloseTo(560 + 4 * 72 + 230, 10)
  })

  it('respects an edited high-season set', () => {
    const m: ForecastModel = { ...DEFAULT_MODEL, highSeasonMonths: [7] }
    expect(isHighSeason(m, 71)).toBe(false)                    // Nov no longer lifted
    expect(isHighSeason(m, 67)).toBe(true)                     // July now is
    expect(systematic(m, 67)).toBeCloseTo(560 + 4 * 67 + 230, 10)
  })

  it('perMonth with the shipped offsets is IDENTICAL to twoSeason', () => {
    // The property that makes the escape hatch safe to expose (demand.ts).
    const two = DEFAULT_MODEL
    const per: ForecastModel = { ...DEFAULT_MODEL, seasonStructure: 'perMonth' }
    for (let p = 1; p <= 84; p++) {
      expect(systematic(per, p)).toBeCloseTo(systematic(two, p), 10)
    }
  })

  it('multiplicative agrees with additive at p = 0 and diverges upward after', () => {
    const add = DEFAULT_MODEL
    const mul: ForecastModel = { ...DEFAULT_MODEL, seasonality: 'multiplicative' }
    // At p = 0 the factor (a+H)/a applied to a is exactly a + H.
    expect(systematic(mul, 0)).toBeCloseTo(systematic(add, 0), 10)
    // Later, the lift has grown with the trend, so the high season is higher.
    expect(systematic(mul, 71)).toBeGreaterThan(systematic(add, 71))
    // …and the low season is untouched either way.
    expect(systematic(mul, 61)).toBeCloseTo(systematic(add, 61), 10)
  })
})

describe('resolveHistory — common across students (spec §2.2)', () => {
  it('serves the published table at the shipped model', () => {
    expect(usesPublishedHistory(DEFAULT_MODEL, 60)).toBe(true)
    expect(resolveHistory(DEFAULT_MODEL, DEFAULT_SEED, 60)).toEqual([...PUBLISHED_HISTORY])
  })

  it('is byte-identical no matter how many times it is called, and takes no participant', () => {
    const a = resolveHistory(DEFAULT_MODEL, DEFAULT_SEED, 60)
    const b = resolveHistory(DEFAULT_MODEL, DEFAULT_SEED, 60)
    expect(a).toEqual(b)
    // resolveHistory's signature has no participant parameter at all — the identity
    // is structural. This asserts the signature has not grown one.
    expect(resolveHistory.length).toBe(3)
  })

  it('is still fixed with NO seed — "blank = random futures" is about the futures only', () => {
    const a = resolveHistory(DEFAULT_MODEL, null, 60)
    const b = resolveHistory(DEFAULT_MODEL, null, 60)
    expect(a).toEqual(b)
    expect(a).toEqual([...PUBLISHED_HISTORY])
  })

  it('regenerates when the model is edited away from the shipped one', () => {
    const edited: ForecastModel = { ...DEFAULT_MODEL, b: 9 }
    expect(usesPublishedHistory(edited, 60)).toBe(false)
    const h = resolveHistory(edited, DEFAULT_SEED, 60)
    expect(h).toHaveLength(60)
    expect(h).not.toEqual([...PUBLISHED_HISTORY])
    // Still deterministic and still student-independent.
    expect(resolveHistory(edited, DEFAULT_SEED, 60)).toEqual(h)
    // A steeper trend must actually show up as a steeper history.
    const slope = (h[59] - h[0]) / 59
    expect(slope).toBeGreaterThan(7)
  })

  it('regenerates when numHistory differs from the published length', () => {
    expect(usesPublishedHistory(DEFAULT_MODEL, 36)).toBe(false)
    expect(resolveHistory(DEFAULT_MODEL, DEFAULT_SEED, 36)).toHaveLength(36)
  })

  it('never produces a negative month', () => {
    // A config an instructor could genuinely set: low level, large noise.
    const m: ForecastModel = { ...DEFAULT_MODEL, a: 20, b: 0, H: 0, sigma: 400 }
    for (const v of resolveHistory(m, '7', 120)) expect(v).toBeGreaterThanOrEqual(0)
  })
})

describe('drawDemand — per student, per period (spec §2.2)', () => {
  const m = DEFAULT_MODEL

  it('is reproducible for one student with a seed set', () => {
    const a = drawDemand(m, '1', 'stu-a', 61)
    const b = drawDemand(m, '1', 'stu-a', 61)
    expect(a).toBe(b)
  })

  it('⚠ the DEFAULT is now `common` — every student faces the same future', () => {
    // Elena, 08-02: this REVERSES spec §2.2's default. The async leak it re-opens is
    // known and accepted. Asserted here so a silent revert would fail rather than
    // quietly change what every instance does.
    expect(DEFAULT_MODEL.demandDraw).toBe('common')
    const played = Array.from({ length: 24 }, (_, i) => 61 + i)
    const a = played.map(p => drawDemand(m, '1', 'stu-a', p))
    const b = played.map(p => drawDemand(m, '1', 'stu-b', p))
    const c = played.map(p => drawDemand(m, '1', 'someone-else-entirely', p))
    expect(a).toEqual(b)
    expect(a).toEqual(c)
  })

  it('⚠ …but demand still VARIES across periods — "same draw" means same per MONTH', () => {
    // Guarding a misreading that would gut the game: `common` makes every student see
    // the SAME demand as each other in a given month. It does NOT make demand
    // constant over time — the trend and the season are the whole exercise.
    const played = Array.from({ length: 24 }, (_, i) => 61 + i)
    const series = played.map(p => drawDemand(m, '1', 'stu-a', p))
    expect(new Set(series).size).toBeGreaterThan(15)
    // …and it still tracks the season: November/December sit far above the low months.
    const nov = drawDemand(m, '1', 'stu-a', 71)
    const jun = drawDemand(m, '1', 'stu-a', 66)
    expect(nov - jun).toBeGreaterThan(100)
  })

  it('perStudent STILL differs across students — the leak closure is intact', () => {
    // The non-default is what a graded take-home should use, so it has to keep working.
    const per: ForecastModel = { ...DEFAULT_MODEL, demandDraw: 'perStudent' }
    const played = Array.from({ length: 24 }, (_, i) => 61 + i)
    const a = played.map(p => drawDemand(per, '1', 'stu-a', p))
    const b = played.map(p => drawDemand(per, '1', 'stu-b', p))
    expect(a).not.toEqual(b)
    const same = a.filter((v, i) => v === b[i]).length
    expect(same).toBeLessThan(6)
  })

  it('differs across periods for one student', () => {
    const xs = Array.from({ length: 24 }, (_, i) => drawDemand(m, '1', 'stu-a', 61 + i))
    expect(new Set(xs).size).toBeGreaterThan(15)
  })

  it('the shipped σ is 60, and the floor it implies is 3,600', () => {
    // Elena, 08-02. The floor is what the debrief reveals as the limit of the
    // predictable, and the whole benchmark table is a function of it.
    expect(DEFAULT_MODEL.sigma).toBe(60)
    expect(DEFAULT_MODEL.sigma ** 2).toBe(3600)
  })

  it('lands on the right mean and sd, and lifts the high season', () => {
    // 4,000 draws of one high-season and one low-season month, across distinct
    // students, checked against the model's own systematic component.
    // ⚠ perStudent, because the whole point is to vary the draw ACROSS students. At the
    // shipped `common` default every one of these 4,000 would be the same number and the
    // sample sd would be exactly 0 — a test that measured nothing.
    const per: ForecastModel = { ...DEFAULT_MODEL, demandDraw: 'perStudent' }
    const draw = (p: number) =>
      Array.from({ length: 4000 }, (_, i) => drawDemand(per, 'S', `stu-${i}`, p))

    for (const p of [61, 71]) {
      const xs = draw(p)
      const mean = xs.reduce((s, v) => s + v, 0) / xs.length
      const sd = Math.sqrt(xs.reduce((s, v) => s + (v - mean) ** 2, 0) / (xs.length - 1))
      // Standard error of the mean is sigma/sqrt(4000) ≈ 0.47, so 3 units is ~6 SE.
      expect(Math.abs(mean - systematic(per, p))).toBeLessThan(5)
      expect(Math.abs(sd - per.sigma)).toBeLessThan(4)
    }

    const low = draw(61).reduce((s, v) => s + v, 0) / 4000
    const high = draw(71).reduce((s, v) => s + v, 0) / 4000
    // The lift is +230 plus ten months of trend (+40).
    expect(high - low).toBeGreaterThan(230)
  })

  it('successive periods are not correlated (the fmix32 avalanche is load-bearing)', () => {
    // Without the avalanche, consecutive period keys differ by one character and the
    // draws would be visibly correlated — which in a FORECASTING game would be a
    // learnable signal inside what the game promises is unpredictable.
    const per: ForecastModel = { ...DEFAULT_MODEL, demandDraw: 'perStudent' }
    const resid: number[] = []
    for (let i = 0; i < 4000; i++) {
      for (let p = 61; p <= 84; p++) {
        resid.push(drawDemand(per, 'C', `stu-${i}`, p) - systematic(per, p))
      }
    }
    // lag-1 autocorrelation of the residuals
    const mean = resid.reduce((s, v) => s + v, 0) / resid.length
    let num = 0, den = 0
    for (let i = 0; i < resid.length; i++) {
      den += (resid[i] - mean) ** 2
      if (i > 0) num += (resid[i] - mean) * (resid[i - 1] - mean)
    }
    expect(Math.abs(num / den)).toBeLessThan(0.05)
  })

  it('floors at zero for a config that could go negative', () => {
    const low: ForecastModel = { ...DEFAULT_MODEL, a: 10, b: 0, H: 0, sigma: 300 }
    for (let i = 0; i < 2000; i++) {
      expect(drawDemand(low, 'Z', `stu-${i}`, 61)).toBeGreaterThanOrEqual(0)
    }
  })

  it('returns whole units', () => {
    for (let i = 0; i < 200; i++) {
      expect(Number.isInteger(drawDemand(m, 'I', `stu-${i}`, 70))).toBe(true)
    }
  })
})

describe('hash32', () => {
  it('is stable and well spread over participant-shaped inputs', () => {
    expect(hash32('abc')).toBe(hash32('abc'))
    const seen = new Set(Array.from({ length: 5000 }, (_, i) => hash32(`participant-${i}`)))
    // Collisions in 5,000 draws from 2^32 should be a handful at most (birthday ≈ 0.003).
    expect(seen.size).toBeGreaterThan(4990)
  })
})

describe('⚠ resolveDrawSeed — the null-seed bug that shipped (production, 08-02)', () => {
  it('an explicit seed is always used, whatever the draw mode', () => {
    expect(resolveDrawSeed('abc', 'common', 'inst-1')).toBe('abc')
    expect(resolveDrawSeed('abc', 'perStudent', 'inst-1')).toBe('abc')
  })

  it('⚠ COMMON with a null seed falls back to the INSTANCE ID, never null', () => {
    // Returning null here is the bug: unit() then answers Math.random() and ignores its
    // key, so every student draws independently while the setting says otherwise.
    expect(resolveDrawSeed(null, 'common', 'inst-1')).toBe('inst-1')
    expect(resolveDrawSeed(null, 'common', 'inst-1')).not.toBeNull()
  })

  it('⚠ two seedless instances get DIFFERENT fallbacks', () => {
    // One shared fallback would hand this semester's class last semester's months.
    expect(resolveDrawSeed(null, 'common', 'inst-1'))
      .not.toBe(resolveDrawSeed(null, 'common', 'inst-2'))
  })

  it('perStudent with a null seed stays null — real randomness, as documented', () => {
    expect(resolveDrawSeed(null, 'perStudent', 'inst-1')).toBeNull()
  })

  it('the fallback actually makes drawDemand deterministic across students', () => {
    // The end-to-end property, at the unit level: the same instance, two students, the
    // same months.
    const m: ForecastModel = { ...DEFAULT_MODEL, demandDraw: 'common' }
    const s = resolveDrawSeed(null, m.demandDraw, 'inst-xyz')
    const played = Array.from({ length: 12 }, (_, i) => 61 + i)
    const a = played.map(p => drawDemand(m, s, 'stu-a', p))
    const b = played.map(p => drawDemand(m, s, 'stu-b', p))
    expect(a).toEqual(b)
    // …and the demonstration that a NULL seed would not have: Math.random() ignores
    // the key, so the same call twice disagrees.
    const r1 = drawDemand(m, null, 'stu-a', 61)
    const r2 = drawDemand(m, null, 'stu-a', 61)
    const r3 = drawDemand(m, null, 'stu-a', 61)
    expect(new Set([r1, r2, r3]).size).toBeGreaterThan(1)
  })
})
