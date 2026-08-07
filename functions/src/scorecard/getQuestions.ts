import { onCall } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import { extractStudentOnCallIds } from '@mygames/game-server'
import {
  SCORECARD_CORS_ORIGINS, INSTANCES_COLLECTION, PARTICIPANTS_SUBCOLLECTION,
} from './config'
import { loadInstance } from './instance'
import { scorecardKcQuestions, toClientKcQuestions, scorecardDebriefQuestion, kcDenominator } from './questions'

// ═══════════════════════════════════════════════════════════════════════════════
// scorecardGetQuestions (student) — the knowledge check (spec §9) and the debrief prompt
// (spec §10) in one call, plus which of them this student has already answered.
//
// ⚠ THE ANSWER KEY NEVER SHIPS. `toClientKcQuestions` drops `correctOptionId` and
// `explanation`; the explanation is EARNED by answering (scorecardSubmitKcAnswer returns
// it).
//
// ⚠ THE STEMS ARE DERIVED FROM LIVE CONFIG (spec §9) — unlike forecast, where an authored
// stem is a leak control. Here every number in a stem is one spec §8 says the student is
// told anyway, and a hardcoded "10 ECU" would be wrong the moment a probability is edited.
// ═══════════════════════════════════════════════════════════════════════════════

export const scorecardGetQuestions = onCall({ cors: SCORECARD_CORS_ORIGINS }, async (request) => {
  const data = request.data as Record<string, unknown>
  const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true'
  const authHeader = request.rawRequest.headers.authorization as string | undefined

  const { participantId, gameInstanceId } = await extractStudentOnCallIds(data, isEmulator, authHeader)

  const db = admin.firestore()
  const { config, truth } = await loadInstance(db, gameInstanceId)

  const snap = await db
    .collection(INSTANCES_COLLECTION).doc(gameInstanceId)
    .collection(PARTICIPANTS_SUBCOLLECTION).doc(participantId)
    .get()
  const pData = snap.data() ?? {}

  const questions = scorecardKcQuestions(config, truth)
  const answered = (pData.kc_answers ?? {}) as Record<string, { answer?: unknown }>
  const debrief = scorecardDebriefQuestion(config)
  const freeText = (pData.free_text_answers ?? {}) as Record<string, unknown>

  return {
    ok: true as const,
    kc: {
      questions: toClientKcQuestions(questions),
      /** ⚠ DYNAMIC — never a hardcoded /8. The shared grader's rule. */
      total: kcDenominator(questions),
      answeredIds: Object.keys(answered),
      score: typeof pData.knowledge_check_score === 'number' ? pData.knowledge_check_score : null,
      complete: pData.knowledge_check_completed_at != null,
    },
    debrief: {
      id: debrief.id,
      prompt: debrief.prompt,
      followUps: debrief.followUps,
      answered: freeText[debrief.id] != null,
    },
  }
})
