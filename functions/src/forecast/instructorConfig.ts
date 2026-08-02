import { onCall, HttpsError } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import { extractInstructorGameId } from '@mygames/game-server'
import {
  FORECAST_CORS_ORIGINS, INSTANCES_COLLECTION, PARTICIPANTS_SUBCOLLECTION, CONFIG_DOC, TRUTH_DOC,
  HARD_MIN_ROUNDS, HARD_MAX_ROUNDS, HARD_MIN_HISTORY, HARD_MAX_HISTORY, MAPE_STABILITY_FLOOR,
  loadForecastConfig, loadForecastModel, loadForecastSeed, parseAddedKcQuestion,
  type ForecastConfig, type ForecastAddedKcQuestion,
} from './config'
import {
  DEFAULT_MODEL, systematic, usesPublishedHistory, type ForecastModel,
} from './demand'
import { resolveForecastKcQuestions, AUTHORED_KC_COUNT } from './questions'

// ═══════════════════════════════════════════════════════════════════════════════
// forecastGetConfig / forecastUpdateConfig (instructor) — the settings page's server
// side (spec §3). Mirrors newsvendor's and pricing's: read everything, write back only
// the fields that were sent, re-read and return what was actually STORED.
//
// ⚠⚠ THIS IS THE ONLY WAY THE MODEL IS EVER EDITED, AND IT MUST BE. `truth/main` is
// rules-denied to every client including an authenticated instructor (firestore.rules),
// so the Settings page cannot reach it with the Firestore SDK — by design. These two
// callables use the ADMIN SDK, which bypasses rules entirely, and they are behind
// extractInstructorGameId. Newsvendor already relies on exactly this arrangement for
// its seed; here the same mechanism carries the whole model.
//
// ⚠ THE PATCH IS SPLIT BY DESTINATION, and that split is the data model in one place:
//     config/main   rounds, numHistory, forecast bounds, labels, flow switches
//     truth/main    a, b, H, highSeasonMonths, σ, seasonality, seasonStructure,
//                   monthOffsets, demandDraw, seed
// A field routed to the wrong document is a leak (config/main is student-readable), so
// the two maps below are built separately and never merged.
//
// ⚠ WARN, NEVER BLOCK (spec §3, §3a, §5a — the platform's inform-don't-block doctrine).
// Nothing here refuses an edit on pedagogical grounds. The response carries a
// `warnings` array and the page shows it; the instructor decides. Only structurally
// impossible values are refused (a non-integer month count, an inverted bound), because
// those are not choices, they are typos.
// ═══════════════════════════════════════════════════════════════════════════════

/** Reads one optional field; `undefined` means "not being changed". */
const has = (d: Record<string, unknown>, k: string) => Object.prototype.hasOwnProperty.call(d, k)

/**
 * The advisory warnings this configuration earns (spec §3, §3a, §5a).
 *
 * ⚠ EVERY ONE IS ADVICE, NOT A REFUSAL. They exist because each of these edits is
 * legitimate but has a consequence an instructor would not otherwise see until the
 * reports looked wrong.
 */
