import { onCall, HttpsError } from 'firebase-functions/v2/https'
import { defineSecret } from 'firebase-functions/params'
import * as admin from 'firebase-admin'
import { extractInstructorGameId } from '@mygames/game-server'
import { POLL_CORS_ORIGINS, PARTICIPANTS_COLLECTION } from './config'

// ═══════════════════════════════════════════════════════════════════════════════
// pollSyncRoster (instructor) — pulls the full course roster from the classroom so the
// dashboard's response-status view (spec §7.3) shows who has and hasn't responded.
//
// ⚠ The poll is ENTIRELY UNGRADED (spec §6). This writes ONLY identity fields
// ({participant_id, game_instance_id, name, external_id}) via merge — it never writes
// or pushes any score, and there is no gradebook callback anywhere in poll. It only
// pre-creates poll_participants docs so non-responders are visible. Safe merge: it
// never touches a responder's `answers`/`completed_at`.
// ═══════════════════════════════════════════════════════════════════════════════

const classroomCallbackSecret = defineSecret('CLASSROOM_CALLBACK_SECRET')

function resolveRosterConfig(data: Record<string, unknown>, isEmulator: boolean): { url: string; secret: string } {
  if (isEmulator) {
    const dev = (data._dev ?? {}) as Record<string, unknown>
    return {
      url: typeof dev.roster_url === 'string' ? dev.roster_url : '',
      secret: typeof dev.callback_secret === 'string' ? dev.callback_secret : '',
    }
  }
  return { url: process.env.CLASSROOM_ROSTER_URL ?? '', secret: classroomCallbackSecret.value() }
}

type RosterEntry = { participant_id: string; name: string; external_id: string | null }

export const pollSyncRoster = onCall(
  { cors: POLL_CORS_ORIGINS, secrets: [classroomCallbackSecret] },
  async (request) => {
    const data = request.data as Record<string, unknown>
    const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true'
    const authHeader = request.rawRequest.headers.authorization as string | undefined

    const gameInstanceId = await extractInstructorGameId(data, isEmulator, authHeader)

    const { url, secret } = resolveRosterConfig(data, isEmulator)
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
    const batch = db.batch()
    for (const p of participants) {
      if (!p.participant_id) continue
      batch.set(
        db.collection(PARTICIPANTS_COLLECTION).doc(p.participant_id),
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
