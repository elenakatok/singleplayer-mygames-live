import { onCall, HttpsError } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import { FieldValue } from 'firebase-admin/firestore'
import { extractStudentOnCallIds } from '@mygames/game-server'
import { PENNIES_CORS_ORIGINS, INSTANCES_COLLECTION, PARTICIPANTS_SUBCOLLECTION } from './config'

// ═══════════════════════════════════════════════════════════════════════════════
// penniesSubmit (student) — validates and writes { estimate, bid, submitted_at }.
// AUTHORITATIVE server-side validation (spec §5.1); the client form is a convenience.
//
// ONE-SHOT LOCK (spec §3.3): submitted_at is the lock. If it is already set, the
// submission is rejected with failed-precondition and a student-facing message —
// enforced inside a transaction so two racing submits cannot both win. Mirrors the
// KC per-question idempotency shape, for a single-screen game.
// ═══════════════════════════════════════════════════════════════════════════════

/** Parses a required money value: finite number ≥ 0. Returns null if invalid. */
function parseMoney(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN
  if (!Number.isFinite(n) || n < 0) return null
  // Round to cents — the fields accept two decimal places (spec §3.1).
  return Math.round(n * 100) / 100
}

export const penniesSubmit = onCall({ cors: PENNIES_CORS_ORIGINS }, async (request) => {
  const data = request.data as Record<string, unknown>
  const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true'
  const authHeader = request.rawRequest.headers.authorization as string | undefined

  const { participantId, gameInstanceId } = await extractStudentOnCallIds(data, isEmulator, authHeader)

  const estimate = parseMoney(data.estimate)
  const bid = parseMoney(data.bid)
  if (estimate === null) {
    throw new HttpsError('invalid-argument', 'Please enter a valid estimate of $0 or more.')
  }
  if (bid === null) {
    throw new HttpsError('invalid-argument', 'Please enter a valid bid of $0 or more.')
  }

  const db = admin.firestore()
  const participantRef = db
    .collection(INSTANCES_COLLECTION).doc(gameInstanceId)
    .collection(PARTICIPANTS_SUBCOLLECTION).doc(participantId)

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(participantRef)
    if (!snap.exists) {
      throw new HttpsError('not-found', 'We could not find your session. Please relaunch from the classroom.')
    }
    const pData = snap.data()!
    // No belongs check needed — the doc IS under this instance (structural isolation).
    // One-shot lock.
    if (pData.submitted_at != null) {
      throw new HttpsError('failed-precondition', 'You have already submitted. Your estimate and bid are final.')
    }
    tx.update(participantRef, {
      estimate,
      bid,
      submitted_at: FieldValue.serverTimestamp(),
    })
  })

  return { ok: true as const }
})
