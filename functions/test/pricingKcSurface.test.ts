import { describe, it, expect } from 'vitest'
import { kcScoreOrNull, calcKCScore } from '@mygames/game-server'
import {
  resolvePricingKcQuestions, pricingResolveKc, resolveAddedKcQuestions, pricingKcScoringSet,
  applyKcOverride, isGradedAdded, toClientKcQuestions, addedToClientKcQuestions,
  pricingPostStageQuestions, postStageToClient,
  PRICING_BUILT_IN_KC_IDS,
} from '../src/pricing/questions'
import {
  DEFAULT_PRICING_CONFIG, parseAddedKcQuestion, PRICING_KC_ID_GUARD,
  DEFAULT_ADDED_KC_STAGE, addedKcStage, PRICING_KC_STAGES,
  type PricingConfig, type PricingAddedKcQuestion,
} from '../src/pricing/config'
import { lockedKcQuestionIds, validateKcOverrides, KC_LOCK_REASON } from '../src/pricing/kcLock'
import {
  parseAddedKcQuestion as parseShared, parseKcHidden, parseKcOrder, parseKcOverrides,
} from '../src/shared/kcSurface'

// ═══════════════════════════════════════════════════════════════════════════════
// PRICING — the shared KC surface (convergence spec §5, §7). Third adopter.
//
// ⚠⚠ THREE THINGS ARE TRUE HERE AND OF NO OTHER GAME, and each has its own block below:
//   1. `ordered` — five of seven built-ins deliberately do NOT shuffle.
//   2. THE MODE SWAP — two mutually exclusive sets on one boolean.
//   3. THE SET IS CONFIG-DEPENDENT IN COUNT — two questions vanish for some markets.
//
// Every test names the mutant it catches. All were calibrated by breaking the code.
// ═══════════════════════════════════════════════════════════════════════════════

const cfg = (over: Partial<PricingConfig> = {}): PricingConfig => ({ ...DEFAULT_PRICING_CONFIG, ...over })
const pmgCfg = (over: Partial<PricingConfig> = {}) => cfg({ pmg: true, ...over })

const STANDARD_IDS = ['kc_base_share', 'kc_share_gap', 'kc_contribution', 'kc_below_cost']
const PMG_IDS = ['kc_pmg_effective', 'kc_pmg_share', 'kc_pmg_undercut']
/** The five numeric ladders. Position tracks value, so they must NOT be shuffled. */
const ORDERED_IDS = ['kc_base_share', 'kc_share_gap', 'kc_contribution', 'kc_pmg_effective', 'kc_pmg_share']
/** The two categorical ones. Authored answer-first, so they MUST be shuffled. */
const SHUFFLED_IDS = ['kc_below_cost', 'kc_pmg_undercut']

const addedMc = (id: string, over: Partial<PricingAddedKcQuestion> = {}): PricingAddedKcQuestion => ({
  id, type: 'mc', prompt: `Added ${id}?`,
  options: [
    { value: 'o0', label: 'First' }, { value: 'o1', label: 'Second' },
    { value: 'o2', label: 'Third' }, { value: 'o3', label: 'Fourth' },
  ],
  correct_value: 'o0',
  ...over,
})
const addedText = (id: string, over: Partial<PricingAddedKcQuestion> = {}): PricingAddedKcQuestion => ({
  id, type: 'text', prompt: `Tell me about ${id}`, ...over,
})
const postMc = (id: string) => addedMc(id, { stage: 'post' })
const postText = (id: string) => addedText(id, { stage: 'post' })

// ═══════════════════════════════════════════════════════════════════════════════
// HIDDEN — the two places that must agree
// ═══════════════════════════════════════════════════════════════════════════════

describe('⚠⚠ a hidden question leaves BOTH the display and the denominator', () => {
  it('is not served', () => {
    // MUTANT CAUGHT: dropping the hide from `pricingResolveKc`.
    const c = cfg({ kcHidden: { kc_contribution: true } })
    const ids = pricingResolveKc(c).map(q => q.field)
    expect(ids).not.toContain('kc_contribution')
    expect(ids).toHaveLength(3)
  })

  it('⚠⚠ AND THE GRADER\'S SCORING SET DROPS IT TOO — not just the display', () => {
    // MUTANT CAUGHT: filtering the display only and leaving `forScoring` intact — spec §5's
    // named worst case. `pricingKcScoringSet` is what `pricingSubmitKcAnswer` calls.
    const c = cfg({
      kcHidden: { kc_contribution: true, akc_hidden: true },
      addedKcQuestions: [addedMc('akc_kept'), addedMc('akc_hidden')],
    })
    const served = [
      ...pricingResolveKc(c).map(q => q.field),
      ...resolveAddedKcQuestions(c).filter(isGradedAdded).map(q => q.id),
    ].sort()
    const graded = pricingKcScoringSet(c).map(x => x.field).sort()

    expect(graded).toEqual(served)
    expect(graded).not.toContain('kc_contribution')
    expect(graded).not.toContain('akc_hidden')
    expect(graded).toContain('akc_kept')
    expect(graded).toHaveLength(4)   // 4 derived − 1 hidden + 1 visible addition
  })

  it('⚠ the scoring set carries the RIGHT KEY for every question it names', () => {
    // MUTANT CAUGHT: an off-by-one zip of ids against keys, which a length check misses.
    const derived = resolvePricingKcQuestions(
      DEFAULT_PRICING_CONFIG.market, false, DEFAULT_PRICING_CONFIG.labels,
    )
    for (const x of pricingKcScoringSet(cfg())) {
      expect(x.correct_value, x.field).toBe(derived.find(q => q.field === x.field)!.correct_value)
    }
  })

  it('hiding every graded question leaves an EMPTY scoring set', () => {
    const c = cfg({ kcHidden: Object.fromEntries(STANDARD_IDS.map(id => [id, true])) })
    expect(pricingKcScoringSet(c)).toHaveLength(0)
  })
})

