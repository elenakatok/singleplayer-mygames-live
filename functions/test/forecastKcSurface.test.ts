import { describe, it, expect } from 'vitest'
import { kcScoreOrNull, calcKCScore } from '@mygames/game-server'
import {
  resolveForecastKc, resolveForecastKcUnordered, resolveAddedKcQuestions,
  forecastKcScoringSet, applyKcOverride, isGradedAdded, authoredToClient,
  addedToClientKcQuestions, forecastPreStage, forecastPostStage, stageToClient,
  FORECAST_BUILT_IN_KC_IDS, DEBRIEF_ROW_ID, AUTHORED_KC_COUNT, forecastKcScoreFor,
} from '../src/forecast/questions'
import {
  DEFAULT_FORECAST_CONFIG, parseAddedKcQuestion, FORECAST_KC_ID_GUARD,
  DEFAULT_ADDED_KC_STAGE, addedKcStage, FORECAST_KC_STAGES,
  type ForecastConfig, type ForecastAddedKcQuestion,
} from '../src/forecast/config'
import {
  lockedKcQuestionIds, probeDetector, validateKcOverrides, forecastOverrideContext,
  KC_LOCK_REASON,
} from '../src/forecast/kcLock'
import { revealGate, isPostRowAnswered, unansweredPostRows } from '../src/forecast/reveal'
import {
  parseAddedKcQuestion as parseShared, parseKcHidden, parseKcOrder, parseKcOverrides,
} from '../src/shared/kcSurface'

// ═══════════════════════════════════════════════════════════════════════════════
// FORECAST — the shared KC surface (convergence spec §5, §7). FIFTH adopter.
//
// ⚠⚠ THE THING THAT MAKES THIS GAME DIFFERENT IS THE REVEAL GATE. Forecast is the only
// game in the family whose after-play stage is enforced SERVER-SIDE: the model is withheld
// until the stage is answered. Widening that gate from one paragraph to the whole stage is
// the riskiest change in this pass, so the gate has its own block below and every failure
// mode in it was calibrated by breaking the code.
//
// ⚠ NOTHING IS LOCKED HERE, as in newsvendor — every stem is a literal string, on purpose.
// The detector is therefore proved with `probeDetector` over a CONTROLLED probe set, because
// "0 of 9 locked" is a report a broken detector produces too.
//
// Every test names the mutant it catches. All were calibrated by breaking the code.
// ═══════════════════════════════════════════════════════════════════════════════

const cfg = (over: Partial<ForecastConfig> = {}): ForecastConfig =>
  ({ ...DEFAULT_FORECAST_CONFIG, ...over })

const AUTHORED_IDS = [
  'kc_systematic', 'kc_goal', 'kc_mse_penalty', 'kc_coefficient', 'kc_pvalue',
  'kc_trend_bias', 'kc_moving_average', 'kc_chasing_noise', 'kc_parsimony',
]

const addedMc = (id: string, over: Partial<ForecastAddedKcQuestion> = {}): ForecastAddedKcQuestion => ({
  id, type: 'mc', prompt: `Added ${id}?`,
  options: [
    { value: 'o0', label: 'First' }, { value: 'o1', label: 'Second' },
    { value: 'o2', label: 'Third' }, { value: 'o3', label: 'Fourth' },
  ],
  correct_value: 'o0',
  ...over,
})
const addedText = (id: string, over: Partial<ForecastAddedKcQuestion> = {}): ForecastAddedKcQuestion => ({
  id, type: 'text', prompt: `Tell me about ${id}`, ...over,
})
const postMc = (id: string) => addedMc(id, { stage: 'post' })
const postText = (id: string) => addedText(id, { stage: 'post' })

/** A stored participant doc: finished, with the given answers already in place. */
const pdoc = (over: Record<string, unknown> = {}) => ({
  finished_at: 'yes',
  free_text_answers: {} as Record<string, unknown>,
  kc_static_answers: {} as Record<string, unknown>,
  ...over,
})
const answeredDebrief = { [DEBRIEF_ROW_ID]: { answer: 'I fitted a trend.' } }

// ═══════════════════════════════════════════════════════════════════════════════
// 1. THE AUTHORED SET, AND THE GATE THAT USED TO LIVE IN THE WRONG FILE
// ═══════════════════════════════════════════════════════════════════════════════

