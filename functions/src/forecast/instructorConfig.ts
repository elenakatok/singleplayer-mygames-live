import { onCall, HttpsError } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import { extractInstructorGameId } from '@mygames/game-server'
import {
  FORECAST_CORS_ORIGINS, INSTANCES_COLLECTION, PARTICIPANTS_SUBCOLLECTION, CONFIG_DOC, TRUTH_DOC,
  HARD_MIN_ROUNDS, HARD_MAX_ROUNDS, HARD_MIN_HISTORY, HARD_MAX_HISTORY, MAPE_STABILITY_FLOOR,
  loadForecastConfig, loadForecastModel, loadForecastSeed, parseAddedKcQuestion,
  addedKcStage, parseKcHidden, parseKcOrder, parseKcOverrides,
  DEBRIEF_ROW_ID, FORECAST_KC_STAGES,
  type ForecastConfig, type ForecastAddedKcQuestion,
} from './config'
import {
  DEFAULT_MODEL, systematic, usesPublishedHistory, resolveHistory, seasonMargin,
  HISTORY_SEARCH_CAP, type ForecastModel,
} from './demand'
import {
  resolveForecastKcQuestions, AUTHORED_KC_COUNT, FORECAST_BUILT_IN_KC_IDS,
  applyKcOverride, debriefQuestion, isGradedAdded, isKcOverridden, resolveForecastKc,
} from './questions'
import {
  forecastOverrideContext, lockedKcQuestionIds, validateKcOverrides, KC_LOCK_REASON,
} from './kcLock'

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
 *
 * Exported for the unit tests only — this is the sole place these sentences exist, and
 * the redraw/stale-CSV one is a claim about student-visible consequences that ought to be
 * pinned rather than eyeballed on the page.
 */