describe('⚠ zero visible graded questions ⇒ null, never 0 and never 1.0', () => {
  const nothingGraded = () => cfg({
    kcHidden: Object.fromEntries(STANDARD_IDS.map(id => [id, true])),
    addedKcQuestions: [addedText('akc_free')],
  })

  it('⚠⚠ the stored score is null', () => {
    // MUTANT CAUGHT: bare `calcKCScore(allAnswers, forScoring).score`, which is what pricing
    // did before this pass. The shared helper answers the EMPTY set with 1.0, so a student
    // who answered only an ungraded free-text addition would be recorded at a PERFECT
    // knowledge-check score and have it pushed to the gradebook by scoreAndRecord.
    const forScoring = pricingKcScoringSet(nothingGraded())
    expect(forScoring).toHaveLength(0)
    expect(kcScoreOrNull({ akc_free: 'x' }, forScoring)).toBeNull()
    // …and the mutant's own answer, pinned, so the difference is explicit.
    expect(calcKCScore({ akc_free: 'x' }, forScoring).score).toBe(1.0)
  })

  it('…while a NON-empty set still scores normally', () => {
    const forScoring = pricingKcScoringSet(cfg())
    const allRight = Object.fromEntries(forScoring.map(x => [x.field, x.correct_value]))
    expect(kcScoreOrNull(allRight, forScoring)).toBe(1)
    expect(kcScoreOrNull(Object.fromEntries(forScoring.map(x => [x.field, '__no__'])), forScoring)).toBe(0)
  })

  it('a half-right set scores over the VISIBLE denominator', () => {
    const c = cfg({ kcHidden: { kc_contribution: true, kc_below_cost: true } })
    const forScoring = pricingKcScoringSet(c)
    expect(forScoring).toHaveLength(2)
    const answers = Object.fromEntries(forScoring.map((x, i) => [x.field, i < 1 ? x.correct_value : '__no__']))
    expect(kcScoreOrNull(answers, forScoring)).toBe(0.5)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// 1. THE `ordered` FLAG — pricing only
// ═══════════════════════════════════════════════════════════════════════════════

describe('⚠⚠ the `ordered` flag survives, PER QUESTION, with shuffle as the default', () => {
  const firstsAcrossCohort = (id: string, pmg: boolean) => {
    const c = pmg ? pmgCfg() : cfg()
    return new Set(
      Array.from({ length: 200 }, (_, i) =>
        toClientKcQuestions(pricingResolveKc(c), `stu-${i}`).find(q => q.field === id)!.options[0].value),
    )
  }

  it('⚠ the five numeric ladders do NOT shuffle — every student sees the same order', () => {
    // MUTANT CAUGHT: "shuffle everything" — dropping the `q.ordered ?` branch in
    // `toClientKcQuestions`. Scrambling a sorted price ladder makes four numbers harder to
    // compare and tells the student nothing, because position already tracks VALUE.
    for (const id of ORDERED_IDS) {
      const pmg = id.startsWith('kc_pmg')
      expect(firstsAcrossCohort(id, pmg).size, `${id} must NOT shuffle`).toBe(1)
    }
  })

  it('⚠ …and their options really are sorted ascending, which is WHY', () => {
    // If they were not sorted, "do not shuffle" would be preserving an arbitrary order
    // rather than a meaningful one, and this whole exception would be wrong.
    for (const q of pricingResolveKc(cfg())) {
      if (!q.ordered) continue
      const vals = q.options.map(o => Number(o.value))
      expect(vals, `${q.field} is a numeric ladder`).toEqual([...vals].sort((a, b) => a - b))
    }
  })

  it('⚠⚠ the two CATEGORICAL ones DO shuffle, and reach every position', () => {
    // MUTANT CAUGHT: marking everything `ordered`. These two are authored answer-first, so
    // an un-shuffled render is answerable by picking the top radio button.
    // ⚠ "Not always first" alone would pass a two-slot swap; this asserts every slot.
    for (const id of SHUFFLED_IDS) {
      const pmg = id.startsWith('kc_pmg')
      const c = pmg ? pmgCfg() : cfg()
      const q = pricingResolveKc(c).find(x => x.field === id)!
      const positions = new Set(
        Array.from({ length: 200 }, (_, i) =>
          toClientKcQuestions([q], `stu-${i}`)[0].options.findIndex(o => o.value === q.correct_value)),
      )
      expect(positions.size, `${id} must reach every slot`).toBe(q.options.length)
    }
  })

  it('⚠ THE DEFAULT IS TO SHUFFLE — a question with no flag is protected', () => {
    // The direction matters: a categorical question added to the file later is protected by
    // FORGETTING the flag, not by remembering it. Asserted on a synthetic question so the
    // property holds independently of which built-ins currently carry it.
    const q = { ...pricingResolveKc(cfg()).find(x => x.field === 'kc_base_share')!, ordered: undefined }
    const positions = new Set(
      Array.from({ length: 200 }, (_, i) =>
        toClientKcQuestions([q], `stu-${i}`)[0].options.findIndex(o => o.value === q.correct_value)),
    )
    expect(positions.size).toBe(q.options.length)
  })

  it('⚠ ADDED questions are never `ordered` — they always shuffle', () => {
    const c = cfg({ addedKcQuestions: [addedMc('akc_a')] })
    const positions = new Set(
      Array.from({ length: 200 }, (_, i) =>
        addedToClientKcQuestions(c, `stu-${i}`, 'pre')[0].options.findIndex(o => o.value === 'o0')),
    )
    expect(positions.size).toBe(4)
  })

  it('an override does not disturb `ordered` or the sort', () => {
    const base = pricingResolveKc(cfg()).find(q => q.field === 'kc_base_share')!
    const c = cfg({ kcOverrides: { kc_base_share: { prompt: 'MY STEM' } } })
    const got = pricingResolveKc(c).find(q => q.field === 'kc_base_share')!
    expect(got.ordered).toBe(base.ordered)
    expect(got.options.map(o => o.value)).toEqual(base.options.map(o => o.value))
    expect(firstsAcrossCohort('kc_base_share', false).size).toBe(1)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// 2. THE MODE SWAP — pricing only
// ═══════════════════════════════════════════════════════════════════════════════

describe('⚠⚠ the mode swap: two sets, one boolean, no cross-talk', () => {
  it('the two built-in sets share NO ids — which is what makes flat maps safe', () => {
    // ⚠ THE MECHANISM. A single flat map per field is mode-isolated precisely because an
    // id belongs to exactly one set. If a future question were added to BOTH sets under one
    // id, every map in this file would start leaking across the toggle — so this is
    // asserted rather than assumed.
    expect(pricingResolveKc(cfg()).map(q => q.field).sort()).toEqual([...STANDARD_IDS].sort())
    expect(pricingResolveKc(pmgCfg()).map(q => q.field).sort()).toEqual([...PMG_IDS].sort())
    expect(STANDARD_IDS.filter(id => PMG_IDS.includes(id))).toEqual([])
    expect([...PRICING_BUILT_IN_KC_IDS].sort()).toEqual([...STANDARD_IDS, ...PMG_IDS].sort())
  })

  it('⚠⚠ an edit made in STANDARD is not applied in PMG, and survives the round trip', () => {
    // MUTANT CAUGHT: one shared map keyed by POSITION rather than id — e.g. `order` or
    // `hidden` indexed 0..n — which would apply the first Standard question's edit to the
    // first PMG question. Test runs the full journey: edit → flip → flip back.
    const edits: Partial<PricingConfig> = {
      kcHidden: { kc_contribution: true },
      kcOverrides: { kc_below_cost: { prompt: 'MY STANDARD STEM' } },
      kcOrder: { kc_below_cost: 0, kc_base_share: 1 },
    }

    // In Standard: the edit applies.
    const std = pricingResolveKc(cfg(edits))
    expect(std.map(q => q.field)).not.toContain('kc_contribution')
    expect(std.find(q => q.field === 'kc_below_cost')!.prompt).toBe('MY STANDARD STEM')
    expect(std[0].field).toBe('kc_below_cost')

    // Flip to PMG: the SAME stored maps are carried, and touch nothing.
    const pmg = pricingResolveKc(pmgCfg(edits))
    expect(pmg.map(q => q.field).sort()).toEqual([...PMG_IDS].sort())
    expect(pmg.every(q => q.prompt !== 'MY STANDARD STEM')).toBe(true)
    expect(pmg).toHaveLength(3)   // nothing hidden, nothing added, nothing lost

    // Flip back: the edit is still exactly there.
    const back = pricingResolveKc(cfg(edits))
    expect(back).toEqual(std)
  })

  it('⚠⚠ …and the other direction: an edit made in PMG is not applied in STANDARD', () => {
    const edits: Partial<PricingConfig> = {
      kcHidden: { kc_pmg_share: true },
      kcOverrides: { kc_pmg_undercut: { prompt: 'MY PMG STEM' } },
    }
    const pmg = pricingResolveKc(pmgCfg(edits))
    expect(pmg.map(q => q.field)).not.toContain('kc_pmg_share')
    expect(pmg.find(q => q.field === 'kc_pmg_undercut')!.prompt).toBe('MY PMG STEM')

    const std = pricingResolveKc(cfg(edits))
    expect(std.map(q => q.field).sort()).toEqual([...STANDARD_IDS].sort())
    expect(std.every(q => q.prompt !== 'MY PMG STEM')).toBe(true)

    expect(pricingResolveKc(pmgCfg(edits))).toEqual(pmg)
  })

  it('⚠ the DENOMINATOR follows the mode', () => {
    expect(pricingKcScoringSet(cfg())).toHaveLength(4)
    expect(pricingKcScoringSet(pmgCfg())).toHaveLength(3)
  })

  it('⚠ the lock classification is computed PER MODE', () => {
    expect([...lockedKcQuestionIds(cfg())].sort()).toEqual([...STANDARD_IDS].sort())
    expect([...lockedKcQuestionIds(pmgCfg())].sort()).toEqual([...PMG_IDS].sort())
  })

  it('⚠ ADDED questions are shared across modes — they are not market-derived', () => {
    // Deliberate and worth pinning: an instructor's own question is not about the mode.
    const c = cfg({ addedKcQuestions: [addedMc('akc_a')] })
    expect(resolveAddedKcQuestions(c).map(q => q.id)).toEqual(['akc_a'])
    expect(resolveAddedKcQuestions({ ...c, pmg: true }).map(q => q.id)).toEqual(['akc_a'])
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// 3. THE SET IS CONFIG-DEPENDENT IN COUNT — pricing only
// ═══════════════════════════════════════════════════════════════════════════════

describe('⚠⚠ questions that VANISH for some markets', () => {
  /**
   * A band one grid step wide.
   *
   * ⚠ THIS DROPS **BOTH** VANISHING QUESTIONS, not just one: `questionPrices` cannot pose a
   * gap (kc_share_gap → null) AND the raised floor sits above the student's unit cost
   * (kc_below_cost → null). Only the two flat questions survive. Discovered by writing the
   * assertion the other way round and being wrong — recorded here because "how many
   * survive" is exactly the number a phantom-denominator bug would get right by accident.
   */
  const narrowBand = () => cfg({
    market: { ...DEFAULT_PRICING_CONFIG.market, minPrice: 1900, maxPrice: 2000 },
  })
  /** A band that drops ONLY kc_share_gap, so the two cases can be told apart. */
  const gapOnly = () => cfg({
    market: { ...DEFAULT_PRICING_CONFIG.market, minPrice: 1700, maxPrice: 1800 },
  })
  /** A floor at or above the student's unit cost: kc_below_cost is unanswerable and drops. */
  const floorAboveCost = () => cfg({
    market: {
      ...DEFAULT_PRICING_CONFIG.market,
      minPrice: DEFAULT_PRICING_CONFIG.market.studentUnitCost + 100,
    },
  })

  it('they really do vanish — otherwise everything below is vacuous', () => {
    expect(pricingResolveKc(narrowBand()).map(q => q.field)).not.toContain('kc_share_gap')
    expect(pricingResolveKc(floorAboveCost()).map(q => q.field)).not.toContain('kc_below_cost')
    // …and BOTH are present at the shipped defaults, so the set really is config-dependent.
    expect(pricingResolveKc(cfg()).map(q => q.field)).toContain('kc_share_gap')
    expect(pricingResolveKc(cfg()).map(q => q.field)).toContain('kc_below_cost')
    expect(pricingResolveKc(cfg())).toHaveLength(4)
  })

  it('⚠ a vanished question leaves the DENOMINATOR with no phantom entry', () => {
    // MUTANT CAUGHT: building the scoring set from a static id list rather than from the
    // resolved set — every student would be scored out of 4 while answering fewer, forever.
    const narrow = pricingKcScoringSet(narrowBand()).map(x => x.field)
    expect(narrow).not.toContain('kc_share_gap')
    expect(narrow).not.toContain('kc_below_cost')
    expect(narrow).toHaveLength(2)

    // The one-question case, so a mutant that hardcodes "4 minus 2" is caught too.
    const one = pricingKcScoringSet(floorAboveCost()).map(x => x.field)
    expect(one).not.toContain('kc_below_cost')
    expect(one).toHaveLength(3)

    const gap = pricingKcScoringSet(gapOnly()).map(x => x.field)
    expect(gap).not.toContain('kc_share_gap')
    expect(gap.length).toBeLessThan(4)
  })

  it('⚠⚠ hidden / order / overrides TOLERATE an id that is not currently served', () => {
    // MUTANT CAUGHT: assuming every id in a map is served — an indexing lookup that throws,
    // or a row rendered from the map rather than from the resolved set (a phantom question
    // with no text). All three maps name `kc_share_gap`, which this market does not build.
    const c = cfg({
      market: narrowBand().market,
      kcHidden: { kc_share_gap: true },
      kcOrder: { kc_share_gap: 0, kc_base_share: 1 },
      kcOverrides: { kc_share_gap: { prompt: 'FOR A QUESTION THAT IS NOT HERE' } },
    })
    const resolved = pricingResolveKc(c)
    expect(resolved).toHaveLength(2)
    expect(resolved.map(q => q.field)).not.toContain('kc_share_gap')
    expect(JSON.stringify(resolved)).not.toContain('FOR A QUESTION THAT IS NOT HERE')
    expect(pricingKcScoringSet(c)).toHaveLength(2)
    // …and the surviving questions are intact and ordered.
    expect(resolved.every(q => q.prompt.length > 0 && q.options.length >= 2)).toBe(true)
  })

  it('⚠ an override STORED for a vanished question is carried, not refused', () => {
    // MUTANT CAUGHT: validating option ids against the CURRENTLY BUILT set only and
    // rejecting the rest. The settings page round-trips the whole override map on every
    // save, so refusing would make the page unsaveable the moment somebody narrowed the
    // band or flipped the PMG toggle — with the instructor's own earlier work as the cause.
    const built = resolvePricingKcQuestions(narrowBand().market, false, DEFAULT_PRICING_CONFIG.labels)
    const rejections = validateKcOverrides(
      { kc_share_gap: { options: { anything: 'x' } } },
      {
        builtInIds: PRICING_BUILT_IN_KC_IDS,
        locked: new Set(),
        optionIds: new Map(built.map(q => [q.field, new Set(q.options.map(o => o.value))])),
      },
    )
    expect(rejections).toEqual([])
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// OVERRIDES AND THE LOCK
// ═══════════════════════════════════════════════════════════════════════════════

describe('⚠⚠ an override changes DISPLAY TEXT and provably nothing else', () => {
  const original = () => resolvePricingKcQuestions(
    DEFAULT_PRICING_CONFIG.market, false, DEFAULT_PRICING_CONFIG.labels,
  ).find(q => q.field === 'kc_below_cost')!

  it('replaces the prompt and leaves the key, option values and count alone', () => {
    // MUTANT CAUGHT: an override that replaces the whole question object, or stores
    // `options` as a LIST rather than a map from existing value to label.
    const o = original()
    const got = applyKcOverride(o, { kc_below_cost: { prompt: 'MY OWN STEM' } })
    expect(got.prompt).toBe('MY OWN STEM')
    expect(got.correct_value).toBe(o.correct_value)
    expect(got.options.map(x => x.value)).toEqual(o.options.map(x => x.value))
    expect(got.options.map(x => x.label)).toEqual(o.options.map(x => x.label))
    expect(got.explanation).toBe(o.explanation)
  })

  it('replaces an option LABEL by value; unknown ids are ignored, never appended', () => {
    const o = original()
    const got = applyKcOverride(o, {
      kc_below_cost: { options: { [o.options[1].value]: 'RENAMED', zzz: 'GHOST' } },
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
    const authored = resolvePricingKcQuestions(
      DEFAULT_PRICING_CONFIG.market, false, DEFAULT_PRICING_CONFIG.labels,
    )
    const resolved = pricingResolveKc(cfg({ kcOverrides: { kc_below_cost: { prompt: 'X' } } }))
    for (const a of authored) {
      if (a.field === 'kc_below_cost') continue
      expect(resolved.find(x => x.field === a.field)!.prompt, a.field).toBe(a.prompt)
    }
    expect(pricingResolveKc(cfg())).toEqual(authored)
  })

  it('applyKcOverride returns the SAME OBJECT when there is no entry', () => {
    const o = original()
    expect(applyKcOverride(o, {})).toBe(o)
  })
})

describe('⚠⚠ a locked question rejects an override AT THE CALLABLE', () => {
  const ctx = (pmg = false) => {
    const c = pmg ? pmgCfg() : cfg()
    const qs = resolvePricingKcQuestions(c.market, c.pmg, c.labels)
    return {
      builtInIds: PRICING_BUILT_IN_KC_IDS,
      locked: lockedKcQuestionIds(c),
      optionIds: new Map(qs.map(q => [q.field, new Set(q.options.map(o => o.value))])),
    }
  }

  it('⚠ refuses an override on EVERY one of the mode\'s questions — all are market-derived', () => {
    // MUTANT CAUGHT: a UI-only guard — deleting the server-side check and trusting the
    // greyed-out Edit button. A stale tab or a hand-made call never renders it.
    for (const [pmg, ids] of [[false, STANDARD_IDS], [true, PMG_IDS]] as const) {
      const c = ctx(pmg)
      for (const id of ids) {
        const bad = validateKcOverrides({ [id]: { prompt: 'rewritten' } }, c)
        expect(bad[0]?.reason, id).toBe('locked')
        expect(bad[0]?.message).toContain(KC_LOCK_REASON.toLowerCase())
      }
    }
  })

  it('refuses an override aimed at an ADDED question, and at the DEBRIEF row', () => {
    expect(validateKcOverrides({ akc_mine: { prompt: 'x' } }, ctx())[0].reason).toBe('not-built-in')
    expect(validateKcOverrides({ debrief_reflection: { prompt: 'x' } }, ctx())[0].reason)
      .toBe('not-built-in')
  })

  it('⚠ refuses an option value that names no offered option — not ignores it', () => {
    const c = { ...ctx(), locked: new Set<string>() }
    expect(validateKcOverrides({ kc_below_cost: { options: { nope: 'x' } } }, c)[0].reason)
      .toBe('unknown-option')
  })
})

describe('⚠⚠ which of pricing\'s questions are locked, pinned one by one', () => {
  // ⚠ THE SPEC'S §3 TABLE PREDICTED "all 7 — every question is a build(market, labels)
  // function". CONFIRMED, in both modes.
  it('all four Standard questions are locked', () => {
    expect([...lockedKcQuestionIds(cfg())].sort()).toEqual([...STANDARD_IDS].sort())
  })

  it('all three PMG questions are locked', () => {
    expect([...lockedKcQuestionIds(pmgCfg())].sort()).toEqual([...PMG_IDS].sort())
  })

  it('⚠⚠ kc_below_cost is locked by STEM AND EXPLANATION — its four options are STATIC', () => {
    // The interesting case, and the one a stem-only or options-only lock test gets wrong.
    const a = resolvePricingKcQuestions(
      DEFAULT_PRICING_CONFIG.market, false, DEFAULT_PRICING_CONFIG.labels,
    ).find(q => q.field === 'kc_below_cost')!
    const b = resolvePricingKcQuestions(
      { ...DEFAULT_PRICING_CONFIG.market, studentUnitCost: DEFAULT_PRICING_CONFIG.market.studentUnitCost + 50 },
      false, DEFAULT_PRICING_CONFIG.labels,
    ).find(q => q.field === 'kc_below_cost')!

    expect(a.options.map(o => o.label)).toEqual(b.options.map(o => o.label))  // options STATIC
    expect(a.prompt).not.toBe(b.prompt)                                       // stem moves
    expect(a.explanation).not.toBe(b.explanation)                             // explanation too
    expect(lockedKcQuestionIds(cfg()).has('kc_below_cost')).toBe(true)
  })

  it('⚠ the classification is MEASURED — market AND labels each move the text', () => {
    const m = DEFAULT_PRICING_CONFIG.market
    const base = resolvePricingKcQuestions(m, false, DEFAULT_PRICING_CONFIG.labels)
    const otherLabels = resolvePricingKcQuestions(m, false, { student: 'Zeta', competitor: 'Omega' })
    const otherMarket = resolvePricingKcQuestions({ ...m, slope: m.slope + 7 }, false, DEFAULT_PRICING_CONFIG.labels)
    expect(base[0].prompt).not.toBe(otherLabels[0].prompt)
    expect(JSON.stringify(base)).not.toBe(JSON.stringify(otherMarket))
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// STAGES, THE DEBRIEF ROW, AND D12
// ═══════════════════════════════════════════════════════════════════════════════

describe('⚠⚠ where pricing\'s existing stored additions are served', () => {
  it('⚠⚠ DEFAULT_ADDED_KC_STAGE is `pre` — DETERMINED, not copied from another game', () => {
    // MUTANT CAUGHT: adopting scorecard's 'post' default. Every added question pricing has
    // ever stored predates the `stage` field, and `pricingGetQuestions` has always returned
    // them in `kc.added`, which Play.tsx concatenates into the PRE-play list. Defaulting to
    // 'post' would silently move all of them to after the results.
    expect(DEFAULT_ADDED_KC_STAGE).toBe('pre')
    const legacy = addedMc('akc_legacy')
    expect(legacy.stage).toBeUndefined()
    expect(addedKcStage(legacy)).toBe('pre')

    const c = cfg({ addedKcQuestions: [legacy] })
    expect(addedToClientKcQuestions(c, 'stu-1', 'pre').map(q => q.field)).toEqual(['akc_legacy'])
    expect(postStageToClient(c, 'stu-1').map(r => r.field)).not.toContain('akc_legacy')
  })

  it('an explicit stage is kept, and an unrecognised one is dropped', () => {
    expect(parseAddedKcQuestion({ id: 'akc_a', type: 'text', prompt: 'x', stage: 'post' })!.stage).toBe('post')
    expect(parseAddedKcQuestion({ id: 'akc_b', type: 'text', prompt: 'x', stage: 'pre' })!.stage).toBe('pre')
    const bogus = parseAddedKcQuestion({ id: 'akc_c', type: 'text', prompt: 'x', stage: 'debrief' })!
    expect(bogus.stage).toBeUndefined()
    expect(addedKcStage(bogus)).toBe('pre')
    expect(PRICING_KC_STAGES).toEqual(['pre', 'post'])
  })

  it('⚠⚠ a graded POST-stage addition IS in the denominator — gradedness ignores the stage', () => {
    // MUTANT CAUGHT: `resolveAddedKcQuestions(config, 'pre')` inside `pricingKcScoringSet`
    // — grading by stage, so an after-results MC question is served, answered, marked… and
    // silently absent from the denominator, leaving every such student scored out of the
    // wrong total and their KC never completing.
    //
    // ⚠ THIS TEST EXISTS BECAUSE THAT MUTANT SURVIVED FIRST CALIBRATION. Every other
    // scoring-set test used PRE-stage additions only, so restricting the call to 'pre'
    // changed nothing any of them observed. D3 is explicit: gradedness follows the answer
    // key, never the stage.
    const c = cfg({ addedKcQuestions: [postMc('akc_after'), postText('akc_after_text')] })
    const ids = pricingKcScoringSet(c).map(x => x.field)
    expect(ids).toContain('akc_after')            // graded, after the results
    expect(ids).not.toContain('akc_after_text')   // ungraded free text, same stage
    expect(ids).toHaveLength(5)                   // 4 derived + 1 graded post addition

    // …and it is genuinely in the POST stage, not quietly served early.
    expect(postStageToClient(c, 'stu-1').map(r => r.field)).toContain('akc_after')
    expect(addedToClientKcQuestions(c, 'stu-1', 'pre')).toHaveLength(0)
  })

  it('⚠ a post-stage addition counts in BOTH modes', () => {
    const c = pmgCfg({ addedKcQuestions: [postMc('akc_after')] })
    expect(pricingKcScoringSet(c).map(x => x.field)).toContain('akc_after')
    expect(pricingKcScoringSet(c)).toHaveLength(4)   // 3 PMG derived + 1
  })

  it('⚠ a post-stage addition is served AFTER the results, not before', () => {
    // MUTANT CAUGHT: dropping the stage filter — serving every addition before play.
    const c = cfg({ addedKcQuestions: [addedMc('akc_pre'), postMc('akc_post')] })
    expect(addedToClientKcQuestions(c, 'stu-1', 'pre').map(q => q.field)).toEqual(['akc_pre'])
    expect(postStageToClient(c, 'stu-1').map(r => r.field)).toContain('akc_post')
    expect(postStageToClient(c, 'stu-1').map(r => r.field)).not.toContain('akc_pre')
  })
})

describe('⚠ the debrief row', () => {
  it('leads the post stage and is NEVER graded', () => {
    // MUTANT CAUGHT: grade by type (it is `type: 'text'`) or by stage.
    const c = cfg({ addedKcQuestions: [postMc('akc_post')] })
    const rows = pricingPostStageQuestions(c)
    expect(rows.map(r => r.kind)).toEqual(['debrief', 'added'])
    expect(pricingKcScoringSet(c).map(x => x.field)).not.toContain('debrief_reflection')
  })

  it('⚠⚠ renders the INSTRUCTOR\'S prompt from `debrief_prompt`', () => {
    // MUTANT CAUGHT: reading the hardcoded literal on the data object, or routing the row
    // through `kcOverrides` — either would ignore every edit the instructor has made.
    // ⚠ A NON-DEFAULT prompt, asserted to differ from the default: a test comparing against
    // the default is vacuous, because the default IS the literal the mutant introduces.
    const custom = 'What did you learn about undercutting?'
    expect(custom).not.toBe(DEFAULT_PRICING_CONFIG.debriefPrompt)

    const c = cfg({ debriefPrompt: custom })
    expect(pricingPostStageQuestions(c)[0].prompt).toBe(custom)
    expect(postStageToClient(c, 'stu-1')[0].prompt).toBe(custom)
    expect(pricingPostStageQuestions(c)[0].field).toBe('debrief_reflection')
  })

  it('⚠ is NOT backed by the override map', () => {
    const c = cfg({ kcOverrides: { debrief_reflection: { prompt: 'FROM THE OVERRIDE MAP' } } })
    expect(pricingPostStageQuestions(c)[0].prompt).toBe(DEFAULT_PRICING_CONFIG.debriefPrompt)
  })

  it('⚠ its default follows the MODE, and the row shows whichever is stored', () => {
    // pricing's debrief default is mode-dependent (config.ts). The row must not flatten it.
    expect(pricingPostStageQuestions(cfg())[0].prompt).toBe(DEFAULT_PRICING_CONFIG.debriefPrompt)
  })

  it('hiding it removes ITS row and leaves the additions', () => {
    const c = cfg({ debriefEnabled: false, addedKcQuestions: [postMc('akc_a')] })
    expect(pricingPostStageQuestions(c).map(r => r.field)).toEqual(['akc_a'])
  })

  it('`order` reorders the post list ACROSS both kinds', () => {
    const c = cfg({
      addedKcQuestions: [postMc('akc_a')],
      kcOrder: { akc_a: 0, debrief_reflection: 1 },
    })
    expect(pricingPostStageQuestions(c).map(r => r.field)).toEqual(['akc_a', 'debrief_reflection'])
  })
})

describe('⚠ D12 — kcEnabled gates GRADED questions only', () => {
  it('off removes the derived set and any GRADED addition', () => {
    const c = cfg({ kcEnabled: false, addedKcQuestions: [addedMc('akc_graded')] })
    expect(pricingResolveKc(c)).toHaveLength(0)
    expect(resolveAddedKcQuestions(c).map(q => q.id)).not.toContain('akc_graded')
    expect(pricingKcScoringSet(c)).toHaveLength(0)
  })

  it('⚠ …and LEAVES an ungraded free-text addition', () => {
    // MUTANT CAUGHT: the toggle gating every addition.
    const c = cfg({ kcEnabled: false, addedKcQuestions: [addedText('akc_free'), postText('akc_post_free')] })
    expect(resolveAddedKcQuestions(c).map(q => q.id).sort()).toEqual(['akc_free', 'akc_post_free'])
    expect(pricingKcScoringSet(c)).toHaveLength(0)
  })

  it('an ungraded addition never reaches the denominator, key-based not type-based', () => {
    // MUTANT CAUGHT: grade by type — an mc whose key named no offered option has its key
    // DROPPED at parse time and must not count.
    const keyless = parseAddedKcQuestion({
      id: 'akc_badkey', type: 'mc', prompt: 'Which?',
      options: [{ value: 'x', label: 'X' }, { value: 'y', label: 'Y' }],
      correct_value: 'NOT_AN_OPTION',
    })!
    expect(keyless.correct_value).toBeUndefined()
    const c = cfg({ addedKcQuestions: [addedMc('akc_g'), addedText('akc_t'), keyless] })
    expect(resolveAddedKcQuestions(c)).toHaveLength(3)
    expect(pricingKcScoringSet(c)).toHaveLength(5)   // 4 derived + 1 graded addition
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// GUARD, ORDER, SHUFFLE, PARSERS
// ═══════════════════════════════════════════════════════════════════════════════

describe('⚠⚠ an added question cannot take a derived question\'s id', () => {
  it('PRICING_KC_ID_GUARD is the PREFIX rule, and it refuses every derived id', () => {
    // MUTANT CAUGHT: swapping in scorecard's explicit id SET, which knows nothing about
    // `kc_base_share` — every one of pricing's seven would sail through, and the grader
    // looks derived questions up FIRST, so the instructor's key would be shadowed.
    expect(PRICING_KC_ID_GUARD.kind).toBe('prefix')
    for (const id of PRICING_BUILT_IN_KC_IDS) {
      expect(id.startsWith('kc_'), `${id} is kc_-prefixed`).toBe(true)
      expect(parseShared({ id, type: 'text', prompt: 'x' }, { guard: PRICING_KC_ID_GUARD }), id).toBeNull()
      expect(parseShared({ id, type: 'text', prompt: 'x' },
        { guard: { kind: 'idSet', ids: new Set(['q1_negotiated_ppm']) } }),
      `an idSet guard would wrongly ACCEPT ${id}`).not.toBeNull()
    }
  })

  it('⚠ the prefix reserves the NAMESPACE, not just the current occupants', () => {
    expect(parseAddedKcQuestion({ id: 'kc_future', type: 'text', prompt: 'x' })).toBeNull()
    expect(parseAddedKcQuestion({ id: 'akc_mine', type: 'text', prompt: 'x' })).not.toBeNull()
  })
})

describe('⚠ reorder', () => {
  it('a COMPLETE map orders exactly, and survives a save/reload round trip', () => {
    // MUTANT CAUGHT: dropping `order` on write.
    const wanted = [...pricingResolveKc(cfg()).map(q => q.field)].reverse()
    const written = Object.fromEntries(wanted.map((id, i) => [id, i]))
    const reloaded = parseKcOrder(JSON.parse(JSON.stringify(written)))
    expect(reloaded).toEqual(written)
    expect(pricingResolveKc(cfg({ kcOrder: reloaded })).map(q => q.field)).toEqual(wanted)
  })

  it('a PARTIAL map drops nothing and duplicates nothing', () => {
    const got = pricingResolveKc(cfg({ kcOrder: { kc_below_cost: 0 } }))
    expect(got).toHaveLength(4)
    expect(new Set(got.map(q => q.field)).size).toBe(4)
  })
})

describe('⚠⚠ added MC questions shuffle — through the SERVE path', () => {
  it('the answer reaches EVERY position over a cohort', () => {
    // MUTANTS CAUGHT: (b) a two-slot swap, (c) not shuffling the added path.
    // ⚠ Tested through `addedToClientKcQuestions` / `postStageToClient`, which the callable
    // composes — NOT through `shuffleClientOptions`. Both previous passes lost a mutant to
    // exactly that distinction.
    for (const [fn, stage] of [
      [(c: PricingConfig, p: string) => addedToClientKcQuestions(c, p, 'pre'), 'pre'],
      [(c: PricingConfig, p: string) => postStageToClient(c, p).filter(r => r.kind === 'added'), 'post'],
    ] as const) {
      const c = cfg({ addedKcQuestions: [stage === 'pre' ? addedMc('akc_a') : postMc('akc_a')] })
      const positions = new Set(
        Array.from({ length: 200 }, (_, i) =>
          fn(c, `stu-${i}`)[0].options.findIndex(o => o.value === 'o0')),
      )
      expect(positions.size, `${stage} stage`).toBe(4)
    }
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

  it('deterministic per student, and no option lost; no key ever ships', () => {
    const c = cfg({ addedKcQuestions: [addedMc('akc_a')] })
    expect(addedToClientKcQuestions(c, 'stu-7', 'pre')).toEqual(addedToClientKcQuestions(c, 'stu-7', 'pre'))
    const opts = addedToClientKcQuestions(c, 'stu-7', 'pre')[0].options
    expect([...opts].sort((x, y) => x.value.localeCompare(y.value))).toEqual(addedMc('akc_a').options)
    expect(JSON.stringify(addedToClientKcQuestions(c, 'stu-1', 'pre'))).not.toContain('correct_value')
    expect(JSON.stringify(postStageToClient(cfg({ addedKcQuestions: [postMc('akc_p')] }), 'stu-1')))
      .not.toContain('correct_value')
  })
})

describe('the three fields are total on absent, and default to current behaviour', () => {
  it('an instance written before they existed reads as no hides, authored order, no rewrites', () => {
    expect(parseKcHidden(undefined)).toEqual({})
    expect(parseKcOrder(undefined)).toEqual({})
    expect(parseKcOverrides(undefined)).toEqual({})
    expect(pricingResolveKc(cfg())).toEqual(
      resolvePricingKcQuestions(DEFAULT_PRICING_CONFIG.market, false, DEFAULT_PRICING_CONFIG.labels),
    )
  })

  it('⚠ only `true` is kept in the hidden map', () => {
    expect(parseKcHidden({ a: true, b: false, c: 'yes' })).toEqual({ a: true })
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
    expect(pricingPostStageQuestions(c).map(r => r.field))
      .toEqual(['debrief_reflection', 'akc_b', 'akc_c', 'akc_a'])
  })

  it('ordering a stage by the order it is already in is a no-op', () => {
    const c0 = cfg({ addedKcQuestions: [postMc('akc_a'), postMc('akc_b')] })
    const once = pricingPostStageQuestions(c0).map(r => r.field)
    const c1 = cfg({
      addedKcQuestions: [postMc('akc_a'), postMc('akc_b')],
      kcOrder: Object.fromEntries(once.map((id, i) => [id, i])),
    })
    expect(pricingPostStageQuestions(c1).map(r => r.field)).toEqual(once)
  })
})
