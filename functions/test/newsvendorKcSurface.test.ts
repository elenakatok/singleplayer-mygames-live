import { describe, it, expect } from 'vitest'
import { kcScoreOrNull, calcKCScore } from '@mygames/game-server'
import {
  resolveNewsvendorKc, resolveAddedKcQuestions, newsvendorKcScoringSet,
  applyKcOverride, isGradedAdded, authoredToClient, addedToClientKcQuestions,
  newsvendorPreStage, newsvendorPostStage, stageToClient,
  NEWSVENDOR_BUILT_IN_KC_IDS, PREP_ROW_ID, DEBRIEF_ROW_ID,
} from '../src/newsvendor/questions'
import {
  DEFAULT_NEWSVENDOR_CONFIG, parseAddedKcQuestion, NEWSVENDOR_KC_ID_GUARD,
  DEFAULT_ADDED_KC_STAGE, addedKcStage, NEWSVENDOR_KC_STAGES,
  type NewsvendorConfig, type NewsvendorAddedKcQuestion,
} from '../src/newsvendor/config'
import {
  lockedKcQuestionIds, probeDetector, validateKcOverrides, KC_LOCK_REASON,
} from '../src/newsvendor/kcLock'
import {
  parseAddedKcQuestion as parseShared, parseKcHidden, parseKcOrder, parseKcOverrides,
} from '../src/shared/kcSurface'

// ═══════════════════════════════════════════════════════════════════════════════
// NEWSVENDOR — the shared KC surface (convergence spec §5, §7). Fourth adopter.
//
// ⚠⚠ THIS IS THE FIRST GAME WHERE NOTHING IS LOCKED. All twenty built-ins are literal
// strings, so the Edit control does real work here for the first time — which makes the
// override tests the centre of this file rather than a formality.
//
// Every test names the mutant it catches. All were calibrated by breaking the code.
// ═══════════════════════════════════════════════════════════════════════════════

const cfg = (over: Partial<NewsvendorConfig> = {}): NewsvendorConfig =>
  ({ ...DEFAULT_NEWSVENDOR_CONFIG, ...over })
const dualCfg = (over: Partial<NewsvendorConfig> = {}) => cfg({ dual: true, ...over })

const REGULAR_IDS = [
  'kc_cr_concept', 'kc_underage', 'kc_overage', 'kc_critical_ratio', 'kc_direction',
  'kc_qstar', 'kc_profit_leftover', 'kc_profit_shortage', 'kc_salvage_rises', 'kc_variability',
]
const DUAL_IDS = [
  'kc_dual_second_source', 'kc_dual_underage', 'kc_dual_price_drops_out', 'kc_dual_overage',
  'kc_dual_critical_ratio', 'kc_dual_qstar', 'kc_dual_premium_rises', 'kc_dual_profit_topup',
  'kc_dual_profit_leftover', 'kc_dual_vs_single',
]

const addedMc = (id: string, over: Partial<NewsvendorAddedKcQuestion> = {}): NewsvendorAddedKcQuestion => ({
  id, type: 'mc', prompt: `Added ${id}?`,
  options: [
    { value: 'o0', label: 'First' }, { value: 'o1', label: 'Second' },
    { value: 'o2', label: 'Third' }, { value: 'o3', label: 'Fourth' },
  ],
  correct_value: 'o0',
  ...over,
})
const addedText = (id: string, over: Partial<NewsvendorAddedKcQuestion> = {}): NewsvendorAddedKcQuestion => ({
  id, type: 'text', prompt: `Tell me about ${id}`, ...over,
})
const postMc = (id: string) => addedMc(id, { stage: 'post' })
const postText = (id: string) => addedText(id, { stage: 'post' })

// ═══════════════════════════════════════════════════════════════════════════════
// HIDDEN — the two places that must agree
// ═══════════════════════════════════════════════════════════════════════════════

describe('⚠⚠ a hidden question leaves BOTH the display and the denominator', () => {
  it('is not served', () => {
    // MUTANT CAUGHT: dropping the hide from `resolveNewsvendorKc`.
    const c = cfg({ kcHidden: { kc_overage: true } })
    const ids = resolveNewsvendorKc(c).map(q => q.field)
    expect(ids).not.toContain('kc_overage')
    expect(ids).toHaveLength(9)
  })

  it('⚠⚠ AND THE GRADER\'S SCORING SET DROPS IT TOO — not just the display', () => {
    // MUTANT CAUGHT: filtering the display only and leaving `forScoring` intact — spec §5's
    // named worst case. `newsvendorKcScoringSet` is what `newsvendorSubmitKcAnswer` calls.
    const c = cfg({
      kcHidden: { kc_overage: true, akc_hidden: true },
      addedKcQuestions: [addedMc('akc_kept'), addedMc('akc_hidden')],
    })
    const served = [
      ...resolveNewsvendorKc(c).map(q => q.field),
      ...resolveAddedKcQuestions(c).filter(isGradedAdded).map(q => q.id),
    ].sort()
    const graded = newsvendorKcScoringSet(c).map(x => x.field).sort()

    expect(graded).toEqual(served)
    expect(graded).not.toContain('kc_overage')
    expect(graded).not.toContain('akc_hidden')
    expect(graded).toContain('akc_kept')
    expect(graded).toHaveLength(10)   // 10 authored − 1 hidden + 1 visible addition
  })

  it('⚠ the scoring set carries the RIGHT KEY for every question it names', () => {
    // MUTANT CAUGHT: an off-by-one zip of ids against keys, which a length check misses.
    const authored = resolveNewsvendorKc(cfg())
    for (const x of newsvendorKcScoringSet(cfg())) {
      expect(x.correct_value, x.field).toBe(authored.find(q => q.field === x.field)!.correct_value)
    }
  })

  it('hiding every graded question leaves an EMPTY scoring set', () => {
    const c = cfg({ kcHidden: Object.fromEntries(REGULAR_IDS.map(id => [id, true])) })
    expect(newsvendorKcScoringSet(c)).toHaveLength(0)
  })

  it('⚠ a hidden question is gone from the SERVE path too, not just the resolver', () => {
    const c = cfg({ kcHidden: { kc_overage: true } })
    expect(authoredToClient(c, 'stu-1').map(q => q.field)).not.toContain('kc_overage')
    expect(newsvendorPreStage(c).map(r => r.field)).not.toContain('kc_overage')
  })
})

