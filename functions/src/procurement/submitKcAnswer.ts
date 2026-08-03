import { onCall, HttpsError } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import { FieldValue } from 'firebase-admin/firestore'
import { extractStudentOnCallIds, calcKCScore } from '@mygames/game-server'
import {
  PROCUREMENT_CORS_ORIGINS, INSTANCES_COLLECTION, PARTICIPANTS_SUBCOLLECTION, CONFIG_DOC,
  loadProcurementConfig,
} from './config'
import { KC_POOL_IDS, defaultVisibleFor, resolveQuestions, scoringSet } from './questions'

// ═══════════════════════════════════════════════════════════════════════════════
// procurementSubmitKcAnswer (student) — grades ONE knowledge-check question.
//
// ⚠⚠ THE GRADER SHIPS WITH THE RENDER PATH. It resolves the question set with the SAME
// `resolveKcQuestions(format, kcVisible)` call procurementGetQuestions made to build the
// question the student answered, from the SAME live config. There is no second list of
// fields anywhere, so a question cannot exist on screen and be unknown to the grader.
//
// ⚠⚠ THE DENOMINATOR IS COMPUTED FROM THE VISIBLE GRADED SET, AT SCORING TIME, AND IS
// NEVER STORED. `scoringSet(...)` is the one derivation. Switch a question off and the
// next student's score is out of one fewer; there is no `/17` to go stale.
//
// ⚠ AND THE DENOMINATOR IS READ PER REQUEST, NOT AT MODULE LOAD. That matters here more
// than in the family's earlier games: `kcVisible` is instructor-editable mid-session, so
// a set captured once at cold start would grade later students against a config nobody
// is using. (The `prepDefaultsFor` lesson, applied to a game-local grader.)
//
// WHY THIS IS GAME-LOCAL AND NOT THE SHARED FACTORY: makeSubmitStaticKnowledgeCheck
// Question is written for the negotiation family — top-level `game_instances`, an
// assigned ROLE, and a role gate. This family is single-player: a procurement_-prefixed
// collection, no roles, and deliberately NO GATE (Part 1 §10 v2: no gate question,
// resolved not flagged). So the callable is local, exactly as every other single-player
// game's is, while the part that must not fork — the scoring rule — is the SHARED
// calcKCScore imported above.
//
// PER-QUESTION ONE-SHOT LOCK, server-enforced, inside a transaction (the family rule):
// an already-answered question DISCARDS the incoming answer and returns the stored
// result, so a double-click cannot overwrite a wrong answer with a right one.
// ═══════════════════════════════════════════════════════════════════════════════

export const procurementSubmitKcAnswer = onCall({ cors: PROCUREMENT_CORS_ORIGINS }, async (request) => {
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
  const config = loadProcurementConfig(configSnap.data(), KC_POOL_IDS, defaultVisibleFor)

  if (!config.kcEnabled) {
    throw new HttpsError('failed-precondition', 'The knowledge check is not part of this game.')
  }

  const visible = resolveQuestions(config.format, config.kcVisible, 'kc')
  const question = visible.find(q => q.id === field)
  if (!question) {
    // ⚠ Covers three distinct cases with one message, deliberately: not in the pool,
    // not tagged for this format, or switched off. All three mean the same thing to a
    // student, and distinguishing them would tell them a question exists that they are
    // not being asked.
    throw new HttpsError('invalid-argument', `'${field}' is not a knowledge-check question in this game.`)
  }
  if (!question.options.some(o => o.value === answer)) {
    throw new HttpsError('invalid-argument', 'Please choose one of the options.')
  }

  /** The graded set, per request, from the live config. THE DENOMINATOR. */
  const forScoring = scoringSet(config.format, config.kcVisible)
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

    // An UNGRADED question (correct_value null) is recorded and never counted wrong.
    const correct = question.correct_value !== null && answer === question.correct_value

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

    // The score lands once, when the last graded question is answered.
    // ⚠ `forScoring.length > 0` guards the empty-pool case: with no graded questions
    // `every()` is vacuously true, and without this a student would be handed a
    // completed KC with a score of 0/0 the first time they touched the screen.
    if (forScoring.length > 0 && allAnswered && pData.knowledge_check_score == null) {
      patch.knowledge_check_score = calcKCScore(allAnswers, forScoring).score
      patch.knowledge_check_completed_at = FieldValue.serverTimestamp()
    }

    tx.set(participantRef, patch, { merge: true })
    return { correct, stored: false as const }
  })

  return {
    ok: true as const,
    correct: result.correct,
    /** False for an ungraded question, so the client shows "recorded" rather than
     *  marking it wrong. */
    graded: question.correct_value !== null,
    // Earned by answering — this is the ONLY path that returns it.
    explanation: question.explanation,
  }
})
