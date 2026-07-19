import { onCall, HttpsError } from 'firebase-functions/v2/https'
import { defineSecret } from 'firebase-functions/params'
import * as admin from 'firebase-admin'
import { extractInstructorGameId } from '@mygames/game-server'
import { PENNIES_CORS_ORIGINS, INSTANCES_COLLECTION, PARTICIPANTS_SUBCOLLECTION } from './config'

// ═══════════════════════════════════════════════════════════════════════════════
// penniesSyncRoster (instructor) — pulls the full course roster from the classroom
// and pre-creates a pennies_participants doc for every enrolled student, so the
// dashboard shows who HASN'T played and Score & Record can grade never-launched
// students −2 (spec §7). Matches the shared makeSyncRoster contract, adapted to
// pennies' TOP-LEVEL pennies_participants collection.
//
// SAFE MERGE: writes ONLY identity fields ({participant_id, game_instance_id, name,
// external_id}) via merge. It never writes submitted_at / bid / launched_at, so it
// can never clobber a student who already launched or submitted — no per-doc read
// needed. A never-launched student ends up with a doc that has no launched_at and no
// submitted_at (→ graded −2 by the existing scoreClass non-submitter path).
//
// Classroom auth mirrors makeSyncRoster: POST CLASSROOM_ROSTER_URL with
// `Authorization: Bearer <CLASSROOM_CALLBACK_SECRET>` and body { game_instance_id }.
// ═══════════════════════════════════════════════════════════════════════════════

const classroomCallbackSecret = defineSecret('CLASSROOM_CALLBACK_SECRET')

interface RosterConfig { url: string; secret: string }

function resolveRosterConfig(data: Record<string, unknown>, isEmulator: boolean): RosterConfig {
  if (isEmulator) {
    const dev = (data._dev ?? {}) as Record<string, unknown>
    return {
      url: typeof dev.roster_url === 'string' ? dev.roster_url : '',
      secret: typeof dev.callback_secret === 'string' ? dev.callback_secret : '',
    }
  }
  return {
    url: process.env.CLASSROOM_ROSTER_URL ?? '',
    secret: classroomCallbackSecret.value(),
  }
}

type RosterEntry = { participant_id: string; name: string; external_id: string | null }

export const penniesSyncRoster = onCall(
  { cors: PENNIES_CORS_ORIGINS, secrets: [classroomCallbackSecret] },
  async (request) => {
    const data = request.data as Record<string, unknown>
    const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true'
    const authHeader = request.rawRequest.headers.authorization as string | undefined

    const gameInstanceId = await extractInstructorGameId(data, isEmulator, authHeader)

    const { url, secret } = resolveRosterConfig(data, isEmulator)
    // Standalone / no classroom configured — no-op rather than error (dashboard still works).
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
      batch.set(
        participantsRef.doc(p.participant_id),
        {
          participant_id: p.participant_id,
          game_instance_id: gameInstanceId,
          name: p.name ?? null,
          external_id: p.external_id ?? null,
        },
        { merge: true },
      )
    }
    await batch.commit()

    return { ok: true as const, synced: participants.length }
  },
)
