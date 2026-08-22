import { onCall } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import { extractStudentOnCallIds } from '@mygames/game-server'
import {
  PENNIES_CORS_ORIGINS, INSTANCES_COLLECTION, PARTICIPANTS_SUBCOLLECTION,
  CONFIG_DOC, DEFAULT_JAR_IMAGE, DEFAULT_REVERSE, DEFAULT_PENNY_VALUE,
} from './config'
import { penniesQuestionsFor } from './questions'

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

  // Participant is read from THIS instance's subcollection — a returning student in a
  // DIFFERENT instance is a different doc, so there is nothing to leak and no belongs
  // check to make (isolation is structural).
  const [configSnap, participantSnap] = await Promise.all([
    instanceRef.collection('config').doc(CONFIG_DOC).get(),
    instanceRef.collection(PARTICIPANTS_SUBCOLLECTION).doc(participantId).get(),
  ])

  const cfg = configSnap.data() ?? {}
  const jarImage = (cfg.jar_image as string | undefined) ?? DEFAULT_JAR_IMAGE
  // Mode + multiplier are non-secret (the student is told which game they play and that
  // each penny is worth $X); they never expose the true value/cost, which stays in truth/.
  const reverse = cfg.reverse === true ? true : DEFAULT_REVERSE
  const pennyValue = typeof cfg.penny_value === 'number' ? cfg.penny_value : DEFAULT_PENNY_VALUE
  const alreadySubmitted = participantSnap.data()?.submitted_at != null

  return {
    ok: true as const,
    jar_image: jarImage,
    reverse,
    penny_value: pennyValue,
    already_submitted: alreadySubmitted,
    questions: penniesQuestionsFor(reverse),
  }
})
