import { onCall } from 'firebase-functions/v2/https'
import { defineSecret } from 'firebase-functions/params'
import * as admin from 'firebase-admin'
import { FieldValue } from 'firebase-admin/firestore'
import { extractInstructorGameId, toGameResult, dispatchResults, type PushSummary } from '@mygames/game-server'
import { FORECAST_CORS_ORIGINS, INSTANCES_COLLECTION, PARTICIPANTS_SUBCOLLECTION } from './config'
import { scoreClass, type ForecastParticipantInput } from './scoring'
import { parseStoredRounds, toPoints } from './rounds'
import { runningMetrics } from './metrics'

// ═══════════════════════════════════════════════════════════════════════════════
// forecastScoreAndRecord (instructor) — the class-wide pass (architecture §5.4).
// Instructor-triggered, re-runnable: it recomputes from the same stored months, and
// nothing here is random (the demand draws already happened and are stored), so a
// re-run is byte-identical rather than merely equivalent.
//
// ⚠ PARTICIPATION ONLY — MSE, MAE, MAPE and the bonus are NEVER graded (spec §6). They
// are recomputed here for ONE purpose: refreshing the report fields the Tier-1 table
// shows. They are not passed to scoreClass — which has no parameter to receive them —
// and toGameResult drops raw_score by contract, so the payload that reaches the
// gradebook carries only normalized_score and knowledge_check_score.
//
// ⚠ THE KC IS THE ASSESSED COMPONENT of this game (spec §8). It still travels on its
// own field rather than being folded into the participation score, exactly as it does
// everywhere else on this platform — the classroom is what weights them.
// ═══════════════════════════════════════════════════════════════════════════════

// Forecast's own secret. Per-game, never shared: a game is deployed, rotated and
// revoked on its own. In the shared single-player project this is what stops
// provisioning one game from rotating another's secret.
const forecastCallbackSecret = defineSecret('FORECAST_CALLBACK_SECRET')

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
    secret: forecastCallbackSecret.value(),
  }
}

export const forecastScoreAndRecord = onCall(
  { cors: FORECAST_CORS_ORIGINS, secrets: [forecastCallbackSecret] },
  async (request) => {
    const data = request.data as Record<string, unknown>
    const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true'
    const authHeader = request.rawRequest.headers.authorization as string | undefined

    const gameInstanceId = await extractInstructorGameId(data, isEmulator, authHeader)

    const db = admin.firestore()
    const instanceRef = db.collection(INSTANCES_COLLECTION).doc(gameInstanceId)
    const participantsRef = instanceRef.collection(PARTICIPANTS_SUBCOLLECTION)
    const participantsSnap = await participantsRef.get()

    const inputs: ForecastParticipantInput[] = []
    /** Report-only outcome figures, by participant. NOT scoring inputs. */
    const outcomes = new Map<string, {
      mse: number | null
      mae: number | null
      mape: number | null
      meanError: number | null
    }>()

    for (const d of participantsSnap.docs) {
      const p = d.data()
      const rounds = parseStoredRounds(p.rounds)
      const points = toPoints(rounds)
      const kc = typeof p.knowledge_check_score === 'number' ? p.knowledge_check_score : null

      inputs.push({
        participant_id: d.id,
        finished: p.finished_at != null,
        months_played: rounds.length,
        knowledge_check_score: kc,
      })

      const r = points.length > 0 ? runningMetrics(points) : null
      outcomes.set(d.id, {
        mse: r?.mse ?? null,
        mae: r?.mae ?? null,
        mape: r?.mape ?? null,
        meanError: r?.meanError ?? null,
      })
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
        rounds_played: s.months_played,
        // Report-only outcome fields (spec §10). Never scored. Refreshed here so a
        // re-run repairs a cache that drifted; the REPORT recomputes from `rounds`
        // anyway (reportStats.ts), so these can never become a second source of truth.
        mse: o?.mse ?? null,
        mae: o?.mae ?? null,
        mape: o?.mape ?? null,
        mean_error: o?.meanError ?? null,
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
