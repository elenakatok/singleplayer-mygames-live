import { onCall, HttpsError } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import { FieldValue } from 'firebase-admin/firestore'
import { extractStudentOnCallIds, calcKCScore } from '@mygames/game-server'
import {
  PD_CORS_ORIGINS, INSTANCES_COLLECTION, PARTICIPANTS_SUBCOLLECTION, CONFIG_DOC, loadPdConfig,
} from './config'
import { resolveKcQuestions } from './questions'

// ═══════════════════════════════════════════════════════════════════════════════
// pdSubmitKcAnswer (student) — grades ONE knowledge-check question (spec §7).
//
// WHY THIS IS PD-LOCAL AND NOT THE SHARED FACTORY: makeSubmitStaticKnowledgeCheck
// Question is written for the negotiation family — it reads the top-level
// `game_instances` collection, requires an assigned ROLE, and refuses to run until
// the role gate (`knowledge_check_completed_at`) is stamped. PD is single-player: a
// pd_-prefixed collection, no roles, and deliberately NO GATE. So the callable is
// local (exactly as pennies' and poll's submits are), while the part that must not
// fork — the scoring rule — is the SHARED calcKCScore, imported above. The stored
// shape is the family's (`kc_static_answers` map, `knowledge_check_score`), so the
// report and the gradebook push read it the same way they read every other game's.
//
// NO GATE, AND NO BLOCK ON A WRONG ANSWER: every answer is recorded and scored, and
// the client advances regardless. The `correct` flag and the explanation come back
// POST-answer — never before, and never as a re-answer opportunity.
//
// PER-QUESTION ONE-SHOT LOCK, server-enforced, inside a transaction (the family
// rule): an already-answered question DISCARDS the incoming answer and returns the
// stored result, so a double-click cannot overwrite a wrong answer with a right one.
// ═══════════════════════════════════════════════════════════════════════════════

export const pdSubmitKcAnswer = onCall({ cors: PD_CORS_ORIGINS }, async (request) => {
  const data = request.data as Record<string, unknown>
  const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true'
  const authHeader = request.rawRequest.headers.authorization as string | undefined

  const { participantId, gameInstanceId } = await extractStudentOnCallIds(data, isEmulator, authHeader)

  const field = data.field
  const answer = data.answer
  if (typeof field !== 'string' || !field) {
    throw new HttpsError('invalid-argument', 'field is required.')
  }
  if (typeof answer !== 'string' || !answer) {
    throw new HttpsError('invalid-argument', 'Please choose an answer.')
  }

  const db = admin.firestore()
  const instanceRef = db.collection(INSTANCES_COLLECTION).doc(gameInstanceId)
  const configSnap = await instanceRef.collection('config').doc(CONFIG_DOC).get()
  const config = loadPdConfig(configSnap.data())

  // Resolved against this instance's matrix — the same call the serve path made, so a
  // student is graded against the matrix they were shown.
  const questions = resolveKcQuestions(config.payoffs)
  const question = questions.find(q => q.field === field)
  if (!question) {
    throw new HttpsError('invalid-argument', `'${field}' is not a knowledge-check question in this game.`)
  }
  if (!(question.options ?? []).some(o => o.value === answer)) {
    throw new HttpsError('invalid-argument', 'Please choose one of the options.')
  }

  const forScoring = questions.map(q => ({ field: q.field, correct_value: q.correct_value! }))
  const participantRef = instanceRef.collection(PARTICIPANTS_SUBCOLLECTION).doc(participantId)

  const result = await db.runTransaction(async (tx) => {
    const snap = await tx.get(participantRef)
    const pData = snap.data() ?? {}
    type KcAnswer = { answer: string; correct: boolean }
    const existing = (pData.kc_static_answers ?? {}) as Record<string, KcAnswer>

    // Idempotent: already answered — the stored verdict stands.
    if (existing[field] != null) {
      return { correct: existing[field].correct, stored: true as const }
    }

    const correct = answer === question.correct_value

    // Every answer, including this one, for the all-answered check + the score.
    const allAnswers: Record<string, string> = {}
    for (const [k, v] of Object.entries(existing)) allAnswers[k] = v.answer
    allAnswers[field] = answer
    const allAnswered = forScoring.every(q => allAnswers[q.field] != null)

    const patch: Record<string, unknown> = {
      participant_id: participantId,
      game_instance_id: gameInstanceId,
      // Nested object, not a dotted key: set({merge:true}) treats 'a.b' as a literal
      // field name (only update() reads it as a path). Merge deep-merges the map, so
      // the other three answers survive.
      kc_static_answers: { [field]: { answer, correct, answered_at: FieldValue.serverTimestamp() } },
    }

    // The score lands once, when the last question is answered — the shared rule:
    // correct / total over the graded static questions. Wrong answers stay in the
    // denominator; they simply do not count in the numerator.
    if (allAnswered && pData.knowledge_check_score == null) {
      patch.knowledge_check_score = calcKCScore(allAnswers, forScoring).score
      patch.knowledge_check_completed_at = FieldValue.serverTimestamp()
    }

    tx.set(participantRef, patch, { merge: true })
    return { correct, stored: false as const }
  })

  return {
    ok: true as const,
    correct: result.correct,
    // Earned by answering — this is the ONLY path that returns it.
    explanation: question.explanation ?? '',
  }
})
