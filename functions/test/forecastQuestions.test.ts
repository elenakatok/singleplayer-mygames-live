import { describe, it, expect } from 'vitest'
import {
  resolveForecastKcQuestions, toClientKcQuestions, AUTHORED_KC_COUNT, debriefQuestion,
} from '../src/forecast/questions'
import { DEFAULT_MODEL } from '../src/forecast/demand'
import { PUBLISHED_HISTORY } from '../src/forecast/history'

// ═══════════════════════════════════════════════════════════════════════════════
// Forecasting — the knowledge check (spec §8) and the single debrief question (§9).
//
// ⚠ THE LOAD-BEARING TEST IN THIS FILE IS THE LEAK ONE. The KC runs BEFORE play
// (spec §4), so a stem that stated this instance's intercept, trend, lift or σ would
// hand a student part of the answer on the screen before the one where they are asked
// to infer it. Spec §4's whitelist rule is flat about it: "no a/b/S/σ, ever."
// ═══════════════════════════════════════════════════════════════════════════════

describe('the authored set (spec §8)', () => {
  const qs = resolveForecastKcQuestions('stu-1')

  it('is NINE questions, all four-option multiple choice', () => {
    expect(AUTHORED_KC_COUNT).toBe(9)
    expect(qs).toHaveLength(9)
    qs.forEach(q => expect(q.options).toHaveLength(4))
  })

  it('every question has a correct answer that is one of its own options', () => {
    qs.forEach(q => {
      expect(q.options.some(o => o.value === q.correct_value), `${q.field}`).toBe(true)
    })
  })

  it('every question has an explanation', () => {
    qs.forEach(q => expect(q.explanation.length, q.field).toBeGreaterThan(30))
  })

  it('field ids are unique and all take the kc_ namespace', () => {
    const fields = qs.map(q => q.field)
    expect(new Set(fields).size).toBe(fields.length)
    fields.forEach(f => expect(f.startsWith('kc_')).toBe(true))
  })

  it('covers the nine topics spec §8 lists', () => {
    const fields = qs.map(q => q.field)
    for (const f of [
      'kc_systematic', 'kc_goal', 'kc_mse_penalty', 'kc_coefficient', 'kc_pvalue',
      'kc_trend_bias', 'kc_moving_average', 'kc_chasing_noise', 'kc_parsimony',
    ]) expect(fields).toContain(f)
  })

  it('Q4/Q5 use the fresh regression case, not the lecture’s Duvel numbers (spec §8)', () => {
    const coef = qs.find(q => q.field === 'kc_coefficient')!
    expect(coef.prompt).toContain('405.5')
    expect(coef.prompt).toContain('3.77')
    expect(coef.prompt).toContain('198.7')
    const pval = qs.find(q => q.field === 'kc_pvalue')!
    expect(pval.prompt).toContain('0.0000013')
    // The deliberate flip: here the trend IS significant, unlike the lecture example.
    expect(pval.correct_value).toBe('detectable_trend')
  })

  it('Q3’s arithmetic is the one spec §8 states (400 vs 1,600)', () => {
    const q = qs.find(q => q.field === 'kc_mse_penalty')!
    expect(q.correct_value).toBe('a')
    // Independently: A is off by 20 every month ⇒ 400. B is 0,0,0,80 ⇒ 6400/4 = 1600.
    expect(20 ** 2).toBe(400)
    expect((0 + 0 + 0 + 80 ** 2) / 4).toBe(1600)
  })
})

