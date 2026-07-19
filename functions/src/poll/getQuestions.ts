import { onCall } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import { extractStudentOnCallIds } from '@mygames/game-server'
import {
  POLL_CORS_ORIGINS, INSTANCES_COLLECTION, PARTICIPANTS_COLLECTION, CONFIG_DOC,
  loadQuestions,
} from './config'

// ═══════════════════════════════════════════════════════════════════════════════
// pollGetQuestions (student) — the VISIBLE questions in order, plus which the caller
// has already answered (drives resume: the client lands on the first visible question
// with no entry in its answers map — same shape as the KC static-answers pattern,
// minus correctness). There is no answer key to strip: a poll has no secret.
// ═══════════════════════════════════════════════════════════════════════════════

export const pollGetQuestions = onCall({ cors: POLL_CORS_ORIGINS }, async (request) => {
  const data = request.data as Record<string, unknown>
  const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true'
  const authHeader = request.rawRequest.headers.authorization as string | undefined

  const { participantId, gameInstanceId } = await extractStudentOnCallIds(data, isEmulator, authHeader)

  const db = admin.firestore()
  const [configSnap, participantSnap] = await Promise.all([
    db.collection(INSTANCES_COLLECTION).doc(gameInstanceId).collection('config').doc(CONFIG_DOC).get(),
    db.collection(PARTICIPANTS_COLLECTION).doc(participantId).get(),
  ])

  const visible = loadQuestions(configSnap.data()).filter(q => q.visible)

  const answers = (participantSnap.data()?.answers ?? {}) as Record<string, unknown>
  const answered = visible.filter(q => answers[q.id] != null).map(q => q.id)

  return {
    ok: true as const,
    questions: visible.map(q => ({ id: q.id, type: q.type, prompt: q.prompt, options: q.options ?? null })),
    answered,
  }
})
