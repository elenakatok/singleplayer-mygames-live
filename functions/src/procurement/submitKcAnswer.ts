import { onCall, HttpsError } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import { FieldValue } from 'firebase-admin/firestore'
import { extractStudentOnCallIds } from '@mygames/game-server'
import {
  PROCUREMENT_CORS_ORIGINS, INSTANCES_COLLECTION, PARTICIPANTS_SUBCOLLECTION, CONFIG_DOC,
  loadProcurementConfig,
} from './config'
import {
  KC_POOL_IDS, defaultVisibleFor, resolveBuiltIns, resolveAddedKcQuestions,
  procurementKcScoreFor,
} from './questions'

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

  // ⚠⚠ NO BLANKET `kcEnabled` REFUSAL ANY MORE. D12 makes the toggle gate GRADED questions
  // only, and this callable now also carries UNGRADED additions — a free-text question an
  // instructor added to either stage. Refusing the whole callable made those unanswerable
  // whenever the graded check was off. The gate lives in the resolvers, so a question the
  // toggle removes is simply absent from the lookup below and gets the ordinary refusal.

  // ⚠ ROUTE THE FIELD TO ITS OWN SOURCE. Built-ins FIRST; an added question cannot take a
  // built-in id (config.ts's explicit id SET — the `kc_` prefix rule would protect nothing
  // in this game), so this lookup order can never shadow one with the other.
  // ⚠ RESOLVED, not raw: a hidden question is not answerable, and an override's rewritten
  // option labels are the ones validated against. `resolveAddedKcQuestions` is called with
  // NO stage — answerability is stage-independent (D3) and this callable serves both.
  const builtIn = resolveBuiltIns(config, 'kc').find(q => q.id === field)
  const added = builtIn ? undefined : resolveAddedKcQuestions(config).find(q => q.id === field)
  const question = builtIn ?? (added
    ? {
      id: added.id,
      options: (added.options ?? []).map(o => ({ value: o.value, label: o.label })),
      correct_value: added.correct_value ?? null,
      explanation: added.explanation ?? '',
      kind: added.type,
    }
    : undefined)
  if (!question) {
    // ⚠ Covers three distinct cases with one message, deliberately: not in the pool,
    // not tagged for this format, or switched off. All three mean the same thing to a
    // student, and distinguishing them would tell them a question exists that they are
    // not being asked.
    throw new HttpsError('invalid-argument', `'${field}' is not a knowledge-check question in this game.`)
  }
  // ⚠ AN ADDED FREE-TEXT QUESTION HAS NO OPTIONS AND IS NOT CHECKED AGAINST ANY. Built-ins
  // in the `kc` stage are always mc, so this branch is new with added questions.
  if (question.kind === 'mc' && !question.options.some(o => o.value === answer)) {
    throw new HttpsError('invalid-argument', 'Please choose one of the options.')
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

    // An UNGRADED question (correct_value null) is recorded and never counted wrong.
    const correct = question.correct_value !== null && answer === question.correct_value

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

    // The score lands once, when the last graded question is answered.
    //
    // ⚠⚠ THE WHOLE DECISION IS `procurementKcScoreFor` — "is the graded set non-empty, is it
    // complete, and what does it score" in ONE pure function the suite can reach. It used to
    // be three conditions inlined here, and forecast lost two mutants to exactly that shape:
    // a decision inlined in a callable is a decision no unit test can reach (spec §7).
    //
    // ⚠ THE EMPTY-SET GUARD IS INSIDE IT AND IS PROCUREMENT'S OWN RULE (spec §9): with no
    // graded questions `every()` is vacuously true, and without the guard a student would be
    // handed a completed KC of 0/0 the first time they touched the screen. ⚠ DO NOT swap this
    // for `kcScoreOrNull` to match the other five — that writes null AND would let the stamp
    // land, which is the thing being prevented.
    const score = procurementKcScoreFor(allAnswers, config)
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
    /** False for an ungraded question, so the client shows "recorded" rather than
     *  marking it wrong. */
    graded: question.correct_value !== null,
    // Earned by answering — this is the ONLY path that returns it.
    explanation: question.explanation,
  }
})