describe('⚠ the KC leaks no model parameter (spec §4, §8)', () => {
  const qs = resolveForecastKcQuestions('stu-leak')
  const allText = qs.map(q => `${q.prompt} ${q.options.map(o => o.label).join(' ')}`).join(' ')

  it('no stem or option states the intercept, the lift or σ', () => {
    for (const v of [DEFAULT_MODEL.a, DEFAULT_MODEL.H, DEFAULT_MODEL.sigma]) {
      expect(allText, `must not contain ${v}`).not.toContain(String(v))
    }
  })

  it('⚠ no stem states the instance’s own TREND as a per-month figure', () => {
    // Spec §8 writes Q6 as "risen about 4 units a month" — the shipped model's own b.
    // That is a deliberate deviation (questions.ts): the KC runs BEFORE play, and the
    // concept transfers at any trend, so a different figure is used.
    expect(allText).not.toMatch(new RegExp(`${DEFAULT_MODEL.b} units a month`))
    // …but the question is still there and still tests the same thing.
    const q = qs.find(q => q.field === 'kc_trend_bias')!
    expect(q.prompt).toMatch(/units a month/)
    expect(q.correct_value).toBe('too_low')
  })

  it('no stem quotes a value from the published history', () => {
    // A stem echoing a history month would tie the teaching case to the game's data.
    const distinctive = PUBLISHED_HISTORY.filter(v => v > 700)
    for (const v of distinctive) expect(allText).not.toContain(String(v))
  })
})

describe('per-student option order (spec §8)', () => {
  it('differs between students', () => {
    const a = resolveForecastKcQuestions('stu-a').map(q => q.options.map(o => o.value).join('|'))
    const b = resolveForecastKcQuestions('stu-b').map(q => q.options.map(o => o.value).join('|'))
    expect(a.join()).not.toBe(b.join())
  })

  it('is STABLE for one student across calls', () => {
    const a1 = resolveForecastKcQuestions('stu-a').map(q => q.options.map(o => o.value).join('|'))
    const a2 = resolveForecastKcQuestions('stu-a').map(q => q.options.map(o => o.value).join('|'))
    expect(a1).toEqual(a2)
  })

  it('is a permutation — no option is lost or duplicated', () => {
    const base = resolveForecastKcQuestions('__base__')
    const other = resolveForecastKcQuestions('stu-xyz')
    base.forEach((q, i) => {
      expect([...q.options.map(o => o.value)].sort())
        .toEqual([...other[i].options.map(o => o.value)].sort())
    })
  })

  it('does not always put the correct answer first', () => {
    // Spec §8 writes every correct answer first for readability; a delivered KC that
    // preserved that would be answerable without reading.
    let firstIsCorrect = 0
    for (let i = 0; i < 40; i++) {
      const qs = resolveForecastKcQuestions(`stu-${i}`)
      firstIsCorrect += qs.filter(q => q.options[0].value === q.correct_value).length
    }
    const total = 40 * AUTHORED_KC_COUNT
    // With four options, chance is 25%. Anything near 100% means the shuffle is broken.
    expect(firstIsCorrect / total).toBeLessThan(0.45)
    expect(firstIsCorrect / total).toBeGreaterThan(0.08)
  })
})

describe('toClientKcQuestions — the answer key never ships', () => {
  it('drops correct_value and explanation', () => {
    const client = toClientKcQuestions(resolveForecastKcQuestions('stu-1'))
    const text = JSON.stringify(client)
    expect(text).not.toContain('correct_value')
    expect(text).not.toContain('explanation')
    client.forEach(q => {
      expect(Object.keys(q).sort()).toEqual(['field', 'options', 'prompt'])
    })
  })

  it('keeps the per-student option order it was given', () => {
    const resolved = resolveForecastKcQuestions('stu-order')
    const client = toClientKcQuestions(resolved)
    resolved.forEach((q, i) => {
      expect(client[i].options.map(o => o.value)).toEqual(q.options.map(o => o.value))
    })
  })
})

describe('the debrief question (spec §9)', () => {
  it('is ONE question, ungraded by construction', () => {
    expect(debriefQuestion.field).toBe('debrief_method')
    // No grading, no correct_value — so it cannot enter calcKCScore's denominator.
    expect('grading' in debriefQuestion).toBe(false)
    expect('correct_value' in debriefQuestion).toBe(false)
    expect(debriefQuestion.category).toBe('debrief')
  })

  it('does not collide with the KC namespace', () => {
    expect(debriefQuestion.field.startsWith('kc_')).toBe(false)
  })
})
