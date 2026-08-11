import { describe, it, expect } from 'vitest'
import { calcKCScore } from '@mygames/game-server'
import {
  KC_POOL_IDS, poolForFormat, defaultVisibleFor,
  resolveBuiltIns, resolveBuiltInsUnordered, resolveAddedKcQuestions,
  procurementScoringSet, procurementKcScoreFor, applyKcOverride, isGradedAdded,
  procurementPreStage, procurementDebriefStage, stageToClient, addedToClientKcQuestions,
  procurementBuiltInIdsForFormat,
} from '../src/procurement/questions'
import {
  DEFAULT_CONFIG, loadProcurementConfig, migrateKcHidden, parseAddedKcQuestion,
  procurementKcIdGuard, addedKcStage, DEFAULT_ADDED_KC_STAGE, PROCUREMENT_KC_STAGES,
  type ProcurementConfig, type ProcurementAddedKcQuestion,
} from '../src/procurement/config'
import {
  lockedKcQuestionIds, probeDetector, validateKcOverrides, procurementOverrideContext,
  KC_LOCK_REASON,
} from '../src/procurement/kcLock'
import {
  parseAddedKcQuestion as parseShared, parseKcHidden, parseKcOrder, parseKcOverrides,
} from '../src/shared/kcSurface'

// ═══════════════════════════════════════════════════════════════════════════════
// PROCUREMENT — the shared KC surface (convergence spec §5, §7). SIXTH AND LAST adopter.
//
// ⚠⚠ THE CENTRE OF THIS FILE IS D18: THE `kcVisible` → `kc_hidden` MIGRATION. Procurement
// shipped the OPPOSITE polarity from the other five — a whitelist ARRAY of the ids switched
// ON, where the family stores a map of the ids switched OFF. A conversion that carries ids
// across without inverting them flips every live instance, so every branch of it is pinned
// here with the mutant it catches.
//
// ⚠ NOTHING IS LOCKED HERE, as in newsvendor and forecast — v3 rewrote every question as a
// self-contained hypothetical. The detector is proved over a controlled probe set AND
// through its own normalisation.
//
// Every test names the mutant it catches. All were calibrated by breaking the code.
// ═══════════════════════════════════════════════════════════════════════════════

const cfg = (over: Partial<ProcurementConfig> = {}): ProcurementConfig =>
  ({ ...DEFAULT_CONFIG, ...over })
const openCfg = (over: Partial<ProcurementConfig> = {}) => cfg({ format: 'open_descending', ...over })

/** The pool, as this game actually ships it — measured, not asserted from the spec. */
const SEALED_IDS = defaultVisibleFor('sealed_first_price')
const OPEN_IDS = defaultVisibleFor('open_descending')

const addedMc = (id: string, over: Partial<ProcurementAddedKcQuestion> = {}): ProcurementAddedKcQuestion => ({
  id, type: 'mc', prompt: `Added ${id}?`,
  options: [
    { value: 'o0', label: 'First' }, { value: 'o1', label: 'Second' },
    { value: 'o2', label: 'Third' }, { value: 'o3', label: 'Fourth' },
  ],
  correct_value: 'o0',
  ...over,
})
const addedText = (id: string, over: Partial<ProcurementAddedKcQuestion> = {}): ProcurementAddedKcQuestion => ({
  id, type: 'text', prompt: `Tell me about ${id}`, ...over,
})
const debriefMc = (id: string) => addedMc(id, { stage: 'debrief' })

/** Load a config the way the callable does, from a raw stored document. */
const load = (doc: Record<string, unknown>) =>
  loadProcurementConfig(doc, KC_POOL_IDS, defaultVisibleFor)

// ═══════════════════════════════════════════════════════════════════════════════
// 0. THE POOL, MEASURED — everything below depends on these being the real ids
// ═══════════════════════════════════════════════════════════════════════════════

