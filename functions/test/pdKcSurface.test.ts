import { describe, it, expect } from 'vitest'
import { kcScoreOrNull, calcKCScore } from '@mygames/game-server'
import {
  resolveKcQuestions, pdResolveKc, resolveAddedKcQuestions, pdKcScoringSet,
  applyKcOverride, isGradedAdded, shuffleClientOptions, addedToClientKcQuestions,
  PD_BUILT_IN_KC_IDS, PD_KC_STAGES,
} from '../src/pd/questions'
import {
  DEFAULT_PD_CONFIG, parseAddedKcQuestion, PD_KC_ID_GUARD,
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
      { both_cooperate: 2, sucker: 9, temptation: 4, both_defect: 6 }, 'years',
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
      { both_cooperate: 2, sucker: 9, temptation: 4, both_defect: 6 }, 'years', DEFAULT_PD_CONFIG.labels,
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

  it('⚠ pd declares NO stages to the parser, so a stage field is DROPPED', () => {
    // pd's Play.tsx has no post-play KC screen, so a stored `stage` would be a promise the
    // student flow cannot keep. The settings block does not offer the choice either
    // (`acceptsAdded: false`), and this is the server-side half of that.
    const q = parseAddedKcQuestion({ id: 'akc_x', type: 'text', prompt: 'x', stage: 'post' })!
    expect((q as PdAddedKcQuestion & { stage?: string }).stage).toBeUndefined()
    expect(PD_KC_STAGES).toEqual(['pre', 'post'])
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
        addedToClientKcQuestions(c, `stu-${i}`)[0].options.findIndex(o => o.value === 'o0')),
    )
    expect(positions.size, 'the answer reaches every slot through the SERVE path').toBe(4)

    // …and the two questions still move independently through that path.
    const same = Array.from({ length: 60 }, (_, i) => {
      const [a, b] = addedToClientKcQuestions(c, `stu-${i}`)
      return a.options.findIndex(o => o.value === 'o0') === b.options.findIndex(o => o.value === 'o0')
    })
    expect(same.every(Boolean)).toBe(false)
  })

  it('⚠ the serve path never ships an answer key', () => {
    const c = cfg({ addedKcQuestions: [addedMc('akc_a')] })
    const json = JSON.stringify(addedToClientKcQuestions(c, 'stu-1'))
    expect(json).not.toContain('correct_value')
    expect(Object.keys(addedToClientKcQuestions(c, 'stu-1')[0]).sort())
      .toEqual(['field', 'options', 'prompt', 'type'])
  })

  it('⚠ a hidden addition never reaches the serve path either', () => {
    const c = cfg({
      addedKcQuestions: [addedMc('akc_a'), addedMc('akc_hidden')],
      kcHidden: { akc_hidden: true },
    })
    expect(addedToClientKcQuestions(c, 'stu-1').map(q => q.field)).toEqual(['akc_a'])
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
