import { onCall, HttpsError } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import { FieldValue } from 'firebase-admin/firestore'
import { extractStudentOnCallIds, kcScoreOrNull } from '@mygames/game-server'
import {
  PRICING_CORS_ORIGINS, INSTANCES_COLLECTION, PARTICIPANTS_SUBCOLLECTION, CONFIG_DOC,
  loadPricingConfig,
} from './config'
import { pricingResolveKc, resolveAddedKcQuestions, pricingKcScoringSet } from './questions'

// ═══════════════════════════════════════════════════════════════════════════════
// pricingSubmitKcAnswer (student) — grades ONE knowledge-check question (spec §8).
//
// ⚠⚠ THE GRADER SHIPS WITH THE RENDER PATH. It grades against
// resolvePricingKcQuestions(config.market, config.pmg, config.labels) — the SAME call
// pricingGetQuestions made to build the question the student answered. There is no
// second list of fields anywhere, so a question cannot exist on screen and be unknown
// to the grader (the deploy-learnings trap this comment exists to name). If a later
// slice adds a question, it is added to questions.ts and both paths get it in the
// same commit, by construction.
//
// WHY THIS IS PRICING-LOCAL AND NOT THE SHARED FACTORY: makeSubmitStaticKnowledge
// CheckQuestion is written for the negotiation family — top-level `game_instances`,
// an assigned ROLE, and a role gate. This family is single-player: a pricing_-prefixed
// collection, no roles, and deliberately NO GATE. So the callable is local (exactly as
// PD's, pennies' and poll's are), while the part that must not fork — the scoring
// rule — is the SHARED calcKCScore, imported above. The stored shape is the family's
// (`kc_static_answers` map, `knowledge_check_score`), so the reports and the gradebook
// push read it the same way they read every other game's.
//
// PER-QUESTION ONE-SHOT LOCK, server-enforced, inside a transaction (the family
// rule): an already-answered question DISCARDS the incoming answer and returns the
// stored result, so a double-click cannot overwrite a wrong answer with a right one.
// ═══════════════════════════════════════════════════════════════════════════════

export const pricingSubmitKcAnswer = onCall({ cors: PRICING_CORS_ORIGINS }, async (request) => {
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
  const config = loadPricingConfig(configSnap.data())

  // ⚠⚠ THE BLANKET `if (!config.kcEnabled) throw` GATE IS GONE, and it had to go with D12.
  // The toggle gates GRADED questions only, so an instance with the check off still SERVES
  // an ungraded free-text addition — and the blanket gate refused an answer to a question
  // the same instance had just handed the student. (pd and scorecard removed the identical
  // gate for the identical reason.)
  //
  // ⚠ NOTHING IS WEAKENED. The routing below does the same job PER QUESTION: with
  // `kcEnabled: false` the derived set resolves empty and every graded addition is filtered
  // out, so answering one falls through to the "not a knowledge-check question" error. A
  // HIDDEN question is refused by the same path, which the blanket gate never covered.

  // ── ROUTE THE FIELD TO ITS OWN SOURCE ─────────────────────────────────────
  // Derived FIRST: resolved against this instance's market and mode, the same call
  // the serve path made, so a student is graded against the market they were shown.
  // Added questions are looked up in config with their own stored key. The two lists
  // are never merged — an added question cannot even take a kc_ id (config.ts), so
  // this lookup order can never shadow one with the other. A field from the OTHER
  // mode's set is not a question in this game at all.
  // ⚠⚠ THE SAME RESOLVERS THE SERVE PATH USES — hidden removed, overrides applied, in the
  // instance's order. This is what keeps `forScoring` below honest.
  const derived = pricingResolveKc(config)
  const addedVisible = resolveAddedKcQuestions(config)
  const derivedQ = derived.find(q => q.field === field)
  const addedQ = derivedQ ? undefined : addedVisible.find(q => q.id === field)

  if (!derivedQ && !addedQ) {
    throw new HttpsError('invalid-argument', `'${field}' is not a knowledge-check question in this game.`)
  }

  /** The correct answer, or null when the question is ungraded (added free text). */
  let correctValue: string | null
  let explanation: string
  if (derivedQ) {
    if (!derivedQ.options.some(o => o.value === answer)) {
      throw new HttpsError('invalid-argument', 'Please choose one of the options.')
    }
    correctValue = derivedQ.correct_value
    explanation = derivedQ.explanation
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
   * The scoring set: every DERIVED question served for this instance, PLUS any added
   * question that carries a key. The denominator is therefore DYNAMIC — Standard's
   * four, PMG's three, one fewer if the market made a question inapplicable
   * (questions.ts), plus whatever the instructor added. Never a hardcoded /4. Added
   * free-text questions are absent from BOTH numerator and denominator, so adding one
   * cannot silently lower everyone's score.
   */
  // ⚠⚠ NOT BUILT HERE. `pricingKcScoringSet` is the single place that decides which
  // questions this instance grades, and it derives from the same resolvers the serve path
  // uses — so a hidden question cannot be served-but-not-graded or graded-but-not-served.
  const forScoring = pricingKcScoringSet(config)
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

    // An ungraded (free-text) added question is stored with correct:false and is
    // excluded from `forScoring`, so it counts nowhere — it is a record, not a mark.
    const correct = correctValue !== null && answer === correctValue

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
      // the other answers survive.
      kc_static_answers: { [field]: { answer, correct, answered_at: FieldValue.serverTimestamp() } },
    }

    // The score lands once, when the last question is answered — the shared rule:
    // correct / total over the graded static questions. Wrong answers stay in the
    // denominator; they simply do not count in the numerator.
    // ⚠⚠ `kcScoreOrNull`, NOT `calcKCScore(...).score`. The shared helper answers the EMPTY
    // graded set with 1.0 — right for a negotiation game's gate-only role, catastrophic
    // here. An instructor who hides every graded question, or whose check is one free-text
    // addition, would otherwise record a PERFECT knowledge-check score for a student who
    // was never asked a graded question, and scoreAndRecord pushes it to the gradebook.
    // That became reachable the moment `kc_hidden` landed.
    if (allAnswered && pData.knowledge_check_score == null) {
      patch.knowledge_check_score = kcScoreOrNull(allAnswers, forScoring)
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
