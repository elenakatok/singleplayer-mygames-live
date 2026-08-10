import { onCall, HttpsError } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import { FieldValue } from 'firebase-admin/firestore'
import { extractStudentOnCallIds } from '@mygames/game-server'
import { FORECAST_CORS_ORIGINS, INSTANCES_COLLECTION, PARTICIPANTS_SUBCOLLECTION } from './config'
import { loadInstance } from './instance'
import { parseStoredRounds } from './rounds'
import { debriefQuestion } from './questions'
import { revealGate, buildReveal, unansweredPostRows } from './reveal'

// ═══════════════════════════════════════════════════════════════════════════════
// forecastSubmitDebrief (student) — the single open-ended paragraph (spec §9),
// UNGRADED, and the transition that REVEALS THE PROCESS.
//
// ⚠⚠ THE ORDER IS THE POINT, AND IT IS ENFORCED SERVER-SIDE. The paragraph is stored
// BEFORE the reveal is built, in that order, inside one transaction — so a student
// cannot read how demand was generated and then describe a method they did not use.
// Spec §9 asks them to say how they ACTUALLY forecast; a reveal available first would
// turn every answer into a description of the right answer.
//
// The game must also already be OVER. That is not checked here in its own words — it
// is `revealGate` (reveal.ts), the same function forecastGetReveal calls, so the two
// paths cannot drift on when the model may be handed over.
//
// ⚠⚠ THE DEBRIEF IS NO LONGER NECESSARILY THE LAST QUESTION. It is now one ROW in the
// after-play stage, and an instructor may add others beside it. The gate is on the WHOLE
// stage, so answering the paragraph while another after-play question is outstanding
// stores the answer and returns `reveal: null` — it does NOT throw. Throwing would report a
// write that actually succeeded as a failure, and a retry would hit the one-shot branch and
// throw again. The client renders the remaining rows and asks for the reveal afterwards.
//
// Ungraded BY CONSTRUCTION: the question carries no `grading` and no `correct_value`
// (questions.ts), so it cannot enter calcKCScore's denominator, and this callable never
// touches knowledge_check_score.
//
// One-shot, like every other submit in the family: an existing answer is returned
// rather than overwritten. ⚠ A repeat call still returns the REVEAL — deliberately, so
// a student who double-submits or whose connection drops mid-transition is not locked
// out of the screen the whole debrief exists for.
// ═══════════════════════════════════════════════════════════════════════════════

/** Bound so a runaway paste cannot push the participant doc toward the 1 MiB limit. */
const MAX_LENGTH = 5000

export const forecastSubmitDebrief = onCall({ cors: FORECAST_CORS_ORIGINS }, async (request) => {
  const data = request.data as Record<string, unknown>
  const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true'
  const authHeader = request.rawRequest.headers.authorization as string | undefined

  const { participantId, gameInstanceId } = await extractStudentOnCallIds(data, isEmulator, authHeader)

  const raw = data.answer
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new HttpsError('invalid-argument', 'Please write a few sentences before submitting.')
  }
  const answer = raw.trim().slice(0, MAX_LENGTH)

  const db = admin.firestore()
  const { config, model, history } = await loadInstance(db, gameInstanceId)

  if (!config.debriefEnabled) {
    throw new HttpsError('failed-precondition', 'That question is not part of this game.')
  }

  const participantRef = db
    .collection(INSTANCES_COLLECTION).doc(gameInstanceId)
    .collection(PARTICIPANTS_SUBCOLLECTION).doc(participantId)

  const stored = await db.runTransaction(async (tx) => {
    const snap = await tx.get(participantRef)
    const pData = snap.data() ?? {}

    // ⚠ THE GAME MUST BE OVER BEFORE THE PARAGRAPH IS EVEN ACCEPTED. Checked on the
    // stored finish stamp, inside the transaction, so a client that reordered its own
    // screens still cannot reach the reveal early.
    if (pData.finished_at == null) {
      throw new HttpsError('failed-precondition',
        'Please finish forecasting every month before answering this question.')
    }

    const existing = (pData.free_text_answers ?? {}) as Record<string, { answer?: unknown }>
    const prior = existing[debriefQuestion.field]
    if (prior != null) {
      return {
        answer: typeof prior.answer === 'string' ? prior.answer : answer,
        wasStored: true as const,
        rounds: parseStoredRounds(pData.rounds),
        pData: { ...pData },
      }
    }

    tx.set(participantRef, {
      participant_id: participantId,
      game_instance_id: gameInstanceId,
      free_text_answers: { [debriefQuestion.field]: { answer, submitted_at: FieldValue.serverTimestamp() } },
    }, { merge: true })

    return {
      answer,
      wasStored: false as const,
      rounds: parseStoredRounds(pData.rounds),
      // The doc AS IT WILL BE once this write lands — the gate below asks whether the
      // debrief is answered, and it now is.
      pData: { ...pData, free_text_answers: { ...existing, [debriefQuestion.field]: { answer } } },
    }
  })

  // ⚠ THE GATE, AFTER THE WRITE. The transaction already refused an unfinished game; this
  // re-asks the SHARED question, so any future change to what "the after-play stage has
  // been completed" means applies to this path automatically.
  const gate = revealGate(stored.pData, config)

  return {
    ok: true as const,
    field: debriefQuestion.field,
    stored: stored.wasStored,
    answer: stored.answer,
    /** ⚠ THE PROCESS (spec §9). The only student payload in this build that carries the
     *  model, and it is built ONLY past the gate — null while the stage is outstanding.
     *  There is no branch here that produces it any other way. */
    reveal: gate.allowed ? buildReveal(model, config, history, stored.rounds) : null,
    /** Why the reveal is withheld, and which rows are still outstanding — so the client
     *  renders the same list the gate is refusing on rather than guessing. */
    revealPending: gate.allowed ? null : gate.reason,
    pendingFields: gate.allowed ? [] : unansweredPostRows(config, stored.pData).map(r => r.field),
  }
})