function warningsFor(
  config: ForecastConfig,
  model: ForecastModel,
  anyRoundsPlayed: boolean,
): string[] {
  const out: string[] = []

  // ── spec §3a: the two unused config flips ───────────────────────────────────
  if (model.seasonality === 'multiplicative') {
    out.push(
      'Multiplicative seasonality is off-method: the lecture teaches an ADDITIVE '
      + 'regression with indicator variables, so a student who applies the taught method '
      + 'correctly will be systematically wrong at the seasonal peaks. No shipped '
      + 'instance uses this.',
    )
  }
  if (model.seasonStructure === 'perMonth') {
    const differs = model.monthOffsets.some((v, i) =>
      v !== (model.highSeasonMonths.includes(i + 1) ? model.H : 0))
    out.push(differs
      ? 'Twelve independent month offsets add parameters the demand process does not '
        + 'need. A student fitting them pays extra forecast error for coefficients '
        + 'estimated from noise — the parsimony point of the debrief, inverted.'
      : 'Per-month seasonality is switched on but the offsets still match the two-season '
        + 'pattern, so this changes nothing. Edit the offsets for it to take effect.')
  }

  // ── spec §5a: the MAPE stability floor ──────────────────────────────────────
  // MAPE divides by actual demand, so it and the bonus destabilize as demand nears
  // zero. Checked against the LOWEST systematic month over the whole game, minus three
  // sigma — the level a realization could plausibly reach.
  const totalPeriods = config.numHistory + config.rounds
  let lowest = Infinity
  for (let p = 1; p <= totalPeriods; p++) lowest = Math.min(lowest, systematic(model, p))
  const plausibleLow = lowest - 3 * model.sigma
  if (plausibleLow < MAPE_STABILITY_FLOOR) {
    out.push(
      `These parameters can produce demand near or below ${MAPE_STABILITY_FLOOR} units `
      + `(lowest expected month ≈ ${Math.round(lowest)}, and realizations run about `
      + `${Math.round(3 * model.sigma)} either side). MAPE, Forecast Accuracy and the `
      + 'bonus become unstable when demand approaches zero — MSE stays valid throughout.',
    )
  }

  // ── The published history and the §2.3 benchmark table ──────────────────────
  if (!usesPublishedHistory(model, config.numHistory)) {
    out.push(
      'This instance no longer uses the published five-year history, so the benchmark '
      + 'table from the game design (flat-mean 37,840 … regression 902) does not describe '
      + 'it. Students will see benchmarks recomputed against their own months instead, '
      + 'and the reports page will say so.',
    )
  }

  // ── Editing mid-flight (spec §3, the pricing precedent) ─────────────────────
  if (anyRoundsPlayed) {
    out.push(
      'Students have already forecast months in this instance. Editing the demand model '
      + 'now means the class is playing two different games: months already played were '
      + 'drawn under the old parameters, and the Tier-1 and Tier-3 reports will pool both.',
    )
  }

  if (model.demandDraw === 'common') {
    out.push(
      'Every student will face the SAME future demand. That is fine for an in-class run, '
      + 'but for a take-home the first student to finish can hand the class every '
      + 'remaining month.',
    )
  }

  return out
}

/** Shape shared by both callables, so the page can never be handed two different
 *  pictures of the same instance. */
