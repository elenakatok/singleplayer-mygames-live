import { describe, it, expect } from 'vitest'
import {
  scorecardKcQuestions, resolveKcQuestions, resolveAddedKcQuestions,
  questionsForStage, applyKcOverride, kcDenominator, isGradedAdded,
  toClientKcQuestions, addedToClientKcQuestions,
  kcScoringSet, kcScoreOrNull, BUILT_IN_KC_IDS, SCORECARD_KC_ID_GUARD,
} from '../src/scorecard/questions'
import {
  DEFAULT_CONFIG, DEFAULT_TRUTH, parseAddedKcQuestion, addedKcStage,
  type ScorecardConfig, type ScorecardAddedKcQuestion,
} from '../src/scorecard/config'
import { lockedKcQuestionIds, validateKcOverrides, KC_LOCK_REASON } from '../src/scorecard/kcLock'
import {
  parseAddedKcQuestion as parseShared, parseKcHidden, parseKcOrder, parseKcOverrides,
  applyKcOrder, visibleKcIds,
} from '../src/shared/kcSurface'

// ═══════════════════════════════════════════════════════════════════════════════
// THE SHARED KC SURFACE — hidden, order, overrides (convergence spec §5, §7).
//
// ⚠⚠ EVERY TEST HERE WAS CALIBRATED BY BREAKING THE CODE AND WATCHING IT FAIL. The mutant
// each one catches is named in its own comment. A test never seen to fail is not known to
// work, and this file exists because the failure it guards against — a hidden question
// still sitting in the grader's `forScoring` set — is silent, produces no error, and shows
// up only as every student's denominator being one too large.
// ═══════════════════════════════════════════════════════════════════════════════

const cfg = (over: Partial<ScorecardConfig> = {}): ScorecardConfig => ({ ...DEFAULT_CONFIG, ...over })

/** The one built-in that interpolates nothing, and therefore the only editable one. */
const EDITABLE = 'q2_charged_for_clean_parts'
/** A locked one, for the rejection tests. */
const LOCKED = 'q5_earnings_arithmetic'

const addedMc = (id: string, over: Partial<ScorecardAddedKcQuestion> = {}): ScorecardAddedKcQuestion => ({
  id, type: 'mc', prompt: `Added ${id}?`,
  options: [
    { value: 'o0', label: 'First' }, { value: 'o1', label: 'Second' },
    { value: 'o2', label: 'Third' }, { value: 'o3', label: 'Fourth' },
  ],
  correct_value: 'o0',
  ...over,
})

const addedText = (id: string, over: Partial<ScorecardAddedKcQuestion> = {}): ScorecardAddedKcQuestion => ({
  id, type: 'text', prompt: `Tell me about ${id}`, ...over,
})

// ═══════════════════════════════════════════════════════════════════════════════
// HIDDEN — the two places that must agree
// ═══════════════════════════════════════════════════════════════════════════════

