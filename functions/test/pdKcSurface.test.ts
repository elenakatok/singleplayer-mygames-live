import { describe, it, expect } from 'vitest'
import { kcScoreOrNull, calcKCScore } from '@mygames/game-server'
import {
  resolveKcQuestions, pdResolveKc, resolveAddedKcQuestions, pdKcScoringSet,
  applyKcOverride, isGradedAdded, shuffleClientOptions, addedToClientKcQuestions,
  pdPostStageQuestions, postStageToClient,
  PD_BUILT_IN_KC_IDS, PD_KC_STAGES,
} from '../src/pd/questions'
import {
  DEFAULT_PD_CONFIG, parseAddedKcQuestion, PD_KC_ID_GUARD,
  DEFAULT_ADDED_KC_STAGE, addedKcStage,
  type PdConfig, type PdAddedKcQuestion,
} from '../src/pd/config'
import { lockedKcQuestionIds, validateKcOverrides, KC_LOCK_REASON } from '../src/pd/kcLock'
import {
  parseAddedKcQuestion as parseShared, parseKcHidden, parseKcOrder, parseKcOverrides,
} from '../src/shared/kcSurface'

// ═══════════════════════════════════════════════════════════════════════════════
// PD — the shared KC surface (convergence spec §5, §7). Second adopter.
//
// ⚠⚠ EVERY TEST HERE WAS CALIBRATED BY BREAKING THE CODE AND WATCHING IT FAIL. The mutant
// each one catches is named in its own comment. The failure this file exists to prevent —
// a hidden question still sitting in the grader's scoring set — is silent, raises no error,
// and shows up only as every student's denominator being one too large.
// ═══════════════════════════════════════════════════════════════════════════════

const cfg = (over: Partial<PdConfig> = {}): PdConfig => ({ ...DEFAULT_PD_CONFIG, ...over })

const addedMc = (id: string, over: Partial<PdAddedKcQuestion> = {}): PdAddedKcQuestion => ({
  id, type: 'mc', prompt: `Added ${id}?`,
  options: [
    { value: 'o0', label: 'First' }, { value: 'o1', label: 'Second' },
    { value: 'o2', label: 'Third' }, { value: 'o3', label: 'Fourth' },
  ],
  correct_value: 'o0',
  ...over,
})

const addedText = (id: string, over: Partial<PdAddedKcQuestion> = {}): PdAddedKcQuestion => ({
  id, type: 'text', prompt: `Tell me about ${id}`, ...over,
})

// ═══════════════════════════════════════════════════════════════════════════════
// HIDDEN — the two places that must agree
// ═══════════════════════════════════════════════════════════════════════════════

describe('⚠⚠ a hidden question leaves BOTH the display and the denominator', () => {
  it('is not served', () => {
    // MUTANT CAUGHT: dropping the hide from `pdResolveKc` — the student sees all four
    // while the instructor's page shows three.
    const c = cfg({ kcHidden: { kc_cd: true } })
    const ids = pdResolveKc(c).map(q => q.field)
    expect(ids).not.toContain('kc_cd')
    expect(ids).toHaveLength(3)
  })

  it('⚠⚠ AND THE GRADER\'S SCORING SET DROPS IT TOO — not just the display', () => {
    // MUTANT CAUGHT: filtering the display only and leaving `forScoring` intact — spec §5's
    // named worst case. `pdKcScoringSet` is what `pdSubmitKcAnswer` actually calls, so
    // reverting it to `resolveKcQuestions(...)` fails HERE and not merely in the harness.
    const c = cfg({
      kcHidden: { kc_cd: true, akc_hidden: true },
      addedKcQuestions: [addedMc('akc_kept'), addedMc('akc_hidden')],
    })
    const served = [
      ...pdResolveKc(c).map(q => q.field),
      ...resolveAddedKcQuestions(c).filter(isGradedAdded).map(q => q.id),
    ].sort()
    const graded = pdKcScoringSet(c).map(x => x.field).sort()

    expect(graded).toEqual(served)
    expect(graded).not.toContain('kc_cd')
    expect(graded).not.toContain('akc_hidden')
    expect(graded).toContain('akc_kept')
    expect(graded).toHaveLength(4)   // 4 derived − 1 hidden + 1 visible addition
  })

  it('⚠ the scoring set carries the RIGHT KEY for every question it names', () => {
    // MUTANT CAUGHT: an off-by-one zip of ids against keys, which a length check misses.
    const derived = resolveKcQuestions(
      DEFAULT_PD_CONFIG.payoffs, DEFAULT_PD_CONFIG.unit, DEFAULT_PD_CONFIG.labels,
    )
    for (const x of pdKcScoringSet(cfg())) {
      expect(x.correct_value, x.field).toBe(derived.find(q => q.field === x.field)!.correct_value)
    }
  })

  it('hiding every graded question leaves an EMPTY scoring set, not a full one', () => {
    const c = cfg({ kcHidden: Object.fromEntries([...PD_BUILT_IN_KC_IDS].map(id => [id, true])) })
    expect(pdKcScoringSet(c)).toHaveLength(0)
  })
})

