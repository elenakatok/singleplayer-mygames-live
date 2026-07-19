import { onCall, HttpsError } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import { extractInstructorGameId } from '@mygames/game-server'
import {
  PENNIES_CORS_ORIGINS, INSTANCES_COLLECTION, CONFIG_DOC, TRUTH_DOC,
  DEFAULT_TRUE_VALUE, DEFAULT_JAR_IMAGE,
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

  const trueValue = (truthSnap.data()?.true_value as number | undefined) ?? DEFAULT_TRUE_VALUE
  const jarImage = (configSnap.data()?.jar_image as string | undefined) ?? DEFAULT_JAR_IMAGE

  return { ok: true as const, true_value: trueValue, jar_image: jarImage }
})

/** penniesUpdateConfig — merge-writes true_value → truth/main and jar_image → config/main. */
export const penniesUpdateConfig = onCall({ cors: PENNIES_CORS_ORIGINS }, async (request) => {
  const data = request.data as Record<string, unknown>
  const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true'
  const authHeader = request.rawRequest.headers.authorization as string | undefined

  const gameInstanceId = await extractInstructorGameId(data, isEmulator, authHeader)

  const db = admin.firestore()
  const instanceRef = db.collection(INSTANCES_COLLECTION).doc(gameInstanceId)

  // true_value (optional in the payload; only written when present + valid).
  if (data.true_value !== undefined) {
    const tv = typeof data.true_value === 'number' ? data.true_value : Number(data.true_value)
    if (!Number.isFinite(tv) || tv < 0) {
      throw new HttpsError('invalid-argument', 'True value must be a number of $0 or more.')
    }
    await instanceRef.collection('truth').doc(TRUTH_DOC).set(
      { true_value: Math.round(tv * 100) / 100 }, { merge: true },
    )
  }

  // jar_image (optional; client-safe, stored in config/main).
  if (data.jar_image !== undefined) {
    if (typeof data.jar_image !== 'string' || !data.jar_image.trim()) {
      throw new HttpsError('invalid-argument', 'Jar image path must be a non-empty string.')
    }
    await instanceRef.collection('config').doc(CONFIG_DOC).set(
      { jar_image: data.jar_image.trim() }, { merge: true },
    )
  }

  return { ok: true as const }
})