describe('⚠⚠ a hidden question leaves BOTH the display and the denominator', () => {
  it('never reaches the denominator', () => {
    // MUTANT CAUGHT: `kcDenominator` (or its caller) counting the AUTHORED set instead of
    // the resolved one — i.e. `scorecardKcQuestions(...)` in place of
    // `resolveKcQuestions(...)`. That mutant leaves the student seeing nine questions and
    // being scored out of ten, forever, with no error anywhere.
    const all = scorecardKcQuestions(DEFAULT_CONFIG, DEFAULT_TRUTH)
    const c = cfg({ kcHidden: { q1_negotiated_ppm: true, q7_coasting: true } })

    expect(kcDenominator(resolveKcQuestions(c, DEFAULT_TRUTH))).toBe(all.length - 2)
    // …and stated the other way round, so a change to `all.length` cannot make this vacuous.
    expect(kcDenominator(resolveKcQuestions(c, DEFAULT_TRUTH))).toBe(8)
  })

  it('is not served — in EITHER stage', () => {
    // MUTANT CAUGHT: filtering the display only. A resolver that dropped the hide for the
    // `post` stage (or applied it after `questionsForStage`) passes a pre-only test.
    const c = cfg({ kcHidden: { q1_negotiated_ppm: true, q7_coasting: true } })
    const resolved = resolveKcQuestions(c, DEFAULT_TRUTH)
    const ids = resolved.map(q => q.id)

    expect(ids).not.toContain('q1_negotiated_ppm')   // pre
    expect(ids).not.toContain('q7_coasting')         // post
    expect(questionsForStage(resolved, 'pre').map(q => q.id)).not.toContain('q1_negotiated_ppm')
    expect(questionsForStage(resolved, 'post').map(q => q.id)).not.toContain('q7_coasting')
  })

  it('⚠⚠ THE GRADER\'S SCORING SET DROPS IT TOO — not just the display', () => {
    // MUTANT CAUGHT: filtering the display only and leaving `forScoring` intact — the bug
    // spec §5 names as the most likely one this whole change introduces. `kcScoringSet` is
    // what `scorecardSubmitKcAnswer` actually calls, so a mutant that reverts it to
    // `scorecardKcQuestions(config, truth)` fails HERE and not merely in the harness.
    //
    // Its signature is (config, truth) — the same inputs the serve path has — so there is
    // no way for a caller to pass it a differently-filtered list by mistake.
    const c = cfg({
      kcHidden: { [EDITABLE]: true, q10_thesis: true, akc_hidden: true },
      addedKcQuestions: [addedMc('akc_kept'), addedMc('akc_hidden')],
    })

    const served = [
      ...resolveKcQuestions(c, DEFAULT_TRUTH).map(q => q.id),
      ...resolveAddedKcQuestions(c).filter(isGradedAdded).map(q => q.id),
    ].sort()
    const graded = kcScoringSet(c, DEFAULT_TRUTH).map(x => x.field).sort()

    expect(graded).toEqual(served)
    expect(graded).not.toContain(EDITABLE)
    expect(graded).not.toContain('q10_thesis')
    expect(graded).not.toContain('akc_hidden')
    expect(graded).toContain('akc_kept')
    // 10 built-ins − 2 hidden + 1 visible addition.
    expect(graded).toHaveLength(9)
  })

  it('⚠ the scoring set carries the RIGHT KEY for every question it names', () => {
    // MUTANT CAUGHT: an off-by-one zip of ids against keys, which a length check misses.
    const authored = scorecardKcQuestions(DEFAULT_CONFIG, DEFAULT_TRUTH)
    for (const x of kcScoringSet(cfg(), DEFAULT_TRUTH)) {
      expect(x.correct_value, x.field).toBe(authored.find(q => q.id === x.field)!.correctOptionId)
    }
  })

  it('hides ADDED questions too, and they leave the denominator with them', () => {
    const c = cfg({
      addedKcQuestions: [addedMc('akc_keep'), addedMc('akc_hide')],
      kcHidden: { akc_hide: true },
    })
    const added = resolveAddedKcQuestions(c)
    expect(added.map(q => q.id)).toEqual(['akc_keep'])
    expect(kcDenominator(resolveKcQuestions(c, DEFAULT_TRUTH), added))
      .toBe(scorecardKcQuestions(DEFAULT_CONFIG, DEFAULT_TRUTH).length + 1)
  })

  it('hiding every graded question leaves a denominator of zero, not of ten', () => {
    const all = scorecardKcQuestions(DEFAULT_CONFIG, DEFAULT_TRUTH)
    const c = cfg({ kcHidden: Object.fromEntries(all.map(q => [q.id, true])) })
    expect(kcDenominator(resolveKcQuestions(c, DEFAULT_TRUTH))).toBe(0)
  })
})

