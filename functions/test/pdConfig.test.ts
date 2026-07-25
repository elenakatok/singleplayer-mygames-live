import { describe, it, expect } from 'vitest'
import {
  loadPdConfig, parseAddedKcQuestion, parseRoundRange,
  DEFAULT_MIN_ROUNDS, DEFAULT_MAX_ROUNDS, DEFAULT_UNIT, DEFAULT_DEBRIEF_PROMPT,
  HARD_MIN_ROUNDS, HARD_MAX_ROUNDS,
} from '../src/pd/config'
import { unitLabel } from '../src/pd/questions'

// Pure config-parsing tests (no emulator). Slice 5 made the matrix, labels, unit,
// round range, KC and debrief instructor-configurable; these pin the parse.

describe('loadPdConfig — defaults when nothing is stored', () => {
  const cfg = loadPdConfig(undefined)

  it('falls back to the shipped defaults for every setting', () => {
    expect(cfg.unit).toBe(DEFAULT_UNIT)
    expect(cfg.minRounds).toBe(DEFAULT_MIN_ROUNDS)
    expect(cfg.maxRounds).toBe(DEFAULT_MAX_ROUNDS)
    expect(cfg.kcEnabled).toBe(true)
    expect(cfg.addedKcQuestions).toEqual([])
    expect(cfg.debriefEnabled).toBe(true)
    expect(cfg.debriefPrompt).toBe(DEFAULT_DEBRIEF_PROMPT)
  })

  it('treats an ABSENT toggle as ON — a pre-Slice-5 instance keeps its flow', () => {
    // The instances already running when this shipped have no kc_enabled field. They
    // must not silently lose their knowledge check.
    expect(loadPdConfig({}).kcEnabled).toBe(true)
    expect(loadPdConfig({}).debriefEnabled).toBe(true)
    expect(loadPdConfig({ kc_enabled: false }).kcEnabled).toBe(false)
    expect(loadPdConfig({ debrief_enabled: false }).debriefEnabled).toBe(false)
  })

  it('reads stored values over defaults', () => {
    const cfg2 = loadPdConfig({
      unit: 'points', min_rounds: 4, max_rounds: 6,
      debrief_prompt: 'What happened?', labels: { C: 'Share', D: 'Take' },
    })
    expect(cfg2.unit).toBe('points')
    expect(cfg2.minRounds).toBe(4)
    expect(cfg2.maxRounds).toBe(6)
    expect(cfg2.debriefPrompt).toBe('What happened?')
    expect(cfg2.labels).toEqual({ C: 'Share', D: 'Take' })
  })

  it('ignores a blank unit or prompt rather than rendering an empty word', () => {
    expect(loadPdConfig({ unit: '   ' }).unit).toBe(DEFAULT_UNIT)
    expect(loadPdConfig({ debrief_prompt: '' }).debriefPrompt).toBe(DEFAULT_DEBRIEF_PROMPT)
  })
})

describe('parseRoundRange', () => {
  it('accepts a valid range', () => {
    expect(parseRoundRange(5, 9)).toEqual({ minRounds: 5, maxRounds: 9 })
  })

  it('accepts min === max (a fixed-length game)', () => {
    expect(parseRoundRange(7, 7)).toEqual({ minRounds: 7, maxRounds: 7 })
  })

  it('falls back when min > max rather than drawing from an impossible range', () => {
    expect(parseRoundRange(9, 5)).toEqual({ minRounds: DEFAULT_MIN_ROUNDS, maxRounds: DEFAULT_MAX_ROUNDS })
  })

  it('falls back on non-integers and missing values', () => {
    for (const bad of [[1.5, 4], ['3', 4], [null, 4], [undefined, undefined], [3, NaN]] as const) {
      expect(parseRoundRange(bad[0], bad[1])).toEqual({ minRounds: DEFAULT_MIN_ROUNDS, maxRounds: DEFAULT_MAX_ROUNDS })
    }
  })

  it('clamps to the hard bounds — no zero-round and no thousand-round games', () => {
    expect(parseRoundRange(0, 5).minRounds).toBe(HARD_MIN_ROUNDS)
    expect(parseRoundRange(5, 5000).maxRounds).toBe(HARD_MAX_ROUNDS)
  })
})

