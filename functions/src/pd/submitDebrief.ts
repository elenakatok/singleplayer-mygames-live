import { onCall, HttpsError } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import { FieldValue } from 'firebase-admin/firestore'
import { extractStudentOnCallIds } from '@mygames/game-server'
import { PD_CORS_ORIGINS, INSTANCES_COLLECTION, PARTICIPANTS_SUBCOLLECTION } from './config'
import { debriefQuestion } from './questions'

// ═══════════════════════════════════════════════════════════════════════════════
// pdSubmitDebrief (student) — the one open-ended paragraph (spec §8). UNGRADED:
// no correctness, no score, no feedback. Stored under `debrief_answers` keyed by
// field, the family's shape, which is what the Tier-2 report will export (Slice 4).
//
// Ungraded BY CONSTRUCTION, not by convention: the debrief question carries no
// `grading` and no `correct_value`, so it can never enter calcKCScore's denominator,
// and this callable never touches knowledge_check_score.
//
// One-shot, like every other submit in the family: an existing answer is returned
// rather than overwritten, inside a transaction.
// ═══════════════════════════════════════════════════════════════════════════════

/** Bound so a runaway paste cannot push the participant doc toward the 1 MiB limit. */
const MAX_LENGTH = 5000

export const pdSubmitDebrief = onCall({ cors: PD_CORS_ORIGINS }, async (request) => {
  const data = request.data as Record<string, unknown>
  const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true'
  const authHeader = request.rawRequest.headers.authorization as string | undefined

  const { participantId, gameInstanceId } = await extractStudentOnCallIds(data, isEmulator, authHeader)

  const raw = data.answer
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new HttpsError('invalid-argument', 'Please write a short paragraph before submitting.')
  }
  const answer = raw.trim().slice(0, MAX_LENGTH)

  const db = admin.firestore()
  const participantRef = db
    .collection(INSTANCES_COLLECTION).doc(gameInstanceId)
    .collection(PARTICIPANTS_SUBCOLLECTION).doc(participantId)

  const field = debriefQuestion.field

  const result = await db.runTransaction(async (tx) => {
    const snap = await tx.get(participantRef)
    const pData = snap.data() ?? {}
    const existing = (pData.debrief_answers ?? {}) as Record<string, { answer: string }>

    if (existing[field] != null) {
      return { stored: true as const, answer: existing[field].answer }
    }

    tx.set(participantRef, {
      participant_id: participantId,
      game_instance_id: gameInstanceId,
      debrief_answers: { [field]: { answer, submitted_at: FieldValue.serverTimestamp() } },
      debrief_completed_at: FieldValue.serverTimestamp(),
    }, { merge: true })

    return { stored: false as const, answer }
  })

  return { ok: true as const, ...result }
})
