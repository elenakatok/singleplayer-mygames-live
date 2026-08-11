import { onCall, HttpsError } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import { FieldValue } from 'firebase-admin/firestore'
import { extractStudentOnCallIds } from '@mygames/game-server'
import {
  PROCUREMENT_CORS_ORIGINS, INSTANCES_COLLECTION, PARTICIPANTS_SUBCOLLECTION, CONFIG_DOC,
  loadProcurementConfig,
} from './config'
import { KC_POOL_IDS, defaultVisibleFor, resolveBuiltIns } from './questions'

// ═══════════════════════════════════════════════════════════════════════════════
// procurementSubmitFreeText (student) — the open-response paragraphs, UNGRADED.
//
// ⚠ ONE CALLABLE FOR BOTH THE PREP AND THE DEBRIEF, chosen by the question's own `stage`
// tag rather than by two near-identical functions. They differ in exactly one rule — when
// they may be answered — and that difference is four lines below. Two callables would be
// two places for the family's one-shot lock and the whitelist to drift.
//
// ⚠ THE TIMING RULE IS SERVER-SIDE AND IS THE POINT:
//   • `prep` must be answered BEFORE any round is played. It asks what the student
//     PLANS to do; answered afterwards it would be a description of what they already
//     did, and the whole reason it exists — comparing plan against play — evaporates.
//   • `debrief` must be answered AFTER every round. It asks how their bidding changed.
// Both are checked on stored facts inside the transaction, so a client that reordered
// its own screens still cannot answer out of turn.
//
// ⚠ UNGRADED BY CONSTRUCTION: a text question carries `correct_value: null`, so it is
// absent from both the numerator and the denominator (`gradedFor`). This callable never
// touches `knowledge_check_score`.
//
// ⚠ NO REVEAL RIDES ON THIS CALL — the deliberate difference from forecastSubmitDebrief,
// which hands over the demand model at this moment because the model is that game's
// answer. Here there is nothing equivalent: the rival cost range is public from the first
// screen and the equilibrium markup is taught on the slide. The revenue-equivalence
// comparison between the two formats is CLASSROOM debrief material, not an in-game
// reveal (Part 2 §1).
//
// One-shot, like every other submit in the family: an existing answer is returned rather
// than overwritten.
// ═══════════════════════════════════════════════════════════════════════════════

/** Bound so a runaway paste cannot push the participant doc toward the 1 MiB limit. */
const MAX_LENGTH = 5000

export const procurementSubmitFreeText = onCall({ cors: PROCUREMENT_CORS_ORIGINS }, async (request) => {
  const data = request.data as Record<string, unknown>
  const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true'
  const authHeader = request.rawRequest.headers.authorization as string | undefined

  const { participantId, gameInstanceId } = await extractStudentOnCallIds(data, isEmulator, authHeader)

  const field = data.field
  if (typeof field !== 'string' || !field) {
    throw new HttpsError('invalid-argument', 'field is required.')
  }
  const raw = data.answer
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new HttpsError('invalid-argument', 'Please write a few sentences before submitting.')
  }
  const answer = raw.trim().slice(0, MAX_LENGTH)

  const db = admin.firestore()
  const instanceRef = db.collection(INSTANCES_COLLECTION).doc(gameInstanceId)
  const configSnap = await instanceRef.collection('config').doc(CONFIG_DOC).get()
  const config = loadProcurementConfig(configSnap.data(), KC_POOL_IDS, defaultVisibleFor)

  // ⚠ RESOLVED THROUGH THE SAME FUNCTION THE SERVE PATH USES, so a hidden paragraph is not
  // answerable and an overridden one validates against the text the student was actually
  // shown. ⚠ ONLY BUILT-IN free text comes here: an ADDED free-text question is `type:
  // 'text'` but is stored in `kc_static_answers` and goes to procurementSubmitKcAnswer.
  const prep = resolveBuiltIns(config, 'prep')
  const debrief = resolveBuiltIns(config, 'debrief')
  const stage = prep.some(q => q.id === field) ? 'prep'
    : debrief.some(q => q.id === field) ? 'debrief'
      : null

  if (stage === null) {
    // ⚠ ONE MESSAGE FOR THREE CASES — not in the pool, not tagged for this format, or
    // switched off. All three mean the same thing to a student, and distinguishing them
    // would tell them a question exists that they are not being asked.
    throw new HttpsError('invalid-argument', `'${field}' is not a question in this game.`)
  }

  const participantRef = instanceRef.collection(PARTICIPANTS_SUBCOLLECTION).doc(participantId)

  const stored = await db.runTransaction(async (tx) => {
    const snap = await tx.get(participantRef)
    const pData = snap.data() ?? {}

    const roundsPlayed = Array.isArray(pData.rounds) ? pData.rounds.length : 0

    if (stage === 'prep' && roundsPlayed > 0) {
      throw new HttpsError('failed-precondition',
        'That question is asked before you start bidding — you have already played a round.')
    }
    if (stage === 'debrief' && pData.finished_at == null) {
      throw new HttpsError('failed-precondition',
        'Please finish every round before answering this question.')
    }

    const existing = (pData.free_text_answers ?? {}) as Record<string, { answer?: unknown }>
    const prior = existing[field]
    if (prior != null) {
      return { answer: typeof prior.answer === 'string' ? prior.answer : answer, wasStored: true as const }
    }

    tx.set(participantRef, {
      participant_id: participantId,
      game_instance_id: gameInstanceId,
      // Nested object, not a dotted key: set({merge:true}) treats 'a.b' as a literal
      // field name. Merge deep-merges the map, so the other answers survive.
      free_text_answers: { [field]: { answer, submitted_at: FieldValue.serverTimestamp() } },
    }, { merge: true })

    return { answer, wasStored: false as const }
  })

  return { ok: true as const, field, stage, stored: stored.wasStored, answer: stored.answer }
})
