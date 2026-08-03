import { onCall } from 'firebase-functions/v2/https'
import { defineSecret } from 'firebase-functions/params'
import * as admin from 'firebase-admin'
import { FieldValue } from 'firebase-admin/firestore'
import { extractInstructorGameId, toGameResult, dispatchResults, type PushSummary } from '@mygames/game-server'
import { PROCUREMENT_CORS_ORIGINS, INSTANCES_COLLECTION, PARTICIPANTS_SUBCOLLECTION } from './config'
import { scoreClass, type ProcurementParticipantInput } from './scoring'
import { parseStoredRounds, totalProfit, roundsWon } from './rounds'

// ═══════════════════════════════════════════════════════════════════════════════
// procurementScoreAndRecord (instructor) — the class-wide pass (architecture §5.4).
// Instructor-triggered, re-runnable: it recomputes from the same stored rounds, and
// nothing here is random (the cost draws already happened and are stored), so a re-run
// is byte-identical rather than merely equivalent.
//
// ⚠ PARTICIPATION ONLY — profit and wins are NEVER graded (Part 1 §11). They are
// recomputed here for ONE purpose: refreshing the report fields the Tier-1 table shows.
// They are not passed to scoreClass — which has no parameter to receive them — and
// toGameResult drops raw_score by contract, so the payload that reaches the gradebook
// carries only normalized_score and knowledge_check_score.
//
// ⚠ THE KC IS THE ASSESSED COMPONENT of this game (Part 1 §11). It travels on its own
// field rather than being folded into the participation score, exactly as it does
// everywhere else on this platform — the classroom is what weights them.
// ═══════════════════════════════════════════════════════════════════════════════

// Procurement's own secret. See syncRoster.ts — the name must match game-locations.json.
const procurementCallbackSecret = defineSecret('PROCUREMENT_CALLBACK_SECRET')

/** Callback config: _dev override in the emulator, else deploy-time env + secret.
 *  CLASSROOM_CALLBACK_URL is project-wide (functions/.env.singleplayer-mygames-live),
 *  shared by every game in this project — only the SECRET is per game. */
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
    secret: procurementCallbackSecret.value(),
  }
}

export const procurementScoreAndRecord = onCall(
  { cors: PROCUREMENT_CORS_ORIGINS, secrets: [procurementCallbackSecret] },
  async (request) => {
    const data = request.data as Record<string, unknown>
    const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true'
    const authHeader = request.rawRequest.headers.authorization as string | undefined

    const gameInstanceId = await extractInstructorGameId(data, isEmulator, authHeader)

    const db = admin.firestore()
    const instanceRef = db.collection(INSTANCES_COLLECTION).doc(gameInstanceId)
    const participantsRef = instanceRef.collection(PARTICIPANTS_SUBCOLLECTION)
    const participantsSnap = await participantsRef.get()

    const inputs: ProcurementParticipantInput[] = []
    /** Report-only outcome figures, by participant. NOT scoring inputs. */
    const outcomes = new Map<string, { profit: number; won: number }>()

    for (const d of participantsSnap.docs) {
      const p = d.data()
      const rounds = parseStoredRounds(p.rounds)
      const kc = typeof p.knowledge_check_score === 'number' ? p.knowledge_check_score : null

      inputs.push({
        participant_id: d.id,
        finished: p.finished_at != null,
        rounds_played: rounds.length,
        knowledge_check_score: kc,
      })

      outcomes.set(d.id, { profit: totalProfit(rounds), won: roundsWon(rounds) })
    }

    const scored = scoreClass(inputs)
    const nameById = new Map(participantsSnap.docs.map(d => [d.id, (d.data().name as string | undefined) ?? null]))

    const batch = db.batch()
    for (const [pid, s] of Object.entries(scored.results)) {
      const o = outcomes.get(pid)
      batch.set(participantsRef.doc(pid), {
        raw_score: s.raw_score,
        normalized_score: s.normalized_score,
        // Written back so the report reads one place; the KC path is what SET it.
        knowledge_check_score: s.knowledge_check_score,
        rounds_played: s.rounds_played,
        // Report-only outcome fields. Never scored. Refreshed here so a re-run repairs a
        // cache that drifted; the REPORT recomputes from `rounds` anyway, so these can
        // never become a second source of truth.
        profit_total: o?.profit ?? 0,
        rounds_won: o?.won ?? 0,
        finalized_at: FieldValue.serverTimestamp(),
      }, { merge: true })
    }
    batch.set(instanceRef, { finalized: true, finalized_at: FieldValue.serverTimestamp() }, { merge: true })
    await batch.commit()

    // Push to the classroom gradebook. `roles: []` — this family has no roles, so
    // toGameResult normalizes role to null. status comes from raw_score: finishers
    // 'completed', everyone else 'no_show'.
    const { url, secret } = resolveCallbackConfig(data, isEmulator)
    let push: PushSummary | null = null
    if (url) {
      const records = Object.entries(scored.results).map(([pid, s]) =>
        toGameResult(gameInstanceId, pid, {
          raw_score: s.raw_score,
          normalized_score: s.normalized_score,
          knowledge_check_score: s.knowledge_check_score,
        }, { roles: [] }),
      )
      push = await dispatchResults(records, url, secret)
    }

    return {
      ok: true as const,
      scored: Object.keys(scored.results).length,
      finishers: scored.finishers,
      names: Object.fromEntries(nameById),
      push,
    }
  },
)
