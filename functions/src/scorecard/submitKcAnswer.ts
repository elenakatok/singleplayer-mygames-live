import { onCall, HttpsError } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import { FieldValue } from 'firebase-admin/firestore'
import { extractStudentOnCallIds, calcKCScore } from '@mygames/game-server'
import {
  SCORECARD_CORS_ORIGINS, INSTANCES_COLLECTION, PARTICIPANTS_SUBCOLLECTION,
} from './config'
import { loadInstance } from './instance'
import { scorecardKcQuestions } from './questions'

// ═══════════════════════════════════════════════════════════════════════════════
// scorecardSubmitKcAnswer (student) — one knowledge-check answer (spec §9).
//
// ⚠ THE QUESTION SET IS REBUILT FROM LIVE CONFIG on every call, so the grader validates
// against exactly the stems the student was shown. This is why the KC deriving from
// config is safe: `scorecardGetQuestions` and this callable both call
// `scorecardKcQuestions(config, truth)`, so they cannot disagree about what the right
// answer is.
//
// ⚠ THE DENOMINATOR IS DYNAMIC — `questions.length`, never a hardcoded 8. Editing the set
// must not silently rescale everyone's score.
//
// Idempotent: a question already answered keeps its stored verdict, so a retry can neither
// change an answer nor re-grade one.
// ═══════════════════════════════════════════════════════════════════════════════

export const scorecardSubmitKcAnswer = onCall({ cors: SCORECARD_CORS_ORIGINS }, async (request) => {
  const data = request.data as Record<string, unknown>
  const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true'
  const authHeader = request.rawRequest.headers.authorization as string | undefined

  const { participantId, gameInstanceId } = await extractStudentOnCallIds(data, isEmulator, authHeader)

  const questionId = data.questionId
  const answer = data.answer
  if (typeof questionId !== 'string' || typeof answer !== 'string') {
    throw new HttpsError('invalid-argument', 'questionId and answer must be strings.')
  }

  const db = admin.firestore()
  const { config, truth } = await loadInstance(db, gameInstanceId)
  const questions = scorecardKcQuestions(config, truth)

  const q = questions.find(x => x.id === questionId)
  if (!q) {
    throw new HttpsError('invalid-argument', `'${questionId}' is not a question in this game.`)
  }
  if (!q.options.some(o => o.id === answer)) {
    throw new HttpsError('invalid-argument', 'Please choose one of the options.')
  }

  const forScoring = questions.map(x => ({ field: x.id, correct_value: x.correctOptionId }))

  const participantRef = db
    .collection(INSTANCES_COLLECTION).doc(gameInstanceId)
    .collection(PARTICIPANTS_SUBCOLLECTION).doc(participantId)

  const result = await db.runTransaction(async (tx) => {
    const snap = await tx.get(participantRef)
    const pData = snap.data() ?? {}
    type Stored = { answer: string; correct: boolean }
    const existing = (pData.kc_answers ?? {}) as Record<string, Stored>

    // Already answered — the stored verdict stands.
    if (existing[questionId] != null) {
      return { correct: existing[questionId].correct, alreadyAnswered: true as const }
    }

    const correct = answer === q.correctOptionId

    const allAnswers: Record<string, string> = {}
    for (const [k, v] of Object.entries(existing)) allAnswers[k] = v.answer
    allAnswers[questionId] = answer
    const allAnswered = forScoring.every(x => allAnswers[x.field] != null)

    const patch: Record<string, unknown> = {
      participant_id: participantId,
      game_instance_id: gameInstanceId,
      // Nested object, not a dotted key: set({merge:true}) treats 'a.b' as a literal
      // field name. Merge deep-merges the map, so other answers survive.
      kc_answers: { [questionId]: { answer, correct, answered_at: FieldValue.serverTimestamp() } },
    }

    // The score lands once, when the last question is answered.
    if (allAnswered && pData.knowledge_check_score == null) {
      patch.knowledge_check_score = calcKCScore(allAnswers, forScoring).score
      patch.knowledge_check_completed_at = FieldValue.serverTimestamp()
    }

    tx.set(participantRef, patch, { merge: true })
    return { correct, alreadyAnswered: false as const }
  })

  return {
    ok: true as const,
    correct: result.correct,
    alreadyAnswered: result.alreadyAnswered,
    /** Earned by answering — this is the ONLY path that returns it. */
    explanation: q.explanation,
  }
})
