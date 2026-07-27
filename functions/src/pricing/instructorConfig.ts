import { onCall, HttpsError } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import { extractInstructorGameId } from '@mygames/game-server'
import {
  PRICING_CORS_ORIGINS, INSTANCES_COLLECTION, PARTICIPANTS_SUBCOLLECTION, CONFIG_DOC, TRUTH_DOC,
  HARD_MIN_ROUNDS, HARD_MAX_ROUNDS,
  loadPricingConfig, loadPricingStrategies, activeStrategy, parseAddedKcQuestion,
  type PricingAddedKcQuestion,
} from './config'
import { STRATEGY_DESCRIPTIONS } from './strategy'
import { nashEquilibrium } from './market'
import { resolvePricingKcQuestions } from './questions'

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
  }
}

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
