import { onCall, HttpsError } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import { FieldValue } from 'firebase-admin/firestore'
import { extractStudentOnCallIds } from '@mygames/game-server'
import {
  SCORECARD_CORS_ORIGINS, INSTANCES_COLLECTION, PARTICIPANTS_SUBCOLLECTION,
} from './config'
import { loadInstance } from './instance'
import { noticingQuestion, linkingQuestion } from './questions'
import { parseStoredContracts } from './state'
import { buildReveal, humanPopulation } from './reveal'
import { isBot } from './botFilter'

// ═══════════════════════════════════════════════════════════════════════════════
// scorecardSubmitDebrief (student) — §10's THREE ORDERED STEPS, and the only path that
// returns the reveal.
//
//   step 'noticing'  → stores the answer, THEN returns the reveal
//   step 'linking'   → stores the answer. Refused until 'noticing' is stored.
//
// ⚠⚠ THE ORDER IS LOAD-BEARING AND IS ENFORCED SERVER-SIDE, not by screen sequence. Step 1
// must be captured BEFORE the student sees any result: students who never acted on the
// reliability label are the most valuable data in the room, and letting them answer after
// seeing their own two curves would let them retrofit a story. A client that reordered its
// own screens still cannot reach the reveal without first committing a noticing answer.
//
// ⚠ Both steps are gated on the stored `finished_at` stamp (S3 — gates key on the stamp,
// never on a contract count, so a mid-assignment config change cannot open one early).
//
// ⚠ THE LINKING ANSWER IS NOT SCORED IN THE GAME (spec §10). Elena grades it offline,
// which is why the Tier-2 export carries each student's own per-condition figures beside
// the text (§11).
// ═══════════════════════════════════════════════════════════════════════════════

export const scorecardSubmitDebrief = onCall({ cors: SCORECARD_CORS_ORIGINS }, async (request) => {
  const data = request.data as Record<string, unknown>
  const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true'
  const authHeader = request.rawRequest.headers.authorization as string | undefined

  const { participantId, gameInstanceId } = await extractStudentOnCallIds(data, isEmulator, authHeader)

  const step = data.step
  if (step !== 'noticing' && step !== 'linking') {
    throw new HttpsError('invalid-argument', 'step must be "noticing" or "linking".')
  }
  const answer = data.answer
  if (typeof answer !== 'string' || answer.trim().length === 0) {
    throw new HttpsError('invalid-argument', 'Please write an answer before submitting.')
  }

  const db = admin.firestore()
  const { config, truth } = await loadInstance(db, gameInstanceId)
  const question = step === 'noticing' ? noticingQuestion(config) : linkingQuestion(config)

  const participantRef = db
    .collection(INSTANCES_COLLECTION).doc(gameInstanceId)
    .collection(PARTICIPANTS_SUBCOLLECTION).doc(participantId)

  const stored = await db.runTransaction(async (tx) => {
    const snap = await tx.get(participantRef)
    const pData = snap.data() ?? {}

    // ⚠ THE FINISH GATE (S3). On the STAMP, not on a count.
    if (pData.finished_at == null) {
      throw new HttpsError('failed-precondition',
        `Please finish every ${config.contractNoun} before answering this question.`)
    }

    const existing = (pData.free_text_answers ?? {}) as Record<string, { answer?: unknown }>

    // ⚠⚠ THE ORDER GATE. `linking` asks the student to look at curves they can only have
    // seen by submitting `noticing` first. Enforced here so screen order is not the
    // control.
    if (step === 'linking' && existing.noticing == null) {
      throw new HttpsError('failed-precondition',
        'Please answer the first question before this one.')
    }

    const prior = existing[question.id]
    if (prior != null) {
      return {
        answer: typeof prior.answer === 'string' ? prior.answer : answer,
        wasStored: true as const,
        pData,
      }
    }

    tx.set(participantRef, {
      participant_id: participantId,
      game_instance_id: gameInstanceId,
      free_text_answers: {
        [question.id]: { answer, submitted_at: FieldValue.serverTimestamp() },
      },
    }, { merge: true })

    return { answer, wasStored: false as const, pData }
  })

  // ── The reveal — returned by the NOTICING step only (spec §10 step 2) ─────
  let reveal = null
  if (step === 'noticing') {
    // ⚠⚠ THE CLASS AVERAGE IS HUMANS-ONLY, ALWAYS, WITH NO DEMO FALLBACK (spec §11,
    // 08-07). A student must never be compared against robots — and unlike the
    // instructor charts, there is no banner here that could tell them they were.
    const popSnap = await db
      .collection(INSTANCES_COLLECTION).doc(gameInstanceId)
      .collection(PARTICIPANTS_SUBCOLLECTION)
      .get()
    const population = humanPopulation(
      popSnap.docs.map(d => ({ id: d.id, data: d.data() })),
      (id, d) => isBot(id, d),
      config,
      parseStoredContracts,
    )
    const contracts = parseStoredContracts(stored.pData.contracts, config)
    reveal = buildReveal(contracts, population, config, truth)
  }

  return {
    ok: true as const,
    step,
    questionId: question.id,
    stored: stored.wasStored,
    answer: stored.answer,
    /**
     * ⚠⚠ THE REVEAL (spec §10 step 2). The only student payload that names the treatment.
     * Present ONLY on the noticing step — which is what makes the ordering physical rather
     * than conventional. Null on `linking`, by which point the student has already seen it.
     *
     * ⚠ It carries no DP (decided 08-07): their two curves against each other and against
     * the class, never against an optimal policy.
     */
    reveal,
  }
})
