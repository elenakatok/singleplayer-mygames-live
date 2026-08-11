import { onCall, HttpsError } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import { FieldValue } from 'firebase-admin/firestore'
import { extractInstructorGameId } from '@mygames/game-server'
import {
  PROCUREMENT_CORS_ORIGINS, INSTANCES_COLLECTION, CONFIG_DOC, TRUTH_DOC,
  loadProcurementConfig, loadProcurementSeed, parseDecrementSchedule, parseDelaySchedule,
  type CostDist,
  isFormat, defaultReserve,
  HARD_MIN_ROUNDS, HARD_MAX_ROUNDS, HARD_MIN_RIVALS, HARD_MAX_RIVALS,
  HARD_MAX_DELAY_JITTER_MS,
  addedKcStage, parseAddedKcQuestion, parseKcHidden, parseKcOrder, parseKcOverrides,
  procurementBuiltInIds, PROCUREMENT_KC_STAGES,
  type ProcurementConfig, type ProcurementKcStage, type ProcurementAddedKcQuestion,
} from './config'
import {
  KC_POOL_IDS, defaultVisibleFor, poolForFormat, procurementScoringSet,
  applyKcOverride, isKcOverridden, isGradedAdded,
} from './questions'
import {
  lockedKcQuestionIds, validateKcOverrides, procurementOverrideContext, KC_LOCK_REASON,
} from './kcLock'
import { hasAnySubmission } from './instance'

// ═══════════════════════════════════════════════════════════════════════════════
// procurementGetConfig / procurementUpdateConfig (instructor) — the Settings surface.
//
// ⚠⚠ TWO DOCS, TWO AUDIENCES, ONE CALLABLE PAIR. `config/main` is student-readable by
// Firestore rules; `truth/main` is denied to every client. The SEED is the only field
// that lives in truth, and it is written from here and read back MASKED — the instructor
// is told whether a seed is set, never what it is, because the Settings page is a normal
// web page and a value on screen is a value in a screenshot.
//
// ⚠⚠ `format` LOCKS ONCE THE INSTANCE HAS ITS FIRST SUBMISSION (Part 1 §3, §14.1).
// Rounds resolved under two different mechanisms in one result set would be incoherent —
// the reports could not say what the numbers mean. The check is `hasAnySubmission`
// (instance.ts), a live query rather than a stored flag, and it runs INSIDE the update
// so a stale Settings page cannot flip a format that has already been played.
//
// ⚠ ADDING A CONFIG FIELD REQUIRES REDEPLOYING **BOTH** OF THESE FUNCTIONS. The
// recognized-field list below lives in the deployed bundle, so a new key added to the
// source and deployed to only one of them produces "No recognised fields to update"
// against code that is visibly correct. (Playbook §2 — the stale-artifact class.)
// ═══════════════════════════════════════════════════════════════════════════════

