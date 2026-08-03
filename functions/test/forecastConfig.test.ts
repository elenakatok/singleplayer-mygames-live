import { describe, it, expect } from 'vitest'
import {
  loadForecastConfig, loadForecastModel, loadForecastSeed,
  DEFAULT_FORECAST_CONFIG, DEFAULT_DEBRIEF_PROMPT,
  HARD_MIN_ROUNDS, HARD_MAX_ROUNDS, HARD_MIN_HISTORY, HARD_MAX_HISTORY,
  parseAddedKcQuestion,
} from '../src/forecast/config'
import { DEFAULT_MODEL, type ForecastModel } from '../src/forecast/demand'
import { warningsFor } from '../src/forecast/instructorConfig'

// ═══════════════════════════════════════════════════════════════════════════════
// Forecasting — the config/truth split (spec §4, §12), and the two loaders' shared
// posture: a malformed field FALLS BACK, it never throws, so a half-written doc can
// never make the game unplayable.
//
// The most important test in this file is the last one: it asserts that the
// STUDENT-SAFE config type carries no model parameter under any name. That is the
// leak surface spec §12 is written about, and it is cheap to police here.
// ═══════════════════════════════════════════════════════════════════════════════

describe('loadForecastConfig — the student-readable half', () => {
  it('reads the shipped defaults from an empty/absent doc', () => {
    expect(loadForecastConfig(undefined)).toEqual(DEFAULT_FORECAST_CONFIG)
    expect(loadForecastConfig({})).toEqual(DEFAULT_FORECAST_CONFIG)
  })

  it('reads stored values over defaults', () => {
    const c = loadForecastConfig({
      num_history: 36,
      rounds: 12,
      product_name: 'Widget 9',
      unit_label: 'cases',
      period_label: 'week',
      debrief_prompt: 'Say something.',
    })
    expect(c.numHistory).toBe(36)
    expect(c.rounds).toBe(12)
    expect(c.productName).toBe('Widget 9')
    expect(c.unitLabel).toBe('cases')
    expect(c.periodLabel).toBe('week')
    expect(c.debriefPrompt).toBe('Say something.')
  })

  it('clamps rounds and history to the hard bounds', () => {
    expect(loadForecastConfig({ rounds: 0 }).rounds).toBe(HARD_MIN_ROUNDS)
    expect(loadForecastConfig({ rounds: 9999 }).rounds).toBe(HARD_MAX_ROUNDS)
    expect(loadForecastConfig({ num_history: 1 }).numHistory).toBe(HARD_MIN_HISTORY)
    expect(loadForecastConfig({ num_history: 9999 }).numHistory).toBe(HARD_MAX_HISTORY)
  })

  it('falls back rather than throwing on garbage', () => {
    const c = loadForecastConfig({
      rounds: 'twelve', num_history: null, product_name: 42,
      forecast_min: 'x', forecast_max: {}, added_kc_questions: 'nope',
    } as unknown as Record<string, unknown>)
    expect(c.rounds).toBe(DEFAULT_FORECAST_CONFIG.rounds)
    expect(c.numHistory).toBe(DEFAULT_FORECAST_CONFIG.numHistory)
    expect(c.productName).toBe(DEFAULT_FORECAST_CONFIG.productName)
    expect(c.forecastMin).toBe(DEFAULT_FORECAST_CONFIG.forecastMin)
    expect(c.forecastMax).toBe(DEFAULT_FORECAST_CONFIG.forecastMax)
    expect(c.addedKcQuestions).toEqual([])
  })

  it('reads the forecast bounds as a PAIR — an inverted pair falls back to both defaults', () => {
    const ok = loadForecastConfig({ forecast_min: 100, forecast_max: 2000 })
    expect(ok.forecastMin).toBe(100)
    expect(ok.forecastMax).toBe(2000)

    const inverted = loadForecastConfig({ forecast_min: 2000, forecast_max: 100 })
    expect(inverted.forecastMin).toBe(DEFAULT_FORECAST_CONFIG.forecastMin)
    expect(inverted.forecastMax).toBe(DEFAULT_FORECAST_CONFIG.forecastMax)

    // Half a pair is not a pair.
    const half = loadForecastConfig({ forecast_min: 100 })
    expect(half.forecastMin).toBe(DEFAULT_FORECAST_CONFIG.forecastMin)
  })

  it('treats an absent flow switch as ON (an old instance keeps the flow it had)', () => {
    expect(loadForecastConfig({}).kcEnabled).toBe(true)
    expect(loadForecastConfig({}).debriefEnabled).toBe(true)
    expect(loadForecastConfig({ kc_enabled: false }).kcEnabled).toBe(false)
    expect(loadForecastConfig({ debrief_enabled: false }).debriefEnabled).toBe(false)
  })

  it('blank prompt text falls back to the shipped prompt', () => {
    expect(loadForecastConfig({ debrief_prompt: '   ' }).debriefPrompt).toBe(DEFAULT_DEBRIEF_PROMPT)
  })
})