describe('the authored nine', () => {
  it('ships all nine, with the ids the KC has always used', () => {
    expect(resolveForecastKc(cfg()).map(q => q.field)).toEqual(AUTHORED_IDS)
    expect(AUTHORED_KC_COUNT).toBe(9)
  })

  it('⚠⚠ `kcEnabled: false` empties the RESOLVER, not only the callable', () => {
    // MUTANT: move the gate back to getQuestions (delete the `if (!config.kcEnabled)` line
    // in resolveForecastKcUnordered). → this fails, and so does the denominator test below.
    // THIS IS SCORECARD'S LATENT BUG, AND FORECAST SHIPPED THE SAME SHAPE: the ternaries
    // lived in getQuestions.ts:52 and :61 alone, so the grader's scoring set still counted
    // all nine questions the student was served none of.
    expect(resolveForecastKc(cfg({ kcEnabled: false }))).toEqual([])
    expect(resolveForecastKcUnordered(cfg({ kcEnabled: false }))).toEqual([])
  })

  it('⚠ and therefore the SCORING SET is empty too — the serve path and the grader agree', () => {
    expect(forecastKcScoringSet(cfg({ kcEnabled: false }))).toEqual([])
    expect(forecastKcScoringSet(cfg()).map(q => q.field)).toEqual(AUTHORED_IDS)
  })

  it('every authored question carries a key that names one of its own options', () => {
    for (const q of resolveForecastKc(cfg())) {
      expect(q.options.some(o => o.value === q.correct_value), q.field).toBe(true)
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// 2. HIDE
// ═══════════════════════════════════════════════════════════════════════════════

describe('kc_hidden', () => {
  it('removes a question from the served set AND from the denominator', () => {
    // MUTANT: drop the `.filter(q => config.kcHidden[...])` line. → both halves fail.
    const c = cfg({ kcHidden: { kc_goal: true, kc_pvalue: true } })
    expect(resolveForecastKc(c).map(q => q.field)).not.toContain('kc_goal')
    expect(forecastKcScoringSet(c).map(q => q.field)).not.toContain('kc_pvalue')
    expect(forecastKcScoringSet(c)).toHaveLength(7)
  })

  it('⚠ `false` is not `true` — only an explicit true hides', () => {
    // MUTANT: `config.kcHidden[q.field]` (truthiness) instead of `!== true`. Survives this
    // one but fails the parse test below, which is why parseKcHidden drops non-booleans.
    expect(resolveForecastKc(cfg({ kcHidden: { kc_goal: false } })).map(q => q.field))
      .toEqual(AUTHORED_IDS)
  })

  it('an absent map is total — an untouched instance is unchanged', () => {
    expect(resolveForecastKc(cfg({ kcHidden: parseKcHidden(undefined) })).map(q => q.field))
      .toEqual(AUTHORED_IDS)
  })

  it('hides an ADDED question too', () => {
    const c = cfg({ addedKcQuestions: [addedMc('a1'), addedMc('a2')], kcHidden: { a1: true } })
    expect(resolveAddedKcQuestions(c).map(q => q.id)).toEqual(['a2'])
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// 3. ORDER
// ═══════════════════════════════════════════════════════════════════════════════

describe('kc_order', () => {
  it('reorders the authored set', () => {
    // MUTANT: return the list unsorted from applyKcOrder. → fails.
    const c = cfg({ kcOrder: { kc_parsimony: 0, kc_systematic: 8 } })
    const ids = resolveForecastKc(c).map(q => q.field)
    expect(ids[0]).toBe('kc_parsimony')
    expect(ids[ids.length - 1]).toBe('kc_systematic')
    expect([...ids].sort()).toEqual([...AUTHORED_IDS].sort())
  })

  it('is total on a PARTIAL map — unmentioned questions keep their relative order', () => {
    // ⚠ THE KEY FOR AN UNMENTIONED ID IS ITS OWN INDEX, and the sort is stable — so a
    // mentioned id sorts BESIDE the unmentioned one at the same index, not ahead of it.
    // `0` ties with kc_systematic's index 0 and leaves it first; `-1` is what moves it.
    // This is exactly the property that makes double-applying `order` invisible on most
    // partial maps (spec §6), so it is asserted rather than assumed.
    expect(resolveForecastKc(cfg({ kcOrder: { kc_parsimony: 0 } })).map(q => q.field))
      .toEqual(['kc_systematic', 'kc_parsimony', ...AUTHORED_IDS.slice(1, -1)])
    expect(resolveForecastKc(cfg({ kcOrder: { kc_parsimony: -1 } })).map(q => q.field))
      .toEqual(['kc_parsimony', ...AUTHORED_IDS.filter(i => i !== 'kc_parsimony')])
  })

  it('⚠⚠ is applied EXACTLY ONCE per stage — a DISCRIMINATING partial map proves it', () => {
    // MUTANT: point forecastPostStage at resolveAddedKcQuestions (the ORDERED one) instead
    // of the unordered one, so `order` runs inside the resolver AND again over the stage.
    // → this fails; most partial maps do NOT, because applyKcOrder is idempotent on a
    // complete map and falls back to an item's own index for an unmentioned id. Divergence
    // needs an UNMENTIONED addition shifted across a MENTIONED row (spec §6).
    const c = cfg({
      addedKcQuestions: [postMc('akc_a'), postMc('akc_b'), postMc('akc_c')],
      kcOrder: { [DEBRIEF_ROW_ID]: 2, akc_a: 9 },
    })
    expect(forecastPostStage(c).map(r => r.field))
      .toEqual([DEBRIEF_ROW_ID, 'akc_b', 'akc_c', 'akc_a'])
  })

  it('orders ACROSS kinds — the debrief paragraph can be moved off the end', () => {
    const c = cfg({
      addedKcQuestions: [postMc('z1'), postMc('z2')],
      kcOrder: { [DEBRIEF_ROW_ID]: 5 },
    })
    expect(forecastPostStage(c).map(r => r.field)).toEqual(['z1', 'z2', DEBRIEF_ROW_ID])
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// 4. OVERRIDES — text only, and PROVABLY unable to move a score
// ═══════════════════════════════════════════════════════════════════════════════

describe('kc_overrides', () => {
  it('replaces the prompt', () => {
    const c = cfg({ kcOverrides: { kc_goal: { prompt: 'Rewritten?' } } })
    expect(resolveForecastKc(c).find(q => q.field === 'kc_goal')!.prompt).toBe('Rewritten?')
  })

  it('replaces an option LABEL, looked up BY VALUE', () => {
    // MUTANT: index options by POSITION instead of by value. → fails once the order test
    // above has moved anything, and fails here because o.value is the key.
    const c = cfg({ kcOverrides: { kc_goal: { options: { eliminate: 'Wipe out every error' } } } })
    const q = resolveForecastKc(c).find(x => x.field === 'kc_goal')!
    expect(q.options.find(o => o.value === 'eliminate')!.label).toBe('Wipe out every error')
    expect(q.options).toHaveLength(4)
  })

  it('⚠⚠ CANNOT move a score — the key and the explanation are untouched, for EVERY question', () => {
    // MUTANT: let applyKcOverride write `correct_value: o.correct_value ?? q.correct_value`.
    // → fails. This is the property the whole edit feature rests on.
    const bare = resolveForecastKc(cfg())
    const overrides = Object.fromEntries(bare.map(q => [
      q.field,
      { prompt: 'x', options: Object.fromEntries(q.options.map(o => [o.value, 'y'])) },
    ]))
    const edited = resolveForecastKc(cfg({ kcOverrides: overrides }))
    for (const q of bare) {
      const e = edited.find(x => x.field === q.field)!
      expect(e.correct_value, q.field).toBe(q.correct_value)
      expect(e.explanation, q.field).toBe(q.explanation)
    }
    expect(forecastKcScoringSet(cfg({ kcOverrides: overrides })))
      .toEqual(forecastKcScoringSet(cfg()))
  })

  it('an unknown option id in the map is INERT in the resolver (and REFUSED at the callable)', () => {
    const c = cfg({ kcOverrides: { kc_goal: { options: { not_an_option: 'ignored' } } } })
    const q = resolveForecastKc(c).find(x => x.field === 'kc_goal')!
    expect(q.options.map(o => o.label)).not.toContain('ignored')
  })

  it('applyKcOverride with no entry returns the SAME object', () => {
    const q = resolveForecastKc(cfg())[0]
    expect(applyKcOverride(q, {})).toBe(q)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// 5. THE LOCK DETECTOR — measured, and PROVED
// ═══════════════════════════════════════════════════════════════════════════════

describe('the lock detector', () => {
  it('⚠ MEASURES that NOTHING in forecast is locked', () => {
    expect([...lockedKcQuestionIds(cfg())]).toEqual([])
  })

  it('reports the same on a perturbed instance — the finding is about the questions', () => {
    expect([...lockedKcQuestionIds(cfg({ rounds: 36, numHistory: 84, productName: 'widgets' }))])
      .toEqual([])
  })

  it('⚠⚠ THE SELF-PROOF: the SAME comparison over a controlled probe set fires correctly', () => {
    // MUTANT: make lockedKcQuestionIds/probeDetector return `new Set()` unconditionally.
    // → the two tests above still pass (they expect empty!) and THIS one fails on every
    // parameterised probe. Without it, "nothing is locked" is indistinguishable from a
    // detector that cannot lock anything.
    const opts = [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }]
    const locked = probeDetector(cfg(), c => [
      // all-static — must NOT lock
      { field: 'static', prompt: 'Fixed.', options: opts, explanation: 'Fixed.' },
      // the stem reads the instance — must lock
      { field: 'stem', prompt: `You play ${c.rounds} months.`, options: opts, explanation: 'x' },
      // an OPTION reads the instance — must lock
      {
        field: 'option',
        prompt: 'Pick one.',
        options: [{ value: 'a', label: `${c.rounds}` }, { value: 'b', label: 'B' }],
        explanation: 'x',
      },
      // only the EXPLANATION reads the instance — must lock
      { field: 'explanation', prompt: 'Fixed.', options: opts, explanation: `${c.productName}` },
    ])
    expect([...locked].sort()).toEqual(['explanation', 'option', 'stem'])
  })

  it('⚠⚠ AN INSTRUCTOR\'S OWN MAPS ARE NORMALISED AWAY — an edit does not forbid the next one', () => {
    // MUTANT: drop `kcHidden: {}, kcOverrides: {}, kcOrder: {}` from `bare`. → fails. The
    // probe perturbs those maps precisely so this is observable: without the normalisation a
    // question whose text depended on an override would differ between arms and lock ITSELF.
    // (The first version of this test did NOT perturb the maps, and the mutant survived.)
    const readsOverrides = (c: ForecastConfig) => [{
      field: 'reads_map',
      prompt: `Overrides: ${Object.keys(c.kcOverrides).sort().join('|')}.`,
      options: [{ value: 'a', label: `${Object.keys(c.kcHidden).sort().join('|')}` }],
      explanation: `${Object.keys(c.kcOrder).sort().join('|')}`,
    }]
    expect([...probeDetector(cfg({ kcOverrides: { kc_goal: { prompt: 'Edited' } } }), readsOverrides)])
      .toEqual([])
  })

  it('⚠ hides and overrides do NOT make a question look locked', () => {
    // MUTANT: drop the `bare(...)` normalisation in lockedKcQuestionIds. → an overridden
    // question would differ from the probe's and lock itself, so an instructor's own edit
    // would silently forbid the next one.
    const c = cfg({
      kcHidden: { kc_goal: true },
      kcOverrides: { kc_pvalue: { prompt: 'Edited' } },
      kcEnabled: false,
    })
    expect([...lockedKcQuestionIds(c)]).toEqual([])
  })
})

describe('validateKcOverrides — the server-side half of the lock', () => {
  // ⚠⚠ THE CONTEXT THE CALLABLE ACTUALLY PASSES, not one this file made up. A mutant that
  // widened `builtInIds` at the CALL SITE survived the whole suite while these tests
  // constructed their own (spec §7); building it through the production function is what
  // makes the call site reachable from here.
  const ctx = forecastOverrideContext(cfg())

  it('accepts a legal rewrite', () => {
    expect(validateKcOverrides({ kc_goal: { prompt: 'New', options: { exact: 'Nail it' } } }, ctx))
      .toEqual([])
  })

  it('REFUSES an unknown option id — a typo would otherwise vanish silently', () => {
    const r = validateKcOverrides({ kc_goal: { options: { nope: 'x' } } }, ctx)
    expect(r).toHaveLength(1)
    expect(r[0].reason).toBe('unknown-option')
  })

  it('REFUSES an override aimed at a question that is not a built-in', () => {
    expect(validateKcOverrides({ made_up: { prompt: 'x' } }, ctx)[0].reason).toBe('not-built-in')
  })

  it('⚠ REFUSES one aimed at the DEBRIEF row — its prompt has its own stored field', () => {
    // MUTANT: add DEBRIEF_ROW_ID to builtInIds. → fails. Accepting it would give one
    // paragraph two sources of truth, and `debrief_prompt` is the one the student is served.
    const r = validateKcOverrides({ [DEBRIEF_ROW_ID]: { prompt: 'x' } }, ctx)
    expect(r[0].reason).toBe('not-built-in')
  })

  it('⚠ the real context locks nothing and knows every authored id and its options', () => {
    expect([...ctx.locked]).toEqual([])
    expect([...ctx.builtInIds].sort()).toEqual([...AUTHORED_IDS].sort())
    expect(ctx.optionIds.get('kc_goal')!.has('eliminate')).toBe(true)
  })

  it('REFUSES a rewrite of a LOCKED question, and says why', () => {
    const r = validateKcOverrides({ kc_goal: { prompt: 'x' } }, { ...ctx, locked: new Set(['kc_goal']) })
    expect(r[0].reason).toBe('locked')
    expect(r[0].message).toContain(KC_LOCK_REASON.toLowerCase())
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// 6. ADDED QUESTIONS — the stage default, the guard, and D12
// ═══════════════════════════════════════════════════════════════════════════════

describe('added questions', () => {
  it('⚠⚠ THE STAGE-LESS DEFAULT IS `pre` — pinned, because it preserves live data', () => {
    // MUTANT: flip DEFAULT_ADDED_KC_STAGE to 'post'. → fails. Every addition forecast has
    // ever stored was served BEFORE play (Play.tsx flattened kc.authored + kc.added), so
    // 'post' would silently move an existing instance's questions to the other end of the
    // game. Scorecard's default is 'post'; the value is PER GAME and never shared (D16).
    expect(DEFAULT_ADDED_KC_STAGE).toBe('pre')
    expect(addedKcStage(addedMc('x'))).toBe('pre')
    expect(addedKcStage(addedMc('x', { stage: 'post' }))).toBe('post')
    expect(FORECAST_KC_STAGES).toEqual(['pre', 'post'])
  })

  it('a stage-less stored addition is served in the PRE stage', () => {
    const c = cfg({ addedKcQuestions: [addedMc('legacy')] })
    expect(forecastPreStage(c).map(r => r.field)).toContain('legacy')
    expect(forecastPostStage(c).map(r => r.field)).not.toContain('legacy')
  })

  it('⚠ D12 — the toggle gates GRADED questions only', () => {
    // MUTANT: `const gated = config.kcEnabled ? visible : []`. → fails: the free-text
    // question disappears with a toggle that is documented to govern grading.
    const c = cfg({
      kcEnabled: false,
      addedKcQuestions: [addedMc('graded'), addedText('ungraded')],
    })
    expect(resolveAddedKcQuestions(c).map(q => q.id)).toEqual(['ungraded'])
  })

  it('an mc with no key is UNGRADED, and so is absent from the denominator', () => {
    const c = cfg({ addedKcQuestions: [addedMc('keyless', { correct_value: undefined })] })
    expect(isGradedAdded(c.addedKcQuestions[0])).toBe(false)
    expect(forecastKcScoringSet(c).map(q => q.field)).toEqual(AUTHORED_IDS)
  })

  it('a graded addition IS in the denominator, in both stages', () => {
    for (const stage of FORECAST_KC_STAGES) {
      const c = cfg({ addedKcQuestions: [addedMc('extra', { stage })] })
      expect(forecastKcScoringSet(c).map(q => q.field)).toContain('extra')
    }
  })

  it('⚠ `stage` is omitted at the grader, deliberately — gradedness is stage-independent', () => {
    const c = cfg({ addedKcQuestions: [addedMc('p', { stage: 'pre' }), addedMc('q', { stage: 'post' })] })
    expect(resolveAddedKcQuestions(c).map(q => q.id)).toEqual(['p', 'q'])
    expect(resolveAddedKcQuestions(c, 'pre').map(q => q.id)).toEqual(['p'])
    expect(resolveAddedKcQuestions(c, 'post').map(q => q.id)).toEqual(['q'])
  })
})

describe('the id guard', () => {
  it('⚠ REFUSES a `kc_` id — the authored set owns that namespace', () => {
    expect(parseAddedKcQuestion({ id: 'kc_goal', type: 'text', prompt: 'x' })).toBeNull()
    expect(FORECAST_KC_ID_GUARD).toEqual({ kind: 'prefix', prefix: 'kc_' })
  })

  it('accepts an ordinary id', () => {
    expect(parseAddedKcQuestion({ id: 'my_q', type: 'text', prompt: 'x' })?.id).toBe('my_q')
  })

  it('⚠⚠ TRIPWIRE — the guard does NOT cover `debrief_method`, and that is not a hole to plug', () => {
    // The prefix rule protects `kc_` only, so an added question may legally take the
    // debrief's id. It is harmless TODAY because the two answers live in DIFFERENT stored
    // maps (`free_text_answers` vs `kc_static_answers`) and the stage builders emit both
    // rows. Widening the guard would refuse ids that existing instances may already hold.
    // ⚠ IF SOMEBODY EVER UNIFIES THE ANSWER MAPS (spec §6 forbids it), THIS TEST IS THE
    // ALARM: it will still pass, and the collision will become real. Read it as a pin on
    // the CURRENT behaviour, not as an endorsement.
    expect(parseAddedKcQuestion({ id: DEBRIEF_ROW_ID, type: 'text', prompt: 'x' })?.id)
      .toBe(DEBRIEF_ROW_ID)
    const c = cfg({ addedKcQuestions: [addedText(DEBRIEF_ROW_ID, { stage: 'post' })] })
    // Two rows with the same field — the collision, made visible rather than assumed away.
    expect(forecastPostStage(c).filter(r => r.field === DEBRIEF_ROW_ID)).toHaveLength(2)
  })

  it('uses the SHARED parser — same result as calling it directly with forecast\'s guard', () => {
    const raw = { id: 'shared_q', type: 'mc', prompt: 'p', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }], correct_value: 'a', stage: 'post' }
    expect(parseAddedKcQuestion(raw))
      .toEqual(parseShared(raw, { guard: FORECAST_KC_ID_GUARD, stages: FORECAST_KC_STAGES }))
  })

  it('an unrecognised stage is dropped, falling back to the default', () => {
    const q = parseAddedKcQuestion({ id: 'q', type: 'text', prompt: 'p', stage: 'during' })!
    expect(q.stage).toBeUndefined()
    expect(addedKcStage(q)).toBe('pre')
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// 7. THE STAGES, AND THE SHUFFLE AT THE SERVE BOUNDARY
// ═══════════════════════════════════════════════════════════════════════════════

describe('the two stages', () => {
  it('pre = the authored nine + pre additions; post = the debrief + post additions', () => {
    const c = cfg({ addedKcQuestions: [addedMc('p1'), postMc('q1')] })
    expect(forecastPreStage(c).map(r => r.field)).toEqual([...AUTHORED_IDS, 'p1'])
    expect(forecastPostStage(c).map(r => r.field)).toEqual([DEBRIEF_ROW_ID, 'q1'])
  })

  it('⚠ the debrief row carries the INSTRUCTOR\'s prompt, not the data object\'s literal', () => {
    const c = cfg({ debriefPrompt: 'What did you actually do?' })
    expect(forecastPostStage(c)[0].prompt).toBe('What did you actually do?')
  })

  it('`debrief_enabled: false` removes the row — and leaves the stage otherwise intact', () => {
    const c = cfg({ debriefEnabled: false, addedKcQuestions: [postMc('q1')] })
    expect(forecastPostStage(c).map(r => r.field)).toEqual(['q1'])
  })

  it('⚠ `kind` distinguishes an ADDED free-text row from the debrief — they submit differently', () => {
    // MUTANT: derive kind from `type` (text ⇒ free-text). → fails, and in production it
    // would route an added paragraph to forecastSubmitDebrief, which only knows one field.
    const c = cfg({ addedKcQuestions: [postText('reflect')] })
    const rows = forecastPostStage(c)
    expect(rows.find(r => r.field === DEBRIEF_ROW_ID)!.kind).toBe('free-text')
    expect(rows.find(r => r.field === 'reflect')!.kind).toBe('added')
    expect(rows.find(r => r.field === 'reflect')!.type).toBe('text')
  })

  it('a hidden POST addition is absent from the stage', () => {
    const c = cfg({ addedKcQuestions: [postMc('q1'), postMc('q2')], kcHidden: { q1: true } })
    expect(forecastPostStage(c).map(r => r.field)).toEqual([DEBRIEF_ROW_ID, 'q2'])
  })
})

describe('the per-student shuffle, AT THE BOUNDARY THE SERVE PATH USES', () => {
  it('⚠⚠ every option reaches every position across students — not just two', () => {
    // MUTANT: shuffle only the first two positions (`i > out.length - 2`). → fails. This is
    // the exact regression shape that shipped once before (`cef36fe`), and a "the order
    // differs between two students" assertion does NOT catch it.
    const seen = new Map<string, Set<number>>()
    for (let p = 0; p < 400; p++) {
      const q = authoredToClient(cfg(), `p${p}`).find(x => x.field === 'kc_goal')!
      q.options.forEach((o, i) => {
        if (!seen.has(o.value)) seen.set(o.value, new Set())
        seen.get(o.value)!.add(i)
      })
    }
    expect(seen.size).toBe(4)
    for (const [value, positions] of seen) expect(positions.size, value).toBe(4)
  })

  it('is STABLE for one student — a reload does not move the options', () => {
    expect(authoredToClient(cfg(), 'alice')).toEqual(authoredToClient(cfg(), 'alice'))
  })

  it('⚠ the ADDED path shuffles too — through the function the callable actually calls', () => {
    // MUTANT: return `q.options` unshuffled from addedToClientKcQuestions. → fails. Most
    // people type the right answer first, so an unshuffled added question is answerable
    // without reading it.
    const c = cfg({ addedKcQuestions: [addedMc('a1')] })
    const orders = new Set<string>()
    for (let p = 0; p < 60; p++) {
      orders.add(addedToClientKcQuestions(c, `p${p}`, 'pre')[0].options.map(o => o.value).join(','))
    }
    expect(orders.size).toBeGreaterThan(1)
  })

  it('⚠ stageToClient shuffles mc rows and leaves free-text rows alone', () => {
    const c = cfg({ addedKcQuestions: [postMc('m1')] })
    const rows = stageToClient(forecastPostStage(c), 'alice')
    expect(rows.find(r => r.field === DEBRIEF_ROW_ID)!.options).toEqual([])
    expect(rows.find(r => r.field === 'm1')!.options).toHaveLength(4)
    const orders = new Set<string>()
    for (let p = 0; p < 60; p++) {
      orders.add(
        stageToClient(forecastPostStage(c), `p${p}`)
          .find(r => r.field === 'm1')!.options.map(o => o.value).join(','),
      )
    }
    expect(orders.size).toBeGreaterThan(1)
  })

  it('⚠ THE KEY NEVER SHIPS — from either source', () => {
    const c = cfg({ addedKcQuestions: [addedMc('a1')] })
    for (const q of authoredToClient(c, 'alice')) {
      expect(Object.keys(q).sort()).toEqual(['field', 'options', 'prompt'])
    }
    for (const q of addedToClientKcQuestions(c, 'alice', 'pre')) {
      expect(q).not.toHaveProperty('correct_value')
      expect(q).not.toHaveProperty('explanation')
    }
    for (const r of stageToClient(forecastPreStage(c), 'alice')) {
      expect(r).not.toHaveProperty('correct_value')
      expect(r).not.toHaveProperty('explanation')
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// 8. ⚠⚠ THE REVEAL GATE — the change with the most to lose
// ═══════════════════════════════════════════════════════════════════════════════

describe('revealGate', () => {
  it('refuses a student who has not finished — first, and regardless of the stage', () => {
    const g = revealGate({ ...pdoc({ finished_at: null }), free_text_answers: answeredDebrief }, cfg())
    expect(g.allowed).toBe(false)
  })

  it('refuses a finished student who has not written the debrief — TODAY\'S BEHAVIOUR, KEPT', () => {
    expect(revealGate(pdoc(), cfg()).allowed).toBe(false)
  })

  it('allows a finished student who HAS — the shipped configuration, unchanged', () => {
    expect(revealGate(pdoc({ free_text_answers: answeredDebrief }), cfg()).allowed).toBe(true)
  })

  it('allows when the debrief is switched off — there was never one to answer', () => {
    expect(revealGate(pdoc(), cfg({ debriefEnabled: false })).allowed).toBe(true)
  })

  it('⚠⚠ REFUSES while ANY visible post-stage row is unanswered — the rule, stated', () => {
    // MUTANT: gate on the debrief row alone (`if (config.debriefEnabled && !answered)`).
    // → fails. The reveal would be handed over with an instructor's own after-play question
    // still on screen, and it could then be answered off the answer key — the exact
    // contamination the gate exists to prevent.
    const c = cfg({ addedKcQuestions: [postMc('extra')] })
    expect(revealGate(pdoc({ free_text_answers: answeredDebrief }), c).allowed).toBe(false)
  })

  it('allows once the WHOLE stage is answered', () => {
    const c = cfg({ addedKcQuestions: [postMc('extra')] })
    const p = pdoc({
      free_text_answers: answeredDebrief,
      kc_static_answers: { extra: { answer: 'o0', correct: true } },
    })
    expect(revealGate(p, c).allowed).toBe(true)
  })

  it('⚠⚠ A HIDDEN POST QUESTION CANNOT BLOCK THE REVEAL FOREVER', () => {
    // MUTANT: build the gate's list from `config.addedKcQuestions` instead of
    // forecastPostStage(config). → fails. A question the student is never shown would be
    // permanently unanswerable, and the reveal — the highest-value screen in the game —
    // would be unreachable for the whole class with no way for the instructor to see why.
    const c = cfg({ addedKcQuestions: [postMc('ghost')], kcHidden: { ghost: true } })
    expect(revealGate(pdoc({ free_text_answers: answeredDebrief }), c).allowed).toBe(true)
  })

  it('⚠ nor can one removed by the kcEnabled toggle', () => {
    const c = cfg({ kcEnabled: false, addedKcQuestions: [postMc('graded_extra')] })
    expect(revealGate(pdoc({ free_text_answers: answeredDebrief }), c).allowed).toBe(true)
  })

  it('⚠ an UNGRADED post addition still blocks — visibility is the rule, not gradedness', () => {
    const c = cfg({ kcEnabled: false, addedKcQuestions: [postText('why')] })
    expect(revealGate(pdoc({ free_text_answers: answeredDebrief }), c).allowed).toBe(false)
  })

  it('⚠⚠ EACH ROW IS CHECKED AGAINST ITS OWN ANSWER MAP', () => {
    // MUTANT: read `free_text_answers` for every row. → fails: an added question stored in
    // kc_static_answers would never satisfy the gate, and the reveal would be unreachable.
    const c = cfg({ addedKcQuestions: [postText('reflect')] })
    const wrongMap = pdoc({
      free_text_answers: { ...answeredDebrief, reflect: { answer: 'filed in the wrong map' } },
    })
    expect(revealGate(wrongMap, c).allowed).toBe(false)
    const rightMap = pdoc({
      free_text_answers: answeredDebrief,
      kc_static_answers: { reflect: { answer: 'here' } },
    })
    expect(revealGate(rightMap, c).allowed).toBe(true)
  })

  it('an empty post stage passes outright', () => {
    expect(revealGate(pdoc(), cfg({ debriefEnabled: false })).allowed).toBe(true)
  })

  it('unansweredPostRows names exactly what the gate is refusing on', () => {
    const c = cfg({ addedKcQuestions: [postMc('a'), postMc('b')] })
    const p = pdoc({ kc_static_answers: { a: { answer: 'o0' } } })
    expect(unansweredPostRows(c, p).map(r => r.field)).toEqual([DEBRIEF_ROW_ID, 'b'])
    expect(isPostRowAnswered(forecastPostStage(c).find(r => r.field === 'a')!, p)).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// 9. THE SCORE — kcScoreOrNull, and why calcKCScore is NOT used here
// ═══════════════════════════════════════════════════════════════════════════════

describe('the empty graded set', () => {
  it('⚠⚠ kcScoreOrNull returns NULL where calcKCScore returns 1.0', () => {
    // MUTANT: swap kcScoreOrNull back for calcKCScore in submitKcAnswer. → fails. An
    // instance with the graded check OFF and one ungraded addition would stamp a PERFECT
    // score for answering a paragraph.
    expect(calcKCScore({}, []).score).toBe(1)
    expect(kcScoreOrNull({}, [])).toBeNull()
  })

  it('⚠ calcKCScore is UNCHANGED — thirteen negotiation games depend on that 1.0', () => {
    expect(calcKCScore({ a: 'x' }, [{ field: 'a', correct_value: 'x' }]).score).toBe(1)
    expect(calcKCScore({ a: 'y' }, [{ field: 'a', correct_value: 'x' }]).score).toBe(0)
  })

  it('the two agree wherever the graded set is non-empty', () => {
    const set = [{ field: 'a', correct_value: 'x' }, { field: 'b', correct_value: 'y' }]
    expect(kcScoreOrNull({ a: 'x', b: 'n' }, set)).toBe(calcKCScore({ a: 'x', b: 'n' }, set).score)
  })

  it('⚠⚠ THE WIRING, NOT THE PRIMITIVE — the grader\'s own decision function returns null', () => {
    // MUTANT: `calcKCScore(allAnswers, forScoring).score` inside forecastKcScoreFor.
    // → fails. The first version of this block tested kcScoreOrNull and calcKCScore side by
    // side and the mutant SURVIVED the whole suite, because the code that CHOOSES between
    // them was inlined in the callable where no unit test could reach it (spec §7).
    const c = cfg({ kcEnabled: false, addedKcQuestions: [addedText('t')] })
    expect(forecastKcScoreFor({ t: 'anything' }, c)).toBeNull()
  })

  it('the decision function scores a real set, and withholds until it is complete', () => {
    const c = cfg({ kcHidden: Object.fromEntries(AUTHORED_IDS.slice(2).map(i => [i, true])) })
    expect(forecastKcScoreFor({ kc_systematic: 'systematic' }, c)).toBeNull()
    expect(forecastKcScoreFor({ kc_systematic: 'systematic', kc_goal: 'explain_describe' }, c)).toBe(1)
    expect(forecastKcScoreFor({ kc_systematic: 'systematic', kc_goal: 'wrong' }, c)).toBe(0.5)
  })

  it('⚠ a HIDDEN question is out of the denominator — the student can finish and be scored', () => {
    // The spec's named worst case in its live form: with the old inline `forScoring`, a
    // hidden question stayed in the denominator, so a student who answered every question
    // they were SHOWN never reached completion and was never scored at all.
    const c = cfg({ kcHidden: { kc_goal: true } })
    const answers = Object.fromEntries(
      forecastKcScoringSet(c).map(q => [q.field, q.correct_value]),
    )
    expect(forecastKcScoreFor(answers, c)).toBe(1)
  })

  it('a config with the check off and one free-text addition HAS an empty graded set', () => {
    const c = cfg({ kcEnabled: false, addedKcQuestions: [addedText('t')] })
    expect(forecastKcScoringSet(c)).toEqual([])
    expect(kcScoreOrNull({ t: 'anything' }, forecastKcScoringSet(c))).toBeNull()
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// 10. THE PARSERS
// ═══════════════════════════════════════════════════════════════════════════════

describe('the stored maps parse defensively', () => {
  it('parseKcHidden keeps only booleans', () => {
    // ⚠ A `false` entry is DROPPED, not kept: the map is a set of hidden ids, so a stale
    // `false` cannot be mistaken for an assertion that a question exists.
    expect(parseKcHidden({ a: true, b: false, c: 'yes', d: 1 })).toEqual({ a: true })
  })
  it('parseKcOrder keeps only finite numbers', () => {
    expect(parseKcOrder({ a: 0, b: 2.5, c: 'x', d: NaN })).toEqual({ a: 0, b: 2.5 })
  })
  it('parseKcOverrides keeps only string prompts and string option labels', () => {
    expect(parseKcOverrides({ a: { prompt: 'p', options: { o: 'l', bad: 3 } }, b: 'nope' }))
      .toEqual({ a: { prompt: 'p', options: { o: 'l' } } })
  })
  it('all three are total on undefined', () => {
    expect(parseKcHidden(undefined)).toEqual({})
    expect(parseKcOrder(undefined)).toEqual({})
    expect(parseKcOverrides(undefined)).toEqual({})
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// 11. ONE-BUILDER CHECK
// ═══════════════════════════════════════════════════════════════════════════════

describe('one resolver, not two', () => {
  it('⚠⚠ the SERVE path and the GRADER see the same ids, under every perturbation', () => {
    // The spec's named worst case (§5): a second list in submitKcAnswer. This asserts the
    // property rather than the shape, so a re-introduced second list fails here.
    const cases: ForecastConfig[] = [
      cfg(),
      cfg({ kcHidden: { kc_goal: true } }),
      cfg({ kcOrder: { kc_parsimony: 0 } }),
      cfg({ kcEnabled: false, addedKcQuestions: [addedText('t')] }),
      cfg({ addedKcQuestions: [addedMc('g'), addedText('u'), postMc('pg')] }),
      cfg({ addedKcQuestions: [addedMc('g')], kcHidden: { g: true } }),
    ]
    for (const c of cases) {
      const served = new Set([
        ...forecastPreStage(c).map(r => r.field),
        ...forecastPostStage(c).map(r => r.field),
      ])
      for (const q of forecastKcScoringSet(c)) {
        expect(served.has(q.field), `${q.field} is graded but never served`).toBe(true)
      }
    }
  })
})