export const procurementGetConfig = onCall({ cors: PROCUREMENT_CORS_ORIGINS }, async (request) => {
  const data = request.data as Record<string, unknown>
  const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true'
  const authHeader = request.rawRequest.headers.authorization as string | undefined

  const gameInstanceId = await extractInstructorGameId(data, isEmulator, authHeader)

  const db = admin.firestore()
  const instanceRef = db.collection(INSTANCES_COLLECTION).doc(gameInstanceId)
  const [configSnap, truthSnap] = await Promise.all([
    instanceRef.collection('config').doc(CONFIG_DOC).get(),
    instanceRef.collection('truth').doc(TRUTH_DOC).get(),
  ])

  const config = loadProcurementConfig(configSnap.data(), KC_POOL_IDS, defaultVisibleFor)
  const locked = await hasAnySubmission(db, gameInstanceId)

  const pool = poolForFormat(config.format)

  return {
    ok: true as const,
    config,
    /**
     * ⚠ MASKED, NEVER RETURNED. The instructor needs to know a seed is in force (so a
     * "why is everyone getting the same rivals?" question has an answer); they do not
     * need the string, and the string on screen is the string in a screenshot.
     */
    seedSet: loadProcurementSeed(truthSnap.data()) !== null,
    /** True once anyone has played a round — Settings disables the `format` control. */
    formatLocked: locked,
    /**
     * The KC pool for THIS format, with each question's visibility and whether it is
     * graded. Settings renders the live count from this — "8 of 17 questions visible, 8
     * graded" — and that count is the SAME derivation the grader uses (`gradedFor`), so
     * the number on the instructor's screen is by construction the number the student's
     * score is out of.
     */
    kcPool: pool.map(q => ({
      id: q.id,
      // ⚠ THE STAGE TRAVELS WITH THE ROW. Settings groups by it, because "hide the
      // debrief" and "hide question 4" are the same control here and an ungrouped list
      // of seventeen would not make that obvious.
      stage: q.stage,
      prompt: q.prompt,
      graded: q.correct_value !== null,
      // ⚠ D18 — READ FROM `kcHidden`, THE MIGRATED FIELD. `kcVisible` is no longer consulted
      // anywhere outside `migrateKcHidden`.
      visible: config.kcHidden[q.id] !== true,
    })),
    kcPoolTotal: pool.length,
    kcVisibleCount: pool.filter(q => config.kcHidden[q.id] !== true).length,
    kcGradedCount: procurementScoringSet(config).length,
    /** ⚠ The three convergence fields as STORED — what the page seeds its draft from. */
    kcHidden: config.kcHidden,
    kcOrder: config.kcOrder,
    kcOverrides: config.kcOverrides,
    addedKcQuestions: config.addedKcQuestions,
    /** Everything the shared knowledge-check block renders. */
    kc: kcInventory(config),
  }
})

/**
 * The instructor-facing inventory of every question this instance could ask — the payload
 * the shared settings block renders.
 *
 * ⚠ THIS IS THE INSTRUCTOR CALLABLE, so `correctValue` belongs here. `procurementGetQuestions`
 * (the STUDENT path) still strips every key.
 *
 * ⚠⚠ THIS FORMAT'S POOL ONLY. procurement serves two mutually exclusive sets on `format`, so
 * the page shows the questions THIS instance can ask. The other format's stored hides, order
 * and overrides are untouched and reappear when the instructor flips back.
 *
 * ⚠⚠ THE TWO FREE-TEXT QUESTIONS ARE ORDINARY ROWS AND ALWAYS WERE. Unlike the other five
 * games there is nothing to fold in and no boundary translation: their prompts live in the
 * pool, not in a config key, so they are edited through `kc_overrides` like any built-in.
 *
 * ⚠ `prep` IS REPORTED AS STAGE `kc` FOR DISPLAY, because both are asked before the first
 * round and the picker offers two stages, not three. The built-in's own pool tag is
 * untouched — this is grouping, not a rewrite.
 */
