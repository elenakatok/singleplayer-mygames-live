import { describe, it, expect } from 'vitest'
import {
  scorecardKcQuestions, questionsForStage, toClientKcQuestions, kcDenominator,
  addedToClientKcQuestions, isGradedAdded,
} from '../src/scorecard/questions'
import {
  DEFAULT_CONFIG, DEFAULT_TRUTH, parseAddedKcQuestion,
  type ScorecardAddedKcQuestion,
} from '../src/scorecard/config'

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

// ═══════════════════════════════════════════════════════════════════════════════
// ⚠⚠ INSTRUCTOR-ADDED QUESTIONS GO THROUGH THE SAME SHUFFLE.
//
// `cef36fe` fixed added questions being served in the order the instructor TYPED them,
// across forecast, newsvendor, pricing and pd. The reasoning was that an instructor has no
// reason to think about where they put the right answer, and most people type it first —
// exactly the tell the built-in ten had. Scorecard's added path was written after that fix
// and these tests exist so it cannot be reintroduced here.
// ═══════════════════════════════════════════════════════════════════════════════

/** An added mc question with the key FIRST — the layout the composer produces and the
 *  one that leaks if nothing permutes it. */
const added = (id: string, n = 4): ScorecardAddedKcQuestion => ({
  id,
  type: 'mc',
  prompt: `Added question ${id}?`,
  options: Array.from({ length: n }, (_, i) => ({ value: `o${i}`, label: `Option ${i}` })),
  correct_value: 'o0',
})

describe('⚠⚠ added questions are shuffled per student, exactly like the built-in ten', () => {
  it('the typed-first answer does not land first for every student', () => {
    const q = added('akc_one')
    const firsts = new Set(
      Array.from({ length: 40 }, (_, i) =>
        addedToClientKcQuestions([q], `stu-${i}`)[0].options[0].id),
    )
    expect(firsts.size, 'the first option must vary across students').toBeGreaterThan(1)
  })

  it('⚠ the answer reaches EVERY position over a cohort — not merely "not always first"', () => {
    // CALIBRATION: this is the assertion that actually pins the permutation down. A
    // shuffle that only ever swapped two slots would pass the test above while still
    // leaking three-quarters of the information, and a shuffle keyed on the participant
    // ALONE (rather than participant+question+position) would put the answer in the same
    // slot for every question a given student sees. Both are caught here and only here.
    //
    // 200 students against 4 options: if the permutation were uniform, the chance of any
    // particular slot never being hit is 4 × (3/4)^200 ≈ 10^-24. A failure is a bug, not
    // a bad draw — this cannot flake.
    const q = added('akc_two')
    const positions = new Set(
      Array.from({ length: 200 }, (_, i) =>
        addedToClientKcQuestions([q], `stu-${i}`)[0].options.findIndex(o => o.id === 'o0')),
    )
    expect(positions.size, 'the answer reaches every slot').toBe(4)
  })

  it('⚠ two questions in one student\'s set are permuted INDEPENDENTLY', () => {
    // The seed is (participant, question, position). Were it (participant, position), every
    // question would carry the same permutation and one revealed answer would give away
    // the rest — which is a worse leak than the one being fixed.
    const same = Array.from({ length: 60 }, (_, i) => {
      const [a, b] = addedToClientKcQuestions([added('akc_a'), added('akc_b')], `stu-${i}`)
      return a.options.findIndex(o => o.id === 'o0') === b.options.findIndex(o => o.id === 'o0')
    })
    expect(same.every(Boolean), 'the two must NOT move together').toBe(false)
  })

  it('the same student sees the same order twice — a reload is not a new screen', () => {
    const qs = [added('akc_a'), added('akc_b')]
    expect(addedToClientKcQuestions(qs, 'stu-7')).toEqual(addedToClientKcQuestions(qs, 'stu-7'))
  })

  it('⚠ no option is dropped, duplicated or rewritten', () => {
    const q = added('akc_three', 5)
    const served = addedToClientKcQuestions([q], 'stu-9')[0].options
    expect([...served].sort((a, b) => a.id.localeCompare(b.id)))
      .toEqual((q.options ?? []).map(o => ({ id: o.value, text: o.label }))
        .sort((a, b) => a.id.localeCompare(b.id)))
  })

  it('⚠ a free-text addition keeps options: [] — that is what the client renders a box on', () => {
    const q: ScorecardAddedKcQuestion = { id: 'akc_txt', type: 'text', prompt: 'Why?' }
    expect(addedToClientKcQuestions([q], 'stu-1')[0].options).toEqual([])
  })

  it('⚠ a two-option question is still shuffled, and a one-option list is left alone', () => {
    const two = added('akc_two_opt', 2)
    const firsts = new Set(
      Array.from({ length: 40 }, (_, i) =>
        addedToClientKcQuestions([two], `s${i}`)[0].options[0].id),
    )
    expect(firsts.size, 'two options must still swap').toBe(2)
  })
})

describe('⚠ added questions are ALWAYS post-stage (spec §9.1 keeps `pre` closed)', () => {
  it('every added question is served with stage "post"', () => {
    const out = addedToClientKcQuestions([added('akc_a'), added('akc_b')], 'stu-1')
    expect(out.every(q => q.stage === 'post')).toBe(true)
  })
})

describe('the denominator counts graded additions and ignores ungraded ones', () => {
  const all = scorecardKcQuestions(DEFAULT_CONFIG, DEFAULT_TRUTH)

  it('a graded addition raises the denominator by one', () => {
    expect(kcDenominator(all, [added('akc_a')])).toBe(all.length + 1)
  })

  it('⚠ a FREE-TEXT addition does not — it is recorded, never marked', () => {
    const text: ScorecardAddedKcQuestion = { id: 'akc_t', type: 'text', prompt: 'Why?' }
    expect(kcDenominator(all, [text])).toBe(all.length)
    expect(isGradedAdded(text)).toBe(false)
  })

  it('⚠ nor does an mc addition whose key named no offered option', () => {
    // parseAddedKcQuestion drops a key that matches nothing, precisely so it cannot mark
    // every student wrong. The question survives as an UNGRADED record, and must then be
    // absent from the denominator too — otherwise adding one silently lowers every score.
    const parsed = parseAddedKcQuestion({
      id: 'akc_bad', type: 'mc', prompt: 'Q?',
      options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }],
      correct_value: 'nonexistent',
    })
    expect(parsed).not.toBeNull()
    expect(parsed!.correct_value).toBeUndefined()
    expect(kcDenominator(all, [parsed!])).toBe(all.length)
  })

  it('with no additions it is unchanged — the default call site still reads 10', () => {
    expect(kcDenominator(all)).toBe(all.length)
    expect(kcDenominator(all, [])).toBe(all.length)
  })
})
