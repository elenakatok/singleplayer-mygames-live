import { describe, it, expect } from 'vitest'
import { kcQuestions, debriefQuestion, resolveKcQuestions, toClientKcQuestions } from '../src/pd/questions'
import { DEFAULT_PAYOFFS } from '../src/pd/payoff'

// Pure KC / debrief data-object tests (no emulator).

describe('the KC data objects (spec §7)', () => {
  it('is four questions, one per cell of the matrix', () => {
    expect(kcQuestions).toHaveLength(4)
    expect(kcQuestions.map(q => q.field)).toEqual(['kc_cc', 'kc_cd', 'kc_dc', 'kc_dd'])
    expect(kcQuestions.map(q => `${q.cell.you}${q.cell.other}`)).toEqual(['CC', 'CD', 'DC', 'DD'])
  })

  it('uses the shared kc_ field prefix, so the shared parser would accept them', () => {
    for (const q of kcQuestions) {
      expect(q.field.startsWith('kc_')).toBe(true)
      expect(q.category).toBe('knowledge_check')
      expect(q.grading).toBe('static')
      expect(q.type).toBe('mc')
    }
  })

  it('asks about the student’s OWN payoff every time', () => {
    for (const q of kcQuestions) expect(q.prompt).toContain('do YOU get')
  })
})

describe('resolveKcQuestions — options and answers come from the INSTANCE matrix', () => {
  it('reproduces the spec’s answer key on the shipped matrix (1 / 15 / 0 / 10)', () => {
    const resolved = resolveKcQuestions(DEFAULT_PAYOFFS)
    expect(resolved.map(q => q.correct_value)).toEqual(['1', '15', '0', '10'])
  })

  it('offers 0 / 1 / 10 / 15 on every question, in ascending order (spec §7)', () => {
    for (const q of resolveKcQuestions(DEFAULT_PAYOFFS)) {
      expect((q.options ?? []).map(o => o.value)).toEqual(['0', '1', '10', '15'])
    }
  })

  it('agrees with the frozen literals in the data objects on the default matrix', () => {
    // The literals are documentation of what the SHIPPED defaults derive. Pinning
    // prompt and explanation too — not just the key — is what stops them rotting into
    // a second source of truth once everything became derived in Slice 5.
    const resolved = resolveKcQuestions(DEFAULT_PAYOFFS)
    for (let i = 0; i < kcQuestions.length; i++) {
      expect(resolved[i].correct_value).toBe(kcQuestions[i].correct_value)
      expect(resolved[i].prompt).toBe(kcQuestions[i].prompt)
      expect(resolved[i].explanation).toBe(kcQuestions[i].explanation)
      expect((resolved[i].options ?? []).map(o => o.value).sort())
        .toEqual((kcQuestions[i].options ?? []).map(o => o.value).sort())
    }
  })

  it('follows the configured UNIT into prompts, options and explanations', () => {
    const resolved = resolveKcQuestions(DEFAULT_PAYOFFS, 'points')
    expect(resolved[0].prompt).toContain('How many points do YOU get?')
    expect((resolved[0].options ?? []).map(o => o.label)).toEqual(['0 points', '1 point', '10 points', '15 points'])
    expect(resolved[0].explanation).toContain('1 point')
    expect(JSON.stringify(resolved)).not.toContain('year')
  })

  it('follows the configured MOVE LABELS into prompts and explanations', () => {
    const resolved = resolveKcQuestions(DEFAULT_PAYOFFS, 'years', { C: 'Stay silent', D: 'Confess' })
    expect(resolved[0].prompt).toBe('You choose Stay silent and the other player also chooses Stay silent. How many years do YOU get?')
    expect(resolved[1].explanation).toBe('Choosing Stay silent while they choose Confess gets you 15 years; they get 0 years.')
    expect(JSON.stringify(resolved)).not.toContain('Cooperate')
  })

  it('states NO direction — the game does not claim which outcome is better', () => {
    const text = JSON.stringify(resolveKcQuestions(DEFAULT_PAYOFFS)).toLowerCase()
    for (const word of ['lower is better', 'higher is better', 'best', 'worst', 'sucker', 'losses', 'prison']) {
      expect(text).not.toContain(word)
    }
  })

  it('FOLLOWS a changed matrix — a student is never graded against a matrix they were not shown', () => {
    const custom = { both_cooperate: 2, sucker: 9, temptation: 1, both_defect: 6 }
    const resolved = resolveKcQuestions(custom)
    expect(resolved.map(q => q.correct_value)).toEqual(['2', '9', '1', '6'])
    for (const q of resolved) {
      expect((q.options ?? []).map(o => o.value)).toEqual(['1', '2', '6', '9'])
    }
  })

  it('collapses duplicate values into one option rather than offering the same answer twice', () => {
    const flat = { both_cooperate: 5, sucker: 5, temptation: 5, both_defect: 5 }
    const [q] = resolveKcQuestions(flat)
    expect((q.options ?? []).map(o => o.value)).toEqual(['5'])
  })

  it('labels 1 as a singular year', () => {
    const [q] = resolveKcQuestions(DEFAULT_PAYOFFS)
    const one = (q.options ?? []).find(o => o.value === '1')
    expect(one?.label).toBe('1 year')
    expect((q.options ?? []).find(o => o.value === '10')?.label).toBe('10 years')
  })
})

describe('toClientKcQuestions — the answer key never ships', () => {
  const client = toClientKcQuestions(resolveKcQuestions(DEFAULT_PAYOFFS))

  it('sends only field, prompt, and options', () => {
    for (const q of client) {
      expect(Object.keys(q).sort()).toEqual(['field', 'options', 'prompt'])
    }
  })

  it('carries no correct_value and no explanation', () => {
    const json = JSON.stringify(client)
    expect(json).not.toContain('correct_value')
    expect(json).not.toContain('explanation')
    // …and not the explanation TEXT under another name either.
    expect(json).not.toContain('sucker’s payoff')
  })
})

describe('the debrief question (spec §8)', () => {
  it('is one ungraded free-text question', () => {
    expect(debriefQuestion.type).toBe('text')
    expect(debriefQuestion.category).toBe('debrief')
    expect(debriefQuestion.field.startsWith('debrief_')).toBe(true)
  })

  it('carries NO grading and NO correct_value — ungraded by construction', () => {
    // This is what keeps it out of calcKCScore's denominator: that function counts
    // grading:'static' questions, and this one can never be mistaken for a KC item.
    expect(debriefQuestion.grading).toBeUndefined()
    expect(debriefQuestion.correct_value).toBeUndefined()
  })

  it('asks the spec’s question', () => {
    expect(debriefQuestion.prompt).toBe('In a short paragraph, explain what you did during the game and why.')
  })
})