describe('parseAddedKcQuestion', () => {
  it('rejects an added question that tries to take a kc_ id', () => {
    expect(parseAddedKcQuestion({ id: 'kc_sneaky', type: 'text', prompt: 'hi' })).toBeNull()
  })

  it('rejects an mc question with fewer than two options', () => {
    expect(parseAddedKcQuestion({
      id: 'q1', type: 'mc', prompt: 'p', options: [{ value: 'a', label: 'A' }],
    })).toBeNull()
  })

  it('OMITS optional fields rather than setting undefined (Firestore rejects undefined)', () => {
    const q = parseAddedKcQuestion({ id: 'q1', type: 'text', prompt: 'p' })!
    expect('explanation' in q).toBe(false)
    expect('correct_value' in q).toBe(false)
  })

  it('drops a correct_value that is not one of the options', () => {
    const q = parseAddedKcQuestion({
      id: 'q1', type: 'mc', prompt: 'p',
      options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }],
      correct_value: 'zzz',
    })!
    expect('correct_value' in q).toBe(false)
  })
})

describe('loadForecastModel — the rules-denied half', () => {
  it('reads the shipped model from an empty/absent doc', () => {
    expect(loadForecastModel(undefined)).toEqual(DEFAULT_MODEL)
    expect(loadForecastModel({})).toEqual(DEFAULT_MODEL)
  })

  it('reads stored model values', () => {
    const m = loadForecastModel({
      intercept: 700, trend: 6, high_season_lift: 100,
      high_season_months: [6, 7], sigma: 45,
      seasonality: 'multiplicative', season_structure: 'perMonth',
      demand_draw: 'common',
    })
    expect(m.a).toBe(700)
    expect(m.b).toBe(6)
    expect(m.H).toBe(100)
    expect(m.highSeasonMonths).toEqual([6, 7])
    expect(m.sigma).toBe(45)
    expect(m.seasonality).toBe('multiplicative')
    expect(m.seasonStructure).toBe('perMonth')
    expect(m.demandDraw).toBe('common')
  })

  it('takes |sigma| — a negative sd would mirror the draw rather than error', () => {
    expect(loadForecastModel({ sigma: -30 }).sigma).toBe(30)
  })

  it('rejects a partly-bad high-season set as a WHOLE, back to the shipped season', () => {
    expect(loadForecastModel({ high_season_months: [11, 99] }).highSeasonMonths).toEqual([11, 12])
    expect(loadForecastModel({ high_season_months: [11, 'x'] }).highSeasonMonths).toEqual([11, 12])
    expect(loadForecastModel({ high_season_months: 'nov' }).highSeasonMonths).toEqual([11, 12])
  })

  it('derives absent monthOffsets from THIS instance’s own lift and season', () => {
    const m = loadForecastModel({ high_season_lift: 400, high_season_months: [3] })
    expect(m.monthOffsets[2]).toBe(400)          // March
    expect(m.monthOffsets[10]).toBe(0)           // November, no longer high
    expect(m.monthOffsets).toHaveLength(12)
  })

  it('only accepts a monthOffsets array of exactly twelve finite numbers', () => {
    const good = Array.from({ length: 12 }, (_, i) => i * 10)
    expect(loadForecastModel({ month_offsets: good }).monthOffsets).toEqual(good)
    // Eleven entries would silently shift every month by one.
    expect(loadForecastModel({ month_offsets: good.slice(1) }).monthOffsets).not.toEqual(good.slice(1))
    expect(loadForecastModel({ month_offsets: [...good.slice(1), 'x'] }).monthOffsets).toHaveLength(12)
  })

  it('unknown enum values fall back to the taught defaults', () => {
    expect(loadForecastModel({ seasonality: 'wibble' }).seasonality).toBe('additive')
    expect(loadForecastModel({ season_structure: 'wibble' }).seasonStructure).toBe('twoSeason')
    // ⚠ 'common' is the shipped default since 08-02, so an unrecognised value falls
    // back to THAT, not to perStudent. The loader and DEFAULT_MODEL must agree — an
    // instance whose truth doc predates the field would otherwise run the other mode.
    expect(loadForecastModel({ demand_draw: 'wibble' }).demandDraw).toBe('common')
    expect(loadForecastModel({}).demandDraw).toBe('common')
    expect(loadForecastModel({ demand_draw: 'perStudent' }).demandDraw).toBe('perStudent')
  })
})