describe('⚠ zero visible graded questions ⇒ null, never 0 and never 1', () => {
  /** Every built-in hidden; one ungraded free-text addition left visible to answer. */
  const nothingGraded = () => cfg({
    kcHidden: Object.fromEntries(
      scorecardKcQuestions(DEFAULT_CONFIG, DEFAULT_TRUTH).map(q => [q.id, true]),
    ),
    addedKcQuestions: [addedText('akc_free')],
  })

  it('the scoring set really is empty in that configuration', () => {
    expect(kcScoringSet(nothingGraded(), DEFAULT_TRUTH)).toHaveLength(0)
  })

  it('⚠⚠ and the stored score is null', () => {
    // MUTANT CAUGHT: `return 0`. And the subtler one that would have shipped by default —
    // the shared `calcKCScore` answers the EMPTY set with 1.0, so a student who answered
    // only an ungraded free-text addition would have been recorded at a PERFECT
    // knowledge-check score and had it pushed to the gradebook by scoreAndRecord.
    // `kcScoreOrNull` is what the callable stores, so both mutants fail here.
    const score = kcScoreOrNull({ akc_free: 'anything' }, kcScoringSet(nothingGraded(), DEFAULT_TRUTH))
    expect(score).toBeNull()
    expect(score).not.toBe(0)
    expect(score).not.toBe(1)
  })

  it('…while a NON-empty set still scores normally', () => {
    // The guard against "fix the empty case by nulling everything".
    const forScoring = kcScoringSet(cfg(), DEFAULT_TRUTH)
    const allRight = Object.fromEntries(forScoring.map(x => [x.field, x.correct_value]))
    expect(kcScoreOrNull(allRight, forScoring)).toBe(1)

    const allWrong = Object.fromEntries(forScoring.map(x => [x.field, '__no__']))
    expect(kcScoreOrNull(allWrong, forScoring)).toBe(0)
  })

  it('a half-right set scores the fraction over the VISIBLE denominator', () => {
    // Hiding two questions changes the denominator, so the same number of correct answers
    // is worth more. This is the observable consequence of the hidden/forScoring fix.
    const c = cfg({ kcHidden: { q9_squeeze: true, q10_thesis: true } })
    const forScoring = kcScoringSet(c, DEFAULT_TRUTH)
    expect(forScoring).toHaveLength(8)
    const answers = Object.fromEntries(
      forScoring.map((x, i) => [x.field, i < 4 ? x.correct_value : '__no__']),
    )
    expect(kcScoreOrNull(answers, forScoring)).toBe(0.5)
  })
})