describe('parseAddedKcQuestion — instructor-authored questions', () => {
  const mc = { id: 'akc_1', type: 'mc', prompt: 'Which?', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }], correct_value: 'b' }

  it('accepts a well-formed multiple-choice question', () => {
    expect(parseAddedKcQuestion(mc)).toMatchObject({ id: 'akc_1', type: 'mc', correct_value: 'b' })
  })

  it('accepts a free-text question, which is ungraded by construction', () => {
    const q = parseAddedKcQuestion({ id: 'akc_2', type: 'text', prompt: 'Why?' })
    expect(q).toMatchObject({ id: 'akc_2', type: 'text' })
    expect(q?.correct_value).toBeUndefined()
  })

  it('⚠ REFUSES a reserved kc_ id — the derived four own that namespace', () => {
    // If an added question could take kc_cc, the grader's derived-first lookup would
    // shadow it and the student would be graded against the matrix, not the key.
    expect(parseAddedKcQuestion({ ...mc, id: 'kc_cc' })).toBeNull()
    expect(parseAddedKcQuestion({ ...mc, id: 'kc_anything' })).toBeNull()
  })

  it('rejects a question with no prompt or no id', () => {
    expect(parseAddedKcQuestion({ ...mc, prompt: '  ' })).toBeNull()
    expect(parseAddedKcQuestion({ ...mc, id: '' })).toBeNull()
  })

  it('rejects a multiple-choice question with fewer than two options', () => {
    expect(parseAddedKcQuestion({ ...mc, options: [{ value: 'a', label: 'A' }] })).toBeNull()
  })

  it('drops a key that names no offered option, rather than marking everyone wrong', () => {
    const q = parseAddedKcQuestion({ ...mc, correct_value: 'zzz' })
    expect(q).not.toBeNull()
    expect(q?.correct_value).toBeUndefined()
  })

  it('drops malformed entries from the config instead of throwing', () => {
    const cfg = loadPdConfig({ added_kc_questions: [mc, { junk: true }, null, { ...mc, id: 'kc_cc' }] })
    expect(cfg.addedKcQuestions.map(q => q.id)).toEqual(['akc_1'])
  })
})

describe('unitLabel — best-effort singularization of an arbitrary unit', () => {
  it('drops a trailing s at exactly one', () => {
    expect(unitLabel('1', 'years')).toBe('1 year')
    expect(unitLabel('1', 'points')).toBe('1 point')
    expect(unitLabel('2', 'years')).toBe('2 years')
    expect(unitLabel('0', 'years')).toBe('0 years')
  })

  it('leaves a unit that does not end in s alone rather than mangling it', () => {
    expect(unitLabel('1', 'cash')).toBe('1 cash')
    expect(unitLabel('1', 'kg')).toBe('1 kg')
  })
})

describe('parseAddedKcQuestion — ⚠ never emits undefined (Firestore rejects it)', () => {
  // These objects are written straight into Firestore, which refuses an undefined
  // value outright. A question with no explanation used to carry `explanation:
  // undefined` and made the WHOLE settings save fail — omit the key instead.
  const hasUndefined = (o: object) => Object.values(o).some(v => v === undefined)

  it('omits explanation rather than setting it undefined (free text)', () => {
    const q = parseAddedKcQuestion({ id: 'akc_t', type: 'text', prompt: 'Why?' })!
    expect('explanation' in q).toBe(false)
    expect(hasUndefined(q)).toBe(false)
  })

  it('omits explanation AND correct_value rather than setting them undefined (mc)', () => {
    const q = parseAddedKcQuestion({
      id: 'akc_m', type: 'mc', prompt: 'Which?',
      options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }],
      // no correct_value at all
    })!
    expect('correct_value' in q).toBe(false)
    expect('explanation' in q).toBe(false)
    expect(hasUndefined(q)).toBe(false)
  })

  it('keeps them when they are genuinely present', () => {
    const q = parseAddedKcQuestion({
      id: 'akc_m', type: 'mc', prompt: 'Which?',
      options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }],
      correct_value: 'a', explanation: 'Because A.',
    })!
    expect(q.correct_value).toBe('a')
    expect(q.explanation).toBe('Because A.')
    expect(hasUndefined(q)).toBe(false)
  })
})