describe('loadForecastSeed', () => {
  it('normalizes a number seed to its string form', () => {
    expect(loadForecastSeed({ seed: 7 })).toBe('7')
    expect(loadForecastSeed({ seed: '7' })).toBe('7')
  })

  it('blank/absent means real randomness', () => {
    expect(loadForecastSeed({})).toBeNull()
    expect(loadForecastSeed({ seed: '' })).toBeNull()
    expect(loadForecastSeed({ seed: '   ' })).toBeNull()
    expect(loadForecastSeed(undefined)).toBeNull()
  })
})

describe('⚠ the split itself (spec §4, §12)', () => {
  it('the STUDENT-SAFE config carries no model parameter, under any name', () => {
    // A model parameter that drifted into config/main would be readable by any student
    // with the plain Firestore SDK, and knowing it is knowing the answer. This asserts
    // on the KEYS of the loaded config, so a future field called `a` or `sigma` or
    // `highSeasonMonths` fails here rather than in a classroom.
    const keys = Object.keys(loadForecastConfig({}))
    for (const banned of [
      'a', 'b', 'H', 'sigma', 'highSeasonMonths', 'seasonality',
      'seasonStructure', 'monthOffsets', 'demandDraw', 'seed',
      'intercept', 'trend', 'high_season_lift', 'high_season_months',
    ]) {
      expect(keys, `config must not carry '${banned}'`).not.toContain(banned)
    }
  })

  it('a model parameter stored in config/main by mistake is NOT read out of it', () => {
    // Belt and braces: even if something wrote the model into the wrong doc, the
    // student-safe loader ignores it entirely.
    const c = loadForecastConfig({
      intercept: 560, trend: 4, high_season_lift: 230, sigma: 30, seed: '1',
    }) as unknown as Record<string, unknown>
    expect(c.a).toBeUndefined()
    expect(c.sigma).toBeUndefined()
    expect(c.seed).toBeUndefined()
  })
})

describe('⚠ Settings warnings — the redraw and the stale CSV (Elena, 08-02)', () => {
  const CONFIG = loadForecastConfig(undefined)
  const M = (o: Partial<ForecastModel>): ForecastModel => ({ ...DEFAULT_MODEL, ...o })
  const joined = (model: ForecastModel, config = CONFIG) =>
    warningsFor(config, model, '7', false).join(' ⏐ ')

  it('says nothing about a redraw at the shipped model', () => {
    expect(joined(DEFAULT_MODEL)).not.toMatch(/REDRAWN/)
  })

  it('⚠ warns that the history is REDRAWN whenever a generator input moves', () => {
    // One per input — the sentence must not be reachable only through σ.
    for (const edit of [{ a: 500 }, { b: 6 }, { H: 300 }, { sigma: 90 },
      { highSeasonMonths: [6, 7] }] as Partial<ForecastModel>[]) {
      expect(joined(M(edit))).toMatch(/THE FIVE-YEAR HISTORY HAS BEEN REDRAWN/)
    }
  })

  it('⚠ names the stale CSV, and names it BEFORE the benchmark note', () => {
    // Elena's ordering, and it is the right one: the CSV is where the regression is
    // actually run, so a student holding a pre-edit copy is fitting replaced data.
    const list = warningsFor(CONFIG, M({ sigma: 90 }), '7', false)
    const staleAt = list.findIndex(w => /stale/.test(w))
    const benchAt = list.findIndex(w => /benchmark table/.test(w))
    expect(staleAt).toBeGreaterThanOrEqual(0)
    expect(list[staleAt]).toMatch(/download the history CSV afresh/)
    expect(staleAt).toBeLessThan(benchAt)
  })

  it('the σ edit no longer claims the history is unaffected', () => {
    // ⚠ THIS SENTENCE WAS DEAD CODE AND WRONG. It sat behind
    // `usesPublishedHistory(...) && sigma !== DEFAULT`, which cannot both hold now that
    // σ is part of the predicate — and it told the instructor the history survives a σ
    // edit, which is exactly the belief this change exists to correct.
    expect(joined(M({ sigma: 90 }))).not.toMatch(/history is unaffected/)
  })

  it('⚠ warns when the model has no season worth showing, without refusing it', () => {
    // σ = 400 against H = 230: the search cannot find a visible season because there
    // isn't one. Inform, don't block.
    const w = joined(M({ sigma: 400 }))
    expect(w).toMatch(/hard to SEE in the redrawn history/)
  })

  it('stays quiet about visibility when the redraw does show the season', () => {
    expect(joined(M({ sigma: 90 }))).not.toMatch(/hard to SEE/)
  })
})