describe('⚠ an ungraded free-text question never reaches the denominator', () => {
  it('gradedness follows the ANSWER KEY, not the stage and not the type badge', () => {
    // MUTANT CAUGHT: grading by stage ("everything in `post` is graded"), and the near
    // miss of grading by `type === 'mc'` alone — an mc question whose key named no offered
    // option has its key DROPPED at parse time and must not count either.
    const keyless = parseAddedKcQuestion({
      id: 'akc_badkey', type: 'mc', prompt: 'Which?',
      options: [{ value: 'x', label: 'X' }, { value: 'y', label: 'Y' }],
      correct_value: 'NOT_AN_OPTION',
    })!
    expect(keyless.correct_value).toBeUndefined()

    const c = cfg({
      addedKcQuestions: [addedMc('akc_graded'), addedText('akc_free'), keyless],
    })
    const added = resolveAddedKcQuestions(c)
    expect(added).toHaveLength(3)
    expect(added.filter(isGradedAdded).map(q => q.id)).toEqual(['akc_graded'])

    const base = scorecardKcQuestions(DEFAULT_CONFIG, DEFAULT_TRUTH).length
    // Three added questions, but only ONE of them moves the denominator.
    expect(kcDenominator(resolveKcQuestions(c, DEFAULT_TRUTH), added)).toBe(base + 1)
  })

  it('a free-text addition in the PRE stage is still ungraded', () => {
    const q = addedText('akc_pre_free', { stage: 'pre' })
    expect(addedKcStage(q)).toBe('pre')
    expect(isGradedAdded(q)).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// OVERRIDES
// ═══════════════════════════════════════════════════════════════════════════════

describe('⚠⚠ an override changes DISPLAY TEXT and provably nothing else', () => {
  it('replaces the prompt, and leaves the key, the option ids and the option count alone', () => {
    // MUTANT CAUGHT: an override that replaces the whole question object (or that stores
    // `options` as a LIST rather than a map from existing option id to label). Either can
    // change the answer key, the option ids or the number of options — and grading
    // compares option IDS, so either could move a score.
    const original = scorecardKcQuestions(DEFAULT_CONFIG, DEFAULT_TRUTH).find(q => q.id === EDITABLE)!
    const c = cfg({ kcOverrides: { [EDITABLE]: { prompt: 'MY OWN STEM' } } })
    const got = resolveKcQuestions(c, DEFAULT_TRUTH).find(q => q.id === EDITABLE)!

    expect(got.prompt).toBe('MY OWN STEM')
    expect(got.correctOptionId).toBe(original.correctOptionId)
    expect(got.options.map(o => o.id)).toEqual(original.options.map(o => o.id))
    expect(got.options.map(o => o.text)).toEqual(original.options.map(o => o.text))
    expect(got.explanation).toBe(original.explanation)
    expect(got.stage).toBe(original.stage)
  })

  it('replaces an option LABEL by option id, and cannot add, drop or reorder one', () => {
    const original = scorecardKcQuestions(DEFAULT_CONFIG, DEFAULT_TRUTH).find(q => q.id === EDITABLE)!
    const c = cfg({
      kcOverrides: {
        [EDITABLE]: {
          options: {
            // A real option, renamed…
            [original.options[1].id]: 'RENAMED',
            // …and one that does not exist. It must be ignored, never appended.
            zzz_not_an_option: 'GHOST',
          },
        },
      },
    })
    const got = resolveKcQuestions(c, DEFAULT_TRUTH).find(q => q.id === EDITABLE)!

    expect(got.options).toHaveLength(original.options.length)
    expect(got.options.map(o => o.id)).toEqual(original.options.map(o => o.id))
    expect(got.options[1].text).toBe('RENAMED')
    expect(got.options[0].text).toBe(original.options[0].text)
    expect(JSON.stringify(got)).not.toContain('GHOST')
    expect(got.correctOptionId).toBe(original.correctOptionId)
  })

  it('⚠ the shuffle is unaffected — the answer still reaches every position', () => {
    // MUTANT CAUGHT: applying the override AFTER the shuffle, or rebuilding the option
    // list from the override map (which would fix the order to the map's key order).
    const c = cfg({ kcOverrides: { [EDITABLE]: { prompt: 'MY OWN STEM' } } })
    const q = resolveKcQuestions(c, DEFAULT_TRUTH).find(x => x.id === EDITABLE)!
    const positions = new Set(
      Array.from({ length: 200 }, (_, i) =>
        toClientKcQuestions([q], `stu-${i}`)[0].options.findIndex(o => o.id === q.correctOptionId)),
    )
    expect(positions.size).toBe(q.options.length)
  })

  it('a built-in with NO override serves its generated text, unchanged', () => {
    // MUTANT CAUGHT: always reading the override map — e.g. `o.prompt ?? ''` or an
    // unconditional `{...q, ...overrides[q.id]}` which yields `undefined` fields for
    // every un-overridden question and blanks nine of the ten prompts.
    const authored = scorecardKcQuestions(DEFAULT_CONFIG, DEFAULT_TRUTH)
    const c = cfg({ kcOverrides: { [EDITABLE]: { prompt: 'MY OWN STEM' } } })
    const resolved = resolveKcQuestions(c, DEFAULT_TRUTH)

    for (const a of authored) {
      const r = resolved.find(x => x.id === a.id)!
      if (a.id === EDITABLE) continue
      expect(r.prompt, `${a.id} keeps its generated stem`).toBe(a.prompt)
      expect(r.options.map(o => o.text), `${a.id} keeps its generated options`)
        .toEqual(a.options.map(o => o.text))
    }
    // And an EMPTY override map changes nothing at all.
    expect(resolveKcQuestions(cfg(), DEFAULT_TRUTH)).toEqual(authored)
  })

  it('applyKcOverride returns the SAME OBJECT when there is no entry', () => {
    const q = scorecardKcQuestions(DEFAULT_CONFIG, DEFAULT_TRUTH)[0]
    expect(applyKcOverride(q, {})).toBe(q)
  })
})

describe('⚠⚠ a locked question rejects an override AT THE CALLABLE', () => {
  const ctx = () => {
    const qs = scorecardKcQuestions(DEFAULT_CONFIG, DEFAULT_TRUTH)
    return {
      builtInIds: new Set(qs.map(q => q.id)),
      locked: lockedKcQuestionIds(DEFAULT_CONFIG, DEFAULT_TRUTH),
      optionIds: new Map(qs.map(q => [q.id, new Set(q.options.map(o => o.id))])),
    }
  }

  it('refuses an override on an interpolating question, with a reason', () => {
    // MUTANT CAUGHT: a UI-only guard — deleting the server-side check and trusting the
    // greyed-out Edit button. A stale tab, a replayed payload or a hand-made call all
    // reach the callable without ever rendering the button.
    const bad = validateKcOverrides({ [LOCKED]: { prompt: 'rewritten' } }, ctx())
    expect(bad).toHaveLength(1)
    expect(bad[0].reason).toBe('locked')
    expect(bad[0].message).toContain(KC_LOCK_REASON.toLowerCase())
  })

  it('accepts one on the question that interpolates nothing', () => {
    expect(validateKcOverrides({ [EDITABLE]: { prompt: 'rewritten' } }, ctx())).toEqual([])
  })

  it('refuses an override aimed at an ADDED question — those are edited in place', () => {
    const bad = validateKcOverrides({ akc_mine: { prompt: 'x' } }, ctx())
    expect(bad[0].reason).toBe('not-built-in')
  })

  it('refuses an option key that names no offered option', () => {
    const bad = validateKcOverrides({ [EDITABLE]: { options: { nope: 'x' } } }, ctx())
    expect(bad[0].reason).toBe('unknown-option')
  })

  it('⚠ EVERY locked question is refused — not merely the one this file names', () => {
    const c = ctx()
    for (const id of c.locked) {
      expect(validateKcOverrides({ [id]: { prompt: 'x' } }, c)[0]?.reason, id).toBe('locked')
    }
  })
})

describe('⚠⚠ which questions are locked, pinned one by one', () => {
  // ⚠ THE SPEC'S §3 TABLE PREDICTED "the arithmetic / parameter questions" locked and "the
  // Metalcraft case questions" editable. THAT IS WRONG, and this test is the correction:
  // Q1, Q3 and Q4 are case questions that interpolate `scorecardNoun` / `buyerName`, and
  // all four post-play strategy questions interpolate a noun, the target score or the
  // currency. Exactly ONE of the ten is free of instance parameters.
  const EXPECTED_LOCKED = [
    'q1_negotiated_ppm', 'q3_buyers_ignore_score', 'q4_comfortably_green',
    'q5_earnings_arithmetic', 'q6_low_effort_is_shared',
    'q7_coasting', 'q8_written_off', 'q9_squeeze', 'q10_thesis',
  ]

  it('nine locked, one editable', () => {
    const locked = lockedKcQuestionIds(DEFAULT_CONFIG, DEFAULT_TRUTH)
    expect([...locked].sort()).toEqual([...EXPECTED_LOCKED].sort())
    expect(locked.has(EDITABLE)).toBe(false)
  })

  it('⚠ the classification is MEASURED, so a noun threaded into Q2 would lock it', () => {
    // This is the property a hand-maintained list cannot have. If someone later edits Q2's
    // stem to say "${config.buyerName} charged him for 75 parts", the detector notices and
    // the test above fails — which is a review prompt, not a silent unlock.
    const withNoun = cfg({ buyerName: 'Metalcraft' })
    const other = cfg({ buyerName: 'Anvilworks' })
    const a = scorecardKcQuestions(withNoun, DEFAULT_TRUTH).find(q => q.id === EDITABLE)!
    const b = scorecardKcQuestions(other, DEFAULT_TRUTH).find(q => q.id === EDITABLE)!
    expect(a.prompt).toBe(b.prompt)
  })

  it('the lock covers OPTIONS and the EXPLANATION, not merely the stem', () => {
    // Q7's stem interpolates only nouns, but its EXPLANATION prints the target score and
    // the currency — checking stems alone would unlock it.
    const q7a = scorecardKcQuestions(cfg({ targetScore: 7 }), DEFAULT_TRUTH).find(q => q.id === 'q7_coasting')!
    const q7b = scorecardKcQuestions(cfg({ targetScore: 5 }), DEFAULT_TRUTH).find(q => q.id === 'q7_coasting')!
    expect(q7a.prompt).toBe(q7b.prompt)          // the stem alone does NOT move…
    expect(q7a.explanation).not.toBe(q7b.explanation)  // …but the explanation does
    expect(lockedKcQuestionIds(DEFAULT_CONFIG, DEFAULT_TRUTH).has('q7_coasting')).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// ORDER
// ═══════════════════════════════════════════════════════════════════════════════

describe('⚠ reorder', () => {
  it('moves a question within its stage', () => {
    const pre = questionsForStage(scorecardKcQuestions(DEFAULT_CONFIG, DEFAULT_TRUTH), 'pre')
    const reversed = Object.fromEntries(pre.map((q, i) => [q.id, pre.length - i]))
    const c = cfg({ kcOrder: reversed })
    const got = questionsForStage(resolveKcQuestions(c, DEFAULT_TRUTH), 'pre').map(q => q.id)
    expect(got).toEqual([...pre.map(q => q.id)].reverse())
  })

  it('⚠⚠ CANNOT move a post-play question in front of play', () => {
    // MUTANT CAUGHT: sorting the whole set by `order` instead of sorting within each
    // stage. The pre/post split is the measurement instrument (spec §9) — an `order` map
    // that could hoist Q8 ("the bonus is already out of reach") in front of play would
    // hand over §4.1's inference, which is the entire thing the game measures.
    const c = cfg({ kcOrder: { q8_written_off: -999, q1_negotiated_ppm: 999 } })
    const resolved = resolveKcQuestions(c, DEFAULT_TRUTH)
    const stages = resolved.map(q => q.stage)
    expect(stages.indexOf('post')).toBeGreaterThan(stages.lastIndexOf('pre'))
    expect(questionsForStage(resolved, 'pre').map(q => q.id)).not.toContain('q8_written_off')
  })

  it('a PARTIAL order map drops nothing and duplicates nothing', () => {
    // MUTANT CAUGHT: `.filter(id => id in order)` — an ordering that silently deletes
    // every question the map does not mention.
    //
    // ⚠ THE PARTIAL CASE DELIBERATELY CHANGES AS LITTLE AS POSSIBLE. An id with no entry
    // sorts on its AUTHORED index, so a map mentioning one question does not hoist it past
    // questions whose authored index already ties with its number. That is a migration and
    // hand-edit safeguard, not the normal path — the settings page writes a COMPLETE map
    // for a stage whenever anything moves (see the test below). The alternative rules
    // (unmentioned ids last, or explicit ids first) both scramble a stored map written by
    // an older build, which is the case this has to survive.
    const c = cfg({ kcOrder: { q4_comfortably_green: 0 } })
    const resolved = resolveKcQuestions(c, DEFAULT_TRUTH)
    expect(resolved).toHaveLength(scorecardKcQuestions(DEFAULT_CONFIG, DEFAULT_TRUTH).length)
    expect(new Set(resolved.map(q => q.id)).size).toBe(resolved.length)
    // Nothing lost from either stage, and the stages stay separated.
    expect(questionsForStage(resolved, 'pre')).toHaveLength(6)
    expect(questionsForStage(resolved, 'post')).toHaveLength(4)
  })

  it('a COMPLETE map — what the settings page writes — orders exactly', () => {
    const pre = questionsForStage(scorecardKcQuestions(DEFAULT_CONFIG, DEFAULT_TRUTH), 'pre')
    const wanted = ['q4_comfortably_green', ...pre.map(q => q.id).filter(id => id !== 'q4_comfortably_green')]
    const c = cfg({ kcOrder: Object.fromEntries(wanted.map((id, i) => [id, i])) })
    expect(questionsForStage(resolveKcQuestions(c, DEFAULT_TRUTH), 'pre').map(q => q.id))
      .toEqual(wanted)
  })

  it('applyKcOrder is stable on ties', () => {
    const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
    expect(applyKcOrder(items, x => x.id, { a: 1, b: 1, c: 1 }).map(x => x.id)).toEqual(['a', 'b', 'c'])
  })

  it('orders ADDED questions too, within their stage', () => {
    const c = cfg({
      addedKcQuestions: [addedMc('akc_1'), addedMc('akc_2'), addedMc('akc_3')],
      kcOrder: { akc_1: 3, akc_2: 2, akc_3: 1 },
    })
    expect(resolveAddedKcQuestions(c, 'post').map(q => q.id)).toEqual(['akc_3', 'akc_2', 'akc_1'])
  })

  it('⚠ survives a save/reload round trip through the stored shape', () => {
    // MUTANT CAUGHT: dropping `order` on write — a parser that returns {} for a stored map,
    // or a writer that never sets `kc_order`. Round-tripped through the loader's own
    // parser, which is what a reload actually goes through.
    const pre = questionsForStage(scorecardKcQuestions(DEFAULT_CONFIG, DEFAULT_TRUTH), 'pre')
    const wanted = [...pre.map(q => q.id)].reverse()
    const written = Object.fromEntries(wanted.map((id, i) => [id, i]))

    const reloaded = parseKcOrder(JSON.parse(JSON.stringify(written)))
    expect(reloaded).toEqual(written)
    expect(questionsForStage(resolveKcQuestions(cfg({ kcOrder: reloaded }), DEFAULT_TRUTH), 'pre')
      .map(q => q.id)).toEqual(wanted)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// ADDED QUESTIONS — the id guard and the stage
// ═══════════════════════════════════════════════════════════════════════════════

describe('⚠⚠ an added question cannot take a built-in id', () => {
  it('SCORECARD_KC_ID_GUARD is the id SET, and it refuses every one of the ten', () => {
    // MUTANT CAUGHT: switching scorecard to a `kc_` PREFIX rule. Scorecard's ids are
    // unprefixed, so a prefix rule lets `q5_earnings_arithmetic` straight through — and
    // the grader looks built-ins up FIRST, so the instructor's key would be shadowed and
    // students marked against the built-in answer.
    //
    // ⚠ Asserted against the guard the CALLABLE actually passes (`instructorConfig`
    // imports this very constant), not against one the test builds for itself — otherwise
    // the mutant lives in the callable where no unit test can see it.
    expect(SCORECARD_KC_ID_GUARD.kind).toBe('idSet')
    expect(BUILT_IN_KC_IDS.size).toBe(10)

    for (const id of BUILT_IN_KC_IDS) {
      expect(parseShared({ id, type: 'text', prompt: 'mine' }, { guard: SCORECARD_KC_ID_GUARD }),
        `${id} must be refused`).toBeNull()
      // …and the prefix rule the other five use would NOT have caught it.
      expect(id.startsWith('kc_'), `${id} is unprefixed`).toBe(false)
      expect(parseShared({ id, type: 'text', prompt: 'mine' },
        { guard: { kind: 'prefix', prefix: 'kc_' } }),
      `a prefix rule would wrongly ACCEPT ${id}`).not.toBeNull()
    }
  })

  it('an instructor-minted akc_ id passes the same guard', () => {
    expect(parseShared({ id: 'akc_mine', type: 'text', prompt: 'x' },
      { guard: SCORECARD_KC_ID_GUARD })).not.toBeNull()
  })

  it('⚠ …while the PREFIX guard still works, because five other games need it', () => {
    // MUTANT CAUGHT: replacing the shared parser's pluggable guard with the id-set alone,
    // which would silently unprotect pd/pricing/newsvendor/forecast when they adopt this.
    expect(parseShared({ id: 'kc_underage', type: 'text', prompt: 'x' },
      { guard: { kind: 'prefix', prefix: 'kc_' } })).toBeNull()
    expect(parseShared({ id: 'akc_mine', type: 'text', prompt: 'x' },
      { guard: { kind: 'prefix', prefix: 'kc_' } })).not.toBeNull()
  })

  it('an unguarded parse still accepts anything — the read path must not drop stored data', () => {
    // The loader parses ALREADY-VALIDATED stored questions with no guard. A guard there
    // would silently delete a question an older build had legitimately stored.
    expect(parseAddedKcQuestion({ id: 'q5_earnings_arithmetic', type: 'text', prompt: 'x' }))
      .not.toBeNull()
  })
})

describe('⚠ the stage pin is reversed (D13), without moving anything already stored', () => {
  it('an added question with no stage is still `post` — nothing stored moves', () => {
    expect(addedKcStage(addedMc('akc_old'))).toBe('post')
    expect(resolveAddedKcQuestions(cfg({ addedKcQuestions: [addedMc('akc_old')] }), 'post'))
      .toHaveLength(1)
    expect(resolveAddedKcQuestions(cfg({ addedKcQuestions: [addedMc('akc_old')] }), 'pre'))
      .toHaveLength(0)
  })

  it('an instructor may choose `pre`, and it is served there', () => {
    const c = cfg({ addedKcQuestions: [addedMc('akc_new', { stage: 'pre' })] })
    expect(resolveAddedKcQuestions(c, 'pre').map(q => q.id)).toEqual(['akc_new'])
    expect(resolveAddedKcQuestions(c, 'post')).toHaveLength(0)
    expect(addedToClientKcQuestions(resolveAddedKcQuestions(c, 'pre'), 'stu-1')[0].stage).toBe('pre')
  })

  it('⚠ an unrecognised stage is DROPPED, not stored — it falls back to `post`', () => {
    const q = parseAddedKcQuestion({ id: 'akc_x', type: 'text', prompt: 'x', stage: 'debrief' })!
    expect(q.stage).toBeUndefined()
    expect(addedKcStage(q)).toBe('post')
  })

  it('a chosen stage survives the parser', () => {
    expect(parseAddedKcQuestion({ id: 'akc_y', type: 'text', prompt: 'y', stage: 'pre' })!.stage)
      .toBe('pre')
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// THE PARSERS
// ═══════════════════════════════════════════════════════════════════════════════

describe('the three fields are total on absent, and default to current behaviour', () => {
  it('an instance written before they existed reads as no hides, authored order, no rewrites', () => {
    expect(parseKcHidden(undefined)).toEqual({})
    expect(parseKcOrder(undefined)).toEqual({})
    expect(parseKcOverrides(undefined)).toEqual({})
    expect(resolveKcQuestions(cfg(), DEFAULT_TRUTH))
      .toEqual(scorecardKcQuestions(DEFAULT_CONFIG, DEFAULT_TRUTH))
  })

  it('⚠ only `true` is kept in the hidden map — a stale `false` is not an assertion', () => {
    expect(parseKcHidden({ a: true, b: false, c: 'yes', d: 1 })).toEqual({ a: true })
  })

  it('an override that overrides nothing is dropped, so no row shows a false "edited" badge', () => {
    expect(parseKcOverrides({ q1: { prompt: '   ' } })).toEqual({})
    expect(parseKcOverrides({ q1: { options: {} } })).toEqual({})
    expect(parseKcOverrides({ q1: {} })).toEqual({})
  })

  it('visibleKcIds is the shared filter both paths are meant to use', () => {
    expect(visibleKcIds(['a', 'b', 'c'], { b: true })).toEqual(['a', 'c'])
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// D12 ALIGNMENT WITH PD — the toggle gates GRADED questions only.
//
// ⚠ Scorecard used to gate ALL additions on `kcEnabled`, and pd did not. pd was right
// (D12 is explicit), so scorecard moved. This block pins the aligned rule and the two
// things that had to move with it.
// ═══════════════════════════════════════════════════════════════════════════════

describe('⚠⚠ D12 — kcEnabled gates GRADED questions only (aligned to pd)', () => {
  it('off removes the built-in ten and any GRADED addition', () => {
    const c = cfg({ kcEnabled: false, addedKcQuestions: [addedMc('akc_graded')] })
    expect(resolveKcQuestions(c, DEFAULT_TRUTH)).toHaveLength(0)
    expect(resolveAddedKcQuestions(c).map(q => q.id)).not.toContain('akc_graded')
    expect(kcScoringSet(c, DEFAULT_TRUTH)).toHaveLength(0)
  })

  it('⚠ …and LEAVES an ungraded free-text addition, which has its own visibility', () => {
    // MUTANT CAUGHT: the toggle gating EVERY addition — scorecard's old behaviour, and the
    // thing this alignment removes.
    const c = cfg({ kcEnabled: false, addedKcQuestions: [addedText('akc_free')] })
    expect(resolveAddedKcQuestions(c).map(q => q.id)).toEqual(['akc_free'])
    expect(kcScoringSet(c, DEFAULT_TRUTH)).toHaveLength(0)
  })

  it('…and its own hidden flag still removes it', () => {
    const c = cfg({
      kcEnabled: false,
      addedKcQuestions: [addedText('akc_free')],
      kcHidden: { akc_free: true },
    })
    expect(resolveAddedKcQuestions(c)).toHaveLength(0)
  })

  it('⚠⚠ the GRADER agrees with the serve path when the toggle is off', () => {
    // MUTANT CAUGHT: leaving the `kcEnabled` gate in `getQuestions` alone, as it was. The
    // grader's `kcScoringSet` calls `resolveKcQuestions` directly, so with the gate in the
    // caller only, an instance with the KC OFF served ZERO questions while the denominator
    // still counted all TEN. The blanket `if (!kcEnabled) throw` in submitKcAnswer hid it;
    // removing that gate for D12 would have exposed it.
    const c = cfg({ kcEnabled: false })
    expect(resolveKcQuestions(c, DEFAULT_TRUTH)).toHaveLength(0)
    expect(kcScoringSet(c, DEFAULT_TRUTH)).toHaveLength(0)
    // …and with it ON, both are the full set again.
    expect(kcScoringSet(cfg(), DEFAULT_TRUTH)).toHaveLength(10)
  })
})
