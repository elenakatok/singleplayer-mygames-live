import { onCall, HttpsError } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import { FieldValue } from 'firebase-admin/firestore'
import { extractStudentOnCallIds } from '@mygames/game-server'
import {
  POLL_CORS_ORIGINS, INSTANCES_COLLECTION, PARTICIPANTS_COLLECTION, CONFIG_DOC,
  loadQuestions,
} from './config'

// ═══════════════════════════════════════════════════════════════════════════════
// pollSubmitAnswer (student) — writes ONE answer, incrementally, into the participant
// doc's `answers` map keyed by question id (spec §8.2). Ungraded: no correctness, no
// score, no feedback.
//
// PER-QUESTION ONE-SHOT LOCK, server-enforced (spec §5.2): if the question already has
// an entry, the incoming answer is DISCARDED and the stored one returned — inside a
// transaction so racing submits can't both win. Client-side disabling is a convenience;
// this is what makes one-shot real. `completed_at` is stamped when every VISIBLE
// question has an entry.
// ═══════════════════════════════════════════════════════════════════════════════

export const pollSubmitAnswer = onCall({ cors: POLL_CORS_ORIGINS }, async (request) => {
  const data = request.data as Record<string, unknown>
  const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true'
  const authHeader = request.rawRequest.headers.authorization as string | undefined

  const { participantId, gameInstanceId } = await extractStudentOnCallIds(data, isEmulator, authHeader)

  const questionId = data.question_id
  if (typeof questionId !== 'string' || !questionId) {
    throw new HttpsError('invalid-argument', 'question_id is required.')
  }

  const db = admin.firestore()
  const instanceRef = db.collection(INSTANCES_COLLECTION).doc(gameInstanceId)
  const configSnap = await instanceRef.collection('config').doc(CONFIG_DOC).get()
  const visible = loadQuestions(configSnap.data()).filter(q => q.visible)

  const question = visible.find(q => q.id === questionId)
  if (!question) {
    throw new HttpsError('invalid-argument', 'That question is not part of this poll.')
  }

  // Validate the value by type. mc → a defined option value; text → a non-empty string.
  let value: string
  if (question.type === 'mc') {
    const v = data.value
    if (typeof v !== 'string' || !(question.options ?? []).some(o => o.value === v)) {
      throw new HttpsError('invalid-argument', 'Please choose one of the options.')
    }
    value = v
  } else {
    const v = data.value
    if (typeof v !== 'string' || v.trim() === '') {
      throw new HttpsError('invalid-argument', 'Please enter an answer.')
    }
    value = v.trim()
  }

  const visibleIds = visible.map(q => q.id)
  const participantRef = db.collection(PARTICIPANTS_COLLECTION).doc(participantId)

  const result = await db.runTransaction(async (tx) => {
    const snap = await tx.get(participantRef)
    const pData = snap.data() ?? {}
    if (snap.exists && pData.game_instance_id !== gameInstanceId) {
      throw new HttpsError('permission-denied', 'Your session does not match this poll.')
    }
    const answers = (pData.answers ?? {}) as Record<string, { value: string }>

    // Idempotent: already answered — discard the incoming value, return the stored one.
    if (answers[questionId] != null) {
      return { stored: true as const, value: answers[questionId].value }
    }

    // Will every visible question be answered after this write?
    const answeredAfter = new Set([...Object.keys(answers), questionId])
    const allAnswered = visibleIds.every(id => answeredAfter.has(id))

    // NOTE: a dotted key ('answers.<id>') is a nested-path ONLY for update(); in
    // set({merge:true}) it would be a literal field name. Use a nested object — merge
    // deep-merges the answers map, preserving the other questions' entries.
    const patch: Record<string, unknown> = {
      participant_id: participantId,
      game_instance_id: gameInstanceId,
      answers: { [questionId]: { value, submitted_at: FieldValue.serverTimestamp() } },
    }
    if (allAnswered) patch.completed_at = FieldValue.serverTimestamp()

    tx.set(participantRef, patch, { merge: true })
    return { stored: false as const, value }
  })

  return { ok: true as const, ...result }
})