async function readConfigView(db: admin.firestore.Firestore, gameInstanceId: string) {
  const instanceRef = db.collection(INSTANCES_COLLECTION).doc(gameInstanceId)
  const [configSnap, truthSnap, playedSnap] = await Promise.all([
    instanceRef.collection('config').doc(CONFIG_DOC).get(),
    instanceRef.collection('truth').doc(TRUTH_DOC).get(),
    // "Has anyone actually PLAYED?" — one indexed hit, not a scan. The edit warning
    // turns on this, not on having merely launched.
    instanceRef.collection(PARTICIPANTS_SUBCOLLECTION).where('rounds_played', '>', 0).limit(1).get(),
  ])

  const config = loadForecastConfig(configSnap.data())
  const model = loadForecastModel(truthSnap.data())
  const anyRoundsPlayed = !playedSnap.empty

  return {
    ok: true as const,
    config: {
      numHistory: config.numHistory,
      rounds: config.rounds,
      forecastMin: config.forecastMin,
      forecastMax: config.forecastMax,
      productName: config.productName,
      unitLabel: config.unitLabel,
      periodLabel: config.periodLabel,
      kcEnabled: config.kcEnabled,
      addedKcQuestions: config.addedKcQuestions,
      debriefEnabled: config.debriefEnabled,
      debriefPrompt: config.debriefPrompt,
    },
    /**
     * ⚠ INSTRUCTOR-ONLY — the whole demand model, read from the rules-denied truth doc.
     * This is the answer key: it reaches no student response (clientState.ts), and the
     * one student path that carries it is gated behind the finished debrief (reveal.ts).
     */
    model: {
      a: model.a,
      b: model.b,
      H: model.H,
      highSeasonMonths: model.highSeasonMonths,
      sigma: model.sigma,
      seasonality: model.seasonality,
      seasonStructure: model.seasonStructure,
      monthOffsets: model.monthOffsets,
      demandDraw: model.demandDraw,
    },
    /** ⚠ INSTRUCTOR-ONLY. It derives every future draw. */
    seed: loadForecastSeed(truthSnap.data()),
    /** Does this instance still use spec §2.1's published history? Drives whether the
     *  published benchmark table applies (reports and debrief both branch on it). */
    usesPublishedHistory: usesPublishedHistory(model, config.numHistory),
    /** Advisory only — spec §3's warn-never-block posture. */
    warnings: warningsFor(config, model, anyRoundsPlayed),
    /**
     * Read-only preview of the AUTHORED knowledge check, with the answer key
     * (instructor-side). Not editable: the stems carry their own numbers on purpose, so
     * that a KC running BEFORE play cannot print a model parameter (questions.ts).
     * Resolved with a fixed pseudo-participant so the preview's option order is stable
     * between page loads; every real student gets their own shuffle.
     */
    authoredKcPreview: resolveForecastKcQuestions('__preview__').map(q => ({
      field: q.field,
      prompt: q.prompt,
      options: q.options,
      correct_value: q.correct_value,
    })),
    /** How many graded questions the authored set contributes to the denominator. */
    authoredKcCount: AUTHORED_KC_COUNT,
    /** Has any student actually played a month? Drives the edit warning. */
    anyRoundsPlayed,
  }
}

export const forecastGetConfig = onCall({ cors: FORECAST_CORS_ORIGINS }, async (request) => {
  const data = request.data as Record<string, unknown>
  const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true'
  const authHeader = request.rawRequest.headers.authorization as string | undefined

  const gameInstanceId = await extractInstructorGameId(data, isEmulator, authHeader)
  return readConfigView(admin.firestore(), gameInstanceId)
})

/** A finite number, or a thrown error naming the field so the settings page can show
 *  the instructor which box is wrong. */
function requireNumber(v: unknown, label: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new HttpsError('invalid-argument', `${label} must be a number.`)
  }
  return v
}

