import { onCall, HttpsError } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import { FieldValue } from 'firebase-admin/firestore'
import { extractStudentOnCallIds } from '@mygames/game-server'
import {
  SCORECARD_CORS_ORIGINS, INSTANCES_COLLECTION, PARTICIPANTS_SUBCOLLECTION,
} from './config'
import { loadInstance } from './instance'
import { scorecardDebriefQuestion } from './questions'
import { parseStoredContracts } from './state'
import { buildReveal } from './reveal'

// ═══════════════════════════════════════════════════════════════════════════════
// scorecardSubmitDebrief (student) — the free-text paragraph (spec §10), and the ONLY
// path that returns the reveal.
//
// ⚠⚠ THE REVEAL IS GATED ON THE GAME BEING OVER, CHECKED INSIDE THE TRANSACTION on the
// stored `finished_at` stamp (S3 — gates key on the stamp, never on a contract count, so
// a mid-assignment config change cannot open a gate early). A client that reordered its
// own screens still cannot reach it.
//
// ⚠ WHY THE ORDER MATTERS AT ALL (spec §10): the reveal names the treatment. Students who
// never acted on the reliability label are the most valuable data in the room, and a
// reveal shown before the paragraph would let them write an answer describing what they
// now know they should have done. The paragraph is stored FIRST, then the reveal is
// returned in the same response.
// ═══════════════════════════════════════════════════════════════════════════════

export const scorecardSubmitDebrief = onCall({ cors: SCORECARD_CORS_ORIGINS }, async (request) => {
  const data = request.data as Record<string, unknown>
  const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true'
  const authHeader = request.rawRequest.headers.authorization as string | undefined

  const { participantId, gameInstanceId } = await extractStudentOnCallIds(data, isEmulator, authHeader)

  const answer = data.answer
  if (typeof answer !== 'string' || answer.trim().length === 0) {
    throw new HttpsError('invalid-argument', 'Please write an answer before submitting.')
  }

  const db = admin.firestore()
  const { config, truth } = await loadInstance(db, gameInstanceId)
  const question = scorecardDebriefQuestion(config)

  const participantRef = db
    .collection(INSTANCES_COLLECTION).doc(gameInstanceId)
    .collection(PARTICIPANTS_SUBCOLLECTION).doc(participantId)

  const stored = await db.runTransaction(async (tx) => {
    const snap = await tx.get(participantRef)
    const pData = snap.data() ?? {}

    // ⚠ THE GATE (S3). On the STAMP, not on a count.
    if (pData.finished_at == null) {
      throw new HttpsError('failed-precondition',
        `Please finish every ${config.contractNoun} before answering this question.`)
    }

    const existing = (pData.free_text_answers ?? {}) as Record<string, { answer?: unknown }>
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

  const contracts = parseStoredContracts(stored.pData.contracts, config)

  // ⚠ THE CLASS AVERAGE IS THE COMPARATOR NOW (spec §10, 08-07) — not the DP. That means
  // reading the whole participant collection, which is the one place a student callable
  // in this game touches other students' documents. It is safe because nothing
  // per-student escapes: `buildReveal` reduces the population to two aggregate curves
  // before it returns, and the response type has no per-participant field to put an id
  // in. ⚠ Keep it that way — an aggregate that carried its own inputs would be a roster
  // leak dressed as a chart.
  const popSnap = await db
    .collection(INSTANCES_COLLECTION).doc(gameInstanceId)
    .collection(PARTICIPANTS_SUBCOLLECTION)
    .get()
  const population = popSnap.docs.map(d => ({
    participantId: d.id,
    contracts: parseStoredContracts(d.data().contracts, config),
  }))

  return {
    ok: true as const,
    questionId: question.id,
    stored: stored.wasStored,
    answer: stored.answer,
    /**
     * ⚠⚠ THE REVEAL (spec §10). The only student payload in this build that names the
     * treatment or carries both conditions. Reachable only past the gate above.
     *
     * ⚠ IT CARRIES NO DP (decided 08-07). Their two curves against each other and against
     * the class — never against an optimal policy. See reveal.ts.
     */
    reveal: buildReveal(contracts, population, config, truth),
  }
})