describe('⚠ zero visible graded questions ⇒ null, never 0 and never 1.0', () => {
  /** Every derived question hidden; one ungraded free-text addition left to answer. */
  const nothingGraded = () => cfg({
    kcHidden: Object.fromEntries([...PD_BUILT_IN_KC_IDS].map(id => [id, true])),
    addedKcQuestions: [addedText('akc_free')],
  })

  it('the scoring set really is empty in that configuration', () => {
    expect(pdKcScoringSet(nothingGraded())).toHaveLength(0)
  })

  it('⚠⚠ and the stored score is null', () => {
    // MUTANT CAUGHT: calling bare `calcKCScore(allAnswers, forScoring).score`, which is
    // what pd did before this pass. The shared helper answers the EMPTY set with 1.0, so a
    // student who answered only an ungraded free-text addition would be recorded at a
    // PERFECT knowledge-check score and have it pushed to the gradebook by scoreAndRecord.
    const forScoring = pdKcScoringSet(nothingGraded())
    expect(kcScoreOrNull({ akc_free: 'anything' }, forScoring)).toBeNull()
    // …and the mutant's own answer, pinned, so the difference is explicit.
    expect(calcKCScore({ akc_free: 'anything' }, forScoring).score).toBe(1.0)
  })

  it('…while a NON-empty set still scores normally', () => {
    // The guard against "fix the empty case by nulling everything".
    const forScoring = pdKcScoringSet(cfg())
    const allRight = Object.fromEntries(forScoring.map(x => [x.field, x.correct_value]))
    expect(kcScoreOrNull(allRight, forScoring)).toBe(1)
    expect(kcScoreOrNull(Object.fromEntries(forScoring.map(x => [x.field, '__no__'])), forScoring)).toBe(0)
  })

  it('a half-right set scores the fraction over the VISIBLE denominator', () => {
    // Hiding two changes the denominator, so the same number of correct answers is worth
    // more — the observable consequence of the hidden/forScoring fix.
    const c = cfg({ kcHidden: { kc_dc: true, kc_dd: true } })
    const forScoring = pdKcScoringSet(c)
    expect(forScoring).toHaveLength(2)
    const answers = Object.fromEntries(
      forScoring.map((x, i) => [x.field, i < 1 ? x.correct_value : '__no__']),
    )
    expect(kcScoreOrNull(answers, forScoring)).toBe(0.5)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// GRADEDNESS, THE DEBRIEF, AND D12
// ═══════════════════════════════════════════════════════════════════════════════

describe('⚠ gradedness follows the ANSWER KEY — not the stage, not the type badge', () => {
  it('an ungraded free-text addition never reaches the denominator', () => {
    // MUTANT CAUGHT: grading by stage ("everything in `pre` is graded"), and the near miss
    // of grading by `type === 'mc'` alone — an mc question whose key named no offered
    // option has its key DROPPED at parse time and must not count either.
    const keyless = parseAddedKcQuestion({
      id: 'akc_badkey', type: 'mc', prompt: 'Which?',
      options: [{ value: 'x', label: 'X' }, { value: 'y', label: 'Y' }],
      correct_value: 'NOT_AN_OPTION',
    })!
    expect(keyless.correct_value).toBeUndefined()

    const c = cfg({ addedKcQuestions: [addedMc('akc_graded'), addedText('akc_free'), keyless] })
    expect(resolveAddedKcQuestions(c)).toHaveLength(3)
    expect(resolveAddedKcQuestions(c).filter(isGradedAdded).map(q => q.id)).toEqual(['akc_graded'])
    // Four derived + exactly ONE of the three additions.
    expect(pdKcScoringSet(c)).toHaveLength(5)
  })

  it('⚠⚠ THE DEBRIEF ROW IS NEVER GRADED — it has no answer key at all', () => {
    // MUTANT CAUGHT: grading by stage. The debrief is the only `post`-stage row, so a
    // stage-based rule would either grade it (wrong) or exempt everything in `pre`.
    // It is ungraded because `debriefQuestion` carries no `grading` and no
    // `correct_value` — the same rule every other ungraded question in the family follows.
    const c = cfg({ debriefEnabled: true })
    const ids = pdKcScoringSet(c).map(x => x.field)
    expect(ids).not.toContain('debrief_reflection')
    // …and it is not in the scoring set no matter how the debrief is configured.
    expect(pdKcScoringSet(cfg({ debriefEnabled: false })).map(x => x.field))
      .not.toContain('debrief_reflection')
  })

  it('⚠ the debrief is NOT gated by kcEnabled — it has its own visibility (D12)', () => {
    // MUTANT CAUGHT: folding the debrief's visibility into the KC toggle. Turning the
    // graded check off must not silently remove the reflection paragraph, which is the
    // Tier-2 report's entire input.
    expect(cfg({ kcEnabled: false, debriefEnabled: true }).debriefEnabled).toBe(true)
    expect(cfg({ kcEnabled: true, debriefEnabled: false }).debriefEnabled).toBe(false)
  })
})

describe('⚠ D12 — kcEnabled gates GRADED questions only', () => {
  it('off removes the derived four and any GRADED addition', () => {
    const c = cfg({ kcEnabled: false, addedKcQuestions: [addedMc('akc_graded')] })
    expect(pdResolveKc(c)).toHaveLength(0)
    expect(resolveAddedKcQuestions(c).map(q => q.id)).not.toContain('akc_graded')
    expect(pdKcScoringSet(c)).toHaveLength(0)
  })

  it('⚠ …and LEAVES an ungraded free-text addition, which has its own visibility', () => {
    // ⚠ A DELIBERATE BEHAVIOUR CHANGE from the pre-convergence build, where the toggle
    // removed every addition regardless of grading. D12 is explicit that it gates graded
    // questions only. Recorded in the handoff.
    const c = cfg({ kcEnabled: false, addedKcQuestions: [addedText('akc_free')] })
    expect(resolveAddedKcQuestions(c).map(q => q.id)).toEqual(['akc_free'])
    expect(pdKcScoringSet(c)).toHaveLength(0)
  })

  it('…and its own hidden flag still removes it', () => {
    const c = cfg({
      kcEnabled: false,
      addedKcQuestions: [addedText('akc_free')],
      kcHidden: { akc_free: true },
    })
    expect(resolveAddedKcQuestions(c)).toHaveLength(0)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// OVERRIDES
// ═══════════════════════════════════════════════════════════════════════════════

describe('⚠⚠ an override changes DISPLAY TEXT and provably nothing else', () => {
  const original = () => resolveKcQuestions(
    DEFAULT_PD_CONFIG.payoffs, DEFAULT_PD_CONFIG.unit, DEFAULT_PD_CONFIG.labels,
  ).find(q => q.field === 'kc_cc')!

  it('replaces the prompt and leaves the key, the option values and the count alone', () => {
    // MUTANT CAUGHT: an override that replaces the whole question object, or that stores
    // `options` as a LIST rather than a map from existing option value to label. Either
    // can change the key, the values or the count — and grading compares VALUES.
    const o = original()
    const got = applyKcOverride(o, { kc_cc: { prompt: 'MY OWN STEM' } })
    expect(got.prompt).toBe('MY OWN STEM')
    expect(got.correct_value).toBe(o.correct_value)
    expect((got.options ?? []).map(x => x.value)).toEqual((o.options ?? []).map(x => x.value))
    expect((got.options ?? []).map(x => x.label)).toEqual((o.options ?? []).map(x => x.label))
    expect(got.explanation).toBe(o.explanation)
  })

  it('replaces an option LABEL by value, and cannot add, drop or reorder one', () => {
    const o = original()
    const got = applyKcOverride(o, {
      kc_cc: {
        options: {
          [o.options![1].value]: 'RENAMED',
          zzz_not_an_option: 'GHOST',
        },
      },
    })
    expect(got.options).toHaveLength(o.options!.length)
    expect((got.options ?? []).map(x => x.value)).toEqual((o.options ?? []).map(x => x.value))
    expect(got.options![1].label).toBe('RENAMED')
    expect(got.options![0].label).toBe(o.options![0].label)
    expect(JSON.stringify(got)).not.toContain('GHOST')
    expect(got.correct_value).toBe(o.correct_value)
  })

  it('a built-in with NO override serves its generated text, unchanged', () => {
    // MUTANT CAUGHT: always reading the override map — an unconditional
    // `{...q, ...overrides[q.field]}` yields `undefined` fields for every un-overridden
    // question and blanks three of the four prompts.
    const authored = resolveKcQuestions(
      DEFAULT_PD_CONFIG.payoffs, DEFAULT_PD_CONFIG.unit, DEFAULT_PD_CONFIG.labels,
    )
    const resolved = pdResolveKc(cfg({ kcOverrides: { kc_cc: { prompt: 'MY OWN STEM' } } }))
    for (const a of authored) {
      if (a.field === 'kc_cc') continue
      const r = resolved.find(x => x.field === a.field)!
      expect(r.prompt, `${a.field} keeps its generated stem`).toBe(a.prompt)
    }
    // And an EMPTY override map changes nothing at all.
    expect(pdResolveKc(cfg())).toEqual(authored)
  })

  it('applyKcOverride returns the SAME OBJECT when there is no entry', () => {
    const o = original()
    expect(applyKcOverride(o, {})).toBe(o)
  })
})

describe('⚠⚠ a locked question rejects an override AT THE CALLABLE', () => {
  const ctx = () => {
    const qs = resolveKcQuestions(
      DEFAULT_PD_CONFIG.payoffs, DEFAULT_PD_CONFIG.unit, DEFAULT_PD_CONFIG.labels,
    )
    return {
      builtInIds: PD_BUILT_IN_KC_IDS,
      locked: lockedKcQuestionIds(DEFAULT_PD_CONFIG),
      optionIds: new Map(qs.map(q => [q.field, new Set((q.options ?? []).map(o => o.value))])),
    }
  }

  it('⚠ refuses an override on EVERY one of pd\'s four — all are matrix-derived', () => {
    // MUTANT CAUGHT: a UI-only guard — deleting the server-side check and trusting the
    // greyed-out Edit button. A stale tab, a replayed payload or a hand-made call all
    // reach the callable without ever rendering the button.
    const c = ctx()
    expect(c.locked.size).toBe(4)
    for (const id of PD_BUILT_IN_KC_IDS) {
      const bad = validateKcOverrides({ [id]: { prompt: 'rewritten' } }, c)
      expect(bad[0]?.reason, id).toBe('locked')
      expect(bad[0]?.message).toContain(KC_LOCK_REASON.toLowerCase())
    }
  })

  it('refuses an override aimed at an ADDED question — those are edited in place', () => {
    expect(validateKcOverrides({ akc_mine: { prompt: 'x' } }, ctx())[0].reason).toBe('not-built-in')
  })

  it('refuses an override aimed at the DEBRIEF row — it is backed by debriefPrompt', () => {
    // The settings page strips this before saving; the callable refuses it anyway, so a
    // hand-made call cannot write a debrief override that nothing would ever read.
    expect(validateKcOverrides({ debrief_reflection: { prompt: 'x' } }, ctx())[0].reason)
      .toBe('not-built-in')
  })

  it('⚠ refuses an option key that names no offered option — not ignores it', () => {
    // An instructor's edit silently going nowhere is worse than an error. Checked against
    // a hypothetically-unlocked question so the unknown-option branch is reachable.
    const c = { ...ctx(), locked: new Set<string>() }
    expect(validateKcOverrides({ kc_cc: { options: { nope: 'x' } } }, c)[0].reason)
      .toBe('unknown-option')
  })
})

describe('⚠⚠ which of pd\'s questions are locked, pinned one by one', () => {
  // ⚠ THE SPEC'S §3 TABLE PREDICTED "the four built from the payoff matrix" — CONFIRMED,
  // unlike scorecard's row, which was wrong. All four interpolate: the stem carries the
  // move LABELS and the UNIT, every option is a payoff VALUE, and the explanation prints
  // two of them.
  const EXPECTED_LOCKED = ['kc_cc', 'kc_cd', 'kc_dc', 'kc_dd']

  it('all four locked, none editable', () => {
    expect([...lockedKcQuestionIds(DEFAULT_PD_CONFIG)].sort()).toEqual(EXPECTED_LOCKED)
  })

  it('⚠ the classification is MEASURED — each of the three inputs moves the text', () => {
    // This is the property a hand-maintained list cannot have. Each assertion names a
    // DIFFERENT interpolated input, so a future edit that removed one from a question
    // would still be caught by the detector rather than passing silently.
    const base = resolveKcQuestions(DEFAULT_PD_CONFIG.payoffs, 'years', { C: 'Cooperate', D: 'Defect' })
    const otherLabels = resolveKcQuestions(DEFAULT_PD_CONFIG.payoffs, 'years', { C: 'Stay quiet', D: 'Talk' })
    const otherUnit = resolveKcQuestions(DEFAULT_PD_CONFIG.payoffs, 'months', { C: 'Cooperate', D: 'Defect' })
    const otherPayoffs = resolveKcQuestions(
      {
        you_cc: 2, you_cd: 9, you_dc: 4, you_dd: 6,
        other_cc: 2, other_cd: 4, other_dc: 9, other_dd: 6,
      }, 'years',
      { C: 'Cooperate', D: 'Defect' },
    )
    expect(base[0].prompt).not.toBe(otherLabels[0].prompt)              // move labels
    expect(base[0].options![0].label).not.toBe(otherUnit[0].options![0].label)  // unit
    expect(base[0].correct_value).not.toBe(otherPayoffs[0].correct_value)      // payoffs
  })

  it('the lock covers OPTIONS and the EXPLANATION, not merely the stem', () => {
    // pd's stems carry labels+unit and its options carry the payoff values, so a
    // payoff-only edit moves the OPTIONS and the EXPLANATION while the stem stands still.
    const a = resolveKcQuestions(DEFAULT_PD_CONFIG.payoffs, 'years', DEFAULT_PD_CONFIG.labels)[0]
    const b = resolveKcQuestions(
      {
        you_cc: 2, you_cd: 9, you_dc: 4, you_dd: 6,
        other_cc: 2, other_cd: 4, other_dc: 9, other_dd: 6,
      }, 'years', DEFAULT_PD_CONFIG.labels,
    )[0]
    expect(a.prompt).toBe(b.prompt)                    // the stem alone does NOT move…
    expect(a.explanation).not.toBe(b.explanation)      // …but the explanation does
    expect(a.options).not.toEqual(b.options)           // …and so do the options
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// ORDER
// ═══════════════════════════════════════════════════════════════════════════════

describe('⚠ reorder', () => {
  it('a COMPLETE map — what the settings page writes — orders exactly', () => {
    const authored = pdResolveKc(cfg()).map(q => q.field)
    const wanted = [...authored].reverse()
    const c = cfg({ kcOrder: Object.fromEntries(wanted.map((id, i) => [id, i])) })
    expect(pdResolveKc(c).map(q => q.field)).toEqual(wanted)
  })

  it('a PARTIAL order map drops nothing and duplicates nothing', () => {
    // MUTANT CAUGHT: `.filter(id => id in order)` — an ordering that silently deletes every
    // question the map does not mention.
    const c = cfg({ kcOrder: { kc_dd: 0 } })
    const got = pdResolveKc(c)
    expect(got).toHaveLength(4)
    expect(new Set(got.map(q => q.field)).size).toBe(4)
  })

  it('orders ADDED questions too', () => {
    const c = cfg({
      addedKcQuestions: [addedMc('akc_1'), addedMc('akc_2'), addedMc('akc_3')],
      kcOrder: { akc_1: 3, akc_2: 2, akc_3: 1 },
    })
    expect(resolveAddedKcQuestions(c).map(q => q.id)).toEqual(['akc_3', 'akc_2', 'akc_1'])
  })

  it('⚠ survives a save/reload round trip through the stored shape', () => {
    // MUTANT CAUGHT: dropping `order` on write — a parser that returns {} for a stored map.
    const wanted = [...pdResolveKc(cfg()).map(q => q.field)].reverse()
    const written = Object.fromEntries(wanted.map((id, i) => [id, i]))
    const reloaded = parseKcOrder(JSON.parse(JSON.stringify(written)))
    expect(reloaded).toEqual(written)
    expect(pdResolveKc(cfg({ kcOrder: reloaded })).map(q => q.field)).toEqual(wanted)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// THE COLLISION GUARD — pd's is the PREFIX, scorecard's is the id SET
// ═══════════════════════════════════════════════════════════════════════════════

describe('⚠⚠ an added question cannot take a derived question\'s id', () => {
  it('PD_KC_ID_GUARD is the PREFIX rule, and it refuses every derived id', () => {
    // MUTANT CAUGHT: swapping in scorecard's explicit id SET. That set holds
    // `q1_negotiated_ppm`… and knows nothing about `kc_cc`, so every one of pd's four
    // would sail through — and the grader looks derived questions up FIRST, so the
    // instructor's key would be shadowed and students marked against the matrix.
    expect(PD_KC_ID_GUARD.kind).toBe('prefix')
    expect(PD_BUILT_IN_KC_IDS.size).toBe(4)

    for (const id of PD_BUILT_IN_KC_IDS) {
      expect(id.startsWith('kc_'), `${id} is kc_-prefixed`).toBe(true)
      expect(parseShared({ id, type: 'text', prompt: 'mine' }, { guard: PD_KC_ID_GUARD }),
        `${id} must be refused`).toBeNull()
      // …and scorecard's strategy would NOT have caught it.
      expect(parseShared({ id, type: 'text', prompt: 'mine' },
        { guard: { kind: 'idSet', ids: new Set(['q1_negotiated_ppm']) } }),
      `an idSet guard would wrongly ACCEPT ${id}`).not.toBeNull()
    }
  })

  it('⚠ the prefix rule refuses ANY kc_ id, not only the four that exist', () => {
    // The namespace is reserved, not just the current occupants — a fifth derived question
    // added later must not be shadowable by a question stored before it existed.
    expect(parseAddedKcQuestion({ id: 'kc_future', type: 'text', prompt: 'x' })).toBeNull()
  })

  it('an instructor-minted akc_ id passes', () => {
    expect(parseAddedKcQuestion({ id: 'akc_mine', type: 'text', prompt: 'x' })).not.toBeNull()
  })

  it('⚠ pd now declares BOTH stages to the parser, so a valid stage is KEPT', () => {
    // ⚠ THIS TEST ASSERTED THE OPPOSITE LAST PASS, and the reversal is the point of this
    // change. `stage` used to be dropped because pd's Play.tsx rendered no post-play
    // question list — a stored stage would have been a promise the student flow could not
    // keep, and the settings block did not offer the choice either (`acceptsAdded: false`).
    // Both halves moved together: the post-play position now walks the whole stage, so the
    // parser keeps the field and the picker offers it.
    expect(PD_KC_STAGES).toEqual(['pre', 'post'])
    expect(parseAddedKcQuestion({ id: 'akc_x', type: 'text', prompt: 'x', stage: 'post' })!.stage)
      .toBe('post')
    expect(parseAddedKcQuestion({ id: 'akc_y', type: 'text', prompt: 'y', stage: 'pre' })!.stage)
      .toBe('pre')
    // An unrecognised stage is still dropped rather than stored.
    const bogus = parseAddedKcQuestion({ id: 'akc_z', type: 'text', prompt: 'z', stage: 'debrief' })!
    expect((bogus as PdAddedKcQuestion & { stage?: string }).stage).toBeUndefined()
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// SHUFFLE — the cef36fe regression
// ═══════════════════════════════════════════════════════════════════════════════

describe('⚠⚠ added MC questions are shuffled per student', () => {
  const OPTS = [
    { value: 'o0', label: 'First' }, { value: 'o1', label: 'Second' },
    { value: 'o2', label: 'Third' }, { value: 'o3', label: 'Fourth' },
  ]

  it('the typed-first answer does not land first for every student', () => {
    // MUTANT CAUGHT (c): don't shuffle the added path at all.
    const firsts = new Set(
      Array.from({ length: 40 }, (_, i) => shuffleClientOptions(OPTS, `stu-${i}`, 'akc_a')[0].value),
    )
    expect(firsts.size).toBeGreaterThan(1)
  })

  it('⚠⚠ the answer reaches EVERY position — not merely "not always first"', () => {
    // MUTANT CAUGHT (b): a two-slot swap. It passes the test above while still leaking
    // three-quarters of the information — this is the cef36fe regression exactly, and
    // this assertion is the ONLY one that catches it.
    //
    // 200 students against 4 options: if the permutation were uniform, the chance of any
    // particular slot never being hit is 4 × (3/4)^200 ≈ 10^-24. It cannot flake.
    const positions = new Set(
      Array.from({ length: 200 }, (_, i) =>
        shuffleClientOptions(OPTS, `stu-${i}`, 'akc_a').findIndex(o => o.value === 'o0')),
    )
    expect(positions.size).toBe(4)
  })

  it('⚠ two questions in one student\'s set are permuted INDEPENDENTLY', () => {
    // MUTANT CAUGHT (a): dropping the question id from the seed. Every question would then
    // carry the SAME permutation for a given student, so one revealed answer gives away
    // the rest — a worse leak than the one being fixed.
    const same = Array.from({ length: 60 }, (_, i) => {
      const a = shuffleClientOptions(OPTS, `stu-${i}`, 'akc_a').findIndex(o => o.value === 'o0')
      const b = shuffleClientOptions(OPTS, `stu-${i}`, 'akc_b').findIndex(o => o.value === 'o0')
      return a === b
    })
    expect(same.every(Boolean)).toBe(false)
  })

  it('the same student sees the same order twice — a reload is not a new screen', () => {
    expect(shuffleClientOptions(OPTS, 'stu-7', 'akc_a'))
      .toEqual(shuffleClientOptions(OPTS, 'stu-7', 'akc_a'))
  })

  it('⚠⚠ …AND THE SERVE PATH ACTUALLY CALLS IT', () => {
    // MUTANT CAUGHT (c): dropping the shuffle from `pdGetQuestions` — mapping the stored
    // options straight through.
    //
    // ⚠⚠ THIS TEST EXISTS BECAUSE THAT MUTANT SURVIVED THE FIVE TESTS ABOVE. They all
    // exercise `shuffleClientOptions` directly, so the helper stayed perfect while nothing
    // called it — a guard in a module nothing invokes. `addedToClientKcQuestions` is what
    // the callable now composes, so this asserts the wiring and not just the primitive.
    const c = cfg({ addedKcQuestions: [addedMc('akc_a'), addedMc('akc_b')] })

    const positions = new Set(
      Array.from({ length: 200 }, (_, i) =>
        addedToClientKcQuestions(c, `stu-${i}`, 'pre')[0].options.findIndex(o => o.value === 'o0')),
    )
    expect(positions.size, 'the answer reaches every slot through the SERVE path').toBe(4)

    // …and the two questions still move independently through that path.
    const same = Array.from({ length: 60 }, (_, i) => {
      const [a, b] = addedToClientKcQuestions(c, `stu-${i}`, 'pre')
      return a.options.findIndex(o => o.value === 'o0') === b.options.findIndex(o => o.value === 'o0')
    })
    expect(same.every(Boolean)).toBe(false)
  })

  it('⚠ the serve path never ships an answer key', () => {
    const c = cfg({ addedKcQuestions: [addedMc('akc_a')] })
    const json = JSON.stringify(addedToClientKcQuestions(c, 'stu-1', 'pre'))
    expect(json).not.toContain('correct_value')
    expect(Object.keys(addedToClientKcQuestions(c, 'stu-1', 'pre')[0]).sort())
      .toEqual(['field', 'options', 'prompt', 'type'])
  })

  it('⚠ a hidden addition never reaches the serve path either', () => {
    const c = cfg({
      addedKcQuestions: [addedMc('akc_a'), addedMc('akc_hidden')],
      kcHidden: { akc_hidden: true },
    })
    expect(addedToClientKcQuestions(c, 'stu-1', 'pre').map(q => q.field)).toEqual(['akc_a'])
  })

  /**
   * ⚠⚠ THE CASE THE `stage` ARGUMENT EXISTS FOR, AND THE ONE NOTHING WAS COVERING.
   *
   * Every call site above passed TWO arguments until 2026-08-16. `stage` has been
   * REQUIRED since the post-play stage started accepting added questions — questions.ts
   * says why: "dropping the argument at the call site silently served every after-play
   * question BEFORE play — a mutation no unit test caught". Nothing compiled this
   * directory, so the tests went on dropping exactly that argument, and
   * `resolveAddedKcQuestions` reads `undefined` as EVERY STAGE. The assertions kept
   * passing only because no fixture here had a post-stage question to leak.
   *
   * So the guard was defeated at five call sites AND the case it guards was untested.
   * This pair fixes the second half.
   */
  it('⚠⚠ a POST-stage addition is NOT served before play', () => {
    const c = cfg({
      addedKcQuestions: [addedMc('akc_pre'), addedMc('akc_post', { stage: 'post' })],
    })
    const served = addedToClientKcQuestions(c, 'stu-1', 'pre')
    expect(served.length).toBe(1)
    expect(served.map(q => q.field)).toEqual(['akc_pre'])
  })

  it('⚠ NEGATIVE CONTROL — the SAME fixture DOES serve it at stage post', () => {
    // Without this, the assertion above is satisfiable by a serve path that returns
    // nothing at all, or that has lost the post question entirely.
    const c = cfg({
      addedKcQuestions: [addedMc('akc_pre'), addedMc('akc_post', { stage: 'post' })],
    })
    const served = addedToClientKcQuestions(c, 'stu-1', 'post')
    expect(served.length).toBe(1)
    expect(served.map(q => q.field)).toEqual(['akc_post'])
  })

  it('⚠ …and the two stages together account for every visible addition', () => {
    // The partition is exhaustive: nothing is served twice, nothing is dropped.
    const c = cfg({
      addedKcQuestions: [addedMc('akc_pre'), addedMc('akc_post', { stage: 'post' })],
    })
    const pre = addedToClientKcQuestions(c, 'stu-1', 'pre').map(q => q.field)
    const post = addedToClientKcQuestions(c, 'stu-1', 'post').map(q => q.field)
    expect([...pre, ...post].sort()).toEqual(['akc_post', 'akc_pre'])
    expect(pre.filter(f => post.includes(f))).toEqual([])
  })

  it('⚠ no option is dropped, duplicated or rewritten', () => {
    const served = shuffleClientOptions(OPTS, 'stu-9', 'akc_a')
    expect([...served].sort((a, b) => a.value.localeCompare(b.value))).toEqual(OPTS)
  })

  it('⚠ THE DERIVED FOUR ARE DELIBERATELY **NOT** SHUFFLED', () => {
    // ⚠ The opposite constraint, and it must survive this pass. All four offer the SAME
    // sorted ladder of payoff values and their answers are 1/15/0/10, so an option's
    // POSITION tracks its VALUE and carries no information about correctness. Scrambling a
    // numeric ladder only makes four numbers harder to compare. This is pricing's
    // `ordered` flag, arrived at independently.
    const a = pdResolveKc(cfg())
    const b = pdResolveKc(cfg())
    expect(a.map(q => q.options)).toEqual(b.map(q => q.options))
    const values = (a[0].options ?? []).map(o => Number(o.value))
    expect(values).toEqual([...values].sort((x, y) => x - y))
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
    expect(pdResolveKc(cfg())).toEqual(
      resolveKcQuestions(DEFAULT_PD_CONFIG.payoffs, DEFAULT_PD_CONFIG.unit, DEFAULT_PD_CONFIG.labels),
    )
  })

  it('⚠ only `true` is kept in the hidden map — a stale `false` is not an assertion', () => {
    expect(parseKcHidden({ a: true, b: false, c: 'yes', d: 1 })).toEqual({ a: true })
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// THE `post` STAGE RECEIVES ADDED QUESTIONS.
//
// It used to hold only the debrief, and the settings block was told the stage accepted no
// additions — correctly, because nothing rendered a post-play question LIST. It renders one
// now: the post-play position in Play.tsx walks the whole stage, the debrief row included,
// exactly as the pre-play position walks the KC list. No new phase; the debrief was already
// occupying that slot.
// ═══════════════════════════════════════════════════════════════════════════════

const postMc = (id: string) => addedMc(id, { stage: 'post' })
const postText = (id: string) => addedText(id, { stage: 'post' })

describe('⚠⚠ an added question assigned to `post` is served AFTER play, not before', () => {
  it('it is absent from the pre-play list and present in the post list', () => {
    // MUTANT CAUGHT: serving the post list in the pre-play phase — i.e. dropping the stage
    // filter from `addedToClientKcQuestions`, which is what pd did before this change (it
    // appended EVERY addition to the derived four). The student would answer an
    // after-play reflection before playing a single round.
    const c = cfg({ addedKcQuestions: [addedMc('akc_pre'), postMc('akc_post')] })

    const pre = addedToClientKcQuestions(c, 'stu-1', 'pre').map(q => q.field)
    expect(pre).toEqual(['akc_pre'])
    expect(pre).not.toContain('akc_post')

    const post = postStageToClient(c, 'stu-1').map(r => r.field)
    expect(post).toContain('akc_post')
    expect(post).not.toContain('akc_pre')
  })

  it('⚠ a stage-less addition still lands in `pre` — nothing already stored moves', () => {
    // ⚠⚠ THE MOST DANGEROUS LINE IN THIS CHANGE. Every added question pd has ever stored
    // predates the `stage` field and is being served BEFORE play. Scorecard's default is
    // 'post'; adopting it here would silently move every existing pd addition to after the
    // last round. MUTANT CAUGHT: DEFAULT_ADDED_KC_STAGE = 'post'.
    expect(DEFAULT_ADDED_KC_STAGE).toBe('pre')
    const legacy = addedMc('akc_legacy')
    expect(legacy.stage).toBeUndefined()
    expect(addedKcStage(legacy)).toBe('pre')

    const c = cfg({ addedKcQuestions: [legacy] })
    expect(addedToClientKcQuestions(c, 'stu-1', 'pre').map(q => q.field)).toEqual(['akc_legacy'])
    expect(postStageToClient(c, 'stu-1').map(r => r.field)).not.toContain('akc_legacy')
  })

  it('the stage SURVIVES the parser now — it used to be dropped', () => {
    expect(parseAddedKcQuestion({ id: 'akc_p', type: 'text', prompt: 'x', stage: 'post' })!.stage)
      .toBe('post')
    // …and an unrecognised one is still dropped, falling back to `pre`.
    const bogus = parseAddedKcQuestion({ id: 'akc_b', type: 'text', prompt: 'x', stage: 'debrief' })!
    expect(bogus.stage).toBeUndefined()
    expect(addedKcStage(bogus)).toBe('pre')
  })

  it('the debrief row leads the post stage, with added questions after it', () => {
    const c = cfg({ addedKcQuestions: [postMc('akc_post')] })
    const rows = pdPostStageQuestions(c)
    expect(rows.map(r => r.kind)).toEqual(['debrief', 'added'])
    expect(rows[0].field).toBe('debrief_reflection')
  })

  it('⚠⚠ the debrief row renders the INSTRUCTOR\'S prompt from `debrief_prompt`', () => {
    // MUTANT CAUGHT: reading the hardcoded literal on the `debriefQuestion` data object
    // instead of `config.debriefPrompt` — i.e. the row silently ignoring every edit the
    // instructor has ever made and showing the shipped default forever.
    //
    // ⚠⚠ THE PROMPT MUST BE NON-DEFAULT FOR THIS TO TEST ANYTHING. An earlier version of
    // this test asserted against DEFAULT_PD_CONFIG.debriefPrompt, which is the SAME STRING
    // as the literal — so the mutant was invisible and survived the first calibration run.
    const custom = 'What was your plan, and when did it change?'
    expect(custom).not.toBe(DEFAULT_PD_CONFIG.debriefPrompt)

    const c = cfg({ debriefPrompt: custom, addedKcQuestions: [postMc('akc_post')] })
    expect(pdPostStageQuestions(c)[0].prompt).toBe(custom)
    expect(postStageToClient(c, 'stu-1')[0].prompt).toBe(custom)
    // …and the field it is keyed by is unchanged, so no stored answer moves.
    expect(pdPostStageQuestions(c)[0].field).toBe('debrief_reflection')
  })

  it('⚠ the debrief row is NOT backed by the override map', () => {
    // MUTANT CAUGHT: routing the row's prompt through `kcOverrides` — which would store the
    // instructor's wording in a map the reports and pdSubmitDebrief never read, and leave
    // `debrief_prompt` stale. The callable refuses such an override; this pins that even a
    // stored one is ignored by the serve path.
    const c = cfg({ kcOverrides: { debrief_reflection: { prompt: 'FROM THE OVERRIDE MAP' } } })
    expect(pdPostStageQuestions(c)[0].prompt).toBe(DEFAULT_PD_CONFIG.debriefPrompt)
    expect(pdPostStageQuestions(c)[0].prompt).not.toBe('FROM THE OVERRIDE MAP')
  })
})

describe('⚠ grading in the post stage follows the ANSWER KEY, never the stage (D3)', () => {
  it('an added MC question in `post` IS graded and IS in the denominator', () => {
    // MUTANT CAUGHT: grade by stage — "only pre-play questions count". A post-stage MC
    // question is exactly as graded as a pre-play one; the stage is about WHEN it is
    // asked, never about whether it is marked.
    const c = cfg({ addedKcQuestions: [postMc('akc_post')] })
    const ids = pdKcScoringSet(c).map(x => x.field)
    expect(ids).toContain('akc_post')
    expect(pdKcScoringSet(c)).toHaveLength(5)   // the derived four + this one
  })

  it('an added FREE-TEXT question in `post` is NOT graded', () => {
    // MUTANT CAUGHT: grade by type, or grade everything in the stage.
    const c = cfg({ addedKcQuestions: [postText('akc_free')] })
    expect(isGradedAdded(postText('akc_free'))).toBe(false)
    expect(pdKcScoringSet(c).map(x => x.field)).not.toContain('akc_free')
    expect(pdKcScoringSet(c)).toHaveLength(4)
  })

  it('⚠ the DEBRIEF row is still never graded, wherever it sits in the order', () => {
    const c = cfg({
      addedKcQuestions: [postMc('akc_post')],
      kcOrder: { akc_post: 0, debrief_reflection: 1 },
    })
    expect(pdPostStageQuestions(c).map(r => r.field)).toEqual(['akc_post', 'debrief_reflection'])
    expect(pdKcScoringSet(c).map(x => x.field)).not.toContain('debrief_reflection')
  })
})

describe('⚠ hidden and order are honoured in the post list', () => {
  it('a hidden post-stage addition is not served', () => {
    // MUTANT CAUGHT: ignoring `hidden` in the post path specifically — the pre path
    // filters, so a suite that only checked pre would pass.
    const c = cfg({
      addedKcQuestions: [postMc('akc_a'), postMc('akc_b')],
      kcHidden: { akc_b: true },
    })
    const fields = postStageToClient(c, 'stu-1').map(r => r.field)
    expect(fields).toContain('akc_a')
    expect(fields).not.toContain('akc_b')
  })

  it('hiding the debrief removes ITS row and leaves the additions', () => {
    const c = cfg({ debriefEnabled: false, addedKcQuestions: [postMc('akc_a')] })
    expect(pdPostStageQuestions(c).map(r => r.field)).toEqual(['akc_a'])
  })

  it('`order` reorders the post list ACROSS both kinds', () => {
    // MUTANT CAUGHT: ignoring `order` in the post path. An instructor can put an added
    // question BEFORE the debrief paragraph.
    const c = cfg({
      addedKcQuestions: [postMc('akc_a'), postMc('akc_b')],
      kcOrder: { akc_b: 0, debrief_reflection: 1, akc_a: 2 },
    })
    expect(pdPostStageQuestions(c).map(r => r.field))
      .toEqual(['akc_b', 'debrief_reflection', 'akc_a'])
  })

  it('an empty post stage is legal — the debrief hidden and nothing added', () => {
    expect(pdPostStageQuestions(cfg({ debriefEnabled: false }))).toEqual([])
  })
})

describe('⚠⚠ an added MC question in `post` still shuffles — through the SERVE path', () => {
  it('the answer reaches EVERY position over a cohort', () => {
    // MUTANTS CAUGHT: (b) a two-slot swap, and (c) routing the post list around the
    // shuffle entirely. ⚠ "Not always first" would pass (b) with three-quarters of the
    // information still leaking — this is the cef36fe assertion.
    //
    // ⚠ TESTED THROUGH `postStageToClient`, which is what pdGetQuestions composes — NOT
    // through `shuffleClientOptions`. Last pass five tests called the helper directly and
    // the "don't shuffle" mutant survived because nothing invoked it.
    const c = cfg({ addedKcQuestions: [postMc('akc_a')] })
    const positions = new Set(
      Array.from({ length: 200 }, (_, i) => {
        const row = postStageToClient(c, `stu-${i}`).find(r => r.field === 'akc_a')!
        return row.options.findIndex(o => o.value === 'o0')
      }),
    )
    expect(positions.size).toBe(4)
  })

  it('two post-stage questions are permuted INDEPENDENTLY', () => {
    // MUTANT CAUGHT: (a) dropping the question id from the seed — every question would
    // carry the same permutation for a student, so one revealed answer gives away the rest.
    const c = cfg({ addedKcQuestions: [postMc('akc_a'), postMc('akc_b')] })
    const same = Array.from({ length: 60 }, (_, i) => {
      const rows = postStageToClient(c, `stu-${i}`)
      const a = rows.find(r => r.field === 'akc_a')!.options.findIndex(o => o.value === 'o0')
      const b = rows.find(r => r.field === 'akc_b')!.options.findIndex(o => o.value === 'o0')
      return a === b
    })
    expect(same.every(Boolean)).toBe(false)
  })

  it('the same student sees the same order twice, and no option is lost', () => {
    const c = cfg({ addedKcQuestions: [postMc('akc_a')] })
    expect(postStageToClient(c, 'stu-7')).toEqual(postStageToClient(c, 'stu-7'))
    const opts = postStageToClient(c, 'stu-7').find(r => r.field === 'akc_a')!.options
    expect([...opts].sort((x, y) => x.value.localeCompare(y.value)))
      .toEqual(addedMc('akc_a').options)
  })

  it('⚠ the DEBRIEF row is not shuffled and ships no options', () => {
    const rows = postStageToClient(cfg(), 'stu-1')
    expect(rows[0].kind).toBe('debrief')
    expect(rows[0].options).toEqual([])
  })

  it('⚠ the post payload ships no answer key', () => {
    const c = cfg({ addedKcQuestions: [postMc('akc_a')] })
    expect(JSON.stringify(postStageToClient(c, 'stu-1'))).not.toContain('correct_value')
  })
})


describe('⚠⚠ CP0 — `order` is applied EXACTLY ONCE per stage', () => {
  it('a DISCRIMINATING partial map proves it — most partial maps do NOT', () => {
    // MUTANT CAUGHT: applying `order` inside `resolveAddedKcQuestions` AND again over the
    // post stage. This SHIPPED and survived two passes.
    //
    // ⚠⚠ NOT EVERY PARTIAL MAP SEPARATES ONE PASS FROM TWO, and my first attempt at this
    // test used one that did not — both mutants survived calibration. `applyKcOrder` sorts
    // by (key, index) with an unmentioned id's key being its OWN index, so pass 1 permutes
    // only MENTIONED items and the additions keep their relative order either way. The
    // divergence needs an unmentioned addition to be SHIFTED across a MENTIONED debrief
    // row: pass 1 moves `akc_a` to the end, which pulls `akc_b`'s index down from 2 to 1,
    // and 1 sorts BEFORE the debrief's explicit key of 2 where 2 tied with it and lost.
    //
    //   one pass : [debrief, akc_b, akc_c, akc_a]
    //   two passes: [akc_b, debrief, akc_c, akc_a]   ← the debrief loses its place
    //
    // Reachable trigger: an instructor reorders (writing keys for the rows that existed),
    // then ADDS questions the stored map does not mention.
    const c = cfg({
      addedKcQuestions: [postMc('akc_a'), postMc('akc_b'), postMc('akc_c')],
      kcOrder: { debrief_reflection: 2, akc_a: 9 },
    })
    expect(pdPostStageQuestions(c).map(r => r.field))
      .toEqual(['debrief_reflection', 'akc_b', 'akc_c', 'akc_a'])
  })

  it('ordering a stage by the order it is already in is a no-op', () => {
    const c0 = cfg({ addedKcQuestions: [postMc('akc_a'), postMc('akc_b')] })
    const once = pdPostStageQuestions(c0).map(r => r.field)
    const c1 = cfg({
      addedKcQuestions: [postMc('akc_a'), postMc('akc_b')],
      kcOrder: Object.fromEntries(once.map((id, i) => [id, i])),
    })
    expect(pdPostStageQuestions(c1).map(r => r.field)).toEqual(once)
  })
})
