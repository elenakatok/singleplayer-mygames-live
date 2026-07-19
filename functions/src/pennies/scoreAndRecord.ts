import { onCall } from 'firebase-functions/v2/https'
import { defineSecret } from 'firebase-functions/params'
import * as admin from 'firebase-admin'
import { FieldValue } from 'firebase-admin/firestore'
import { extractInstructorGameId, toGameResult, dispatchResults, type PushSummary } from '@mygames/game-server'
import {
  PENNIES_CORS_ORIGINS, INSTANCES_COLLECTION, PARTICIPANTS_SUBCOLLECTION,
  TRUTH_DOC, DEFAULT_TRUE_VALUE,
} from './config'
import { scoreClass, type ParticipantInput } from './scoring'

// ═══════════════════════════════════════════════════════════════════════════════
// penniesScoreAndRecord (instructor) — the class-wide pass (spec §6). Instructor-
// triggered, runs whenever they choose. IDEMPOTENT: recomputes from the same
// submissions; a prior winner is preserved across re-runs (see scoreClass). The
// only randomness is the tie-break, server-side, at score time.
//
// Grading is participation-only; PROFIT is a game outcome and is NEVER graded — the
// push carries only normalized_score (toGameResult drops raw_score by contract).
// ═══════════════════════════════════════════════════════════════════════════════

const classroomCallbackSecret = defineSecret('CLASSROOM_CALLBACK_SECRET')

/** Callback config: _dev override in the emulator, else deploy-time env + secret. */
function resolveCallbackConfig(data: Record<string, unknown>, isEmulator: boolean): { url: string; secret: string } {
  if (isEmulator) {
    const dev = (data._dev ?? {}) as Record<string, unknown>
    return {
      url: typeof dev.callback_url === 'string' ? dev.callback_url : '',
      secret: typeof dev.callback_secret === 'string' ? dev.callback_secret : '',
    }
  }
  return {
    url: process.env.CLASSROOM_CALLBACK_URL ?? '',
    secret: classroomCallbackSecret.value(),
  }
}

export const penniesScoreAndRecord = onCall(
  { cors: PENNIES_CORS_ORIGINS, secrets: [classroomCallbackSecret] },
  async (request) => {
    const data = request.data as Record<string, unknown>
    const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true'
    const authHeader = request.rawRequest.headers.authorization as string | undefined

    const gameInstanceId = await extractInstructorGameId(data, isEmulator, authHeader)

    const db = admin.firestore()
    const instanceRef = db.collection(INSTANCES_COLLECTION).doc(gameInstanceId)
    const participantsRef = instanceRef.collection(PARTICIPANTS_SUBCOLLECTION)

    // 1–2. Read this instance's participants (its own subcollection — no cross-instance
    // filter needed) + the true value (truth/main).
    const [participantsSnap, truthSnap] = await Promise.all([
      participantsRef.get(),
      instanceRef.collection('truth').doc(TRUTH_DOC).get(),
    ])
    const trueValue = (truthSnap.data()?.true_value as number | undefined) ?? DEFAULT_TRUE_VALUE

    const inputs: ParticipantInput[] = participantsSnap.docs.map(d => {
      const p = d.data()
      return {
        participant_id: d.id,
        submitted: p.submitted_at != null,
        bid: typeof p.bid === 'number' ? p.bid : null,
        priorWon: p.won === true,
      }
    })

    // 3–7. Compute winner (random tie-break, idempotency-aware), profits, grades.
    const scored = scoreClass(inputs, trueValue)

    const nameById = new Map(participantsSnap.docs.map(d => [d.id, (d.data().name as string | undefined) ?? null]))

    const batch = db.batch()
    for (const [pid, s] of Object.entries(scored.results)) {
      batch.update(participantsRef.doc(pid), {
        won: s.won,
        profit: s.profit,
        raw_score: s.raw_score,
        normalized_score: s.normalized_score,
        finalized_at: FieldValue.serverTimestamp(),
      })
    }
    batch.set(instanceRef, { finalized: true, finalized_at: FieldValue.serverTimestamp() }, { merge: true })
    await batch.commit()

    // 8. Push participation grades to the classroom gradebook (normalized_score only;
    //    toGameResult sets status from raw_score and omits it from the payload).
    const { url, secret } = resolveCallbackConfig(data, isEmulator)
    let push: PushSummary | null = null
    if (url) {
      const records = Object.entries(scored.results).map(([pid, s]) =>
        toGameResult(gameInstanceId, pid, {
          raw_score: s.raw_score,
          normalized_score: s.normalized_score,
          knowledge_check_score: null,
        }, { roles: [] }),
      )
      push = await dispatchResults(records, url, secret)
    }

    return {
      ok: true as const,
      winner: scored.winnerId,
      scored: Object.keys(scored.results).length,
      names: Object.fromEntries(nameById),
      push,
    }
  },
)
