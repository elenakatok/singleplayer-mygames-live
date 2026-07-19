import { onCall, HttpsError } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import { extractStudentOnCallIds } from '@mygames/game-server'
import {
  PENNIES_CORS_ORIGINS, INSTANCES_COLLECTION, PARTICIPANTS_COLLECTION,
  CONFIG_DOC, DEFAULT_JAR_IMAGE,
} from './config'
import { penniesQuestions } from './questions'

// ═══════════════════════════════════════════════════════════════════════════════
// penniesGetScreen (student) — returns the jar image path and the two question
// definitions, plus whether THIS caller has already submitted (drives the one-shot
// resume: a returning student sees the confirmation, not the form).
//
// ⚠ It NEVER returns true_value under ANY circumstance — it does not even read
// truth/main. The jar image comes from config/main (client-safe); the true value
// lives only in the rules-denied truth/ subcollection (spec §4.4).
// ═══════════════════════════════════════════════════════════════════════════════

export const penniesGetScreen = onCall({ cors: PENNIES_CORS_ORIGINS }, async (request) => {
  const data = request.data as Record<string, unknown>
  const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true'
  const authHeader = request.rawRequest.headers.authorization as string | undefined

  const { participantId, gameInstanceId } = await extractStudentOnCallIds(data, isEmulator, authHeader)

  const db = admin.firestore()
  const instanceRef = db.collection(INSTANCES_COLLECTION).doc(gameInstanceId)

  const [configSnap, participantSnap] = await Promise.all([
    instanceRef.collection('config').doc(CONFIG_DOC).get(),
    db.collection(PARTICIPANTS_COLLECTION).doc(participantId).get(),
  ])

  const jarImage = (configSnap.data()?.jar_image as string | undefined) ?? DEFAULT_JAR_IMAGE
  const alreadySubmitted = participantSnap.data()?.submitted_at != null

  if (participantSnap.exists && participantSnap.data()?.game_instance_id !== gameInstanceId) {
    throw new HttpsError('permission-denied', 'Participant does not belong to this instance.')
  }

  return {
    ok: true as const,
    jar_image: jarImage,
    already_submitted: alreadySubmitted,
    questions: penniesQuestions,
  }
})
