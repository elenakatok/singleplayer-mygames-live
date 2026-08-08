import { describe, it, expect } from 'vitest'
import {
  scorecardKcQuestions, questionsForStage, toClientKcQuestions, kcDenominator,
} from '../src/scorecard/questions'
import { DEFAULT_CONFIG, DEFAULT_TRUTH } from '../src/scorecard/config'

// ═══════════════════════════════════════════════════════════════════════════════
// ⚠⚠ THE ANSWER'S POSITION IS PART OF THE ANSWER KEY.
//
// Every question in questions.ts is AUTHORED with its correct option first, as `'a'` —
// which is readable to write and review, and shipped a live tell: ten questions whose
// answer is always the top radio button are answerable without reading one of them.
// Found in the live game (Elena, 2026-08-08) after the KC had already been run.
//
// These tests hold the two halves apart: the authoring order stays correct-first (so a
// reviewer can still scan the file), and the SERVED order must not be.
// ═══════════════════════════════════════════════════════════════════════════════

const all = () => scorecardKcQuestions(DEFAULT_CONFIG, DEFAULT_TRUTH)

describe('⚠ the authored order is correct-answer-first, deliberately', () => {
  it('every question declares its answer as the FIRST option', () => {
    // This is what makes the shuffle necessary. Asserted so that if someone ever
    // hand-scrambles the source instead, the shuffle test below stops being the only
    // thing standing between students and a positional tell.
    for (const q of all()) {
      expect(q.options[0].id, `${q.id} is authored answer-first`).toBe(q.correctOptionId)
    }
  })
})

describe('⚠⚠ …and the SERVED order is not', () => {
  it('the answer does not land first for every student', () => {
    for (const q of all()) {
      const firsts = new Set(
        Array.from({ length: 40 }, (_, i) =>
          toClientKcQuestions([q], `stu-${i}`)[0].options[0].id),
      )
      expect(firsts.size, `${q.id}: the first option must vary across students`)
        .toBeGreaterThan(1)
    }
  })

  it('⚠ over a cohort, the answer lands in EVERY position — not merely "not always first"', () => {
    // A permutation that only ever swaps two slots would pass the test above while
    // still leaking. This asserts the answer reaches all four positions.
    for (const q of all()) {
      const positions = new Set(
        Array.from({ length: 200 }, (_, i) =>
          toClientKcQuestions([q], `stu-${i}`)[0].options
            .findIndex(o => o.id === q.correctOptionId)),
      )
      expect(positions.size, `${q.id}: the answer reaches every slot`)
        .toBe(q.options.length)
    }
  })

  it('⚠ BOTH STAGES get it — a shuffle on `pre` alone leaves four post questions bare', () => {
    const set = all()
    for (const stage of ['pre', 'post'] as const) {
      const qs = questionsForStage(set, stage)
      expect(qs.length, `${stage} is non-empty`).toBeGreaterThan(0)
      for (const q of qs) {
        const firsts = new Set(
          Array.from({ length: 40 }, (_, i) =>
            toClientKcQuestions([q], `s${i}`)[0].options[0].id),
        )
        expect(firsts.size, `${stage}/${q.id} is shuffled`).toBeGreaterThan(1)
      }
    }
  })
})

describe('the shuffle is deterministic and lossless', () => {
  it('⚠ the same student sees the same order twice — a reload is not a new screen', () => {
    const set = all()
    expect(toClientKcQuestions(set, 'stu-7')).toEqual(toClientKcQuestions(set, 'stu-7'))
  })

  it('two students see DIFFERENT orders (over the whole set, not merely per question)', () => {
    const a = JSON.stringify(toClientKcQuestions(all(), 'alice'))
    const b = JSON.stringify(toClientKcQuestions(all(), 'bob'))
    expect(a).not.toBe(b)
  })

  it('⚠ no option is dropped, duplicated or rewritten', () => {
    const byId = (xs: { id: string }[]) => [...xs].sort((x, y) => x.id.localeCompare(y.id))
    for (const q of all()) {
      const served = toClientKcQuestions([q], 'stu-9')[0].options
      expect(served).toHaveLength(q.options.length)
      expect(byId(served)).toEqual(byId(q.options.map(o => ({ id: o.id, text: o.text }))))
    }
  })
})

describe('⚠ the answer key still never ships', () => {
  it('correctOptionId, explanation and tests are all absent from the client shape', () => {
    const json = JSON.stringify(toClientKcQuestions(all(), 'stu-1'))
    for (const leaked of ['correctOptionId', 'explanation', 'tests']) {
      expect(json).not.toContain(leaked)
    }
    for (const q of toClientKcQuestions(all(), 'stu-1')) {
      expect(Object.keys(q).sort()).toEqual(['id', 'options', 'prompt', 'stage'])
    }
  })

  it('and the denominator counts both stages, dynamically', () => {
    const set = all()
    expect(kcDenominator(set)).toBe(set.length)
    expect(kcDenominator(set))
      .toBe(questionsForStage(set, 'pre').length + questionsForStage(set, 'post').length)
  })
})
