import { onCall, HttpsError } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import { extractInstructorGameId } from '@mygames/game-server'
import {
  POLL_CORS_ORIGINS, INSTANCES_COLLECTION, CONFIG_DOC,
  SYSTEM_QUESTION_IDS, parseQuestion, loadQuestions, type PollQuestion,
} from './config'

// ═══════════════════════════════════════════════════════════════════════════════
// Poll settings callables (spec §10). pollGetConfig returns the FULL question list
// (defaults + authored) for the editor; pollUpdateConfig writes it back. The list is
// the poll's real instructor work: visibility, prompt edits, order, add/delete.
//
// pollUpdateConfig REFUSES to delete a system:true default (spec §9, §10): every
// shipped default id must still be present. Instructor-authored questions (system
// false) are freely deletable.
// ═══════════════════════════════════════════════════════════════════════════════

export const pollGetConfig = onCall({ cors: POLL_CORS_ORIGINS }, async (request) => {
  const data = request.data as Record<string, unknown>
  const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true'
  const authHeader = request.rawRequest.headers.authorization as string | undefined

  const gameInstanceId = await extractInstructorGameId(data, isEmulator, authHeader)

  const db = admin.firestore()
  const snap = await db.collection(INSTANCES_COLLECTION).doc(gameInstanceId).collection('config').doc(CONFIG_DOC).get()

  return { ok: true as const, questions: loadQuestions(snap.data()) }
})

export const pollUpdateConfig = onCall({ cors: POLL_CORS_ORIGINS }, async (request) => {
  const data = request.data as Record<string, unknown>
  const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true'
  const authHeader = request.rawRequest.headers.authorization as string | undefined

  const gameInstanceId = await extractInstructorGameId(data, isEmulator, authHeader)

  if (!Array.isArray(data.questions)) {
    throw new HttpsError('invalid-argument', 'questions must be an array.')
  }

  // Parse + validate every question.
  const parsed: PollQuestion[] = []
  const seenIds = new Set<string>()
  for (const raw of data.questions) {
    const q = parseQuestion(raw)
    if (!q) throw new HttpsError('invalid-argument', 'One or more questions is malformed.')
    if (seenIds.has(q.id)) throw new HttpsError('invalid-argument', `Duplicate question id: ${q.id}`)
    seenIds.add(q.id)
    // A shipped default must keep system:true; an authored question must not claim it.
    if (SYSTEM_QUESTION_IDS.has(q.id) && !q.system) {
      throw new HttpsError('invalid-argument', `Default question ${q.id} cannot drop its system flag.`)
    }
    if (!SYSTEM_QUESTION_IDS.has(q.id) && q.system) {
      throw new HttpsError('invalid-argument', `Only shipped defaults may be system questions.`)
    }
    parsed.push(q)
  }

  // Refuse to delete any system default — every shipped default id must remain.
  for (const id of SYSTEM_QUESTION_IDS) {
    if (!seenIds.has(id)) {
      throw new HttpsError('failed-precondition', `The default question "${id}" cannot be deleted (hide it instead).`)
    }
  }

  const db = admin.firestore()
  await db.collection(INSTANCES_COLLECTION).doc(gameInstanceId).collection('config').doc(CONFIG_DOC).set(
    { questions: parsed }, { merge: true },
  )
  return { ok: true as const, questions: parsed }
})
