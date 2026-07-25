import { onCall } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import { extractStudentOnCallIds } from '@mygames/game-server'
import {
  PD_CORS_ORIGINS, INSTANCES_COLLECTION, PARTICIPANTS_SUBCOLLECTION, CONFIG_DOC, loadPdConfig,
} from './config'
import { resolveKcQuestions, toClientKcQuestions, debriefQuestion } from './questions'

// ═══════════════════════════════════════════════════════════════════════════════
// pdGetQuestions (student) — the whole non-round question set in ONE call: the four
// KC questions (spec §7) and the debrief paragraph (spec §8), plus which of them this
// student has already answered.
//
// ONE CALLABLE FOR BOTH because the play screen builds its whole sequence up front
// (KC → round loop → debrief) and would otherwise round-trip twice before rendering
// anything. Poll's getQuestions has the same shape: the questions, plus `answered`
// so the client can resume on the first one with no entry.
//
// ⚠ THE ANSWER KEY NEVER SHIPS. toClientKcQuestions drops `correct_value` AND
// `explanation` — the explanation is earned by answering (pdSubmitKcAnswer returns
// it) and the key is server-only. This is the same whitelist discipline the round
// callables use for the round count and the strategy: build the client object field
// by field, never spread the server-side one.
// ═══════════════════════════════════════════════════════════════════════════════

export const pdGetQuestions = onCall({ cors: PD_CORS_ORIGINS }, async (request) => {
  const data = request.data as Record<string, unknown>
  const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true'
  const authHeader = request.rawRequest.headers.authorization as string | undefined

  const { participantId, gameInstanceId } = await extractStudentOnCallIds(data, isEmulator, authHeader)

  const db = admin.firestore()
  const instanceRef = db.collection(INSTANCES_COLLECTION).doc(gameInstanceId)
  const [configSnap, participantSnap] = await Promise.all([
    instanceRef.collection('config').doc(CONFIG_DOC).get(),
    instanceRef.collection(PARTICIPANTS_SUBCOLLECTION).doc(participantId).get(),
  ])

  const config = loadPdConfig(configSnap.data())
  const pData = participantSnap.data() ?? {}

  // Resolved against THIS instance's matrix, so the options match the matrix the KC
  // screen renders beside them.
  const resolved = resolveKcQuestions(config.payoffs)

  const answers = (pData.kc_static_answers ?? {}) as Record<string, unknown>
  const answered = resolved.filter(q => answers[q.field] != null).map(q => q.field)

  return {
    ok: true as const,
    kc: toClientKcQuestions(resolved),
    // Ungraded and keyless — safe to send whole, but still built field by field.
    debrief: {
      field: debriefQuestion.field,
      prompt: debriefQuestion.prompt,
      placeholder: debriefQuestion.placeholder,
    },
    kcAnswered: answered,
    debriefSubmitted: (pData.debrief_answers ?? {})[debriefQuestion.field] != null,
  }
})
