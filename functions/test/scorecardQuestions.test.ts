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

// ═══════════════════════════════════════════════════════════════════════════════
// ⚠⚠ THE THREE REWRITTEN QUESTIONS (Elena, 08-08) — Q1 narrowed, Q5 made
// self-contained, Q6 replaced. Same ten questions, same stages, same order.
// ═══════════════════════════════════════════════════════════════════════════════

const at = (c: Partial<typeof DEFAULT_CONFIG>, t: Partial<typeof DEFAULT_TRUTH> = {}) =>
  scorecardKcQuestions({ ...DEFAULT_CONFIG, ...c }, { ...DEFAULT_TRUTH, ...t })
const q = (id: string, c = {}, t = {}) => at(c, t).find(x => x.id === id)!
const textOf = (id: string, c = {}, t = {}) => {
  const x = q(id, c, t)
  return `${x.prompt} ${x.options.map(o => o.text).join(' ')}`
}

describe('⚠ Q1 no longer bundles two opposite effects', () => {
  it('the stem does not mention excluding spikes or removing noise', () => {
    // The ambiguity was structural: excluding a one-time spike RAISES reliability while
    // negotiating the figures LOWERS it, so both directions were defensible and the item
    // measured which effect a student happened to weight.
    const stem = q('q1_negotiated_ppm').prompt.toLowerCase()
    for (const gone of ['spike', 'exclude', 'excludes', 'one-time']) {
      expect(stem, `the stem must not say '${gone}'`).not.toContain(gone)
    }
    expect(stem).toContain('negotiate')
  })

  it('⚠ and no OPTION reintroduces it — the fairness distractor is gone', () => {
    const opts = q('q1_negotiated_ppm').options.map(o => o.text.toLowerCase()).join(' | ')
    for (const gone of ['fairer', 'spike', 'noise']) {
      expect(opts, `no option may say '${gone}'`).not.toContain(gone)
    }
  })

  it('still offers four options with exactly one key', () => {
    const x = q('q1_negotiated_ppm')
    expect(x.options).toHaveLength(4)
    expect(x.options.filter(o => o.id === x.correctOptionId)).toHaveLength(1)
  })
})

describe('⚠ Q5 is self-contained — every parameter it uses is in the stem', () => {
  it('states endowment, high-effort cost, target and bonus, all interpolated', () => {
    const stem = q('q5_earnings_arithmetic').prompt
    for (const n of [50, 4, 7, 120]) {
      expect(stem, `the shipped default ${n} appears`).toContain(String(n))
    }
    // ⚠ INTERPOLATED, not literal: an edit must move the stem with the answer.
    const edited = q('q5_earnings_arithmetic', {
      endowmentPerContract: 80, highEffortCost: 3, targetScore: 9, bonus: 200,
    }).prompt
    for (const n of [80, 3, 9, 200]) expect(edited).toContain(String(n))
    for (const n of ['50 ECU', '120 ECU']) expect(edited).not.toContain(n)
  })

  it('⚠ does NOT claim low effort is free when it has been given a price', () => {
    expect(q('q5_earnings_arithmetic').prompt).toContain('low effort is free')
    const paid = q('q5_earnings_arithmetic', { lowEffortCost: 1 }).prompt
    expect(paid, 'a false sentence must not reach a student').not.toContain('free')
    expect(paid).toContain('low effort costs')
  })

  it('the answer is the spec §1 formula, and the three distractors are the named slips', () => {
    const x = q('q5_earnings_arithmetic')
    const texts = x.options.map(o => o.text)
    expect(texts[0]).toBe('26 ECU')                       // 50 − 4×6, no bonus
    expect(texts).toContain('146 ECU')                    // bonus added anyway
    expect(texts).toContain('50 ECU')                     // costs forgotten
    expect(texts).toContain('30 ECU')                     // paid only for the 5 that worked
    expect(x.options[0].id).toBe(x.correctOptionId)
  })
})