export function warningsFor(
  config: ForecastConfig,
  model: ForecastModel,
  seed: string | null,
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

  // ── The five-year history is REDRAWN, and downloaded CSVs go stale ──────────
  //
  // ⚠⚠ THE HISTORY IS A FUNCTION OF a, b, H, σ AND THE HIGH SEASON (Elena, 08-02). They
  // are generator INPUTS, not estimates, so editing one does not merely make the shipped
  // table "no longer the recommended one" — it makes it not this instance's history at
  // all, and the sixty months are redrawn at the new parameters.
  //
  // ⚠ THE STALE CSV IS THE HEADLINE, ahead of the benchmark note. The CSV is where the
  // regression actually gets run: a student who downloaded before the edit is fitting a
  // model to data the game has since replaced, and will get coefficients that disagree
  // with everyone else's for a reason no one in the room can see. Nothing prompts a
  // re-download, so this is the one consequence that needs saying out loud.
  if (!usesPublishedHistory(model, config.numHistory)) {
    out.push(
      'THE FIVE-YEAR HISTORY HAS BEEN REDRAWN at these parameters — it is generated from '
      + 'them, so it moves when they do. Any CSV a student has already downloaded is now '
      + 'stale, and nothing tells them to fetch it again: ask anyone who has started to '
      + 'download the history CSV afresh.',
    )
    out.push(
      'The benchmark table from the game design no longer describes this instance either '
      + '— those figures were computed against the published history at the shipped noise '
      + 'level. Students will see benchmarks recomputed against their own months instead, '
      + `and the reports page will say so. The floor becomes `
      + `${Math.round(model.sigma * model.sigma).toLocaleString()} — no forecast can beat it.`,
    )

    // ⚠ THE REDRAW IS SCREENED, BUT SOME MODELS CANNOT PASS. The generator searches for a
    // history in which the high season beats every ordinary month of its own year by at
    // least one σ, because a season the student cannot SEE leaves them nothing to model.
    // At H = 230 against σ = 300 no such series exists — the model does not have a visible
    // season to draw. Say so rather than shipping the best of a bad set in silence.
    const margin = seasonMargin(resolveHistory(model, seed, config.numHistory), model)
    if (margin !== null && margin < model.sigma) {
      out.push(
        `The high season is hard to SEE in the redrawn history: in its worst year the `
        + `seasonal months clear the ordinary ones by only ${Math.round(margin)} units `
        + `against noise of ${model.sigma}. The best of ${HISTORY_SEARCH_CAP} candidate `
        + 'draws was used, so this is the model, not the draw — the lift is small relative to the noise. Students '
        + 'are being asked to spot a pattern the chart barely shows.',
      )
    }
  }

  // ── Editing mid-flight (spec §3, the pricing precedent) ─────────────────────
  if (anyRoundsPlayed) {
    out.push(
      'Students have already forecast months in this instance. Editing the demand model '
      + 'now means the class is playing two different games: months already played were '
      + 'drawn under the old parameters, and the Tier-1 and Tier-3 reports will pool both.',
    )
  }

  // ⚠ NO WARNING FOR demandDraw: 'common' ANY MORE — it is the shipped DEFAULT as of
  // 08-02, and a warning that fires on every unedited instance is noise that trains an
  // instructor to skim this box. The leak it re-opens is real and is documented at the
  // default itself (demand.ts); the warning below fires on the NON-default instead, so
  // the box only ever speaks when something has been changed.
  if (model.demandDraw === 'perStudent') {
    out.push(
      'Each student will face a DIFFERENT future. That closes the take-home leak — no '
      + 'student can hand the class the answers — but it also means two students\' MSEs '
      + 'are not strictly comparable, and the class chart averages unrelated series.',
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
    warnings: warningsFor(config, model, loadForecastSeed(truthSnap.data()), anyRoundsPlayed),
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
 * ⚠ THIS IS THE INSTRUCTOR CALLABLE, so `correctValue` belongs here. `forecastGetQuestions`
 * (the STUDENT path) still strips every key.
 *
 * ⚠⚠ THE DEBRIEF PARAGRAPH IS A ROW (spec D9), in `post`. It is reported as a `builtin` row
 * but is STORED under the existing `debrief_prompt` / `debrief_enabled` keys, NOT in the
 * three convergence maps. The page translates at the boundary and the callable REFUSES an
 * override aimed at its id. No storage migration; no stored answer moves.
 *
 * ⚠⚠ NOTHING IS LOCKED HERE, and that is a MEASURED finding rather than an omission or a
 * default — every authored stem is a literal string, deliberately, because this game's model
 * parameters are the answer and the KC runs before play (questions.ts, kcLock.ts). The
 * `locked`/`lockReason` fields still ship because the detector is live: the day a stem gains
 * a config value they start populating without another line of code.
 */
function kcInventory(config: ForecastConfig) {
  const locked = lockedKcQuestionIds(config)
  // ⚠ Resolved BARE — the page must show every built-in, including ones this instance
  // currently hides or has switched off, with its own visibility reported separately.
  const authored = resolveForecastKc({
    ...config, kcEnabled: true, kcHidden: {}, kcOverrides: {}, kcOrder: {},
  })

  const builtIn = authored.map((raw) => {
    const q = applyKcOverride(raw, config.kcOverrides)
    return {
      id: q.field,
      kind: 'builtin' as const,
      stage: 'pre' as const,
      type: 'mc' as const,
      prompt: q.prompt,
      options: q.options.map(o => ({ value: o.value, label: o.label })),
      correctValue: q.correct_value,
      /** Always graded — every authored question carries a key. */
      graded: true,
      visible: config.kcHidden[q.field] !== true,
      locked: locked.has(q.field),
      lockReason: locked.has(q.field) ? KC_LOCK_REASON : null,
      overridden: isKcOverridden(q.field, config.kcOverrides),
      /** The AUTHORED text, so the page can offer "revert to the original". */
      originalPrompt: raw.prompt,
      originalOptions: raw.options.map(o => ({ value: o.value, label: o.label })),
      order: config.kcOrder[q.field] ?? null,
    }
  })

  const added = config.addedKcQuestions.map(q => ({
    id: q.id,
    kind: 'added' as const,
    stage: addedKcStage(q),
    type: q.type,
    prompt: q.prompt,
    options: (q.options ?? []).map(o => ({ value: o.value, label: o.label })),
    correctValue: q.correct_value ?? null,
    graded: isGradedAdded(q),
    visible: config.kcHidden[q.id] !== true,
    locked: false,
    lockReason: null,
    overridden: false,
    order: config.kcOrder[q.id] ?? null,
  }))

  /** ⚠ The debrief paragraph, as a row. See the note on `kcInventory`. */
  const debriefRow = {
    id: DEBRIEF_ROW_ID,
    kind: 'builtin' as const,
    stage: 'post' as const,
    type: 'text' as const,
    prompt: config.debriefPrompt,
    placeholder: debriefQuestion.placeholder,
    options: [] as { value: string; label: string }[],
    correctValue: null,
    /** ⚠ NEVER GRADED, and by ABSENCE OF A KEY rather than by its stage or its type. */
    graded: false,
    visible: config.debriefEnabled,
    locked: false,
    lockReason: null,
    overridden: false,
    order: config.kcOrder[DEBRIEF_ROW_ID] ?? null,
  }

  const pool = [...builtIn, ...added, debriefRow]
  return {
    stages: FORECAST_KC_STAGES,
    builtIn,
    added,
    debrief: debriefRow,
    /** ⚠ THE COUNT LINE'S THREE NUMBERS — visible AND graded. Never stored (D5). */
    poolTotal: pool.length,
    visibleCount: pool.filter(q => q.visible).length,
    gradedCount: pool.filter(q => q.visible && q.graded).length,
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
      // ⚠⚠ THE COLLISION GUARD, KEPT VERBATIM. The shared parser already refuses a `kc_`
      // id (config.ts's FORECAST_KC_ID_GUARD), so this is the SECOND of two; both stay,
      // because this one produces the instructor-facing sentence and the parser's refusal
      // would otherwise surface as the generic "incomplete question" message.
      //
      // ⚠ IT DOES NOT COVER `debrief_method`, and that is deliberate and pinned by a test.
      // See FORECAST_KC_ID_GUARD's note: the two answer maps are what keeps a collision
      // harmless, and widening the guard would refuse ids that existing instances may
      // already hold.
      if (q.id.startsWith('kc_')) {
        throw new HttpsError('invalid-argument', 'An added question cannot use a reserved kc_ id.')
      }
      if (seen.has(q.id)) throw new HttpsError('invalid-argument', `Duplicate question id: ${q.id}`)
      seen.add(q.id)
      parsed.push(q)
    }
    configPatch.added_kc_questions = parsed
  }

  // ── The three convergence fields (spec §5) ──────────────────────────────────
  //
  // ⚠ Validated against the questions this instance ACTUALLY has — including any addition
  // being saved in the SAME call, which is why `knownAdded` prefers the incoming list.
  // Without that, adding a question and reordering it in one save would refuse itself.
  {
    const storedSnap = await instanceRef.collection('config').doc(CONFIG_DOC).get()
    const stored = loadForecastConfig(storedSnap.data())
    const knownAdded = new Set(
      (configPatch.added_kc_questions as ForecastAddedKcQuestion[] | undefined)?.map(q => q.id)
      ?? stored.addedKcQuestions.map(q => q.id),
    )
    const knownId = (id: string) =>
      FORECAST_BUILT_IN_KC_IDS.has(id) || knownAdded.has(id) || id === DEBRIEF_ROW_ID

    if (has(data, 'kcHidden')) {
      const p = parseKcHidden(data.kcHidden)
      for (const id of Object.keys(p)) {
        if (!knownId(id)) throw new HttpsError('invalid-argument', `'${id}' is not a question in this game.`)
      }
      configPatch.kc_hidden = p
    }

    if (has(data, 'kcOrder')) {
      const p = parseKcOrder(data.kcOrder)
      for (const id of Object.keys(p)) {
        if (!knownId(id)) throw new HttpsError('invalid-argument', `'${id}' is not a question in this game.`)
      }
      configPatch.kc_order = p
    }

    if (has(data, 'kcOverrides')) {
      // ⚠⚠ THE LOCK IS ENFORCED HERE, NOT ONLY IN THE UI (spec §5) — even though forecast
      // locks nothing today. A greyed-out Edit button stops an instructor; it does not stop
      // a stale tab or a hand-made call. The detector is live, so the day a stem gains a
      // config value this starts refusing without another line of code.
      //
      // ⚠ AN UNKNOWN OPTION ID IS REFUSED, not dropped: `applyKcOverride` looks options up
      // BY VALUE, so a typo'd key would simply never apply and the instructor would see
      // their edit silently vanish on the next load.
      const rejections = validateKcOverrides(
        parseKcOverrides(data.kcOverrides),
        forecastOverrideContext(stored),
      )
      if (rejections.length > 0) throw new HttpsError('invalid-argument', rejections[0].message)
      configPatch.kc_overrides = parseKcOverrides(data.kcOverrides)
    }
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
