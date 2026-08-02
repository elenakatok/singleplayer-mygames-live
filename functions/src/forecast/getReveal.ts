import { onCall, HttpsError } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import { extractStudentOnCallIds } from '@mygames/game-server'
import { FORECAST_CORS_ORIGINS, INSTANCES_COLLECTION, PARTICIPANTS_SUBCOLLECTION } from './config'
import { loadInstance } from './instance'
import { parseStoredRounds } from './rounds'
import { revealGate, buildReveal } from './reveal'

// ═══════════════════════════════════════════════════════════════════════════════
// forecastGetReveal (student) — re-reads the debrief reveal (spec §9) for a student
// who has already earned it.
//
// ⚠ WHY THIS EXISTS AT ALL. forecastSubmitDebrief returns the reveal on the
// transition, which covers the normal path. But spec §4 promises the game is
// "self-paced, closeable, resumable", and spec §9 calls the reveal "the highest-value
// screen in the game" — so a student who closes the tab after submitting and comes back
// must be able to see it again. Without this they would return to a finished game with
// the one screen that explains it now unreachable.
//
// ⚠⚠ IT IS THE SAME GATE, NOT A SECOND ONE. This is a READ path to the answer key, so
// it is precisely the endpoint an early-reveal bug would come through. It calls
// `revealGate` (reveal.ts) — the identical function forecastSubmitDebrief calls — so
// there is exactly one definition of when the model may be handed to a student, and
// widening one path cannot silently fail to widen the other. The harness drives this
// callable at every stage of the flow and requires it to REFUSE until the debrief is
// behind the student.
//
// No write, no side effect: a student may call it as often as they like once earned.
// ═══════════════════════════════════════════════════════════════════════════════

export const forecastGetReveal = onCall({ cors: FORECAST_CORS_ORIGINS }, async (request) => {
  const data = request.data as Record<string, unknown>
  const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true'
  const authHeader = request.rawRequest.headers.authorization as string | undefined

  const { participantId, gameInstanceId } = await extractStudentOnCallIds(data, isEmulator, authHeader)

  const db = admin.firestore()
  const { config, model, history } = await loadInstance(db, gameInstanceId)

  const snap = await db
    .collection(INSTANCES_COLLECTION).doc(gameInstanceId)
    .collection(PARTICIPANTS_SUBCOLLECTION).doc(participantId)
    .get()
  const pData = snap.data() ?? {}

  // ⚠ THE GATE. Nothing below this line runs for a student who has not earned it — and
  // note that the refusal happens BEFORE buildReveal is called, so the payload is never
  // even constructed on the failing path.
  const gate = revealGate(pData, config)
  if (!gate.allowed) throw new HttpsError('failed-precondition', gate.reason)

  return {
    ok: true as const,
    reveal: buildReveal(model, config, history, parseStoredRounds(pData.rounds)),
  }
})
