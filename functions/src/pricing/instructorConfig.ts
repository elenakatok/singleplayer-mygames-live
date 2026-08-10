import { onCall, HttpsError } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import { extractInstructorGameId } from '@mygames/game-server'
import {
  PRICING_CORS_ORIGINS, INSTANCES_COLLECTION, PARTICIPANTS_SUBCOLLECTION, CONFIG_DOC, TRUTH_DOC,
  HARD_MIN_ROUNDS, HARD_MAX_ROUNDS,
  loadPricingConfig, loadPricingStrategies, activeStrategy, parseAddedKcQuestion,
  addedKcStage, parseKcHidden, parseKcOrder, parseKcOverrides, PRICING_KC_STAGES,
  type PricingAddedKcQuestion, type PricingConfig,
} from './config'
import { STRATEGY_DESCRIPTIONS } from './strategy'
import { nashEquilibrium } from './market'
import {
  resolvePricingKcQuestions, applyKcOverride, isKcOverridden, isGradedAdded,
  PRICING_BUILT_IN_KC_IDS,
} from './questions'
import { lockedKcQuestionIds, validateKcOverrides, KC_LOCK_REASON } from './kcLock'

// ═══════════════════════════════════════════════════════════════════════════════
// pricingGetConfig / pricingUpdateConfig (instructor) — the settings page's server
// side (spec §3). Mirrors pdGetConfig/pdUpdateConfig: read the whole config, write
// back only the fields that were sent, re-read and return what was actually STORED.
//
// WHAT IS AND IS NOT EDITABLE:
//   editable   the PMG toggle, the market (size, both base shares, both unit costs,
//              slope, price bounds), the firm labels, the round RANGE, KC on/off,
//              instructor-added KC questions, debrief on/off + prompt
//   derived    the mode's own KC questions — computed from the market at serve AND
//              grade time (questions.ts), never stored as text. They are RETURNED
//              here read-only so the settings page can preview what the current
//              market produces. Editing the market rewrites them; that is the
//              feature, not a gap.
//   fixed      the competitor rule — DISPLAY ONLY, as PD's bot strategies are. The
//              library has one rule per mode today and the mode already selects it;
//              a picker would offer a choice of one.
//   truth      each student's DRAWN round count — never returned here, never
//              editable. Only its range is. A range edit does not redraw a student
//              already playing (init.ts); `anyRoundsDrawn` below tells the instructor
//              which state they are in without revealing any student's number.
//
// ⚠ CONFIG-EDIT SAFETY. PD's precedent is WARN, NEVER BLOCK, and only about the round
// range. Pricing keeps that posture but extends the warning to the MARKET, because a
// market edit here is worse than a matrix edit in PD: profits already recorded were
// computed under the old market, so a mid-week edit leaves one instance holding two
// incompatible sets of numbers that the Tier-1 averages will silently pool. The page
// cannot refuse the edit — an instructor fixing a typo on day one must be able to —
// so it reports `anyRoundsPlayed` and says plainly what will happen.
// ═══════════════════════════════════════════════════════════════════════════════

/** Reads one optional field; `undefined` means "not being changed". */
const has = (d: Record<string, unknown>, k: string) => Object.prototype.hasOwnProperty.call(d, k)

/** Shape-shared by both callables, so the page can never be handed two different
 *  pictures of the same instance. */