export const forecastUpdateConfig = onCall({ cors: FORECAST_CORS_ORIGINS }, async (request) => {
  const data = request.data as Record<string, unknown>
  const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true'
  const authHeader = request.rawRequest.headers.authorization as string | undefined

  const gameInstanceId = await extractInstructorGameId(data, isEmulator, authHeader)

  const db = admin.firestore()
  const instanceRef = db.collection(INSTANCES_COLLECTION).doc(gameInstanceId)

  // ⚠ TWO PATCHES, TWO DESTINATIONS. Never merged — see the file header.
  const configPatch: Record<string, unknown> = {}
  const truthPatch: Record<string, unknown> = {}

  // ── config/main: the student-safe half ──────────────────────────────────────

  if (has(data, 'rounds')) {
    const v = data.rounds
    if (typeof v !== 'number' || !Number.isInteger(v)) {
      throw new HttpsError('invalid-argument', 'The number of months must be a whole number.')
    }
    if (v < HARD_MIN_ROUNDS || v > HARD_MAX_ROUNDS) {
      throw new HttpsError('invalid-argument',
        `The number of months must be between ${HARD_MIN_ROUNDS} and ${HARD_MAX_ROUNDS}.`)
    }
    configPatch.rounds = v
  }

  if (has(data, 'numHistory')) {
    const v = data.numHistory
    if (typeof v !== 'number' || !Number.isInteger(v)) {
      throw new HttpsError('invalid-argument', 'The history length must be a whole number.')
    }
    if (v < HARD_MIN_HISTORY || v > HARD_MAX_HISTORY) {
      throw new HttpsError('invalid-argument',
        `The history length must be between ${HARD_MIN_HISTORY} and ${HARD_MAX_HISTORY} months.`)
    }
    configPatch.num_history = v
  }

  // The forecast bounds are validated as a PAIR against their prospective values, not
  // one at a time: a legal min and a legal max can still be an inverted range.
  if (has(data, 'forecastMin') || has(data, 'forecastMax')) {
    const currentSnap = await instanceRef.collection('config').doc(CONFIG_DOC).get()
    const current = loadForecastConfig(currentSnap.data())
    const lo = has(data, 'forecastMin')
      ? Math.round(requireNumber(data.forecastMin, 'The lowest forecast')) : current.forecastMin
    const hi = has(data, 'forecastMax')
      ? Math.round(requireNumber(data.forecastMax, 'The highest forecast')) : current.forecastMax
    if (lo < 0) throw new HttpsError('invalid-argument', 'The lowest forecast cannot be negative.')
    if (hi <= lo) {
      throw new HttpsError('invalid-argument', 'The highest forecast must be above the lowest.')
    }
    configPatch.forecast_min = lo
    configPatch.forecast_max = hi
  }

  const text = (key: string, store: string, label: string) => {
    if (!has(data, key)) return
    const v = typeof data[key] === 'string' ? (data[key] as string).trim() : ''
    if (!v) throw new HttpsError('invalid-argument', `${label} is required.`)
    configPatch[store] = v
  }
  text('productName', 'product_name', 'The product name')
  text('unitLabel', 'unit_label', 'The unit label')
  text('periodLabel', 'period_label', 'The period label')
  text('debriefPrompt', 'debrief_prompt', 'The debrief prompt')

  const toggle = (key: string, store: string, label: string) => {
    if (!has(data, key)) return
    if (typeof data[key] !== 'boolean') {
      throw new HttpsError('invalid-argument', `${label} must be true or false.`)
    }
    configPatch[store] = data[key]
  }
  toggle('kcEnabled', 'kc_enabled', 'kcEnabled')
  toggle('debriefEnabled', 'debrief_enabled', 'debriefEnabled')

  if (has(data, 'addedKcQuestions')) {
    if (!Array.isArray(data.addedKcQuestions)) {
      throw new HttpsError('invalid-argument', 'addedKcQuestions must be an array.')
    }
    const parsed: ForecastAddedKcQuestion[] = []
    const seen = new Set<string>()
    for (const raw of data.addedKcQuestions) {
      const q = parseAddedKcQuestion(raw)
      if (!q) {
        throw new HttpsError('invalid-argument',
          'An added question is incomplete — every question needs a prompt, and a multiple-choice question needs at least two options and a correct answer among them.')
      }
      if (q.id.startsWith('kc_')) {
        throw new HttpsError('invalid-argument', 'An added question cannot use a reserved kc_ id.')
      }
      if (seen.has(q.id)) throw new HttpsError('invalid-argument', `Duplicate question id: ${q.id}`)
      seen.add(q.id)
      parsed.push(q)
    }
    configPatch.added_kc_questions = parsed
  }

  // ── truth/main: the model and the seed ──────────────────────────────────────

  const modelNum = (key: string, store: string, label: string) => {
    if (!has(data, key)) return
    truthPatch[store] = requireNumber(data[key], label)
  }
  modelNum('a', 'intercept', 'The intercept')
  modelNum('b', 'trend', 'The trend')
  modelNum('H', 'high_season_lift', 'The high-season lift')

  if (has(data, 'sigma')) {
    const v = requireNumber(data.sigma, 'The noise standard deviation')
    if (v < 0) throw new HttpsError('invalid-argument', 'The standard deviation cannot be negative.')
    truthPatch.sigma = v
  }

  if (has(data, 'highSeasonMonths')) {
    const raw = data.highSeasonMonths
    if (!Array.isArray(raw)
      || !raw.every(m => typeof m === 'number' && Number.isInteger(m) && m >= 1 && m <= 12)) {
      throw new HttpsError('invalid-argument', 'High-season months must be whole numbers from 1 to 12.')
    }
    // De-duplicated and sorted, so {12,11,11} and {11,12} are the same stored season.
    truthPatch.high_season_months = [...new Set(raw as number[])].sort((x, y) => x - y)
  }

  if (has(data, 'monthOffsets')) {
    const raw = data.monthOffsets
    if (!Array.isArray(raw) || raw.length !== 12
      || !raw.every(v => typeof v === 'number' && Number.isFinite(v))) {
      throw new HttpsError('invalid-argument', 'Month offsets must be exactly twelve numbers.')
    }
    truthPatch.month_offsets = raw
  }

  const enumField = (key: string, store: string, allowed: string[], label: string) => {
    if (!has(data, key)) return
    const v = data[key]
    if (typeof v !== 'string' || !allowed.includes(v)) {
      throw new HttpsError('invalid-argument', `${label} must be one of: ${allowed.join(', ')}.`)
    }
    truthPatch[store] = v
  }
  enumField('seasonality', 'seasonality', ['additive', 'multiplicative'], 'Seasonality')
  enumField('seasonStructure', 'season_structure', ['twoSeason', 'perMonth'], 'The season structure')
  enumField('demandDraw', 'demand_draw', ['perStudent', 'common'], 'The demand draw')

  // The seed. An empty string CLEARS it (back to real randomness for the futures).
  if (has(data, 'seed')) {
    const raw = data.seed
    if (raw === null || (typeof raw === 'string' && raw.trim() === '')) {
      truthPatch.seed = null
    } else if (typeof raw === 'string') {
      truthPatch.seed = raw.trim()
    } else if (typeof raw === 'number' && Number.isFinite(raw)) {
      truthPatch.seed = String(raw)
    } else {
      throw new HttpsError('invalid-argument', 'The seed must be text, a number, or blank.')
    }
  }

  if (Object.keys(configPatch).length === 0 && Object.keys(truthPatch).length === 0) {
    throw new HttpsError('invalid-argument', 'Nothing to update.')
  }

  const writes: Promise<unknown>[] = []
  // merge:true — a settings save touches only the fields it was given, so it can never
  // clobber a sibling setting.
  if (Object.keys(configPatch).length > 0) {
    writes.push(instanceRef.collection('config').doc(CONFIG_DOC).set(configPatch, { merge: true }))
  }
  if (Object.keys(truthPatch).length > 0) {
    writes.push(instanceRef.collection('truth').doc(TRUTH_DOC).set(truthPatch, { merge: true }))
  }
  await Promise.all(writes)

  // Return the re-read effective configuration, so the page shows what was actually
  // stored (including any defaulting) and the warnings the new values earn.
  return readConfigView(db, gameInstanceId)
})

/** Provisions a brand-new instance at the shipped model (spec §2 defaults + seed 1).
 *  Exported for the harness and any future instance-creation path; the loaders already
 *  default correctly, so an instance that never calls this is still playable. */
export const DEFAULT_TRUTH_DOC = {
  intercept: DEFAULT_MODEL.a,
  trend: DEFAULT_MODEL.b,
  high_season_lift: DEFAULT_MODEL.H,
  high_season_months: DEFAULT_MODEL.highSeasonMonths,
  sigma: DEFAULT_MODEL.sigma,
  seasonality: DEFAULT_MODEL.seasonality,
  season_structure: DEFAULT_MODEL.seasonStructure,
  demand_draw: DEFAULT_MODEL.demandDraw,
  seed: '1',
}
