import { onCall, HttpsError } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import { FieldValue } from 'firebase-admin/firestore'
import { extractInstructorGameId } from '@mygames/game-server'
import {
  PROCUREMENT_CORS_ORIGINS, INSTANCES_COLLECTION, CONFIG_DOC, TRUTH_DOC,
  loadProcurementConfig, loadProcurementSeed, parseDecrementSchedule,
  type CostDist,
  isFormat, defaultReserve,
  HARD_MIN_ROUNDS, HARD_MAX_ROUNDS, HARD_MIN_RIVALS, HARD_MAX_RIVALS,
} from './config'
import { KC_POOL_IDS, defaultVisibleFor, poolForFormat, gradedFor } from './questions'
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
      visible: config.kcVisible.includes(q.id),
    })),
    kcPoolTotal: pool.length,
    kcVisibleCount: pool.filter(q => config.kcVisible.includes(q.id)).length,
    kcGradedCount: gradedFor(config.format, config.kcVisible).length,
  }
})

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
  if ('decrementSchedule' in patch) {
    configPatch.decrementSchedule = parseDecrementSchedule(patch.decrementSchedule)
  }
  if ('botDelayMs' in patch) {
    const v = patch.botDelayMs
    if (Array.isArray(v) && v.length === 2 && num(v[0]) && num(v[1]) && v[0] >= 0 && v[1] >= v[0]) {
      configPatch.botDelayMs = [v[0], v[1]]
    } else {
      rejected.push('botDelayMs')
    }
  }

  // ── labels + question switches ──────────────────────────────────────────────
  if ('currencyLabel' in patch && typeof patch.currencyLabel === 'string') {
    configPatch.currencyLabel = patch.currencyLabel.trim().slice(0, 16)
  }
  if ('kcEnabled' in patch && typeof patch.kcEnabled === 'boolean') {
    configPatch.kcEnabled = patch.kcEnabled
  }
  if ('kcVisible' in patch) {
    // Unknown ids are DROPPED rather than rejected: a Settings page held open across a
    // release that removed a question would otherwise fail the whole save.
    const known = new Set(KC_POOL_IDS)
    configPatch.kcVisible = Array.isArray(patch.kcVisible)
      ? patch.kcVisible.filter((v): v is string => typeof v === 'string' && known.has(v))
      : []
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