function kcInventory(config: ProcurementConfig) {
  // ⚠ `lockedKcQuestionIds` does its OWN normalisation (kcLock.ts's `bare`) — do not
  // pre-clear the maps here as well, or the page and the callable would classify differently.
  const locked = lockedKcQuestionIds(config)

  const builtIn = poolForFormat(config.format).map((raw) => {
    const q = applyKcOverride(raw, config.kcOverrides)
    return {
      id: q.id,
      kind: 'builtin' as const,
      stage: (q.stage === 'debrief' ? 'debrief' : 'kc') as ProcurementKcStage,
      type: (q.kind === 'mc' ? 'mc' : 'text') as 'mc' | 'text',
      prompt: q.prompt,
      placeholder: q.placeholder ?? undefined,
      options: q.options.map(o => ({ value: o.value, label: o.label })),
      correctValue: q.correct_value,
      /** ⚠ BY THE PRESENCE OF A KEY (D3), never by stage or type. */
      graded: q.correct_value !== null,
      visible: config.kcHidden[q.id] !== true,
      locked: locked.has(q.id),
      lockReason: locked.has(q.id) ? KC_LOCK_REASON : null,
      overridden: isKcOverridden(q.id, config.kcOverrides),
      /** The AUTHORED text, so the page can offer "revert to the original". */
      originalPrompt: raw.prompt,
      originalOptions: raw.options.map(o => ({ value: o.value, label: o.label })),
      order: config.kcOrder[q.id] ?? null,
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

  const pool = [...builtIn, ...added]
  return {
    stages: PROCUREMENT_KC_STAGES,
    builtIn,
    added,
    /** ⚠ THE COUNT LINE'S THREE NUMBERS — visible AND graded. Never stored (D5). This is
     *  procurement's own count, returning to procurement: it donated the wording to the
     *  shared block five passes ago. */
    poolTotal: pool.length,
    visibleCount: pool.filter(q => q.visible).length,
    gradedCount: pool.filter(q => q.visible && q.graded).length,
  }
}

// ── Update ─────────────────────────────────────────────────────────────────────

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const intIn = (v: unknown, min: number, max: number): number | null =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : null

export const procurementUpdateConfig = onCall({ cors: PROCUREMENT_CORS_ORIGINS }, async (request) => {
  const data = request.data as Record<string, unknown>
  const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true'
  const authHeader = request.rawRequest.headers.authorization as string | undefined

  const gameInstanceId = await extractInstructorGameId(data, isEmulator, authHeader)

  const patch = (data.config ?? {}) as Record<string, unknown>
  const db = admin.firestore()
  const instanceRef = db.collection(INSTANCES_COLLECTION).doc(gameInstanceId)

  const configPatch: Record<string, unknown> = {}
  const rejected: string[] = []

  // ⚠ ONE READ of the config as it stands, used by the format lock AND the reserve's
  // follow rule. Both need to know what was there before the patch; loading it twice
  // would let the two see different states inside one save.
  const existing = loadProcurementConfig(
    (await instanceRef.collection('config').doc(CONFIG_DOC).get()).data(),
    KC_POOL_IDS, defaultVisibleFor,
  )

  // ── format — the locked one ─────────────────────────────────────────────────
  if ('format' in patch) {
    if (!isFormat(patch.format)) {
      throw new HttpsError('invalid-argument',
        'format must be sealed_first_price or open_descending.')
    }
    if (patch.format !== existing.format) {
      if (await hasAnySubmission(db, gameInstanceId)) {
        throw new HttpsError('failed-precondition',
          'The bidding format cannot be changed once a student has played a round — ' +
          'the results would mix two different mechanisms. Create a second instance instead.')
      }
      configPatch.format = patch.format
    }
  }

  // ── plain numeric settings ──────────────────────────────────────────────────
  if ('rounds' in patch) {
    const v = intIn(patch.rounds, HARD_MIN_ROUNDS, HARD_MAX_ROUNDS)
    if (v === null) rejected.push('rounds'); else configPatch.rounds = v
  }
  if ('rivalCount' in patch) {
    const v = intIn(patch.rivalCount, HARD_MIN_RIVALS, HARD_MAX_RIVALS)
    if (v === null) rejected.push('rivalCount'); else configPatch.rivalCount = v
  }
  if ('bidIncrementUnit' in patch) {
    const v = intIn(patch.bidIncrementUnit, 1, 1000)
    if (v === null) rejected.push('bidIncrementUnit'); else configPatch.bidIncrementUnit = v
  }

  // ── the cost distributions (§3) ─────────────────────────────────────────────
  //
  // ⚠ VALIDATED HERE, NOT LEFT TO parseCostDist. That parser is a DEFENSIVE READER for
  // half-written docs: it silently substitutes the default when it dislikes the input,
  // which is right on the read path and wrong on a save — an instructor who typed
  // min 60 / max 20 would be told "saved" and get 10/110 back. On this path a bad range
  // is REJECTED BY NAME so the Settings page can say which field it refused.
  //
  // ⚠ INTEGERS ONLY. Costs are whole ECU by construction (§3.1) and every bid is an
  // integer; a fractional bound would make `randomInt` draw outside the stated range.
  const costDist = (raw: unknown, key: string) => {
    if (typeof raw !== 'object' || raw === null) { rejected.push(key); return null }
    const d = raw as Record<string, unknown>
    const min = d.min, max = d.max
    if (!num(min) || !num(max) || !Number.isInteger(min) || !Number.isInteger(max)) {
      rejected.push(key); return null
    }
    if (min < 0 || min >= max) { rejected.push(key); return null }
    return { distribution: 'uniform' as const, min, max, integer: true }
  }
  if ('rivalCostDist' in patch) {
    const d = costDist(patch.rivalCostDist, 'rivalCostDist')
    if (d) configPatch.rivalCostDist = d
  }
  if ('playerCostDist' in patch) {
    const d = costDist(patch.playerCostDist, 'playerCostDist')
    if (d) configPatch.playerCostDist = d
  }

  // ── the reserve, and whether it still FOLLOWS the rival max ─────────────────
  //
  // ⚠ DELIBERATELY NOT CLAMPED to the rival cost range. Lowering it below the cost max is
  // the setting slide 10 teaches — it makes the entry decision live (Part 1 §3.1) — and
  // clamping would silently undo the instructor's choice.
  //
  // ⚠⚠ THE FOLLOW RULE. `reserve` defaults to the top of the rival range, and a rival
  // whose cost exceeds the reserve makes NO BID (§3.1). So if the reserve did not follow,
  // raising the rival max to 130 would quietly convert the instance into a lowered-reserve
  // game with bots missing from the auction. It therefore FOLLOWS until the instructor
  // edits it, and STOPS the moment they do — recorded in `reserveAuto`, never inferred
  // from whether the two numbers happen to match (config.ts).
  const explicitReserve = 'reserve' in patch
  if (explicitReserve) {
    if (patch.reserve === null) {
      // Reset: back to the top of the rival range, and following again.
      const dist = (configPatch.rivalCostDist ?? existing.rivalCostDist) as CostDist
      configPatch.reserve = defaultReserve(dist)
      configPatch.reserveAuto = true
    } else if (num(patch.reserve) && patch.reserve >= 0) {
      configPatch.reserve = patch.reserve
      // ⚠ Set even when the value is unchanged. An instructor who types the number that
      // was already there has still CHOSEN it, and a reserve that resumed following after
      // a no-op save would be the surprise this whole rule exists to prevent.
      configPatch.reserveAuto = false
    } else {
      rejected.push('reserve')
    }
  } else if (configPatch.rivalCostDist !== undefined && existing.reserveAuto) {
    // The rival range moved and nobody has pinned the reserve — carry it along.
    configPatch.reserve = defaultReserve(configPatch.rivalCostDist as CostDist)
  }

  // ── open-format pacing ──────────────────────────────────────────────────────
  //
  // ⚠⚠ BOTH SCHEDULES ARE EDITABLE HERE BECAUSE TUNING THEM MUST NOT COST A DEPLOY. Open
  // §2 and §10 name exactly three levers for the pacing of the first live run — shorter
  // delays in the coarse bands, a coarser TOP BAND (20 above 80, cutting Phase 1 from ten
  // steps to seven), or a lower reserve — and say all three must be reachable "between
  // rounds, while the feel is fresh". The reserve is already above; these are the other two.
  //
  // ⚠ A REJECTED SCHEDULE IS NOT SILENTLY DEFAULTED HERE. `parseDecrementSchedule` is a
  // DEFENSIVE READER for half-written docs — it substitutes the shipped default when it
  // dislikes the input, which is right on the read path and wrong on a save, where an
  // instructor who mistyped one band would be told "saved" and get the shipped schedule
  // back. Same distinction the cost ranges make above.
  const bandsIn = (raw: unknown, key: string, parse: (r: unknown) => unknown[]): unknown[] | null => {
    if (!Array.isArray(raw) || raw.length === 0) { rejected.push(key); return null }
    const parsed = parse(raw)
    // The parser drops bands it cannot read; if any went missing, the instructor's input
    // was not what would be stored, so refuse the whole save rather than half of it.
    if (parsed.length !== raw.length) { rejected.push(key); return null }
    return parsed
  }
  if ('decrementSchedule' in patch) {
    const v = bandsIn(patch.decrementSchedule, 'decrementSchedule', parseDecrementSchedule)
    if (v) configPatch.decrementSchedule = v
  }
  if ('delaySchedule' in patch) {
    const v = bandsIn(patch.delaySchedule, 'delaySchedule', parseDelaySchedule)
    if (v) configPatch.delaySchedule = v
  }
  if ('delayJitterMs' in patch) {
    const v = intIn(patch.delayJitterMs, 0, HARD_MAX_DELAY_JITTER_MS)
    if (v === null) rejected.push('delayJitterMs'); else configPatch.delayJitterMs = v
  }

  // ── labels + question switches ──────────────────────────────────────────────
  if ('currencyLabel' in patch && typeof patch.currencyLabel === 'string') {
    configPatch.currencyLabel = patch.currencyLabel.trim().slice(0, 16)
  }
  if ('kcEnabled' in patch && typeof patch.kcEnabled === 'boolean') {
    configPatch.kcEnabled = patch.kcEnabled
  }
  // ══════════════════════════════════════════════════════════════════════════
  // ⚠⚠ D18 — THE THREE CONVERGENCE FIELDS, AND THE END OF `kcVisible`.
  //
  // `kcVisible` IS NO LONGER ACCEPTED FROM THE CLIENT and is no longer written. Every save
  // writes `kc_hidden` and DELETES `kcVisible` from the document, so an instance heals itself
  // the first time an instructor saves anything. Until then `migrateKcHidden` converts on
  // read (config.ts).
  //
  // ⚠ THE DELETE IS UNCONDITIONAL ON ANY SAVE THAT TOUCHES THE QUESTION LIST, not only on a
  // visibility change. A save that reordered a question while leaving `kcVisible` in place
  // would leave the document holding both fields — legal (the reader prefers `kc_hidden`) but
  // exactly the ambiguity this migration exists to remove.
  // ══════════════════════════════════════════════════════════════════════════
  {
    const stored = loadProcurementConfig(
      (await instanceRef.collection('config').doc(CONFIG_DOC).get()).data(),
      KC_POOL_IDS, defaultVisibleFor,
    )

    if ('addedKcQuestions' in patch) {
      if (!Array.isArray(patch.addedKcQuestions)) {
        throw new HttpsError('invalid-argument', 'addedKcQuestions must be an array.')
      }
      const parsed: ProcurementAddedKcQuestion[] = []
      const seen = new Set<string>()
      for (const raw of patch.addedKcQuestions) {
        const q = parseAddedKcQuestion(raw)
        if (!q) {
          throw new HttpsError('invalid-argument',
            'An added question is incomplete — every question needs a prompt, and a multiple-choice '
            + 'question needs at least two options and a correct answer among them.')
        }
        // ⚠⚠ THE COLLISION GUARD IS THE EXPLICIT ID SET, NOT THE `kc_` PREFIX RULE. These ids
        // are `S1`…`S9` / `O1`…`O10` — unprefixed — so a prefix rule would protect nothing and
        // an added `S3` would shadow a built-in in the grader's lookup. The shared parser has
        // already refused it; this second check exists to produce the instructor-facing
        // sentence rather than the generic "incomplete question" message.
        if (procurementBuiltInIds().has(q.id)) {
          throw new HttpsError('invalid-argument',
            `'${q.id}' is the id of a built-in question. Please choose a different one.`)
        }
        if (seen.has(q.id)) throw new HttpsError('invalid-argument', `Duplicate question id: ${q.id}`)
        seen.add(q.id)
        parsed.push(q)
      }
      configPatch.added_kc_questions = parsed
    }

    const knownAdded = new Set(
      (configPatch.added_kc_questions as ProcurementAddedKcQuestion[] | undefined)?.map(q => q.id)
      ?? stored.addedKcQuestions.map(q => q.id),
    )
    // ⚠ THE WHOLE POOL, not this format's slice: a hide or an order set in the other format
    // must round-trip rather than be refused the moment the instructor flips.
    const knownId = (id: string) => procurementBuiltInIds().has(id) || knownAdded.has(id)

    if ('kcHidden' in patch) {
      const p = parseKcHidden(patch.kcHidden)
      for (const id of Object.keys(p)) {
        if (!knownId(id)) throw new HttpsError('invalid-argument', `'${id}' is not a question in this game.`)
      }
      configPatch.kc_hidden = p
      // ⚠⚠ THE LEGACY FIELD IS REMOVED FROM THE DOCUMENT. This is the "write-new" half of
      // read-both/write-new, and it is what lets the legacy read branch eventually be deleted.
      configPatch.kcVisible = FieldValue.delete()
    }

    if ('kcOrder' in patch) {
      const p = parseKcOrder(patch.kcOrder)
      for (const id of Object.keys(p)) {
        if (!knownId(id)) throw new HttpsError('invalid-argument', `'${id}' is not a question in this game.`)
      }
      configPatch.kc_order = p
    }

    if ('kcOverrides' in patch) {
      // ⚠⚠ THE LOCK IS ENFORCED HERE, NOT ONLY IN THE UI (spec §5) — even though procurement
      // locks nothing today. The detector is live; the day a stem gains a config value this
      // starts refusing without another line of code.
      //
      // ⚠ Classified against the PROSPECTIVE format, so flipping `format` in the same save is
      // judged against the format being saved rather than the one being left.
      const next: ProcurementConfig = {
        ...stored,
        format: isFormat(configPatch.format) ? configPatch.format : stored.format,
      }
      const rejections = validateKcOverrides(
        parseKcOverrides(patch.kcOverrides),
        procurementOverrideContext(next),
      )
      if (rejections.length > 0) throw new HttpsError('invalid-argument', rejections[0].message)
      configPatch.kc_overrides = parseKcOverrides(patch.kcOverrides)
    }
  }

  // ── the seed — TRUTH DOC, never config ──────────────────────────────────────
  // ⚠ It derives every rival cost draw. config/main is student-readable by rules, so a
  // seed stored there could be read with the plain SDK and used to compute round 5's
  // rivals before bidding in round 4. Do not move it.
  let seedWritten = false
  if ('seed' in patch) {
    const s = patch.seed
    if (s === null || (typeof s === 'string' && s.trim() === '')) {
      await instanceRef.collection('truth').doc(TRUTH_DOC)
        .set({ seed: FieldValue.delete() }, { merge: true })
      seedWritten = true
    } else if (typeof s === 'string') {
      await instanceRef.collection('truth').doc(TRUTH_DOC)
        .set({ seed: s.trim().slice(0, 200) }, { merge: true })
      seedWritten = true
    } else {
      rejected.push('seed')
    }
  }

  if (Object.keys(configPatch).length === 0 && !seedWritten) {
    throw new HttpsError('invalid-argument',
      rejected.length > 0
        ? `No recognised fields to update. Rejected: ${rejected.join(', ')}.`
        : 'No recognised fields to update.')
  }

  if (Object.keys(configPatch).length > 0) {
    await instanceRef.collection('config').doc(CONFIG_DOC).set(configPatch, { merge: true })
  }

  const after = loadProcurementConfig(
    (await instanceRef.collection('config').doc(CONFIG_DOC).get()).data(), KC_POOL_IDS, defaultVisibleFor,
  )

  return {
    ok: true as const,
    config: after,
    updated: Object.keys(configPatch),
    seedWritten,
    rejected,
  }
})
