import { onCall, HttpsError } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import { FieldValue } from 'firebase-admin/firestore'
import { extractStudentOnCallIds, calcKCScore } from '@mygames/game-server'
import {
  FORECAST_CORS_ORIGINS, INSTANCES_COLLECTION, PARTICIPANTS_SUBCOLLECTION, CONFIG_DOC,
  loadForecastConfig,
} from './config'
import { resolveForecastKcQuestions } from './questions'

// ═══════════════════════════════════════════════════════════════════════════════
// forecastSubmitKcAnswer (student) — grades ONE knowledge-check question (spec §8).
//
// ⚠⚠ THE GRADER SHIPS WITH THE RENDER PATH. It grades against
// resolveForecastKcQuestions(participantId) — the SAME call forecastGetQuestions made
// to build the question the student answered, with the SAME per-student option order.
// There is no second list of fields anywhere, so a question cannot exist on screen and
// be unknown to the grader ("'x' is not a valid graded KC question" is the failure this
// arrangement exists to make impossible). A later slice that adds a question adds it to
// questions.ts, and both paths get it in the same commit.
//
// WHY THIS IS FORECAST-LOCAL AND NOT THE SHARED FACTORY: makeSubmitStaticKnowledge
// CheckQuestion is written for the negotiation family — top-level `game_instances`, an
// assigned ROLE, and a role gate. This family is single-player: a forecast_-prefixed
// collection, no roles, and deliberately NO GATE. So the callable is local (exactly as
// newsvendor's, pricing's, PD's, pennies' and poll's are), while the part that must not
// fork — the scoring rule — is the SHARED calcKCScore, imported above.
//
// DENOMINATOR = 9 (spec §8), and it is COMPUTED from the served set rather than
// written down: turn the KC off and there is nothing to grade; add two instructor
// questions with keys and it is 11. There is no `/9` anywhere in this file.
//
// PER-QUESTION ONE-SHOT LOCK, server-enforced, inside a transaction (the family rule):
// an already-answered question DISCARDS the incoming answer and returns the stored
// result, so a double-click cannot overwrite a wrong answer with a right one.
// ═══════════════════════════════════════════════════════════════════════════════

export const forecastSubmitKcAnswer = onCall({ cors: FORECAST_CORS_ORIGINS }, async (request) => {
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
  const config = loadForecastConfig(configSnap.data())

  if (!config.kcEnabled) {
    throw new HttpsError('failed-precondition', 'The knowledge check is not part of this game.')
  }

  // ── ROUTE THE FIELD TO ITS OWN SOURCE ─────────────────────────────────────
  // Authored FIRST. Added questions are looked up in config with their own stored key.
  // The two lists are never merged — an added question cannot even take a kc_ id
  // (config.ts), so this lookup order can never shadow one with the other.
  const authored = resolveForecastKcQuestions(participantId)
  const authoredQ = authored.find(q => q.field === field)
  const addedQ = authoredQ ? undefined : config.addedKcQuestions.find(q => q.id === field)

  if (!authoredQ && !addedQ) {
    throw new HttpsError('invalid-argument', `'${field}' is not a knowledge-check question in this game.`)
  }

  /** The correct answer, or null when the question is ungraded (added free text). */
  let correctValue: string | null
  let explanation: string
  if (authoredQ) {
    if (!authoredQ.options.some(o => o.value === answer)) {
      throw new HttpsError('invalid-argument', 'Please choose one of the options.')
    }
    correctValue = authoredQ.correct_value
    explanation = authoredQ.explanation
  } else {
    const q = addedQ!
    if (q.type === 'mc' && !(q.options ?? []).some(o => o.value === answer)) {
      throw new HttpsError('invalid-argument', 'Please choose one of the options.')
    }
    // Free text has no key: it is RECORDED and left ungraded, never counted wrong.
    correctValue = q.type === 'mc' ? (q.correct_value ?? null) : null
    explanation = q.explanation ?? ''
  }

  /**
   * The scoring set: every AUTHORED question, PLUS any added question that carries a
   * key. Added free-text questions are absent from BOTH numerator and denominator, so
   * adding one cannot silently lower everyone's score.
   */
  const forScoring = [
    ...authored.map(q => ({ field: q.field, correct_value: q.correct_value })),
    ...config.addedKcQuestions
      .filter(q => q.type === 'mc' && typeof q.correct_value === 'string')
      .map(q => ({ field: q.id, correct_value: q.correct_value! })),
  ]
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

    const correct = correctValue !== null && answer === correctValue

    const allAnswers: Record<string, string> = {}
    for (const [k, v] of Object.entries(existing)) allAnswers[k] = v.answer
    allAnswers[field] = answer
    const allAnswered = forScoring.every(q => allAnswers[q.field] != null)

    const patch: Record<string, unknown> = {
      participant_id: participantId,
      game_instance_id: gameInstanceId,
      // Nested object, not a dotted key: set({merge:true}) treats 'a.b' as a literal
      // field name (only update() reads it as a path). Merge deep-merges the map, so
      // the other answers survive.
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
    /** False for an ungraded added question, so the client shows "recorded" rather
     *  than marking a free-text answer wrong. */
    graded: correctValue !== null,
    // Earned by answering — this is the ONLY path that returns it.
    explanation,
  }
})