async function readConfigView(db: admin.firestore.Firestore, gameInstanceId: string) {
  const instanceRef = db.collection(INSTANCES_COLLECTION).doc(gameInstanceId)
  const [configSnap, truthSnap, drawnSnap, playedSnap] = await Promise.all([
    instanceRef.collection('config').doc(CONFIG_DOC).get(),
    instanceRef.collection('truth').doc(TRUTH_DOC).get(),
    // "Has ANY student drawn a horizon yet?" — one indexed hit, not a scan. Only
    // participant truth docs carry a numeric `rounds`, so a single match answers it.
    instanceRef.collection('truth').where('rounds', '>', 0).limit(1).get(),
    // "Has anyone actually PLAYED?" — the market-edit warning turns on this, not on
    // having merely launched: a student who opened the tab and left has no numbers to
    // invalidate.
    instanceRef.collection(PARTICIPANTS_SUBCOLLECTION).where('rounds_played', '>', 0).limit(1).get(),
  ])

  const config = loadPricingConfig(configSnap.data())
  const strategy = activeStrategy(config, loadPricingStrategies(truthSnap.data()))
  const eq = nashEquilibrium(config.market)

  return {
    ok: true as const,
    pmg: config.pmg,
    labels: config.labels,
    market: config.market,
    minRounds: config.minRounds,
    maxRounds: config.maxRounds,
    kcEnabled: config.kcEnabled,
    addedKcQuestions: config.addedKcQuestions,
    debriefEnabled: config.debriefEnabled,
    debriefPrompt: config.debriefPrompt,
    /**
     * Read-only preview of what the CURRENT market derives, so the settings page can
     * show the instructor the questions their market edits just produced.
     * Instructor-side, so the answer key may be included here.
     */
    derivedKcPreview: resolvePricingKcQuestions(config.market, config.pmg, config.labels).map(q => ({
      field: q.field,
      prompt: q.prompt,
      options: q.options,
      correct_value: q.correct_value,
    })),
    /** The rule in force for this mode, in plain language. Display only. */
    competitorRule: { id: strategy, description: STRATEGY_DESCRIPTIONS[strategy] },
    /** The Tier-3 reference the current market implies — shown so an instructor can
     *  see their market edit move the equilibrium before any student meets it. */
    equilibrium: config.pmg
      ? { student: config.market.maxPrice, competitor: config.market.maxPrice }
      : { student: eq.studentPrice, competitor: eq.competitorPrice },
    /** Has ANY student drawn their hidden round count — i.e. has anyone launched? A
     *  BOOLEAN, never a number. Drives the "a new range reaches only students who have
     *  not launched" notice. */
    anyRoundsDrawn: !drawnSnap.empty,
    /** Has any student actually played a round? Drives the market-edit warning. */
    anyRoundsPlayed: !playedSnap.empty,
    /** ⚠ The three convergence fields (spec §5). */
    kcHidden: config.kcHidden,
    kcOrder: config.kcOrder,
    kcOverrides: config.kcOverrides,
    /** Everything the shared knowledge-check block renders. */
    kc: kcInventory(config),
  }
}

/**
 * The instructor-facing inventory of every question this instance could ask — the payload
 * the shared settings block renders.
 *
 * ⚠ THIS IS THE INSTRUCTOR CALLABLE, so `correctValue` belongs here. `pricingGetQuestions`
 * (the STUDENT path) still strips every key.
 *
 * ⚠⚠ THE MODE'S SET ONLY. pricing serves two mutually exclusive built-in sets on one
 * boolean, so the page shows the questions THIS instance asks. The other mode's stored
 * hides, order and overrides are untouched and reappear when the instructor flips back —
 * they are keyed by ids this mode never serves (config.ts).
 *
 * ⚠ A question `build()` returned null for is simply absent — no row, and no phantom entry
 * in any count. `kc_share_gap` vanishes on a narrow band and `kc_below_cost` when the price
 * floor is at or above the student's unit cost.
 *
 * ⚠⚠ THE DEBRIEF IS A ROW (spec D9) — an ungraded question in a later stage, not a separate
 * surface. It is reported as a `builtin` row in the `post` stage but is STORED under the
 * existing `debrief_prompt` / `debrief_enabled` keys, NOT in the three convergence maps.
 * The settings page translates at the boundary and the callable refuses an override or hide
 * aimed at its id. No storage migration; no stored answer moves.
 */
