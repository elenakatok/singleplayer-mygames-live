import { onCall, HttpsError } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import { extractInstructorGameId } from '@mygames/game-server'
import {
  PD_CORS_ORIGINS, INSTANCES_COLLECTION, CONFIG_DOC,
  HARD_MIN_ROUNDS, HARD_MAX_ROUNDS, loadPdConfig, parseAddedKcQuestion, addedKcStage,
  parseKcHidden, parseKcOrder, parseKcOverrides,
  type PdAddedKcQuestion, type PdConfig,
} from './config'
import {
  resolveKcQuestions, applyKcOverride, isKcOverridden, isGradedAdded,
  PD_BUILT_IN_KC_IDS, PD_KC_STAGES,
} from './questions'
import { lockedKcQuestionIds, validateKcOverrides, KC_LOCK_REASON } from './kcLock'
import { PAYOFF_KEYS } from './payoff'

// ═══════════════════════════════════════════════════════════════════════════════
// PD settings callables (Slice 5). pdGetConfig returns the whole editable config for
// the settings page; pdUpdateConfig validates and writes it back. Same shape as
// poll's instructorConfig pair.
//
// WHAT IS AND IS NOT EDITABLE:
//   editable   payoff matrix (EIGHT values — Y and O per cell), move labels, unit,
//              round RANGE, KC on/off, added KC questions, debrief on/off + prompt
//   derived    the four matrix-comprehension KC questions — computed from the matrix
//              at serve and grade time, never stored as text (see questions.ts). They
//              are RETURNED here read-only so the settings page can preview what the
//              current matrix produces.
//   fixed      the bot strategies (TFT/GRIM) — not configurable, by decision
//   truth      the DRAWN round counts — never returned here, never editable. Only
//              their range is. Each STUDENT draws their own on first launch
//              (init.ts) and a range edit never redraws a student already playing;
//              `anyRoundsDrawn` below tells the instructor whether anyone has
//              started, without revealing any student's number.
// ═══════════════════════════════════════════════════════════════════════════════

export const pdGetConfig = onCall({ cors: PD_CORS_ORIGINS }, async (request) => {
  const data = request.data as Record<string, unknown>
  const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true'
  const authHeader = request.rawRequest.headers.authorization as string | undefined

  const gameInstanceId = await extractInstructorGameId(data, isEmulator, authHeader)

  const db = admin.firestore()
  const instanceRef = db.collection(INSTANCES_COLLECTION).doc(gameInstanceId)
  const [configSnap, drawnSnap] = await Promise.all([
    instanceRef.collection('config').doc(CONFIG_DOC).get(),
    // "Has ANY student drawn a horizon yet?" — one indexed hit, not a scan, and
    // deliberately not a read of a specific document: horizons are per student
    // (init.ts), so there is no instance-level count to look at. Only participant
    // truth docs carry a numeric `rounds`, so a single match answers the question.
    instanceRef.collection('truth').where('rounds', '>', 0).limit(1).get(),
  ])

  const config = loadPdConfig(configSnap.data())

  return configView(config, !drawnSnap.empty)
})

/** Reads one optional field; `undefined` means "not being changed". */
const has = (d: Record<string, unknown>, k: string) => Object.prototype.hasOwnProperty.call(d, k)