describe('⚠ zero visible graded questions ⇒ null, never 0 and never 1.0', () => {
  const nothingGraded = () => cfg({
    kcHidden: Object.fromEntries(REGULAR_IDS.map(id => [id, true])),
    addedKcQuestions: [addedText('akc_free')],
  })

  it('⚠⚠ the stored score is null', () => {
    // MUTANT CAUGHT: bare `calcKCScore(allAnswers, forScoring).score`, which is what
    // newsvendor did before this pass. The shared helper answers the EMPTY set with 1.0, so
    // a student who answered only an ungraded free-text addition would be recorded at a
    // PERFECT knowledge-check score and have it pushed to the gradebook by scoreAndRecord.
    const forScoring = newsvendorKcScoringSet(nothingGraded())
    expect(forScoring).toHaveLength(0)
    expect(kcScoreOrNull({ akc_free: 'x' }, forScoring)).toBeNull()
    expect(calcKCScore({ akc_free: 'x' }, forScoring).score).toBe(1.0)
  })

  it('…while a NON-empty set still scores normally', () => {
    const forScoring = newsvendorKcScoringSet(cfg())
    const allRight = Object.fromEntries(forScoring.map(x => [x.field, x.correct_value]))
    expect(kcScoreOrNull(allRight, forScoring)).toBe(1)
    expect(kcScoreOrNull(Object.fromEntries(forScoring.map(x => [x.field, '__no__'])), forScoring)).toBe(0)
  })

  it('a half-right set scores over the VISIBLE denominator', () => {
    const c = cfg({ kcHidden: Object.fromEntries(REGULAR_IDS.slice(0, 6).map(id => [id, true])) })
    const forScoring = newsvendorKcScoringSet(c)
    expect(forScoring).toHaveLength(4)
    const answers = Object.fromEntries(forScoring.map((x, i) => [x.field, i < 2 ? x.correct_value : '__no__']))
    expect(kcScoreOrNull(answers, forScoring)).toBe(0.5)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// THE LOCK DETECTOR — and the proof it still works when it locks nothing
// ═══════════════════════════════════════════════════════════════════════════════

describe('⚠⚠ NOTHING is locked — and the detector is proven to still fire', () => {
  it('all twenty are editable, in BOTH modes', () => {
    // ⚠ SPEC §3 PREDICTED "none locked / all 20 editable". CONFIRMED. Every stem, option
    // label and explanation is a literal string: the teaching market's numbers are baked in
    // as text on purpose, so nothing moves when the instance moves.
    expect(lockedKcQuestionIds(cfg()).size).toBe(0)
    expect(lockedKcQuestionIds(dualCfg()).size).toBe(0)
    expect(resolveNewsvendorKc(cfg()).map(q => q.field).sort()).toEqual([...REGULAR_IDS].sort())
    expect(resolveNewsvendorKc(dualCfg()).map(q => q.field).sort()).toEqual([...DUAL_IDS].sort())
  })

  it('⚠⚠ THE DETECTOR STILL WORKS — it locks a deliberately parameterised probe', () => {
    // MUTANT CAUGHT: a detector that always returns "editable" — by comparing nothing, by
    // perturbing nothing, or by comparing an object to itself. In every other game a real
    // question locks and proves the machinery live; here NOTHING does, so "0 of 20" is
    // indistinguishable from a broken detector unless this test exists.
    //
    // `probeDetector` runs the IDENTICAL comparison over a builder we control, so it cannot
    // drift from the real one.
    const probe = (c: NewsvendorConfig) => ([
      { field: 'p_static', prompt: 'Static.', options: [{ value: 'a', label: 'A' }], explanation: 'Static.' },
      { field: 'p_stem', prompt: `P is ${c.P}.`, options: [{ value: 'a', label: 'A' }], explanation: 'Static.' },
      { field: 'p_option', prompt: 'Static.', options: [{ value: 'a', label: `${c.mean}` }], explanation: 'Static.' },
      { field: 'p_expl', prompt: 'Static.', options: [{ value: 'a', label: 'A' }], explanation: `sd is ${c.sd}.` },
    ])
    const locked = probeDetector(DEFAULT_NEWSVENDOR_CONFIG, probe)

    // ⚠ ALL THREE SURFACES, separately — a detector that only checked stems would pass a
    // stem-only probe and still be wrong (spec §3: Q7 is locked by its explanation alone,
    // Q9 by its options alone).
    expect([...locked].sort()).toEqual(['p_expl', 'p_option', 'p_stem'])
    expect(locked.has('p_static')).toBe(false)
  })

  it('⚠ and it is not merely locking everything — the static probe stays editable', () => {
    const allStatic = () => ([
      { field: 'a', prompt: 'x', options: [{ value: 'a', label: 'A' }], explanation: 'y' },
      { field: 'b', prompt: 'x', options: [{ value: 'a', label: 'A' }], explanation: 'y' },
    ])
    expect(probeDetector(DEFAULT_NEWSVENDOR_CONFIG, allStatic).size).toBe(0)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// OVERRIDES — the point of this pass
// ═══════════════════════════════════════════════════════════════════════════════

describe('⚠⚠ an override changes DISPLAY TEXT and CANNOT change a score', () => {
  const original = (dual = false) =>
    resolveNewsvendorKc(dual ? dualCfg() : cfg()).find(q => q.field === (dual ? DUAL_IDS[1] : 'kc_underage'))!

  it('replaces the prompt and leaves the key, option values and count alone', () => {
    // MUTANT CAUGHT: an override that replaces the whole question object, or stores
    // `options` as a LIST rather than a map from existing value to label.
    for (const dual of [false, true]) {
      const o = original(dual)
      const got = applyKcOverride(o, { [o.field]: { prompt: 'MY OWN STEM' } })
      expect(got.prompt).toBe('MY OWN STEM')
      expect(got.correct_value).toBe(o.correct_value)
      expect(got.options.map(x => x.value)).toEqual(o.options.map(x => x.value))
      expect(got.options.map(x => x.label)).toEqual(o.options.map(x => x.label))
      expect(got.explanation).toBe(o.explanation)
    }
  })

  it('⚠⚠ AN OVERRIDE PROVABLY CANNOT MOVE A SCORE — asserted directly, both modes', () => {
    // MUTANT CAUGHT: letting overrides reach `correct_value` (e.g. spreading the entry onto
    // the question, or rebuilding options from the map so a relabelled option gets a new
    // value). Grading compares VALUES; if an override could touch one, an instructor
    // rewording a distractor would silently re-mark every student.
    for (const [c, ids] of [[cfg(), REGULAR_IDS], [dualCfg(), DUAL_IDS]] as const) {
      const before = newsvendorKcScoringSet(c)
      // Rewrite EVERY question's prompt and EVERY option label.
      const overrides = Object.fromEntries(
        resolveNewsvendorKc(c).map(q => [
          q.field,
          {
            prompt: `REWRITTEN ${q.field}`,
            options: Object.fromEntries(q.options.map(o => [o.value, `RELABELLED ${o.value}`])),
          },
        ]),
      )
      const after = newsvendorKcScoringSet({ ...c, kcOverrides: overrides })

      expect(after).toEqual(before)                       // the scoring set is byte-identical
      expect(after.map(x => x.field).sort()).toEqual([...ids].sort())
      // …and the served text really did change, so this is not vacuous.
      expect(resolveNewsvendorKc({ ...c, kcOverrides: overrides })[0].prompt).toMatch(/^REWRITTEN /)
    }
  })

  it('replaces an option LABEL by value; unknown values are ignored, never appended', () => {
    const o = original()
    const got = applyKcOverride(o, {
      [o.field]: { options: { [o.options[1].value]: 'RENAMED', zzz: 'GHOST' } },
    })
    expect(got.options).toHaveLength(o.options.length)
    expect(got.options.map(x => x.value)).toEqual(o.options.map(x => x.value))
    expect(got.options[1].label).toBe('RENAMED')
    expect(JSON.stringify(got)).not.toContain('GHOST')
    expect(got.correct_value).toBe(o.correct_value)
  })

  it('a built-in with NO override serves its generated text, unchanged', () => {
    // MUTANT CAUGHT: always reading the override map — an unconditional
    // `{...q, ...overrides[q.field]}` blanks every un-overridden prompt.
    const authored = resolveNewsvendorKc(cfg())
    const resolved = resolveNewsvendorKc(cfg({ kcOverrides: { kc_underage: { prompt: 'X' } } }))
    for (const a of authored) {
      if (a.field === 'kc_underage') continue
      expect(resolved.find(x => x.field === a.field)!.prompt, a.field).toBe(a.prompt)
    }
    expect(resolveNewsvendorKc(cfg())).toEqual(authored)
  })

  it('applyKcOverride returns the SAME OBJECT when there is no entry', () => {
    const o = original()
    expect(applyKcOverride(o, {})).toBe(o)
  })

  it('⚠ the override reaches the STUDENT through the serve path', () => {
    const c = cfg({ kcOverrides: { kc_underage: { prompt: 'MY OWN STEM' } } })
    expect(authoredToClient(c, 'stu-1').find(q => q.field === 'kc_underage')!.prompt)
      .toBe('MY OWN STEM')
    expect(newsvendorPreStage(c).find(r => r.field === 'kc_underage')!.prompt).toBe('MY OWN STEM')
  })
})

describe('⚠ the override validator, at the callable', () => {
  const ctx = (dual = false) => {
    const c = dual ? dualCfg() : cfg()
    const qs = resolveNewsvendorKc(c)
    return {
      builtInIds: NEWSVENDOR_BUILT_IN_KC_IDS,
      locked: lockedKcQuestionIds(c),
      optionIds: new Map(qs.map(q => [q.field, new Set(q.options.map(o => o.value))])),
    }
  }

  it('accepts an override on any built-in — nothing here is locked', () => {
    for (const id of REGULAR_IDS) {
      expect(validateKcOverrides({ [id]: { prompt: 'mine' } }, ctx()), id).toEqual([])
    }
  })

  it('⚠ but STILL REFUSES a locked one — the mechanism is live for the day one appears', () => {
    // MUTANT CAUGHT: a UI-only guard. Newsvendor locks nothing today, so this is checked
    // with an injected locked set — the branch must exist and fire, or the first question
    // that ever gains a parameter would be silently editable.
    const bad = validateKcOverrides(
      { kc_underage: { prompt: 'mine' } },
      { ...ctx(), locked: new Set(['kc_underage']) },
    )
    expect(bad[0]?.reason).toBe('locked')
    expect(bad[0]?.message).toContain(KC_LOCK_REASON.toLowerCase())
  })

  it('refuses an override aimed at an ADDED question, or at either PARAGRAPH row', () => {
    expect(validateKcOverrides({ akc_mine: { prompt: 'x' } }, ctx())[0].reason).toBe('not-built-in')
    expect(validateKcOverrides({ [PREP_ROW_ID]: { prompt: 'x' } }, ctx())[0].reason).toBe('not-built-in')
    expect(validateKcOverrides({ [DEBRIEF_ROW_ID]: { prompt: 'x' } }, ctx())[0].reason).toBe('not-built-in')
  })

  it('⚠ refuses an option value that names no offered option — not ignores it', () => {
    expect(validateKcOverrides({ kc_underage: { options: { nope: 'x' } } }, ctx())[0].reason)
      .toBe('unknown-option')
  })

  it('⚠⚠ CARRIES an override for the OTHER mode\'s question rather than refusing it', () => {
    // MUTANT CAUGHT: validating option ids against the current mode only and rejecting the
    // rest. The settings page round-trips the whole map on every save, so refusing would
    // make the page unsaveable the moment somebody flipped the dual toggle — with the
    // instructor's own earlier work as the cause. Pricing hit the identical case.
    expect(validateKcOverrides({ kc_dual_underage: { options: { anything: 'x' } } }, ctx(false)))
      .toEqual([])
    expect(validateKcOverrides({ kc_underage: { options: { anything: 'x' } } }, ctx(true)))
      .toEqual([])
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// THE MODE SWAP
// ═══════════════════════════════════════════════════════════════════════════════

describe('⚠⚠ the mode swap: two sets of ten, one boolean, no cross-talk', () => {
  it('⚠ the two sets share NO ids — VERIFIED, not assumed (spec §6)', () => {
    const reg = resolveNewsvendorKc(cfg()).map(q => q.field)
    const dual = resolveNewsvendorKc(dualCfg()).map(q => q.field)
    expect(reg).toHaveLength(10)
    expect(dual).toHaveLength(10)
    expect(reg.filter(id => dual.includes(id))).toEqual([])
    expect(NEWSVENDOR_BUILT_IN_KC_IDS.size).toBe(20)
    // …and every dual id is distinguishable by construction, which is WHY they are disjoint.
    expect(dual.every(id => id.startsWith('kc_dual_'))).toBe(true)
    expect(reg.every(id => !id.startsWith('kc_dual_'))).toBe(true)
  })

  it('⚠⚠ an edit made in REGULAR is not applied in DUAL, and survives the round trip', () => {
    // MUTANT CAUGHT: one shared map keyed by POSITION rather than id, which would apply the
    // first regular question's edit to the first dual one.
    const edits: Partial<NewsvendorConfig> = {
      kcHidden: { kc_overage: true },
      kcOverrides: { kc_underage: { prompt: 'MY REGULAR STEM' } },
      kcOrder: { kc_underage: 0, kc_cr_concept: 1 },
    }

    const reg = resolveNewsvendorKc(cfg(edits))
    expect(reg.map(q => q.field)).not.toContain('kc_overage')
    expect(reg.find(q => q.field === 'kc_underage')!.prompt).toBe('MY REGULAR STEM')
    expect(reg[0].field).toBe('kc_underage')

    const dual = resolveNewsvendorKc(dualCfg(edits))
    expect(dual.map(q => q.field).sort()).toEqual([...DUAL_IDS].sort())
    expect(dual.every(q => q.prompt !== 'MY REGULAR STEM')).toBe(true)
    expect(dual).toHaveLength(10)

    expect(resolveNewsvendorKc(cfg(edits))).toEqual(reg)
  })

  it('⚠⚠ …and the other direction: an edit made in DUAL is not applied in REGULAR', () => {
    const edits: Partial<NewsvendorConfig> = {
      kcHidden: { kc_dual_qstar: true },
      kcOverrides: { kc_dual_underage: { prompt: 'MY DUAL STEM' } },
    }
    const dual = resolveNewsvendorKc(dualCfg(edits))
    expect(dual.map(q => q.field)).not.toContain('kc_dual_qstar')
    expect(dual.find(q => q.field === 'kc_dual_underage')!.prompt).toBe('MY DUAL STEM')

    const reg = resolveNewsvendorKc(cfg(edits))
    expect(reg.map(q => q.field).sort()).toEqual([...REGULAR_IDS].sort())
    expect(reg.every(q => q.prompt !== 'MY DUAL STEM')).toBe(true)

    expect(resolveNewsvendorKc(dualCfg(edits))).toEqual(dual)
  })

  it('⚠ the DENOMINATOR follows the mode', () => {
    expect(newsvendorKcScoringSet(cfg())).toHaveLength(10)
    expect(newsvendorKcScoringSet(dualCfg())).toHaveLength(10)
    expect(newsvendorKcScoringSet(cfg()).map(x => x.field).sort())
      .not.toEqual(newsvendorKcScoringSet(dualCfg()).map(x => x.field).sort())
  })

  it('⚠ ADDED questions are shared across modes — they are not market-derived', () => {
    const c = cfg({ addedKcQuestions: [addedMc('akc_a')] })
    expect(resolveAddedKcQuestions(c).map(q => q.id)).toEqual(['akc_a'])
    expect(resolveAddedKcQuestions({ ...c, dual: true }).map(q => q.id)).toEqual(['akc_a'])
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// STAGES, THE TWO PARAGRAPH ROWS, AND D12
// ═══════════════════════════════════════════════════════════════════════════════

describe('⚠⚠ where newsvendor\'s existing stored additions are served', () => {
  it('⚠⚠ DEFAULT_ADDED_KC_STAGE is `pre` — DETERMINED, not copied (D16)', () => {
    // MUTANT CAUGHT: adopting scorecard's 'post' default. `newsvendorGetQuestions` returns
    // added questions in `kc.added`, and Play.tsx built its pre-play list as
    // `[...kc.authored, ...kc.added]`, so every addition newsvendor has ever stored is
    // served BEFORE play. Defaulting to 'post' would relocate live questions.
    expect(DEFAULT_ADDED_KC_STAGE).toBe('pre')
    const legacy = addedMc('akc_legacy')
    expect(legacy.stage).toBeUndefined()
    expect(addedKcStage(legacy)).toBe('pre')

    const c = cfg({ addedKcQuestions: [legacy] })
    expect(addedToClientKcQuestions(c, 'stu-1', 'pre').map(q => q.field)).toEqual(['akc_legacy'])
    expect(newsvendorPostStage(c).map(r => r.field)).not.toContain('akc_legacy')
    expect(newsvendorPreStage(c).map(r => r.field)).toContain('akc_legacy')
  })

  it('an explicit stage is kept; an unrecognised one is dropped', () => {
    expect(parseAddedKcQuestion({ id: 'akc_a', type: 'text', prompt: 'x', stage: 'post' })!.stage).toBe('post')
    expect(parseAddedKcQuestion({ id: 'akc_b', type: 'text', prompt: 'x', stage: 'pre' })!.stage).toBe('pre')
    const bogus = parseAddedKcQuestion({ id: 'akc_c', type: 'text', prompt: 'x', stage: 'debrief' })!
    expect(bogus.stage).toBeUndefined()
    expect(addedKcStage(bogus)).toBe('pre')
    expect(NEWSVENDOR_KC_STAGES).toEqual(['pre', 'post'])
  })

  it('⚠ a post-stage addition is served AFTER the results, not before', () => {
    // MUTANT CAUGHT: dropping the stage filter — serving every addition before play.
    const c = cfg({ addedKcQuestions: [addedMc('akc_pre'), postMc('akc_post')] })
    expect(addedToClientKcQuestions(c, 'stu-1', 'pre').map(q => q.field)).toEqual(['akc_pre'])
    expect(newsvendorPostStage(c).map(r => r.field)).toContain('akc_post')
    expect(newsvendorPreStage(c).map(r => r.field)).not.toContain('akc_post')
  })

  it('⚠⚠ a graded POST-stage addition IS in the denominator — gradedness ignores the stage', () => {
    // MUTANT CAUGHT: grade by stage. ⚠ Spec §7: exercise the discriminating argument at
    // EVERY value — the other scoring-set tests all use PRE additions, so without this a
    // `resolveAddedKcQuestions(config, 'pre')` in the scoring set changes nothing observable.
    const c = cfg({ addedKcQuestions: [postMc('akc_after'), postText('akc_after_text')] })
    const ids = newsvendorKcScoringSet(c).map(x => x.field)
    expect(ids).toContain('akc_after')
    expect(ids).not.toContain('akc_after_text')
    expect(ids).toHaveLength(11)   // 10 authored + 1 graded post addition
  })
})

describe('⚠⚠ the two free-text rows', () => {
  it('the PREP row leads nothing and sits in `pre`; the DEBRIEF row sits in `post`', () => {
    const pre = newsvendorPreStage(cfg())
    const post = newsvendorPostStage(cfg())
    expect(pre.map(r => r.field)).toContain(PREP_ROW_ID)
    expect(pre[pre.length - 1].field).toBe(PREP_ROW_ID)   // appended after the authored ten
    expect(post.map(r => r.field)).toEqual([DEBRIEF_ROW_ID])
    expect(pre.find(r => r.field === PREP_ROW_ID)!.kind).toBe('free-text')
  })

  it('⚠⚠ NEITHER is ever graded — by absence of a key, not by stage or type', () => {
    // MUTANT CAUGHT: grade by type (both are `type: 'text'`), or grade by stage.
    const ids = newsvendorKcScoringSet(cfg()).map(x => x.field)
    expect(ids).not.toContain(PREP_ROW_ID)
    expect(ids).not.toContain(DEBRIEF_ROW_ID)
    // …under every configuration of their own visibility.
    for (const prepEnabled of [true, false]) {
      for (const debriefEnabled of [true, false]) {
        const s = newsvendorKcScoringSet(cfg({ prepEnabled, debriefEnabled })).map(x => x.field)
        expect(s).not.toContain(PREP_ROW_ID)
        expect(s).not.toContain(DEBRIEF_ROW_ID)
      }
    }
  })

  it('⚠⚠ EACH renders the INSTRUCTOR\'S prompt from its OWN existing key', () => {
    // MUTANT CAUGHT: reading the hardcoded literal on the data object, or routing either row
    // through `kcOverrides` — both would ignore every edit the instructor has made.
    // ⚠ NON-DEFAULT values, asserted to differ from the defaults: a test comparing against
    // the default is vacuous, because the default IS the literal a mutant would introduce.
    const prep = 'How will you decide how much to order?'
    const debrief = 'Looking back, what would you order differently?'
    expect(prep).not.toBe(DEFAULT_NEWSVENDOR_CONFIG.prepPrompt)
    expect(debrief).not.toBe(DEFAULT_NEWSVENDOR_CONFIG.debriefPrompt)

    const c = cfg({ prepPrompt: prep, debriefPrompt: debrief })
    expect(newsvendorPreStage(c).find(r => r.field === PREP_ROW_ID)!.prompt).toBe(prep)
    expect(newsvendorPostStage(c).find(r => r.field === DEBRIEF_ROW_ID)!.prompt).toBe(debrief)
    // …and the ids are unchanged, so no stored answer moves.
    expect(PREP_ROW_ID).toBe('prep_strategy')
    expect(DEBRIEF_ROW_ID).toBe('debrief_regular')
  })

  it('⚠ NEITHER is backed by the override map', () => {
    const c = cfg({
      kcOverrides: {
        [PREP_ROW_ID]: { prompt: 'FROM THE MAP' },
        [DEBRIEF_ROW_ID]: { prompt: 'FROM THE MAP' },
      },
    })
    expect(newsvendorPreStage(c).find(r => r.field === PREP_ROW_ID)!.prompt)
      .toBe(DEFAULT_NEWSVENDOR_CONFIG.prepPrompt)
    expect(newsvendorPostStage(c).find(r => r.field === DEBRIEF_ROW_ID)!.prompt)
      .toBe(DEFAULT_NEWSVENDOR_CONFIG.debriefPrompt)
  })

  it('hiding either removes ITS row and leaves everything else', () => {
    expect(newsvendorPreStage(cfg({ prepEnabled: false })).map(r => r.field))
      .not.toContain(PREP_ROW_ID)
    expect(newsvendorPreStage(cfg({ prepEnabled: false }))).toHaveLength(10)
    expect(newsvendorPostStage(cfg({ debriefEnabled: false }))).toEqual([])
  })

  it('⚠ the debrief default follows the MODE, and the row shows whichever is stored', () => {
    expect(newsvendorPostStage(cfg())[0].prompt).toBe(DEFAULT_NEWSVENDOR_CONFIG.debriefPrompt)
  })

  it('`order` reorders a stage ACROSS all kinds — with a COMPLETE map', () => {
    // ⚠ A COMPLETE MAP is what the settings page writes whenever anything moves, and it is
    // the only input for which exact positions are guaranteed. A PARTIAL map deliberately
    // "changes as little as possible": an id the map does not mention keeps its AUTHORED
    // index as its sort key, which can tie with an explicit small number. Asserting exact
    // positions from a partial map over-specifies the contract — the case below pins what
    // a partial map really promises.
    const c0 = cfg({ addedKcQuestions: [addedMc('akc_a')] })
    const authored = newsvendorPreStage(c0).map(r => r.field)
    const wanted = [PREP_ROW_ID, 'akc_a', ...authored.filter(f => f !== PREP_ROW_ID && f !== 'akc_a')]

    const c = cfg({
      addedKcQuestions: [addedMc('akc_a')],
      kcOrder: Object.fromEntries(wanted.map((id, i) => [id, i])),
    })
    expect(newsvendorPreStage(c).map(r => r.field)).toEqual(wanted)
  })

  it('⚠ a PARTIAL map drops nothing, duplicates nothing, and keeps both stages intact', () => {
    // MUTANT CAUGHT: `.filter(id => id in order)` — an ordering that silently deletes every
    // row the map does not mention.
    const c = cfg({
      addedKcQuestions: [addedMc('akc_a'), postMc('akc_p')],
      kcOrder: { [PREP_ROW_ID]: 0 },
    })
    const pre = newsvendorPreStage(c).map(r => r.field)
    const post = newsvendorPostStage(c).map(r => r.field)
    expect(pre).toHaveLength(12)                  // 10 authored + prep + 1 addition
    expect(new Set(pre).size).toBe(12)
    expect(post).toHaveLength(2)                  // debrief + 1 addition
    expect(new Set(post).size).toBe(2)
  })

  it('⚠⚠ `order` is applied EXACTLY ONCE — a PARTIAL map proves it', () => {
    // MUTANT CAUGHT: applying `order` inside the resolver AND again over the stage.
    //
    // ⚠ ONLY A PARTIAL MAP CATCHES THIS. A complete map is idempotent under double
    // application, so the round-trip and idempotence tests below both pass while the bug is
    // present — which is exactly how it survived first calibration. With a partial map the
    // second pass sorts against positions the FIRST pass produced, and because an
    // unmentioned id falls back to its CURRENT index, the result differs.
    //
    // Single pass: `prep_strategy` has key 0 and every unmentioned authored question keeps
    // its authored index, so the prep row leads. Double pass: the authored set is resorted
    // first, its indices shift, and `kc_underage` ends up in front instead.
    const c = cfg({
      addedKcQuestions: [addedMc('akc_a')],
      kcOrder: { [PREP_ROW_ID]: 0, akc_a: 1, kc_cr_concept: 2 },
    })
    expect(newsvendorPreStage(c)[0].field).toBe(PREP_ROW_ID)
  })

  it('⚠⚠ `order` is applied EXACTLY ONCE per stage', () => {
    // MUTANT CAUGHT: applying it inside the resolver AND again over the stage. The second
    // pass then sorts against positions the first produced, and because `applyKcOrder` falls
    // back to an item's CURRENT index for an unmentioned id, a partial map ends up in an
    // order neither pass intended. Pinned by the idempotence a single pass must have:
    // ordering a stage by the order it is already in must be a no-op.
    const c0 = cfg({ addedKcQuestions: [addedMc('akc_a')] })
    const once = newsvendorPreStage(c0).map(r => r.field)
    const c1 = cfg({
      addedKcQuestions: [addedMc('akc_a')],
      kcOrder: Object.fromEntries(once.map((id, i) => [id, i])),
    })
    expect(newsvendorPreStage(c1).map(r => r.field)).toEqual(once)
  })
})

describe('⚠ D12 — kcEnabled gates GRADED questions only', () => {
  it('off removes the mode\'s ten and any GRADED addition', () => {
    const c = cfg({ kcEnabled: false, addedKcQuestions: [addedMc('akc_graded')] })
    expect(resolveNewsvendorKc(c)).toHaveLength(0)
    expect(resolveAddedKcQuestions(c).map(q => q.id)).not.toContain('akc_graded')
    expect(newsvendorKcScoringSet(c)).toHaveLength(0)
  })

  it('⚠⚠ an mc addition whose KEY was dropped counts NOWHERE', () => {
    // MUTANT CAUGHT: grading by TYPE — `q.type === 'mc'` without the key check. A question
    // whose `correct_value` named no offered option has its key DROPPED at parse time; if
    // gradedness were type-based it would enter the denominator with no way to be right,
    // marking every student down by one.
    //
    // ⚠ THIS TEST WAS MISSING and the mutant survived first calibration because every other
    // added question in this file carries a valid key — spec §7's "exercise the
    // discriminating argument at every value", where the argument is the key's presence.
    const keyless = parseAddedKcQuestion({
      id: 'akc_badkey', type: 'mc', prompt: 'Which?',
      options: [{ value: 'x', label: 'X' }, { value: 'y', label: 'Y' }],
      correct_value: 'NOT_AN_OPTION',
    })!
    expect(keyless.type).toBe('mc')              // still an mc question…
    expect(keyless.correct_value).toBeUndefined() // …with no key
    expect(isGradedAdded(keyless)).toBe(false)

    const c = cfg({ addedKcQuestions: [addedMc('akc_g'), addedText('akc_t'), keyless] })
    expect(resolveAddedKcQuestions(c)).toHaveLength(3)   // all three are SERVED…
    const ids = newsvendorKcScoringSet(c).map(x => x.field)
    expect(ids).toContain('akc_g')                       // …one is graded
    expect(ids).not.toContain('akc_badkey')
    expect(ids).not.toContain('akc_t')
    expect(ids).toHaveLength(11)                         // 10 authored + 1
  })

  it('⚠ …and LEAVES both paragraphs AND an ungraded free-text addition', () => {
    // MUTANT CAUGHT: the toggle gating every addition, or the paragraphs.
    const c = cfg({ kcEnabled: false, addedKcQuestions: [addedText('akc_free'), postText('akc_post_free')] })
    expect(resolveAddedKcQuestions(c).map(q => q.id).sort()).toEqual(['akc_free', 'akc_post_free'])
    expect(newsvendorPreStage(c).map(r => r.field)).toContain(PREP_ROW_ID)
    expect(newsvendorPostStage(c).map(r => r.field)).toContain(DEBRIEF_ROW_ID)
    expect(newsvendorKcScoringSet(c)).toHaveLength(0)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// GUARD, ORDER, SHUFFLE, PARSERS
// ═══════════════════════════════════════════════════════════════════════════════

describe('⚠⚠ an added question cannot take a built-in id', () => {
  it('NEWSVENDOR_KC_ID_GUARD is the PREFIX rule, and it refuses every built-in id', () => {
    // MUTANT CAUGHT: swapping in scorecard's explicit id SET, which knows nothing about
    // `kc_underage` — every one of the twenty would sail through, and the grader looks
    // authored questions up FIRST, so the instructor's key would be shadowed.
    expect(NEWSVENDOR_KC_ID_GUARD.kind).toBe('prefix')
    for (const id of NEWSVENDOR_BUILT_IN_KC_IDS) {
      expect(id.startsWith('kc_'), `${id} is kc_-prefixed`).toBe(true)
      expect(parseShared({ id, type: 'text', prompt: 'x' }, { guard: NEWSVENDOR_KC_ID_GUARD }), id).toBeNull()
      expect(parseShared({ id, type: 'text', prompt: 'x' },
        { guard: { kind: 'idSet', ids: new Set(['q1_negotiated_ppm']) } }),
      `an idSet guard would wrongly ACCEPT ${id}`).not.toBeNull()
    }
  })

  it('⚠ the prefix reserves the NAMESPACE, not just the current occupants', () => {
    expect(parseAddedKcQuestion({ id: 'kc_future', type: 'text', prompt: 'x' })).toBeNull()
    expect(parseAddedKcQuestion({ id: 'akc_mine', type: 'text', prompt: 'x' })).not.toBeNull()
  })

  it('⚠⚠ BUT IT DOES NOT COVER THE TWO FREE-TEXT IDS — reported, not silently fixed', () => {
    // An added question CAN legally take `prep_strategy` or `debrief_regular`. It is
    // harmless TODAY only because free-text answers live in `free_text_answers` and KC
    // answers in `kc_static_answers`, so the two never meet — spec §6's "do not unify the
    // answer maps" is what keeps it harmless.
    //
    // ⚠ This test PINS the current state rather than asserting it is right. If the guard is
    // widened, this fails and forces the decision to be made explicitly.
    expect(parseAddedKcQuestion({ id: PREP_ROW_ID, type: 'text', prompt: 'x' })).not.toBeNull()
    expect(parseAddedKcQuestion({ id: DEBRIEF_ROW_ID, type: 'text', prompt: 'x' })).not.toBeNull()
    expect(PREP_ROW_ID.startsWith('kc_')).toBe(false)
    expect(DEBRIEF_ROW_ID.startsWith('kc_')).toBe(false)
  })
})

describe('⚠ reorder', () => {
  it('a COMPLETE map orders exactly, and survives a save/reload round trip', () => {
    // MUTANT CAUGHT: dropping `order` on write.
    const wanted = [...resolveNewsvendorKc(cfg()).map(q => q.field)].reverse()
    const written = Object.fromEntries(wanted.map((id, i) => [id, i]))
    const reloaded = parseKcOrder(JSON.parse(JSON.stringify(written)))
    expect(reloaded).toEqual(written)
    expect(resolveNewsvendorKc(cfg({ kcOrder: reloaded })).map(q => q.field)).toEqual(wanted)
  })

  it('a PARTIAL map drops nothing and duplicates nothing', () => {
    const got = resolveNewsvendorKc(cfg({ kcOrder: { kc_variability: 0 } }))
    expect(got).toHaveLength(10)
    expect(new Set(got.map(q => q.field)).size).toBe(10)
  })
})

describe('⚠⚠ added MC questions shuffle — through the SERVE path', () => {
  it('the answer reaches EVERY position, in BOTH stages', () => {
    // MUTANTS CAUGHT: (b) a two-slot swap, (c) not shuffling the added path, (d) not
    // shuffling the post path. ⚠ Tested through what the callable composes, not through
    // `shuffleClientOptions` — spec §7's "test the wiring, not the helper".
    // ⚠ "Not always first" alone would pass (b); this asserts every slot.
    const preC = cfg({ addedKcQuestions: [addedMc('akc_a')] })
    const prePos = new Set(Array.from({ length: 200 }, (_, i) =>
      addedToClientKcQuestions(preC, `stu-${i}`, 'pre')[0].options.findIndex(o => o.value === 'o0')))
    expect(prePos.size, 'pre stage').toBe(4)

    const postC = cfg({ addedKcQuestions: [postMc('akc_p')] })
    const postPos = new Set(Array.from({ length: 200 }, (_, i) =>
      stageToClient(newsvendorPostStage(postC), `stu-${i}`)
        .find(r => r.field === 'akc_p')!.options.findIndex(o => o.value === 'o0')))
    expect(postPos.size, 'post stage').toBe(4)
  })

  it('⚠ the AUTHORED set shuffles through the serve path too', () => {
    // MUTANT CAUGHT: the shuffle being lost when it moved out of the old resolver.
    const q = resolveNewsvendorKc(cfg())[1]
    const positions = new Set(Array.from({ length: 200 }, (_, i) =>
      authoredToClient(cfg(), `stu-${i}`)[1].options.findIndex(o => o.value === q.correct_value)))
    expect(positions.size).toBe(q.options.length)
  })

  it('two questions are permuted INDEPENDENTLY', () => {
    // MUTANT CAUGHT: (a) dropping the question id from the seed.
    const c = cfg({ addedKcQuestions: [addedMc('akc_a'), addedMc('akc_b')] })
    const same = Array.from({ length: 60 }, (_, i) => {
      const [a, b] = addedToClientKcQuestions(c, `stu-${i}`, 'pre')
      return a.options.findIndex(o => o.value === 'o0') === b.options.findIndex(o => o.value === 'o0')
    })
    expect(same.every(Boolean)).toBe(false)
  })

  it('deterministic per student, no option lost, and no key ever ships', () => {
    const c = cfg({ addedKcQuestions: [addedMc('akc_a')] })
    expect(addedToClientKcQuestions(c, 'stu-7', 'pre')).toEqual(addedToClientKcQuestions(c, 'stu-7', 'pre'))
    const opts = addedToClientKcQuestions(c, 'stu-7', 'pre')[0].options
    expect([...opts].sort((x, y) => x.value.localeCompare(y.value))).toEqual(addedMc('akc_a').options)
    expect(JSON.stringify(authoredToClient(cfg(), 'stu-1'))).not.toContain('correct_value')
    expect(JSON.stringify(stageToClient(newsvendorPreStage(cfg()), 'stu-1'))).not.toContain('correct_value')
  })

  it('⚠ a free-text row is never shuffled and ships no options', () => {
    const rows = stageToClient(newsvendorPreStage(cfg()), 'stu-1')
    expect(rows.find(r => r.field === PREP_ROW_ID)!.options).toEqual([])
  })
})

describe('the three fields are total on absent, and default to current behaviour', () => {
  it('an instance written before they existed reads as no hides, authored order, no rewrites', () => {
    expect(parseKcHidden(undefined)).toEqual({})
    expect(parseKcOrder(undefined)).toEqual({})
    expect(parseKcOverrides(undefined)).toEqual({})
    expect(resolveNewsvendorKc(cfg()).map(q => q.field)).toEqual(REGULAR_IDS)
  })

  it('⚠ only `true` is kept in the hidden map', () => {
    expect(parseKcHidden({ a: true, b: false, c: 'yes' })).toEqual({ a: true })
  })
})