function kcInventory(config: PricingConfig) {
  const locked = lockedKcQuestionIds(config)
  const authored = resolvePricingKcQuestions(config.market, config.pmg, config.labels)

  const builtIn = authored.map((raw) => {
    const q = applyKcOverride(raw, config.kcOverrides)
    return {
      id: q.field,
      kind: 'builtin' as const,
      stage: 'pre' as const,
      prompt: q.prompt,
      options: q.options.map(o => ({ value: o.value, label: o.label })),
      correctValue: q.correct_value,
      /** Always graded — every derived question carries a key. */
      graded: true,
      visible: config.kcHidden[q.field] !== true,
      locked: locked.has(q.field),
      /** ⚠ Always populated when `locked` — a disabled control with no reason is a bug. */
      lockReason: locked.has(q.field) ? KC_LOCK_REASON : null,
      overridden: isKcOverridden(q.field, config.kcOverrides),
      /** The GENERATED text, so the page can offer "revert to the original". */
      originalPrompt: raw.prompt,
      originalOptions: raw.options.map(o => ({ value: o.value, label: o.label })),
      order: config.kcOrder[q.field] ?? null,
    }
  })

  const added = config.addedKcQuestions.map(q => ({
    id: q.id,
    kind: 'added' as const,
    // ⚠ The question's OWN stage, never a hardcoded 'pre'.
    stage: addedKcStage(q),
    type: q.type,
    prompt: q.prompt,
    options: (q.options ?? []).map(o => ({ value: o.value, label: o.label })),
    correctValue: q.correct_value ?? null,
    graded: isGradedAdded(q),
    visible: config.kcHidden[q.id] !== true,
    /** Added questions are stored DATA — edited in place, never overridden, never locked. */
    locked: false,
    lockReason: null,
    overridden: false,
    order: config.kcOrder[q.id] ?? null,
  }))

  /** ⚠ The debrief, as a row. See the note on `kcInventory`. */
  const debriefRow = {
    id: DEBRIEF_ROW_ID,
    kind: 'builtin' as const,
    stage: 'post' as const,
    type: 'text' as const,
    prompt: config.debriefPrompt,
    options: [] as { value: string; label: string }[],
    correctValue: null,
    /** ⚠ NEVER GRADED, and by ABSENCE OF A KEY rather than by its stage. */
    graded: false,
    visible: config.debriefEnabled,
    locked: false,
    lockReason: null,
    overridden: false,
    order: config.kcOrder[DEBRIEF_ROW_ID] ?? null,
  }

  const pool = [...builtIn, ...added, debriefRow]
  return {
    stages: PRICING_KC_STAGES,
    builtIn,
    added,
    debrief: debriefRow,
    /** ⚠ THE COUNT LINE'S THREE NUMBERS — visible AND graded. Never stored (D5). */
    poolTotal: pool.length,
    visibleCount: pool.filter(q => q.visible).length,
    gradedCount: pool.filter(q => q.visible && q.graded).length,
  }
}

/**
 * The id the debrief row uses in the settings block.
 *
 * ⚠ It is the question's real `field`, so the row's id matches the key its answers are
 * already stored under and the reports already read. Nothing moves.
 */
export const DEBRIEF_ROW_ID = 'debrief_reflection'

export const pricingGetConfig = onCall({ cors: PRICING_CORS_ORIGINS }, async (request) => {
  const data = request.data as Record<string, unknown>
  const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true'
  const authHeader = request.rawRequest.headers.authorization as string | undefined

  const gameInstanceId = await extractInstructorGameId(data, isEmulator, authHeader)

  return readConfigView(admin.firestore(), gameInstanceId)
})

/** A finite number, with an optional lower bound. Throws with the field's own name so
 *  the settings page can show the instructor which box is wrong. */
function requireNumber(v: unknown, label: string, opts: { min?: number; exclusiveMin?: number } = {}): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new HttpsError('invalid-argument', `${label} must be a number.`)
  }
  if (opts.exclusiveMin !== undefined && v <= opts.exclusiveMin) {
    throw new HttpsError('invalid-argument', `${label} must be greater than ${opts.exclusiveMin}.`)
  }
  if (opts.min !== undefined && v < opts.min) {
    throw new HttpsError('invalid-argument', `${label} must be at least ${opts.min}.`)
  }
  return v
}