export const pdUpdateConfig = onCall({ cors: PD_CORS_ORIGINS }, async (request) => {
  const data = request.data as Record<string, unknown>
  const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true'
  const authHeader = request.rawRequest.headers.authorization as string | undefined

  const gameInstanceId = await extractInstructorGameId(data, isEmulator, authHeader)

  const patch: Record<string, unknown> = {}

  // ── Payoff matrix — EIGHT finite, non-negative numbers ────────────────────
  //
  // ⚠ ALL EIGHT ARE REQUIRED ON SAVE, and the save writes all eight (spec §2). There is
  // no half-migration: an instance still storing the legacy four is normalized to eight
  // when it is READ (payoff.ts `parsePayoffs`), the settings page therefore renders
  // eight, and the first instructor save stores eight. Nothing backfills an instance
  // nobody has saved.
  //
  // ⚠ NO DILEMMA CHECK HERE, DELIBERATELY. Whether the numbers form a prisoner's
  // dilemma is ADVISORY — the settings page warns and the save still succeeds (spec §2).
  // A matrix that is not a dilemma is a legitimate thing to run; it is just not the
  // lecture's example.
  if (has(data, 'payoffs')) {
    const p = (typeof data.payoffs === 'object' && data.payoffs !== null ? data.payoffs : {}) as Record<string, unknown>
    const out: Record<string, number> = {}
    for (const key of PAYOFF_KEYS) {
      const v = p[key]
      // ⚠ ANY FINITE NUMBER — no floor, no ceiling, no integer requirement. A payoff
      // may be negative (a cost, a penalty, a loss) or fractional. Only non-numeric
      // input, NaN and ±Infinity are refused, and the message says exactly that rather
      // than asserting a range that does not exist.
      //
      // ⚠ THIS MUST AGREE WITH THE FORM. The settings page's number inputs carry no
      // `min`, so a stricter rule here is how a value gets typed, accepted, and then
      // rejected on save — which is how the `>= 0` floor was found.
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        throw new HttpsError('invalid-argument', `Payoff "${key}" must be a number.`)
      }
      out[key] = v
    }
    patch.payoffs = out
  }

  // ── Move labels — two non-empty strings ───────────────────────────────────
  if (has(data, 'labels')) {
    const l = (typeof data.labels === 'object' && data.labels !== null ? data.labels : {}) as Record<string, unknown>
    const C = typeof l.C === 'string' ? l.C.trim() : ''
    const D = typeof l.D === 'string' ? l.D.trim() : ''
    if (!C || !D) throw new HttpsError('invalid-argument', 'Both move labels are required.')
    patch.labels = { C, D }
  }

  // ── Unit — one non-empty word ─────────────────────────────────────────────
  if (has(data, 'unit')) {
    const unit = typeof data.unit === 'string' ? data.unit.trim() : ''
    if (!unit) throw new HttpsError('invalid-argument', 'The unit is required.')
    patch.unit = unit
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
    const parsed: PdAddedKcQuestion[] = []
    const seen = new Set<string>()
    for (const raw of data.addedKcQuestions) {
      const q = parseAddedKcQuestion(raw)
      if (!q) {
        throw new HttpsError('invalid-argument',
          'An added question is incomplete — every question needs a prompt, and a multiple-choice question needs at least two options and a correct answer among them.')
      }
      // The derived four own the kc_ namespace; parseAddedKcQuestion already refuses
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
  // ⚠ Every key is checked against the ids this instance actually has. A stale id — from a
  // question deleted between page load and save — is REFUSED rather than stored, because a
  // hidden map full of ids nothing serves is how "10 of 12 visible" starts lying.
  //
  // ⚠ ADDED IDS AND THE DEBRIEF ROW COUNT AS KNOWN for `hidden` and `order`. Only
  // `overrides` is derived-question-only: added questions are stored data edited in place,
  // and the debrief row is backed by `debrief_prompt`.
  const db0 = admin.firestore()
  const stored = has(data, 'kcHidden') || has(data, 'kcOrder') || has(data, 'kcOverrides')
    ? loadPdConfig((await db0.collection(INSTANCES_COLLECTION).doc(gameInstanceId)
      .collection('config').doc(CONFIG_DOC).get()).data())
    : null

  if (stored !== null) {
    const knownAdded = new Set(
      (patch.added_kc_questions as PdAddedKcQuestion[] | undefined)?.map(q => q.id)
      ?? stored.addedKcQuestions.map(q => q.id),
    )
    const knownId = (id: string) =>
      PD_BUILT_IN_KC_IDS.has(id) || knownAdded.has(id) || id === DEBRIEF_ROW_ID

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
      // hand-made call. A locked question's text is RECOMPUTED from the payoff matrix, so
      // an override on it would be discarded on the next matrix edit — or, worse, kept and
      // left contradicting the numbers beside it.
      //
      // ⚠ Classified against THIS instance's live config, not a hardcoded list — see
      // kcLock.ts for why the classification is measured rather than listed.
      const derived = resolveKcQuestions(stored.payoffs, stored.unit, stored.labels)
      const rejections = validateKcOverrides(parseKcOverrides(data.kcOverrides), {
        builtInIds: PD_BUILT_IN_KC_IDS,
        locked: lockedKcQuestionIds(stored),
        optionIds: new Map(derived.map(q => [q.field, new Set((q.options ?? []).map(o => o.value))])),
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
  const instanceRef = db.collection(INSTANCES_COLLECTION).doc(gameInstanceId)
  // merge:true — a settings save touches only the fields it was given, so it can
  // never clobber a sibling setting or, more importantly, anything an in-progress
  // game depends on. The drawn round count is in truth/, which this never writes.
  await instanceRef.collection('config').doc(CONFIG_DOC).set(patch, { merge: true })

  // Return the re-read effective config, so the page shows what was actually stored
  // (including any defaulting) rather than what it hoped it sent.
  const [configSnap, drawnSnap] = await Promise.all([
    instanceRef.collection('config').doc(CONFIG_DOC).get(),
    // "Has ANY student drawn a horizon yet?" — one indexed hit, not a scan, and
    // deliberately not a read of a specific document: horizons are per student
    // (init.ts), so there is no instance-level count to look at. Only participant
    // truth docs carry a numeric `rounds`, so a single match answers the question.
    instanceRef.collection('truth').where('rounds', '>', 0).limit(1).get(),
  ])
  const config = loadPdConfig(configSnap.data())

  return configView(config, !drawnSnap.empty)
})

/**
 * The settings page's whole picture of ONE instance.
 *
 * ⚠⚠ BOTH CALLABLES RETURN THIS, AND THAT IS THE POINT. `pdGetConfig` and `pdUpdateConfig`
 * used to build the object separately, so this pass's new `kc` field landed in one of them
 * and not the other — the page loaded fine and then crashed on save. One builder, two
 * callers: the same discipline the serve path and the grader now share.
 */
function configView(config: PdConfig, anyRoundsDrawn: boolean) {
  return {
    ok: true as const,
    payoffs: config.payoffs,
    labels: config.labels,
    unit: config.unit,
    minRounds: config.minRounds,
    maxRounds: config.maxRounds,
    kcEnabled: config.kcEnabled,
    addedKcQuestions: config.addedKcQuestions,
    debriefEnabled: config.debriefEnabled,
    debriefPrompt: config.debriefPrompt,
    /**
     * Read-only preview of what the CURRENT matrix derives, so the settings page can show
     * the instructor the four questions their payoff edits just produced. Instructor-side,
     * so the answer key may be included here.
     */
    derivedKcPreview: resolveKcQuestions(config.payoffs, config.unit, config.labels).map(q => ({
      field: q.field,
      prompt: q.prompt,
      options: q.options ?? [],
      correct_value: q.correct_value,
    })),
    /** Has ANY student drawn their hidden round count yet — i.e. has anyone launched? A
     *  BOOLEAN — never a number, and never a count of students, even for the instructor's
     *  settings page. Drives the "range edits will not reach students already playing"
     *  warning. */
    anyRoundsDrawn,
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
 * ⚠ THIS IS THE INSTRUCTOR CALLABLE, so `correctValue` belongs here. `pdGetQuestions` (the
 * STUDENT path) still strips every key.
 *
 * ⚠⚠ THE DEBRIEF IS A ROW IN THIS LIST (spec D9). It is not a separate surface: "debrief is
 * an ungraded question in a later stage". It is reported as a `builtin` row in the `post`
 * stage — editable, hideable, reorderable, never graded and never deletable — but its
 * prompt and its visibility are STORED under the existing `debrief_prompt` /
 * `debrief_enabled` keys, NOT in the three convergence maps. The settings page translates
 * between the two. No storage migration; stored answers do not move.
 *
 * ⚠ Unlike scorecard's `noticing`/`linking`, pd's debrief has NO server-enforced ordering to
 * protect — nothing is refused until it is stored — which is precisely why it can be folded
 * into the list and they cannot.
 */
function kcInventory(config: PdConfig) {
  const locked = lockedKcQuestionIds(config)
  const authored = resolveKcQuestions(config.payoffs, config.unit, config.labels)

  const builtIn = authored.map((raw) => {
    const q = applyKcOverride(raw, config.kcOverrides)
    return {
      id: q.field,
      kind: 'builtin' as const,
      stage: 'pre' as const,
      prompt: q.prompt,
      options: (q.options ?? []).map(o => ({ value: o.value, label: o.label })),
      correctValue: q.correct_value ?? null,
      /** Always graded — every derived question carries a key. */
      graded: true,
      visible: config.kcHidden[q.field] !== true,
      locked: locked.has(q.field),
      /** ⚠ Always populated when `locked` — a disabled control with no reason is a bug. */
      lockReason: locked.has(q.field) ? KC_LOCK_REASON : null,
      overridden: isKcOverridden(q.field, config.kcOverrides),
      /** The GENERATED text, so the page can offer "revert to the original". */
      originalPrompt: raw.prompt,
      originalOptions: (raw.options ?? []).map(o => ({ value: o.value, label: o.label })),
      order: config.kcOrder[q.field] ?? null,
    }
  })

  const added = config.addedKcQuestions.map(q => ({
    id: q.id,
    kind: 'added' as const,
    // ⚠ THE QUESTION'S OWN STAGE, not a hardcoded 'pre'. It was hardcoded while `post`
    // could not receive additions; leaving it would file every post-stage question under
    // the wrong heading on the settings page while the student saw it after play.
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
    /** ⚠ NEVER GRADED, and by ABSENCE OF A KEY rather than by being in the post stage —
     *  the same rule every other ungraded question in the family follows. */
    graded: false,
    visible: config.debriefEnabled,
    locked: false,
    lockReason: null,
    /** No revert affordance — its "original" is the shipped default, and the row is backed
     *  by `debrief_prompt` rather than by an override entry. */
    overridden: false,
    order: config.kcOrder[DEBRIEF_ROW_ID] ?? null,
  }

  const pool = [...builtIn, ...added, debriefRow]
  return {
    stages: PD_KC_STAGES,
    builtIn,
    added,
    debrief: debriefRow,
    /** ⚠ THE COUNT LINE'S THREE NUMBERS, derived exactly as the grader's denominator is —
     *  visible AND graded. Never stored (D5). */
    poolTotal: pool.length,
    visibleCount: pool.filter(q => q.visible).length,
    gradedCount: pool.filter(q => q.visible && q.graded).length,
  }
}

/**
 * The id the debrief row uses in the settings block.
 *
 * ⚠ It is the question's real `field` (`debrief_reflection`), so the row's id matches the
 * key its answers are already stored under and the reports already read. Nothing moves.
 */
export const DEBRIEF_ROW_ID = 'debrief_reflection'
