import { onCall, HttpsError } from 'firebase-functions/v2/https'
import { defineSecret } from 'firebase-functions/params'
import * as admin from 'firebase-admin'
import { extractInstructorGameId } from '@mygames/game-server'
import { PROCUREMENT_CORS_ORIGINS, INSTANCES_COLLECTION, PARTICIPANTS_SUBCOLLECTION } from './config'

// ═══════════════════════════════════════════════════════════════════════════════
// procurementSyncRoster (instructor) — pulls the course roster from the classroom and
// pre-creates a participant doc for every enrolled student, so the dashboard shows who
// HASN'T played and procurementScoreAndRecord can grade never-launched students −2.
// Mirrors forecastSyncRoster exactly, with procurement's secret and collections.
//
// SAFE MERGE: writes ONLY identity fields ({participant_id, game_instance_id, name,
// external_id}). It never writes rounds / finished_at / kc_static_answers, so it can
// never clobber a student mid-game — no per-doc read needed. A never-launched student
// ends up with a doc carrying no finished_at, which is exactly the −2 path in scoring.ts.
//
// CLASSROOM_ROSTER_URL is project-wide (functions/.env.singleplayer-mygames-live) and is
// already set for this project — only the SECRET is per game.
// ═══════════════════════════════════════════════════════════════════════════════

// ⚠ PROCUREMENT'S OWN SECRET. Per-game, never shared: in this seven-game project it is
// what stops provisioning one game from rotating another's. The name here MUST match
// `gameSecretName` in scripts/game-locations.json — if the two disagree,
// spawn-secret.sh writes one name while the deployed function binds another and every
// callback 403s behind a deploy that reported success.
const procurementCallbackSecret = defineSecret('PROCUREMENT_CALLBACK_SECRET')

function resolveRosterConfig(data: Record<string, unknown>, isEmulator: boolean): { url: string; secret: string } {
  if (isEmulator) {
    const dev = (data._dev ?? {}) as Record<string, unknown>
    return {
      url: typeof dev.roster_url === 'string' ? dev.roster_url : '',
      secret: typeof dev.callback_secret === 'string' ? dev.callback_secret : '',
    }
  }
  return {
    url: process.env.CLASSROOM_ROSTER_URL ?? '',
    secret: procurementCallbackSecret.value(),
  }
}

type RosterEntry = { participant_id: string; name: string; external_id: string | null }

export const procurementSyncRoster = onCall(
  { cors: PROCUREMENT_CORS_ORIGINS, secrets: [procurementCallbackSecret] },
  async (request) => {
    const data = request.data as Record<string, unknown>
    const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true'
    const authHeader = request.rawRequest.headers.authorization as string | undefined

    const gameInstanceId = await extractInstructorGameId(data, isEmulator, authHeader)

    const { url, secret } = resolveRosterConfig(data, isEmulator)
    // Standalone / no classroom configured — no-op rather than error.
    if (!url) return { ok: true as const, synced: 0, note: 'no roster url configured' }

    let participants: RosterEntry[]
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret.trim()}` },
        body: JSON.stringify({ game_instance_id: gameInstanceId }),
      })
      if (!res.ok) {
        const body = await res.text()
        throw new HttpsError('internal', `Roster fetch failed (${res.status}): ${body.slice(0, 200)}`)
      }
      const json = (await res.json()) as { participants?: RosterEntry[] }
      participants = Array.isArray(json.participants) ? json.participants : []
    } catch (err) {
      if (err instanceof HttpsError) throw err
      throw new HttpsError('internal', err instanceof Error ? err.message : 'Roster fetch failed.')
    }

    const db = admin.firestore()
    const participantsRef = db
      .collection(INSTANCES_COLLECTION).doc(gameInstanceId)
      .collection(PARTICIPANTS_SUBCOLLECTION)
    const batch = db.batch()
    for (const p of participants) {
      if (!p.participant_id) continue
      batch.set(participantsRef.doc(p.participant_id), {
        participant_id: p.participant_id,
        game_instance_id: gameInstanceId,
        name: p.name ?? null,
        external_id: p.external_id ?? null,
      }, { merge: true })
    }
    await batch.commit()

    return { ok: true as const, synced: participants.length }
  },
)
