import { onCall } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import { extractInstructorGameId } from '@mygames/game-server'
import {
  PENNIES_CORS_ORIGINS, INSTANCES_COLLECTION, PARTICIPANTS_SUBCOLLECTION,
  TRUTH_DOC, CONFIG_DOC, DEFAULT_TRUE_VALUE, DEFAULT_REVERSE, DEFAULT_PENNY_VALUE,
  DEFAULT_PENNY_COUNT, resolveTrueValue,
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
  /** Did the student actually open the game (penniesBootstrap stamped launched_at)? */
  launched: boolean
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

  const [participantsSnap, truthSnap, instanceSnap, configSnap] = await Promise.all([
    instanceRef.collection(PARTICIPANTS_SUBCOLLECTION).get(),
    instanceRef.collection('truth').doc(TRUTH_DOC).get(),
    instanceRef.get(),
    instanceRef.collection('config').doc(CONFIG_DOC).get(),
  ])

  const cfg = configSnap.data() ?? {}
  const reverse = cfg.reverse === true ? true : DEFAULT_REVERSE
  const pennyValue = typeof cfg.penny_value === 'number' ? cfg.penny_value : DEFAULT_PENNY_VALUE
  const truth = truthSnap.data() ?? {}
  // Value (forward) or cost = penny_count × penny_value (reverse) — the same one-place
  // derivation the scorer uses, so the report can never disagree with the profits it shows.
  const trueValue = resolveTrueValue({
    reverse,
    trueValue: typeof truth.true_value === 'number' ? truth.true_value : DEFAULT_TRUE_VALUE,
    pennyCount: typeof truth.penny_count === 'number' ? truth.penny_count : DEFAULT_PENNY_COUNT,
    pennyValue,
  })
  const scored = instanceSnap.data()?.finalized === true

  const participants: ReportParticipant[] = participantsSnap.docs.map(d => {
    const p = d.data()
    return {
      participant_id: d.id,
      name: (p.name as string | undefined) ?? null,
      launched: p.launched_at != null,
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
  // The winning bid follows the mechanism: highest (forward) vs lowest (reverse).
  const winningBid = responses > 0
    ? (reverse ? Math.min(...submitters.map(p => p.bid as number)) : Math.max(...submitters.map(p => p.bid as number)))
    : null

  return {
    ok: true as const,
    scored,
    reverse,
    penny_value: pennyValue,
    true_value: trueValue,
    participants,
    stats: { responses, avgEstimate, avgBid, winningBid },
  }
})
