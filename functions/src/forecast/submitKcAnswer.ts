import { onCall, HttpsError } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import { FieldValue } from 'firebase-admin/firestore'
import { extractStudentOnCallIds } from '@mygames/game-server'
import {
  FORECAST_CORS_ORIGINS, INSTANCES_COLLECTION, PARTICIPANTS_SUBCOLLECTION, CONFIG_DOC,
  loadForecastConfig,
} from './config'
import { forecastKcScoreFor, resolveAddedKcQuestions, resolveForecastKc } from './questions'

// ═══════════════════════════════════════════════════════════════════════════════
// forecastSubmitKcAnswer (student) — grades ONE knowledge-check question (spec §8).
//
// ⚠⚠ THE GRADER SHIPS WITH THE RENDER PATH. It grades against `forecastKcScoringSet`,
// which is built from `resolveForecastKc` and `resolveAddedKcQuestions` — the SAME
// resolvers forecastGetQuestions serves from. There is no second list of fields anywhere,
// so a question cannot exist on screen and be unknown to the grader ("'x' is not a valid
// graded KC question" is the failure this arrangement exists to make impossible).
//
// ⚠⚠ THIS FILE USED TO BUILD ITS OWN `forScoring` from the UNFILTERED authored nine plus
// `config.addedKcQuestions`, and that was the spec's named worst case (§5): a hidden
// question stayed in the denominator, so a student who answered every question they were
// SHOWN never reached `allAnswered` and never got a score at all. One resolver, one list.
//
// ⚠ Grading compares option VALUES, so the per-student shuffle is irrelevant here and the
// grader deliberately does not shuffle. An instructor's override changes labels only —
// there is no path from `kc_overrides` to `correct_value`.
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

  // ⚠⚠ NO BLANKET `kcEnabled` REFUSAL HERE ANY MORE. D12 makes the toggle gate GRADED
  // questions only, and this callable also carries UNGRADED additions — a free-text
  // question an instructor added to either stage. Refusing the whole callable made those
  // unanswerable whenever the graded check was off. The gate now lives in the resolvers,
  // so a question that `kcEnabled` removes is simply absent from the lookup below and gets
  // the ordinary "not a knowledge-check question in this game".

  // ── ROUTE THE FIELD TO ITS OWN SOURCE ─────────────────────────────────────
  // Authored FIRST. Added questions are looked up with their own stored key. The two lists
  // are never merged — an added question cannot take a kc_ id (config.ts), so this lookup
  // order can never shadow one with the other.
  //
  // ⚠ RESOLVED, not raw: a hidden question is not answerable, and an override's rewritten
  // labels are the ones validated against. `resolveAddedKcQuestions` is called with NO
  // stage — gradedness and answerability are stage-independent (D3), and this callable
  // serves both stages.
  const authored = resolveForecastKc(config)
  const authoredQ = authored.find(q => q.field === field)
  const addedQ = authoredQ
    ? undefined
    : resolveAddedKcQuestions(config).find(q => q.id === field)

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
    //
    // ⚠⚠ THE WHOLE DECISION IS `forecastKcScoreFor` — "is the set complete, and what does it
    // score" in ONE pure function, so a unit test can reach it. Inlining the three steps
    // here is what let a `calcKCScore` mutant survive the entire suite once (questions.ts).
    const score = forecastKcScoreFor(allAnswers, config)
    if (score !== null && pData.knowledge_check_score == null) {
      patch.knowledge_check_score = score
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