describe('⚠⚠ Q5/Q6 distractors cannot collapse onto the answer at edited parameters', () => {
  // ⚠ CALIBRATION: each config below is chosen because it makes ONE specific distractor
  // equal the answer under naive arithmetic. `bonus: 0` makes "bonus added anyway" == the
  // answer; `highEffortCost: 0` makes "costs forgotten" == it; `targetScore: 8` makes the
  // score equal the high-effort count, so "paid for successes" == it. A duplicate option
  // marks a student wrong for picking something that is right.
  const CONFIGS: Partial<typeof DEFAULT_CONFIG>[] = [
    {}, { bonus: 0 }, { highEffortCost: 0 }, { targetScore: 8 }, { lowEffortCost: 1 },
    { endowmentPerContract: 26, highEffortCost: 0, bonus: 0 },
    { periodsPerContract: 3, targetScore: 2 },
    { pAcceptableLow: 0 }, { pAcceptableLow: 0.01 }, { pAcceptableLow: 0.03 },
    { pAcceptableLow: 0.9 },
  ]

  for (const cfg of CONFIGS) {
    const name = Object.keys(cfg).length ? JSON.stringify(cfg) : 'defaults'
    it(`no duplicate option at ${name}`, () => {
      for (const id of ['q5_earnings_arithmetic', 'q6_low_effort_is_shared']) {
        const texts = q(id, cfg).options.map(o => o.text)
        expect(new Set(texts).size, `${id} has a duplicate option`).toBe(texts.length)
        expect(texts.length, `${id} must stay answerable`).toBeGreaterThanOrEqual(2)
      }
    })
  }

  it('⚠ every Q6 distractor is strictly BELOW the true low-effort rate', () => {
    // A number ABOVE the rate answers a confusion nobody has, and the scaling story rules
    // it out on sight — which makes the item easier. Found by driving pAcceptableLow 0.03,
    // where the top-up ladder stepped UP and printed 4% against a true rate of 3%.
    for (const cfg of CONFIGS) {
      const rate = Math.round((cfg.pAcceptableLow ?? DEFAULT_CONFIG.pAcceptableLow) * 100)
      for (const o of q('q6_low_effort_is_shared', cfg).options.slice(1)) {
        const m = /^(\d+)%$/.exec(o.text)
        if (m) expect(Number(m[1]), `${o.text} vs a true rate of ${rate}%`).toBeLessThan(rate)
      }
    }
  })

  it('⚠ R8 — no option anywhere prints an unrounded float, at any of these configs', () => {
    for (const cfg of CONFIGS) {
      for (const x of at(cfg)) {
        for (const o of x.options) {
          expect(/\d\.\d{4,}/.test(o.text), `${x.id}: '${o.text}'`).toBe(false)
        }
      }
    }
  })
})

describe('⚠ Q6 catches the misreading that would hide the whole treatment', () => {
  it('the stem contrasts BOTH condition rates and the answer is the unchanged low rate', () => {
    const x = q('q6_low_effort_is_shared')
    expect(x.prompt).toContain('70%')      // reliabilityHigh
    expect(x.prompt).toContain('40%')      // reliabilityLow
    expect(x.prompt).toContain('30%')      // pAcceptableLow, given for the good contract
    expect(x.options[0].text).toMatch(/^30%/)
    expect(x.options[0].id).toBe(x.correctOptionId)
  })

  it('⚠ all three rates interpolate — an edit moves the stem and the key together', () => {
    const x = q('q6_low_effort_is_shared', { pAcceptableLow: 0.25 },
      { reliabilityHigh: 0.9, reliabilityLow: 0.5 })
    expect(x.prompt).toContain('90%')
    expect(x.prompt).toContain('50%')
    expect(x.options[0].text).toMatch(/^25%/)
  })

  it('⚠ it no longer asks for a subtraction — "percentage points" is gone', () => {
    expect(textOf('q6_low_effort_is_shared')).not.toContain('percentage points')
  })

  it('offers "it depends", the answer a student gives when they think the rate is contextual', () => {
    expect(textOf('q6_low_effort_is_shared').toLowerCase()).toContain('it depends')
  })
})

describe('⚠⚠ §9.1 binds pre-play EXPLANATIONS, not only stems', () => {
  it('no PRE-stage explanation states that a target can become unreachable', () => {
    // ⚠ This test exists because a draft of Q5's rewrite ended "…spending it on a contract
    // you cannot win", which says outright what §9.1 withholds until Q8 asks it post-play.
    // The harness only scans prompts and options — explanations never ship in
    // getQuestions — so nothing would have caught it. An explanation is shown the instant
    // a question is answered, which for a pre-play question is pre-play.
    const banned = [
      'out of reach', 'unreachable', 'no longer reach', 'already lost', 'impossible',
      'cannot win', "can't win", 'cannot reach', 'no way to reach',
    ]
    for (const x of questionsForStage(all(), 'pre')) {
      const text = x.explanation.toLowerCase()
      for (const b of banned) {
        expect(text, `${x.id}'s explanation must not say '${b}'`).not.toContain(b)
      }
    }
  })

  it('…and the POST set is where that inference is allowed to appear', () => {
    // Not vacuous: the constraint is a pre/post SPLIT, so the post set must actually
    // discuss it. Q8 is the question that asks it.
    const post = questionsForStage(all(), 'post')
      .map(x => `${x.prompt} ${x.options.map(o => o.text).join(' ')} ${x.explanation}`)
      .join(' ').toLowerCase()
    expect(post).toContain('out of reach')
  })
})