export const pricingUpdateConfig = onCall({ cors: PRICING_CORS_ORIGINS }, async (request) => {
  const data = request.data as Record<string, unknown>
  const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true'
  const authHeader = request.rawRequest.headers.authorization as string | undefined

  const gameInstanceId = await extractInstructorGameId(data, isEmulator, authHeader)

  const patch: Record<string, unknown> = {}

  // ── The MODE ──────────────────────────────────────────────────────────────
  // One boolean, and everything downstream follows it: the market computation
  // (market.ts), the competitor rule (config.activeStrategy), the KC set
  // (questions.ts), the rules screen, the debrief prompt, and the Tier-3 reference.
  // None of that is duplicated here — flipping this flag is the whole edit.
  if (has(data, 'pmg')) {
    if (typeof data.pmg !== 'boolean') throw new HttpsError('invalid-argument', 'pmg must be true or false.')
    patch.pmg = data.pmg
  }

  // ── The market ────────────────────────────────────────────────────────────
  if (has(data, 'market')) {
    const m = (typeof data.market === 'object' && data.market !== null ? data.market : {}) as Record<string, unknown>

    const marketSize = requireNumber(m.marketSize, 'Market size', { exclusiveMin: 0 })
    const studentBaseShare = requireNumber(m.studentBaseShare, 'Your base share', { exclusiveMin: 0 })
    const competitorBaseShare = requireNumber(m.competitorBaseShare, 'The competitor base share', { exclusiveMin: 0 })
    const studentUnitCost = requireNumber(m.studentUnitCost, 'Your unit cost', { min: 0 })
    const competitorUnitCost = requireNumber(m.competitorUnitCost, 'The competitor unit cost', { min: 0 })
    const slope = requireNumber(m.slope, 'The share slope', { exclusiveMin: 0 })
    const minPrice = requireNumber(m.minPrice, 'The minimum price', { exclusiveMin: 0 })
    const maxPrice = requireNumber(m.maxPrice, 'The maximum price', { exclusiveMin: 0 })

    // Shares must each sit strictly inside (0,1) AND sum to 1 — they are two firms
    // splitting one market, so anything else is not a market share.
    if (studentBaseShare >= 1 || competitorBaseShare >= 1) {
      throw new HttpsError('invalid-argument', 'Each base share must be between 0 and 1 (exclusive).')
    }
    if (Math.abs(studentBaseShare + competitorBaseShare - 1) > 1e-9) {
      throw new HttpsError('invalid-argument',
        `The two base shares must add up to 1 — they currently add up to ${studentBaseShare + competitorBaseShare}.`)
    }

    if (!Number.isInteger(minPrice) || !Number.isInteger(maxPrice)) {
      throw new HttpsError('invalid-argument', 'Both price bounds must be whole dollars.')
    }
    if (minPrice >= maxPrice) {
      throw new HttpsError('invalid-argument', 'The minimum price must be below the maximum price.')
    }
    // A unit cost at or above the ceiling makes EVERY legal price a loss — the game
    // would be unplayable rather than merely hard, so it is refused rather than
    // warned about.
    if (studentUnitCost >= maxPrice || competitorUnitCost >= maxPrice) {
      throw new HttpsError('invalid-argument',
        'Both unit costs must be below the maximum price, or no price could ever be profitable.')
    }

    patch.market = {
      market_size: marketSize,
      student_base_share: studentBaseShare,
      competitor_base_share: competitorBaseShare,
      student_unit_cost: studentUnitCost,
      competitor_unit_cost: competitorUnitCost,
      slope,
      min_price: minPrice,
      max_price: maxPrice,
      // The competitor's decision grid is NOT edited here (it is not in the spec §3
      // table); it is carried through so a market save cannot silently reset it.
      grid_step: typeof m.gridStep === 'number' && Number.isFinite(m.gridStep) && m.gridStep > 0
        ? m.gridStep : 100,
    }
  }

  // ── Firm labels — two non-empty strings ───────────────────────────────────
  if (has(data, 'labels')) {
    const l = (typeof data.labels === 'object' && data.labels !== null ? data.labels : {}) as Record<string, unknown>
    const student = typeof l.student === 'string' ? l.student.trim() : ''
    const competitor = typeof l.competitor === 'string' ? l.competitor.trim() : ''
    if (!student || !competitor) throw new HttpsError('invalid-argument', 'Both firm names are required.')
    patch.labels = { student, competitor }
  }

  // ── Round range — integers, min ≤ max, both inside the hard bounds ────────
  if (has(data, 'minRounds') || has(data, 'maxRounds')) {
    const min = data.minRounds
    const max = data.maxRounds
    if (typeof min !== 'number' || !Number.isInteger(min) || typeof max !== 'number' || !Number.isInteger(max)) {
      throw new HttpsError('invalid-argument', 'Both round-range bounds must be whole numbers.')
    }
    if (min < HARD_MIN_ROUNDS || max < HARD_MIN_ROUNDS) {
      throw new HttpsError('invalid-argument', `Rounds must be at least ${HARD_MIN_ROUNDS}.`)
    }
    if (min > HARD_MAX_ROUNDS || max > HARD_MAX_ROUNDS) {
      throw new HttpsError('invalid-argument', `Rounds cannot exceed ${HARD_MAX_ROUNDS}.`)
    }
    if (min > max) {
      throw new HttpsError('invalid-argument', 'The minimum number of rounds cannot exceed the maximum.')
    }
    patch.min_rounds = min
    patch.max_rounds = max
  }

  // ── Knowledge check ───────────────────────────────────────────────────────
  if (has(data, 'kcEnabled')) {
    if (typeof data.kcEnabled !== 'boolean') throw new HttpsError('invalid-argument', 'kcEnabled must be true or false.')
    patch.kc_enabled = data.kcEnabled
  }

  if (has(data, 'addedKcQuestions')) {
    if (!Array.isArray(data.addedKcQuestions)) {
      throw new HttpsError('invalid-argument', 'addedKcQuestions must be an array.')
    }
    const parsed: PricingAddedKcQuestion[] = []
    const seen = new Set<string>()
    for (const raw of data.addedKcQuestions) {
      const q = parseAddedKcQuestion(raw)
      if (!q) {
        throw new HttpsError('invalid-argument',
          'An added question is incomplete — every question needs a prompt, and a multiple-choice question needs at least two options and a correct answer among them.')
      }
      // The derived set owns the kc_ namespace; parseAddedKcQuestion already refuses
      // it, and this second check keeps the error message specific.
      if (q.id.startsWith('kc_')) {
        throw new HttpsError('invalid-argument', 'An added question cannot use a reserved kc_ id.')
      }
      if (seen.has(q.id)) throw new HttpsError('invalid-argument', `Duplicate question id: ${q.id}`)
      seen.add(q.id)
      parsed.push(q)
    }
    patch.added_kc_questions = parsed
  }

  // ── The three convergence fields (spec §5) ────────────────────────────────
  //
  // ⚠ Every key is checked against the ids this instance could have. A stale id — from a
  // question deleted between page load and save — is REFUSED rather than stored, because a
  // hidden map full of ids nothing serves is how "6 of 8 visible" starts lying.
  //
  // ⚠⚠ AGAINST THE UNION OF BOTH MODES, NOT THE CURRENT ONE, and not against the set the
  // CURRENT MARKET happens to build. An instructor who edits in Standard, flips to PMG and
  // saves must not have their Standard work rejected — and `kc_share_gap` / `kc_below_cost`
  // legitimately vanish for some markets while their stored entries remain valid.
  if (has(data, 'kcHidden') || has(data, 'kcOrder') || has(data, 'kcOverrides')) {
    // ⚠ Its own handle — the shared `db` is declared further down, after the whole patch
    // has been validated, and this block must run inside the validation.
    const stored = loadPricingConfig(
      (await admin.firestore().collection(INSTANCES_COLLECTION).doc(gameInstanceId)
        .collection('config').doc(CONFIG_DOC).get()).data(),
    )
    const knownAdded = new Set(
      (patch.added_kc_questions as PricingAddedKcQuestion[] | undefined)?.map(q => q.id)
      ?? stored.addedKcQuestions.map(q => q.id),
    )
    const knownId = (id: string) =>
      PRICING_BUILT_IN_KC_IDS.has(id) || knownAdded.has(id) || id === DEBRIEF_ROW_ID

    if (has(data, 'kcHidden')) {
      const p = parseKcHidden(data.kcHidden)
      for (const id of Object.keys(p)) {
        if (!knownId(id)) throw new HttpsError('invalid-argument', `'${id}' is not a question in this game.`)
      }
      patch.kc_hidden = p
    }

    if (has(data, 'kcOrder')) {
      const p = parseKcOrder(data.kcOrder)
      for (const id of Object.keys(p)) {
        if (!knownId(id)) throw new HttpsError('invalid-argument', `'${id}' is not a question in this game.`)
      }
      patch.kc_order = p
    }

    if (has(data, 'kcOverrides')) {
      // ⚠⚠ THE LOCK IS ENFORCED HERE, NOT ONLY IN THE UI (spec §5). A greyed-out Edit
      // button stops an instructor; it does not stop a stale tab, a replayed payload or a
      // hand-made call. A locked question's text is RECOMPUTED from the market, so an
      // override on it would be discarded on the next market edit — or, worse, kept and
      // left contradicting the numbers beside it.
      //
      // ⚠ The classification is per MODE, and it is measured, not listed (kcLock.ts). The
      // prospective config is used, so flipping `pmg` in the SAME save is classified
      // against the mode being saved rather than the one being left.
      const next: PricingConfig = {
        ...stored,
        pmg: has(data, 'pmg') && typeof data.pmg === 'boolean' ? data.pmg : stored.pmg,
      }
      const built = resolvePricingKcQuestions(next.market, next.pmg, next.labels)
      const rejections = validateKcOverrides(parseKcOverrides(data.kcOverrides), {
        builtInIds: PRICING_BUILT_IN_KC_IDS,
        locked: lockedKcQuestionIds(next),
        optionIds: new Map(built.map(q => [q.field, new Set(q.options.map(o => o.value))])),
      })
      if (rejections.length > 0) throw new HttpsError('invalid-argument', rejections[0].message)
      patch.kc_overrides = parseKcOverrides(data.kcOverrides)
    }
  }

  // ── Debrief ───────────────────────────────────────────────────────────────
  if (has(data, 'debriefEnabled')) {
    if (typeof data.debriefEnabled !== 'boolean') throw new HttpsError('invalid-argument', 'debriefEnabled must be true or false.')
    patch.debrief_enabled = data.debriefEnabled
  }
  if (has(data, 'debriefPrompt')) {
    const prompt = typeof data.debriefPrompt === 'string' ? data.debriefPrompt.trim() : ''
    if (!prompt) throw new HttpsError('invalid-argument', 'The debrief prompt is required.')
    patch.debrief_prompt = prompt
  }

  if (Object.keys(patch).length === 0) {
    throw new HttpsError('invalid-argument', 'Nothing to update.')
  }

  const db = admin.firestore()
  // merge:true — a settings save touches only the fields it was given, so it can never
  // clobber a sibling setting or, more importantly, anything an in-progress game
  // depends on. Every student's drawn round count is in truth/, which this never writes.
  await db.collection(INSTANCES_COLLECTION).doc(gameInstanceId)
    .collection('config').doc(CONFIG_DOC).set(patch, { merge: true })

  // Return the re-read effective config, so the page shows what was actually stored
  // (including any defaulting) and the re-derived KC preview and equilibrium the new
  // market produces.
  return readConfigView(db, gameInstanceId)
})
