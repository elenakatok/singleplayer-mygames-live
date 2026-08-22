import { onCall, HttpsError } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import { extractInstructorGameId } from '@mygames/game-server'
import {
  PENNIES_CORS_ORIGINS, INSTANCES_COLLECTION, CONFIG_DOC, TRUTH_DOC,
  DEFAULT_TRUE_VALUE, DEFAULT_JAR_IMAGE, DEFAULT_REVERSE, DEFAULT_PENNY_VALUE,
  DEFAULT_PENNY_COUNT,
} from './config'

// ═══════════════════════════════════════════════════════════════════════════════
// Instructor settings callables (spec §9). The true value is the game's one secret:
// it lives ONLY in truth/main (rules-denied to every client, spec §4.4). The
// instructor reads/writes it exclusively through these authenticated callables,
// never directly. jar_image is non-secret and lives in config/main.
// ═══════════════════════════════════════════════════════════════════════════════

/** penniesGetConfig — returns the current true value + jar image for the settings screen. */
export const penniesGetConfig = onCall({ cors: PENNIES_CORS_ORIGINS }, async (request) => {
  const data = request.data as Record<string, unknown>
  const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true'
  const authHeader = request.rawRequest.headers.authorization as string | undefined

  const gameInstanceId = await extractInstructorGameId(data, isEmulator, authHeader)

  const db = admin.firestore()
  const instanceRef = db.collection(INSTANCES_COLLECTION).doc(gameInstanceId)
  const [truthSnap, configSnap] = await Promise.all([
    instanceRef.collection('truth').doc(TRUTH_DOC).get(),
    instanceRef.collection('config').doc(CONFIG_DOC).get(),
  ])

  const truth = truthSnap.data() ?? {}
  const cfg = configSnap.data() ?? {}
  const trueValue = (truth.true_value as number | undefined) ?? DEFAULT_TRUE_VALUE
  const jarImage = (cfg.jar_image as string | undefined) ?? DEFAULT_JAR_IMAGE
  const reverse = cfg.reverse === true ? true : DEFAULT_REVERSE
  const pennyValue = typeof cfg.penny_value === 'number' ? cfg.penny_value : DEFAULT_PENNY_VALUE
  const pennyCount = typeof truth.penny_count === 'number' ? truth.penny_count : DEFAULT_PENNY_COUNT

  return {
    ok: true as const,
    true_value: trueValue,
    jar_image: jarImage,
    reverse,
    penny_value: pennyValue,
    penny_count: pennyCount,
  }
})

/** penniesUpdateConfig — merge-writes true_value → truth/main and jar_image → config/main. */
export const penniesUpdateConfig = onCall({ cors: PENNIES_CORS_ORIGINS }, async (request) => {
  const data = request.data as Record<string, unknown>
  const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true'
  const authHeader = request.rawRequest.headers.authorization as string | undefined

  const gameInstanceId = await extractInstructorGameId(data, isEmulator, authHeader)

  const db = admin.firestore()
  const instanceRef = db.collection(INSTANCES_COLLECTION).doc(gameInstanceId)

  // ── Secret (truth/main): forward true_value + reverse penny_count ──────────────
  const truthPatch: Record<string, unknown> = {}

  // true_value (forward). Optional; only written when present + valid.
  if (data.true_value !== undefined) {
    const tv = typeof data.true_value === 'number' ? data.true_value : Number(data.true_value)
    if (!Number.isFinite(tv) || tv < 0) {
      throw new HttpsError('invalid-argument', 'True value must be a number of $0 or more.')
    }
    truthPatch.true_value = Math.round(tv * 100) / 100
  }

  // penny_count (reverse) — the jar's actual penny count, the secret suppliers estimate.
  // A whole, non-negative count.
  if (data.penny_count !== undefined) {
    const pc = typeof data.penny_count === 'number' ? data.penny_count : Number(data.penny_count)
    if (!Number.isInteger(pc) || pc < 0) {
      throw new HttpsError('invalid-argument', 'Penny count must be a whole number of 0 or more.')
    }
    truthPatch.penny_count = pc
  }

  if (Object.keys(truthPatch).length > 0) {
    await instanceRef.collection('truth').doc(TRUTH_DOC).set(truthPatch, { merge: true })
  }

  // ── Non-secret (config/main): jar_image + mode + penny_value ───────────────────
  const configPatch: Record<string, unknown> = {}

  // jar_image (client-safe, stored in config/main).
  if (data.jar_image !== undefined) {
    if (typeof data.jar_image !== 'string' || !data.jar_image.trim()) {
      throw new HttpsError('invalid-argument', 'Jar image path must be a non-empty string.')
    }
    configPatch.jar_image = data.jar_image.trim()
  }

  // reverse (mode). A plain boolean.
  if (data.reverse !== undefined) {
    if (typeof data.reverse !== 'boolean') {
      throw new HttpsError('invalid-argument', 'Reverse must be true or false.')
    }
    configPatch.reverse = data.reverse
  }

  // penny_value ($ per penny). A positive number.
  if (data.penny_value !== undefined) {
    const pv = typeof data.penny_value === 'number' ? data.penny_value : Number(data.penny_value)
    if (!Number.isFinite(pv) || pv <= 0) {
      throw new HttpsError('invalid-argument', 'Dollars per penny must be a positive number.')
    }
    configPatch.penny_value = pv
  }

  if (Object.keys(configPatch).length > 0) {
    await instanceRef.collection('config').doc(CONFIG_DOC).set(configPatch, { merge: true })
  }

  return { ok: true as const }
})
