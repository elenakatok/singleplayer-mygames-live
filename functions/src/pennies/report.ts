import { onCall } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import { extractInstructorGameId } from '@mygames/game-server'
import {
  PENNIES_CORS_ORIGINS, INSTANCES_COLLECTION, PARTICIPANTS_COLLECTION,
  TRUTH_DOC, DEFAULT_TRUE_VALUE,
} from './config'

// ═══════════════════════════════════════════════════════════════════════════════
// penniesGetReport (instructor) — the single instructor-facing data source, feeding
// BOTH the dashboard roster and the two reports (spec §8). Instructor-authenticated,
// so it may include true_value; this data NEVER reaches a student (no student path
// calls it). Before Score & Record, won/profit are null and `scored` is false — the
// UI shows a "not yet scored" state rather than a broken chart.
// ═══════════════════════════════════════════════════════════════════════════════

export interface ReportParticipant {
  participant_id: string
  name: string | null
  submitted: boolean
  estimate: number | null
  bid: number | null
  won: boolean | null
  profit: number | null
}

export const penniesGetReport = onCall({ cors: PENNIES_CORS_ORIGINS }, async (request) => {
  const data = request.data as Record<string, unknown>
  const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true'
  const authHeader = request.rawRequest.headers.authorization as string | undefined

  const gameInstanceId = await extractInstructorGameId(data, isEmulator, authHeader)

  const db = admin.firestore()
  const instanceRef = db.collection(INSTANCES_COLLECTION).doc(gameInstanceId)

  const [participantsSnap, truthSnap, instanceSnap] = await Promise.all([
    db.collection(PARTICIPANTS_COLLECTION).where('game_instance_id', '==', gameInstanceId).get(),
    instanceRef.collection('truth').doc(TRUTH_DOC).get(),
    instanceRef.get(),
  ])

  const trueValue = (truthSnap.data()?.true_value as number | undefined) ?? DEFAULT_TRUE_VALUE
  const scored = instanceSnap.data()?.finalized === true

  const participants: ReportParticipant[] = participantsSnap.docs.map(d => {
    const p = d.data()
    return {
      participant_id: d.id,
      name: (p.name as string | undefined) ?? null,
      submitted: p.submitted_at != null,
      estimate: typeof p.estimate === 'number' ? p.estimate : null,
      bid: typeof p.bid === 'number' ? p.bid : null,
      won: typeof p.won === 'boolean' ? p.won : null,
      profit: typeof p.profit === 'number' ? p.profit : null,
    }
  })

  // Stats over submitters (spec §8.2 Report 1).
  const submitters = participants.filter(p => p.submitted && p.bid != null)
  const responses = submitters.length
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0)
  const avgEstimate = responses > 0 ? sum(submitters.map(p => p.estimate ?? 0)) / responses : null
  const avgBid = responses > 0 ? sum(submitters.map(p => p.bid as number)) / responses : null
  const winningBid = responses > 0 ? Math.max(...submitters.map(p => p.bid as number)) : null

  return {
    ok: true as const,
    scored,
    true_value: trueValue,
    participants,
    stats: { responses, avgEstimate, avgBid, winningBid },
  }
})