describe('the shipped pool', () => {
  it('⚠ is 19 questions, not the 17 the spec predicted', () => {
    // A finding, reported rather than papered over: the pool is S1–S9 and O1–O10.
    expect(KC_POOL_IDS).toHaveLength(19)
    expect(SEALED_IDS).toHaveLength(9)
    expect(OPEN_IDS).toHaveLength(13)
  })

  it('⚠⚠ THE TWO FORMAT SETS ARE **NOT** DISJOINT — S1, S3 and S5 are in BOTH', () => {
    // ⚠ ASSERTED, NOT ASSUMED (spec §6). Pricing's and newsvendor's mode sets ARE disjoint,
    // and the family's flat id-keyed map is mode-isolated because of it. Procurement is the
    // exception: three questions are tagged for both formats and appear under the SAME id in
    // each. A flat map therefore gives those three SHARED state across the flip and gives
    // every exclusive question isolated state — which is right, because a shared question is
    // literally the same question. The isolation tests below use an EXCLUSIVE id.
    const shared = SEALED_IDS.filter(id => OPEN_IDS.includes(id))
    expect(shared).toEqual(['S1', 'S3', 'S5'])
  })

  it('the free-text questions are pool entries with ordinary ids', () => {
    // ⚠ This is why procurement needs no boundary translation and no `debriefPrompt` key,
    // and why its guard covers the free-text ids that every other game leaves outside.
    const text = poolForFormat('sealed_first_price').filter(q => q.kind !== 'mc')
    expect(text.map(q => q.id)).toEqual(['S8', 'S9'])
    expect(text.every(q => q.correct_value === null)).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// 1. ⚠⚠ D18 — THE MIGRATION
// ═══════════════════════════════════════════════════════════════════════════════

describe('migrateKcHidden — kcVisible → kc_hidden', () => {
  it('⚠⚠ A LEGACY WHITELIST HIDES EXACTLY THE IDS IT OMITS, AND ONLY THOSE', () => {
    // MUTANT: carry the values across without inverting — `for (const id of visible)
    // out[id] = true`. → fails. That mutation flips every live instance: every question an
    // instructor deliberately hid becomes visible and every visible one hides. This is the
    // single most dangerous line in the pass.
    const hidden = migrateKcHidden(
      { kcHidden: undefined, kcVisible: SEALED_IDS.filter(id => id !== 'S3') },
      SEALED_IDS,
    )
    expect(hidden).toEqual({ S3: true })
  })

  it('⚠ DROPS the visible entries — the map is short, like every other game\'s', () => {
    // MUTANT: write `out[id] = false` for a visible id. → fails. `kcVisible` was FULL (the
    // shipped default is every id for the format), so carrying it whole would leave
    // procurement holding a 9- or 13-entry map where the family holds a 1-entry one — the
    // same inconsistency under a new name, which is the thing D18 exists to end.
    const hidden = migrateKcHidden({ kcHidden: undefined, kcVisible: SEALED_IDS }, SEALED_IDS)
    expect(hidden).toEqual({})
    expect(Object.keys(hidden)).toHaveLength(0)
  })

  it('⚠⚠ `kc_hidden` WINS when both fields are present', () => {
    // MUTANT: check kcVisible first. → fails. Should not happen — a save that writes
    // kc_hidden deletes kcVisible — but "should not happen" is not a guarantee, and the new
    // field is the one a save actually wrote.
    const hidden = migrateKcHidden(
      { kcHidden: { S7: true }, kcVisible: SEALED_IDS },   // the array says nothing is hidden
      SEALED_IDS,
    )
    expect(hidden).toEqual({ S7: true })
  })

  it('a fresh instance with NEITHER field hides nothing', () => {
    // MUTANT: default to hiding everything (`for (const id of pool) out[id] = true`).
    // → fails. An absent `kcVisible` means never configured, and the old code's fallback
    // was `defaultVisibleFor(format)` — every question ON. Same behaviour, new field.
    expect(migrateKcHidden({ kcHidden: undefined, kcVisible: undefined }, SEALED_IDS)).toEqual({})
  })

  it('⚠ an EMPTY array is "ask nothing", NOT "never configured"', () => {
    // MUTANT: treat `[]` like absent and return {}. → fails. config.ts already carried this
    // distinction for `kcVisible` and the migration must not lose it: re-defaulting would
    // silently switch the whole knowledge check back on the next time anyone loaded.
    expect(migrateKcHidden({ kcHidden: undefined, kcVisible: [] }, SEALED_IDS))
      .toEqual(Object.fromEntries(SEALED_IDS.map(id => [id, true])))
  })

  it('⚠⚠ SCOPED TO THE FORMAT\'S POOL — the other format\'s ids are left UNMENTIONED', () => {
    // MUTANT: pass KC_POOL_IDS instead of the format's pool at the call site in config.ts.
    // → fails. Converting against the whole pool marks every open-format id hidden, so an
    // instructor who flipped a legacy sealed instance to open would find an EMPTY knowledge
    // check with nothing on screen to explain why.
    const hidden = migrateKcHidden({ kcHidden: undefined, kcVisible: SEALED_IDS }, SEALED_IDS)
    for (const id of OPEN_IDS.filter(i => !SEALED_IDS.includes(i))) {
      expect(hidden[id], id).toBeUndefined()
    }
  })

  it('a legacy instance that is never re-saved still hides correctly on EVERY read', () => {
    // MUTANT: delete the legacy read branch (`if (!Array.isArray(...)) return {}` for all).
    // → fails. The branch is live code until no instance holds `kcVisible`; deleting it
    // strands every instance an instructor has not happened to re-save.
    const c = load({ kcVisible: SEALED_IDS.filter(id => id !== 'S4') })
    expect(c.kcHidden).toEqual({ S4: true })
    expect(resolveBuiltIns(c, 'kc').map(q => q.id)).not.toContain('S4')
    expect(procurementScoringSet(c).map(q => q.field)).not.toContain('S4')
  })

  it('⚠⚠ A FORMAT FLIP MADE BEFORE ANY SAVE REPRODUCES THE LEGACY BEHAVIOUR EXACTLY', () => {
    // ⚠ THIS EXPECTATION WAS WRONG THE FIRST TIME AND THE SUITE CAUGHT IT. I asserted that
    // the open-only ids stayed VISIBLE — an improvement on the old behaviour — and the code
    // said otherwise. The code is right: a MIGRATION MUST NOT CHANGE BEHAVIOUR. What the old
    // reader did with a sealed-era whitelist under an open format was show ONLY the
    // whitelisted ids, because `resolveQuestions` filtered by `on.has(id)`; the config.ts
    // comment defends it as "keeps their choices for the questions that still apply and
    // loses the ones that do not". The conversion reproduces that, id for id.
    //
    // ⚠ The instructor's escape hatch is better than it was, and that IS the improvement:
    // the settings page now lists O1…O10 with their boxes unticked, so the empty check is
    // visible and fixable instead of being an unexplained absence.
    const c = load({ format: 'open_descending', kcVisible: ['S1', 'S5'] })   // S3 omitted
    expect(c.kcHidden.S3).toBe(true)
    expect(c.kcHidden.O1).toBe(true)
    const served = resolveBuiltIns(c, 'kc').map(q => q.id)
    expect(served).toEqual(['S1', 'S5'])

    // ⚠ FIDELITY, ASSERTED DIRECTLY: the migrated read serves exactly what the legacy
    // filter would have served, rather than merely looking similar.
    const legacy = poolForFormat('open_descending')
      .filter(q => q.stage === 'kc' && ['S1', 'S5'].includes(q.id))
      .map(q => q.id)
    expect(served).toEqual(legacy)
  })

  it('a MIGRATED instance reads its own kc_hidden and ignores the stale array', () => {
    const c = load({ kc_hidden: { S2: true }, kcVisible: SEALED_IDS })
    expect(c.kcHidden).toEqual({ S2: true })
  })

  it('non-string entries in the legacy array are ignored', () => {
    expect(migrateKcHidden({ kcHidden: undefined, kcVisible: ['S1', 7, null] as unknown[] }, ['S1', 'S2']))
      .toEqual({ S2: true })
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// 2. HIDE, ORDER, OVERRIDES
// ═══════════════════════════════════════════════════════════════════════════════

describe('kc_hidden', () => {
  it('removes a question from the served set AND from the denominator', () => {
    // MUTANT: filter the display only, leaving the scoring set intact. → the second half
    // fails. This is the bug forecast actually shipped (spec §5).
    const c = cfg({ kcHidden: { S2: true } })
    expect(resolveBuiltIns(c, 'kc').map(q => q.id)).not.toContain('S2')
    expect(procurementScoringSet(c).map(q => q.field)).not.toContain('S2')
  })

  it('hides a free-text built-in, and an added question', () => {
    const c = cfg({ addedKcQuestions: [addedMc('extra')], kcHidden: { S8: true, extra: true } })
    expect(resolveBuiltIns(c, 'prep')).toEqual([])
    expect(resolveAddedKcQuestions(c)).toEqual([])
  })

  it('⚠ only an explicit true hides', () => {
    expect(resolveBuiltIns(cfg({ kcHidden: { S2: false } }), 'kc').map(q => q.id)).toContain('S2')
  })
})

describe('kc_order', () => {
  it('reorders within a stage', () => {
    // MUTANT: return the list unsorted from applyKcOrder. → fails.
    const ids = procurementPreStage(cfg({ kcOrder: { S7: -1 } })).map(r => r.field)
    expect(ids[0]).toBe('S7')
  })

  it('⚠⚠ is applied EXACTLY ONCE per stage — a DISCRIMINATING partial map proves it', () => {
    // MUTANT: point procurementDebriefStage at resolveAddedKcQuestions (the ORDERED one)
    // instead of the unordered one, so `order` runs in the resolver AND again over the
    // stage. → this fails; most partial maps do NOT, because applyKcOrder is idempotent on a
    // complete map and keys an unmentioned id on its own index. Divergence needs an
    // UNMENTIONED addition shifted across a MENTIONED row (spec §6).
    const c = cfg({
      addedKcQuestions: [debriefMc('akc_a'), debriefMc('akc_b'), debriefMc('akc_c')],
      kcOrder: { S9: 2, akc_a: 9 },
    })
    expect(procurementDebriefStage(c).map(r => r.field))
      .toEqual(['S9', 'akc_b', 'akc_c', 'akc_a'])
  })

  it('orders ACROSS kinds — an addition can precede a built-in', () => {
    const c = cfg({ addedKcQuestions: [addedMc('mine')], kcOrder: { mine: -1 } })
    expect(procurementPreStage(c)[0].field).toBe('mine')
  })

  it('survives a save/reload round trip', () => {
    // MUTANT: drop `order` on write (never set configPatch.kc_order). → fails.
    const stored = { kc_order: { S7: -1, S1: 5 } }
    expect(load(stored).kcOrder).toEqual({ S7: -1, S1: 5 })
    expect(procurementPreStage(load(stored)).map(r => r.field)[0]).toBe('S7')
  })
})

describe('kc_overrides', () => {
  it('replaces the prompt, and an option LABEL looked up BY VALUE', () => {
    // MUTANT: index options by POSITION. → fails on the unknown-key half below.
    const first = poolForFormat('sealed_first_price').find(q => q.kind === 'mc')!
    const opt = first.options[0].value
    const c = cfg({ kcOverrides: { [first.id]: { prompt: 'Rewritten?', options: { [opt]: 'New label' } } } })
    const q = resolveBuiltIns(c, 'kc').find(x => x.id === first.id)!
    expect(q.prompt).toBe('Rewritten?')
    expect(q.options.find(o => o.value === opt)!.label).toBe('New label')
    expect(q.options).toHaveLength(first.options.length)
  })

  it('an unknown option key is INERT in the resolver (and REFUSED at the callable)', () => {
    // MUTANT: index by position — then this key WOULD apply, to the wrong option.
    const c = cfg({ kcOverrides: { S1: { options: { not_an_option: 'ignored' } } } })
    const q = resolveBuiltIns(c, 'kc').find(x => x.id === 'S1')!
    expect(q.options.map(o => o.label)).not.toContain('ignored')
  })

  it('⚠⚠ CANNOT move a score — the key is untouched, for EVERY question', () => {
    // MUTANT: let applyKcOverride write `correct_value`. → fails.
    const bare = resolveBuiltIns(cfg(), 'kc')
    const overrides = Object.fromEntries(bare.map(q => [
      q.id, { prompt: 'x', options: Object.fromEntries(q.options.map(o => [o.value, 'y'])) },
    ]))
    const edited = resolveBuiltIns(cfg({ kcOverrides: overrides }), 'kc')
    for (const q of bare) {
      expect(edited.find(x => x.id === q.id)!.correct_value, q.id).toBe(q.correct_value)
    }
    expect(procurementScoringSet(cfg({ kcOverrides: overrides })))
      .toEqual(procurementScoringSet(cfg()))
  })

  it('⚠ NO override → the generated text is served unchanged', () => {
    // MUTANT: always read the override map (e.g. `o?.prompt ?? ''`). → fails.
    const raw = poolForFormat('sealed_first_price')[0]
    expect(applyKcOverride(raw, {})).toBe(raw)
    expect(resolveBuiltIns(cfg(), 'kc')[0].prompt).toBe(raw.prompt)
  })

  it('edits a FREE-TEXT built-in through the same map — no config key exists for it', () => {
    // ⚠ Procurement's distinguishing property: the other five translate their paragraph
    // prompts to and from `prepPrompt`/`debriefPrompt` at the page boundary. Here the
    // paragraphs ARE pool entries, so they take an override like anything else.
    const c = cfg({ kcOverrides: { S9: { prompt: 'What surprised you?' } } })
    expect(resolveBuiltIns(c, 'debrief')[0].prompt).toBe('What surprised you?')
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// 3. THE LOCK DETECTOR
// ═══════════════════════════════════════════════════════════════════════════════

describe('the lock detector', () => {
  it('⚠ MEASURES that NOTHING is locked, in EITHER format', () => {
    expect([...lockedKcQuestionIds(cfg())]).toEqual([])
    expect([...lockedKcQuestionIds(openCfg())]).toEqual([])
  })

  it('⚠⚠ THE SELF-PROOF: the SAME comparison over a controlled probe set fires correctly', () => {
    // MUTANT: make lockedKcQuestionIds/probeDetector return `new Set()` unconditionally.
    // → the two assertions above still pass (they expect empty!) and THIS one fails on every
    // parameterised probe. Without it, "0 of 19 locked" proves nothing.
    const opts = [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }]
    const locked = probeDetector(cfg(), c => [
      { id: 'static', prompt: 'Fixed.', options: opts, explanation: 'Fixed.' },
      { id: 'stem', prompt: `The reserve is ${c.reserve}.`, options: opts, explanation: 'x' },
      {
        id: 'option',
        prompt: 'Pick one.',
        options: [{ value: 'a', label: `${c.rivalCount}` }, { value: 'b', label: 'B' }],
        explanation: 'x',
      },
      { id: 'explanation', prompt: 'Fixed.', options: opts, explanation: `${c.currencyLabel}` },
    ])
    expect([...locked].sort()).toEqual(['explanation', 'option', 'stem'])
  })

  it('⚠⚠ THE NORMALISATION IS EXERCISED — an instructor\'s edit does not forbid the next one', () => {
    // MUTANT: drop `kcHidden: {}, kcOverrides: {}, kcOrder: {}` from `bare`. → fails. The
    // probe perturbs those maps precisely so this is observable; forecast's first version did
    // not, and the mutant survived (spec §7).
    const readsMaps = (c: ProcurementConfig) => [{
      id: 'reads_map',
      prompt: `Overrides: ${Object.keys(c.kcOverrides).sort().join('|')}.`,
      options: [{ value: 'a', label: `${Object.keys(c.kcHidden).sort().join('|')}` }],
      explanation: `${Object.keys(c.kcOrder).sort().join('|')}`,
    }]
    expect([...probeDetector(cfg({ kcOverrides: { S1: { prompt: 'Edited' } } }), readsMaps)])
      .toEqual([])
  })

  it('⚠ a hidden or edited question is still classified, and the toggle does not lock the lot', () => {
    expect([...lockedKcQuestionIds(cfg({
      kcEnabled: false, kcHidden: { S1: true }, kcOverrides: { S2: { prompt: 'Edited' } },
    }))]).toEqual([])
  })
})

describe('validateKcOverrides — the server-side half of the lock', () => {
  // ⚠⚠ THE CONTEXT THE CALLABLE ACTUALLY PASSES, not one this file made up. A mutant that
  // widened `builtInIds` at the CALL SITE survived forecast's whole suite because every test
  // built its own context (spec §7).
  const ctx = procurementOverrideContext(cfg())

  it('the real context locks nothing and knows the whole pool', () => {
    expect([...ctx.locked]).toEqual([])
    expect(ctx.builtInIds.size).toBe(19)
    expect(ctx.optionIds.has('S1')).toBe(true)
  })

  it('accepts a legal rewrite', () => {
    const opt = poolForFormat('sealed_first_price')[0].options[0].value
    expect(validateKcOverrides({ S1: { prompt: 'New', options: { [opt]: 'Nail it' } } }, ctx))
      .toEqual([])
  })

  it('REFUSES an unknown option id', () => {
    expect(validateKcOverrides({ S1: { options: { nope: 'x' } } }, ctx)[0].reason).toBe('unknown-option')
  })

  it('REFUSES an override aimed at something that is not a built-in', () => {
    expect(validateKcOverrides({ made_up: { prompt: 'x' } }, ctx)[0].reason).toBe('not-built-in')
  })

  it('⚠ CARRIES an override for the OTHER format\'s question rather than refusing it', () => {
    // MUTANT: refuse when `optionIds` has no entry. → fails. The page round-trips the whole
    // map on every save, so refusing would make it unsaveable the moment somebody flipped
    // format, with the instructor's own earlier work as the cause. Pricing hit this exactly.
    expect(validateKcOverrides({ O1: { prompt: 'edited in the other format' } }, ctx)).toEqual([])
  })

  it('REFUSES a rewrite of a LOCKED question, and says why', () => {
    const r = validateKcOverrides({ S1: { prompt: 'x' } }, { ...ctx, locked: new Set(['S1']) })
    expect(r[0].reason).toBe('locked')
    expect(r[0].message).toContain(KC_LOCK_REASON.toLowerCase())
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// 4. ADDED QUESTIONS — the guard, the default stage, D12, D3
// ═══════════════════════════════════════════════════════════════════════════════

describe('the id guard', () => {
  it('⚠⚠ IS THE EXPLICIT ID SET, NOT THE `kc_` PREFIX RULE', () => {
    // MUTANT: use `{ kind: 'prefix', prefix: 'kc_' }`. → fails. procurement's built-in ids
    // are UNPREFIXED, so the prefix rule protects NOTHING here: `S3` would be accepted and
    // would shadow a built-in in the grader's lookup. Scorecard is in the same position.
    expect(procurementKcIdGuard()).toEqual({ kind: 'idSet', ids: procurementBuiltInIdsForFormat() })
    expect(parseAddedKcQuestion({ id: 'S3', type: 'text', prompt: 'x' })).toBeNull()
    expect(parseAddedKcQuestion({ id: 'O10', type: 'text', prompt: 'x' })).toBeNull()
    // ⚠ And a `kc_` id is FINE here — nothing in this game owns that namespace.
    expect(parseAddedKcQuestion({ id: 'kc_mine', type: 'text', prompt: 'x' })?.id).toBe('kc_mine')
  })

  it('⚠ THE GUARD COVERS THE FREE-TEXT IDS TOO — unlike every other game', () => {
    // Elsewhere `prep_strategy` / `debrief_regular` / `debrief_method` sit OUTSIDE the prefix
    // rule and are safe only because the answer maps are separate (spec §6). Here they are
    // ordinary pool entries, so the id set covers them and the collision cannot happen.
    expect(parseAddedKcQuestion({ id: 'S8', type: 'text', prompt: 'x' })).toBeNull()
    expect(parseAddedKcQuestion({ id: 'S9', type: 'text', prompt: 'x' })).toBeNull()
  })

  it('uses the SHARED parser — same result as calling it directly with procurement\'s guard', () => {
    const raw = { id: 'mine', type: 'mc', prompt: 'p', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }], correct_value: 'a', stage: 'debrief' }
    expect(parseAddedKcQuestion(raw))
      .toEqual(parseShared(raw, { guard: procurementKcIdGuard(), stages: PROCUREMENT_KC_STAGES }))
  })
})

describe('added questions', () => {
  it('⚠⚠ THE STAGE-LESS DEFAULT IS `kc`, AND IT WAS CHOSEN RATHER THAN MEASURED', () => {
    // MUTANT: flip it to 'debrief'. → fails. ⚠ Procurement is the ONE game where this value
    // is a free choice (D16): the other five each MEASURED where their existing additions
    // were already being served, because a different value would relocate live questions.
    // Procurement has never had an `addedKcQuestions` field, so there is no history and
    // nothing to measure. `kc` matches the other four prefixed games.
    expect(DEFAULT_ADDED_KC_STAGE).toBe('kc')
    expect(addedKcStage(addedMc('x'))).toBe('kc')
    expect(addedKcStage(addedMc('x', { stage: 'debrief' }))).toBe('debrief')
    expect(PROCUREMENT_KC_STAGES).toEqual(['kc', 'debrief'])
  })

  it('an unrecognised stage falls back to the default', () => {
    const q = parseAddedKcQuestion({ id: 'q', type: 'text', prompt: 'p', stage: 'prep' })!
    expect(q.stage).toBeUndefined()
    expect(addedKcStage(q)).toBe('kc')
  })

  it('⚠ D12 — the toggle gates GRADED questions only', () => {
    // MUTANT: `const gated = config.kcEnabled ? visible : []`. → fails.
    const c = cfg({ kcEnabled: false, addedKcQuestions: [addedMc('graded'), addedText('ungraded')] })
    expect(resolveAddedKcQuestions(c).map(q => q.id)).toEqual(['ungraded'])
  })

  it('⚠ and it gates the graded BUILT-INS while leaving the paragraphs alone', () => {
    // ⚠ Already procurement's shipped behaviour, now stated by the page (spec §9).
    const c = cfg({ kcEnabled: false })
    expect(resolveBuiltIns(c, 'kc')).toEqual([])
    expect(resolveBuiltIns(c, 'prep').map(q => q.id)).toEqual(['S8'])
    expect(resolveBuiltIns(c, 'debrief').map(q => q.id)).toEqual(['S9'])
  })

  it('⚠⚠ THE GATE IS IN THE RESOLVER, not only in the callers', () => {
    // MUTANT: delete the `if (stage === 'kc' && !config.kcEnabled) return []` line and put
    // the ternary back in getQuestions. → fails. That is the shape scorecard AND forecast
    // each shipped a real bug in; procurement had three copies of the ternary that happened
    // to agree.
    expect(resolveBuiltInsUnordered(cfg({ kcEnabled: false }), 'kc')).toEqual([])
    expect(procurementScoringSet(cfg({ kcEnabled: false }))).toEqual([])
  })

  it('⚠ GRADEDNESS FOLLOWS THE ANSWER KEY (D3), not the stage and not the type', () => {
    // MUTANT: grade by stage (`stage === 'kc'`). → fails on both halves: a keyless mc in
    // `kc` would count, and a graded mc in `debrief` would not.
    const c = cfg({
      addedKcQuestions: [
        addedMc('keyless', { correct_value: undefined }),
        debriefMc('graded_in_debrief'),
      ],
    })
    expect(isGradedAdded(c.addedKcQuestions[0])).toBe(false)
    const ids = procurementScoringSet(c).map(q => q.field)
    expect(ids).not.toContain('keyless')
    expect(ids).toContain('graded_in_debrief')
  })

  it('⚠ a keyless MC addition is NOT graded — by key, not by type', () => {
    // MUTANT: `isGradedAdded = q => q.type === 'mc'`. → fails.
    const c = cfg({ addedKcQuestions: [addedMc('keyless', { correct_value: undefined })] })
    expect(procurementScoringSet(c).map(q => q.field)).not.toContain('keyless')
  })

  it('⚠ `stage` is omitted at the grader — gradedness is stage-independent', () => {
    const c = cfg({ addedKcQuestions: [addedMc('p'), debriefMc('d')] })
    expect(resolveAddedKcQuestions(c).map(q => q.id)).toEqual(['p', 'd'])
    expect(resolveAddedKcQuestions(c, 'kc').map(q => q.id)).toEqual(['p'])
    expect(resolveAddedKcQuestions(c, 'debrief').map(q => q.id)).toEqual(['d'])
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// 5. THE STAGES AND THE SHUFFLE
// ═══════════════════════════════════════════════════════════════════════════════

describe('the two stages', () => {
  it('pre = graded built-ins + the prep paragraph + kc-stage additions', () => {
    const c = cfg({ addedKcQuestions: [addedMc('mine'), debriefMc('later')] })
    const pre = procurementPreStage(c).map(r => r.field)
    expect(pre).toEqual([...SEALED_IDS.filter(id => id !== 'S9'), 'mine'])
    expect(procurementDebriefStage(c).map(r => r.field)).toEqual(['S9', 'later'])
  })

  it('⚠ `kind` routes the submit — and an ADDED free-text row is NOT `free-text`', () => {
    // MUTANT: derive kind from type (`text ⇒ free-text`). → fails. In production it would
    // post an added paragraph to procurementSubmitFreeText, which only knows pool ids.
    const c = cfg({ addedKcQuestions: [addedText('reflect')] })
    const rows = procurementPreStage(c)
    expect(rows.find(r => r.field === 'S8')!.kind).toBe('free-text')
    expect(rows.find(r => r.field === 'S1')!.kind).toBe('authored')
    const added = rows.find(r => r.field === 'reflect')!
    expect(added.kind).toBe('added')
    expect(added.type).toBe('text')
  })

  it('⚠⚠ MODE-SWAP ISOLATION, BOTH DIRECTIONS, AND THE ROUND TRIP', () => {
    // MUTANT: key the maps by POSITION rather than by id. → fails: position 0 is S1 in one
    // format and S1 in the other but position 3 is S4 vs O2, so a hide would leak.
    // ⚠ An EXCLUSIVE id (S7, sealed-only) — the shared S1/S3/S5 deliberately DO carry across.
    const hidden = { S7: true }
    expect(resolveBuiltIns(cfg({ kcHidden: hidden }), 'kc').map(q => q.id)).not.toContain('S7')
    // flip to open: not applied, nothing lost
    const asOpen = openCfg({ kcHidden: hidden })
    expect(resolveBuiltIns(asOpen, 'kc').map(q => q.id)).toEqual(OPEN_IDS.filter(id => id !== 'S9' && id !== 'O10' && id !== 'S8' && id !== 'O9'))
    // flip back: still there
    expect(resolveBuiltIns(cfg({ kcHidden: hidden }), 'kc').map(q => q.id)).not.toContain('S7')
  })

  it('⚠ a SHARED question\'s hide DOES carry across the flip, deliberately', () => {
    // S1/S3/S5 are tagged for both formats and are the SAME question under the same id, so
    // an instructor who switches one off has switched off that question, not "the sealed
    // copy of it". Asserted rather than left implicit — it is the consequence of the two
    // sets not being disjoint.
    const c = { kcHidden: { S3: true } }
    expect(resolveBuiltIns(cfg(c), 'kc').map(q => q.id)).not.toContain('S3')
    expect(resolveBuiltIns(openCfg(c), 'kc').map(q => q.id)).not.toContain('S3')
  })
})

describe('the per-student shuffle, AT THE BOUNDARY THE CALLABLE COMPOSES', () => {
  it('⚠⚠ every option reaches every position across students — not just two', () => {
    // MUTANTS: (a) drop the question id from the seed, (b) a two-slot swap. → both fail.
    // ⚠ "Not always first" alone passes (b) with three-quarters of the information leaking.
    const seen = new Map<string, Set<number>>()
    for (let p = 0; p < 400; p++) {
      const row = stageToClient(procurementPreStage(cfg()), `p${p}`).find(r => r.field === 'S1')!
      row.options.forEach((o, i) => {
        if (!seen.has(o.value)) seen.set(o.value, new Set())
        seen.get(o.value)!.add(i)
      })
    }
    const n = poolForFormat('sealed_first_price').find(q => q.id === 'S1')!.options.length
    expect(seen.size).toBe(n)
    for (const [value, positions] of seen) expect(positions.size, value).toBe(n)
  })

  it('⚠ the seed includes the QUESTION ID — two questions do not share a permutation', () => {
    // MUTANT: drop the id from the hash key. → fails.
    const orders = new Set(
      stageToClient(procurementPreStage(cfg()), 'alice')
        .filter(r => r.options.length === 4)
        .map(r => r.options.map(o => o.value).join(',')),
    )
    expect(orders.size).toBeGreaterThan(1)
  })

  it('is STABLE for one student', () => {
    expect(stageToClient(procurementPreStage(cfg()), 'alice'))
      .toEqual(stageToClient(procurementPreStage(cfg()), 'alice'))
  })

  it('⚠ the ADDED path shuffles, through the function the callable calls', () => {
    // MUTANT: return `q.options` unshuffled from addedToClientKcQuestions. → fails.
    const c = cfg({ addedKcQuestions: [addedMc('mine')] })
    const orders = new Set<string>()
    for (let p = 0; p < 60; p++) {
      orders.add(addedToClientKcQuestions(c, `p${p}`, 'kc')[0].options.map(o => o.value).join(','))
    }
    expect(orders.size).toBeGreaterThan(1)
  })

  it('⚠ the STAGE path shuffles added rows too, and leaves free text alone', () => {
    // MUTANT: don't shuffle the stage path (return rows untouched). → fails.
    const c = cfg({ addedKcQuestions: [addedMc('mine')] })
    const orders = new Set<string>()
    for (let p = 0; p < 60; p++) {
      orders.add(
        stageToClient(procurementPreStage(c), `p${p}`)
          .find(r => r.field === 'mine')!.options.map(o => o.value).join(','),
      )
    }
    expect(orders.size).toBeGreaterThan(1)
    expect(stageToClient(procurementPreStage(c), 'alice').find(r => r.field === 'S8')!.options)
      .toEqual([])
  })

  it('⚠ THE KEY NEVER SHIPS from either source', () => {
    const c = cfg({ addedKcQuestions: [addedMc('mine')] })
    for (const r of stageToClient(procurementPreStage(c), 'alice')) {
      expect(r).not.toHaveProperty('correct_value')
      expect(r).not.toHaveProperty('explanation')
    }
    for (const q of addedToClientKcQuestions(c, 'alice', 'kc')) {
      expect(q).not.toHaveProperty('correct_value')
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// 6. ⚠⚠ THE SCORE — procurement's own guard, which must NOT become kcScoreOrNull
// ═══════════════════════════════════════════════════════════════════════════════

describe('procurementKcScoreFor — the empty-set guard', () => {
  it('⚠⚠ AN EMPTY GRADED SET WRITES NEITHER A SCORE NOR A STAMP', () => {
    // MUTANT: swap in `kcScoreOrNull` to "align" with the other five. → fails. It returns
    // null AND lets the caller stamp `knowledge_check_completed_at`, handing a student a
    // completed knowledge check the first time they open the screen. calcKCScore is worse
    // still: it answers the empty set with 1.0, a stored PERFECT score (spec §9).
    expect(procurementKcScoreFor({}, cfg({ kcEnabled: false }))).toBeNull()
    expect(calcKCScore({}, []).score).toBe(1)     // what the shared helper would have said
  })

  it('⚠⚠ THE GUARD IS NOW LIVE, AND THE OLD UNREACHABILITY INVARIANT IS GONE', () => {
    // ⚠ Spec §7 pinned the guard as unreachable: every `kc`-stage question carried a key and
    // every free-text question lived in another stage. ADDED QUESTIONS END THAT — an
    // instructor may put an ungraded question in the `kc` stage, or hide every graded one.
    // The spec predicted this exactly: "if someone adds an ungraded question to the kc stage,
    // the invariant test fails, the guard becomes live, and it then needs real coverage."
    // This is that coverage.
    const c = cfg({ kcEnabled: false, addedKcQuestions: [addedText('only_ungraded')] })
    expect(procurementScoringSet(c)).toEqual([])
    expect(procurementKcScoreFor({ only_ungraded: 'anything' }, c)).toBeNull()

    const allHidden = cfg({ kcHidden: Object.fromEntries(SEALED_IDS.map(id => [id, true])) })
    expect(procurementKcScoreFor({}, allHidden)).toBeNull()
  })

  it('withholds until the set is COMPLETE, then scores it', () => {
    const c = cfg({ kcHidden: Object.fromEntries(SEALED_IDS.filter(id => !['S1', 'S2'].includes(id)).map(id => [id, true])) })
    const key = Object.fromEntries(procurementScoringSet(c).map(q => [q.field, q.correct_value]))
    expect(Object.keys(key)).toHaveLength(2)
    expect(procurementKcScoreFor({ S1: key.S1 }, c)).toBeNull()
    expect(procurementKcScoreFor(key, c)).toBe(1)
    expect(procurementKcScoreFor({ ...key, S2: 'wrong' }, c)).toBe(0.5)
  })

  it('⚠ the ARITHMETIC is the shared calcKCScore and is not reimplemented', () => {
    const c = cfg({ kcHidden: Object.fromEntries(SEALED_IDS.filter(id => !['S1', 'S2'].includes(id)).map(id => [id, true])) })
    const set = procurementScoringSet(c)
    const answers = { S1: set[0].correct_value, S2: 'wrong' }
    expect(procurementKcScoreFor(answers, c)).toBe(calcKCScore(answers, set).score)
  })

  it('⚠ A HIDDEN QUESTION IS OUT OF THE DENOMINATOR — the student can finish and be scored', () => {
    // The spec's named worst case in its live form (forecast shipped it): with a hidden
    // question left in `forScoring`, a student who answered everything SHOWN never completed.
    const c = cfg({ kcHidden: { S2: true } })
    const answers = Object.fromEntries(procurementScoringSet(c).map(q => [q.field, q.correct_value]))
    expect(procurementKcScoreFor(answers, c)).toBe(1)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// 7. THE PARSERS AND THE ONE-BUILDER CHECK
// ═══════════════════════════════════════════════════════════════════════════════

describe('the stored maps parse defensively', () => {
  it('parseKcHidden keeps only `true`', () => {
    expect(parseKcHidden({ a: true, b: false, c: 'yes' })).toEqual({ a: true })
  })
  it('parseKcOrder keeps only finite numbers', () => {
    expect(parseKcOrder({ a: 0, b: 2.5, c: 'x', d: NaN })).toEqual({ a: 0, b: 2.5 })
  })
  it('parseKcOverrides keeps only string prompts and labels', () => {
    expect(parseKcOverrides({ a: { prompt: 'p', options: { o: 'l', bad: 3 } }, b: 'nope' }))
      .toEqual({ a: { prompt: 'p', options: { o: 'l' } } })
  })
  it('all three are total on undefined', () => {
    expect(parseKcHidden(undefined)).toEqual({})
    expect(parseKcOrder(undefined)).toEqual({})
    expect(parseKcOverrides(undefined)).toEqual({})
  })
  it('a malformed added question is DROPPED, not thrown', () => {
    const c = load({ added_kc_questions: [{ id: 'ok', type: 'text', prompt: 'p' }, { nonsense: true }] })
    expect(c.addedKcQuestions.map(q => q.id)).toEqual(['ok'])
  })
})

describe('one resolver, not two', () => {
  it('⚠⚠ the SERVE path and the GRADER see the same ids, under every perturbation', () => {
    const cases: ProcurementConfig[] = [
      cfg(),
      openCfg(),
      cfg({ kcHidden: { S2: true } }),
      cfg({ kcOrder: { S7: -1 } }),
      cfg({ kcEnabled: false, addedKcQuestions: [addedText('t')] }),
      cfg({ addedKcQuestions: [addedMc('g'), addedText('u'), debriefMc('dg')] }),
      cfg({ addedKcQuestions: [addedMc('g')], kcHidden: { g: true } }),
      load({ kcVisible: SEALED_IDS.filter(id => id !== 'S4') }),
    ]
    for (const c of cases) {
      const served = new Set([
        ...procurementPreStage(c).map(r => r.field),
        ...procurementDebriefStage(c).map(r => r.field),
      ])
      for (const q of procurementScoringSet(c)) {
        expect(served.has(q.field), `${q.field} is graded but never served`).toBe(true)
      }
    }
  })
})
