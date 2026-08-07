import { onCall } from 'firebase-functions/v2/https'
import { defineSecret } from 'firebase-functions/params'
import * as admin from 'firebase-admin'
import { FieldValue } from 'firebase-admin/firestore'
import { extractInstructorGameId, toGameResult, dispatchResults, type PushSummary } from '@mygames/game-server'
import { SCORECARD_CORS_ORIGINS, INSTANCES_COLLECTION, PARTICIPANTS_SUBCOLLECTION } from './config'
import { scoreClass, type ScorecardParticipantInput } from './scoring'
import { parseStoredContracts } from './state'
import { loadInstance } from './instance'
import { effortGap, highEffortRate, contractsIn } from './stats'

// ═══════════════════════════════════════════════════════════════════════════════
// scorecardScoreAndRecord (instructor) — the class-wide pass (architecture §5.4).
// Instructor-triggered, re-runnable: it recomputes from the same stored months, and
// nothing here is random (the demand draws already happened and are stored), so a
// re-run is byte-identical rather than merely equivalent.
//
// ⚠⚠ PARTICIPATION ONLY, AND HERE IT IS A CORRECTNESS REQUIREMENT (spec §7). Earnings
// and the effort gap are recomputed here for ONE purpose: refreshing the report cache the
// Tier-1 table reads. Neither is passed to `scoreClass` — which has no parameter to
// receive them — and `toGameResult` drops raw_score by contract, so the payload reaching
// the gradebook carries only normalized_score and knowledge_check_score.
//
// Why the rule bites harder in THIS game than anywhere else: a student who plays
// CORRECTLY under low reliability earns LESS than one who works flat out and gets lucky.
// Grading earnings would grade the treatment and punish the lesson. Grading the effort
// gap would be worse — it would give students a reason to manufacture the gap rather than
// reason about it, destroying the measurement the design exists to take. See scoring.ts.
//
// ⚠ THE KC IS THE ASSESSED COMPONENT of this game (spec §9). It travels on its own field
// rather than being folded into participation, exactly as everywhere else on this
// platform — the classroom is what weights them.
// ═══════════════════════════════════════════════════════════════════════════════

// Scorecard's own secret. Per-game, never shared: a game is deployed, rotated and
// revoked on its own. In the shared single-player project this is what stops
// provisioning one game from rotating another's secret.
const scorecardCallbackSecret = defineSecret('SCORECARD_CALLBACK_SECRET')

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
    secret: scorecardCallbackSecret.value(),
  }
}

export const scorecardScoreAndRecord = onCall(
  { cors: SCORECARD_CORS_ORIGINS, secrets: [scorecardCallbackSecret] },
  async (request) => {
    const data = request.data as Record<string, unknown>
    const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true'
    const authHeader = request.rawRequest.headers.authorization as string | undefined

    const gameInstanceId = await extractInstructorGameId(data, isEmulator, authHeader)

    const db = admin.firestore()
    const instanceRef = db.collection(INSTANCES_COLLECTION).doc(gameInstanceId)
    const participantsRef = instanceRef.collection(PARTICIPANTS_SUBCOLLECTION)
    const participantsSnap = await participantsRef.get()

    const { config } = await loadInstance(db, gameInstanceId)

    const inputs: ScorecardParticipantInput[] = []
    /** Report-only cache fields, by participant. NOT scoring inputs. */
    const outcomes = new Map<string, {
      contractsCompleted: number
      effortGap: number | null
      rateHigh: number | null
      rateLow: number | null
    }>()

    for (const d of participantsSnap.docs) {
      const p = d.data()
      const contracts = parseStoredContracts(p.contracts, config)
      const completed = contracts.filter(c => c.periods.length >= config.periodsPerContract).length
      const kc = typeof p.knowledge_check_score === 'number' ? p.knowledge_check_score : null

      inputs.push({
        participant_id: d.id,
        finished: p.finished_at != null,
        contracts_completed: completed,
        knowledge_check_score: kc,
      })

      outcomes.set(d.id, {
        contractsCompleted: completed,
        effortGap: effortGap(contracts, config),
        rateHigh: highEffortRate(contractsIn(contracts, 'high', config)),
        rateLow: highEffortRate(contractsIn(contracts, 'low', config)),
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
        contracts_completed: s.contracts_completed,
        // Report-only cache (spec §11). NEVER scored — see scoring.ts on why grading
        // earnings or the effort gap would be wrong here. The REPORT recomputes all of
        // these from `contracts` anyway (stats.ts), so this can never become a second
        // source of truth; it is refreshed so a drifted cache is repaired by a re-run.
        effort_gap: o?.effortGap ?? null,
        high_effort_rate_high: o?.rateHigh ?? null,
        high_effort_rate_low: o?.rateLow ?? null,
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
