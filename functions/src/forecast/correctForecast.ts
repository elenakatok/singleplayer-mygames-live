import { onCall, HttpsError } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import { FieldValue, Timestamp } from 'firebase-admin/firestore'
import { extractInstructorGameId } from '@mygames/game-server'
import { FORECAST_CORS_ORIGINS, INSTANCES_COLLECTION, PARTICIPANTS_SUBCOLLECTION } from './config'
import { loadInstance } from './instance'
import { parseStoredRounds, toPoints, type StoredRound } from './rounds'
import { runningMetrics } from './metrics'

// ═══════════════════════════════════════════════════════════════════════════════
// forecastCorrectForecast (instructor) — fix ONE typed forecast after the fact.
//
// Why this exists: a student typed 152 for 1,152 in the last month (Jamaal, 2026-10-06),
// and the family's submit-and-lock rule (submitRound.ts) is right to refuse a student's
// own revision — a month that could be re-entered after its demand is revealed is not
// a forecast. The INSTRUCTOR is a different matter: she can see the entry was a slip,
// and until now her only recourse was a hand-written database edit.
//
// WHAT IT CHANGES, AND WHAT IT NEVER TOUCHES
//   • rewrites `forecast` for one played month — a whole number within the instance's
//     own bounds, exactly what the student could have typed;
//   • appends an AUDIT entry to `forecast_corrections` (round, period, from, to, when,
//     an optional note) — a correction is a fact about the record, kept with it;
//   • refreshes the REPORT-ONLY cached figures (mse, mae, mape, mean_error) that
//     scoreAndRecord also writes, so the roster agrees with the month table at once.
//   • NEVER the realized demand (`actual`): that is the draw, not an entry.
//   • NEVER a score. Participation is the only thing graded here (scoring.ts), and it
//     does not read forecasts, so no gradebook figure moves.
//
// Every derived figure on every screen is a pure function of (forecast, actual)
// (rounds.ts), so this one write is the whole fix — the student's final screen, the
// CSV and the report all follow.
// ═══════════════════════════════════════════════════════════════════════════════

/** One audit entry, as stored on the participant doc. */
export interface ForecastCorrection {
  round: number
  period: number
  from: number
  to: number
  at: Timestamp
  by: 'instructor'
  note: string | null
}

export const forecastCorrectForecast = onCall({ cors: FORECAST_CORS_ORIGINS }, async (request) => {
  const data = request.data as Record<string, unknown>
  const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true'
  const authHeader = request.rawRequest.headers.authorization as string | undefined

  const gameInstanceId = await extractInstructorGameId(data, isEmulator, authHeader)

  const participantId = data.participant_id
  if (typeof participantId !== 'string' || !participantId) {
    throw new HttpsError('invalid-argument', 'participant_id is required.')
  }
  const round = data.round
  if (typeof round !== 'number' || !Number.isInteger(round) || round < 1) {
    throw new HttpsError('invalid-argument', 'round must be a positive integer.')
  }
  const note = typeof data.note === 'string' && data.note.trim() ? data.note.trim().slice(0, 300) : null

  const db = admin.firestore()
  const { config } = await loadInstance(db, gameInstanceId)

  // The same bounds the student faced (submitRound.ts) — a correction is what they
  // could have typed, not a number the game would have refused.
  const F = data.forecast
  if (typeof F !== 'number' || !Number.isInteger(F) || F < config.forecastMin || F > config.forecastMax) {
    throw new HttpsError('invalid-argument',
      `Enter a whole number between ${config.forecastMin} and ${config.forecastMax}.`)
  }

  const participantRef = db
    .collection(INSTANCES_COLLECTION).doc(gameInstanceId)
    .collection(PARTICIPANTS_SUBCOLLECTION).doc(participantId)

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(participantRef)
    if (!snap.exists) throw new HttpsError('not-found', 'That student is not in this game.')
    const stored = parseStoredRounds(snap.data()?.rounds)
    const idx = stored.findIndex(r => r.round === round)
    if (idx < 0) {
      throw new HttpsError('failed-precondition', `That student has not played month ${round} yet — only a played month can be corrected.`)
    }
    const was = stored[idx]
    if (was.forecast === F) {
      return { ok: true as const, changed: false as const, round, period: was.period, from: was.forecast, to: F }
    }

    const fixed: StoredRound[] = stored.map(r => (r.round === round ? { ...r, forecast: F } : r))
    const after = runningMetrics(toPoints(fixed))
    const entry: ForecastCorrection = {
      round, period: was.period, from: was.forecast, to: F, at: Timestamp.now(), by: 'instructor', note,
    }
    tx.update(participantRef, {
      // Whole-array write, as submitRound does: read and re-written inside the
      // transaction, so a racing write is caught by the version check.
      rounds: fixed,
      forecast_corrections: FieldValue.arrayUnion(entry),
      mse: after.mse,
      mae: after.mae,
      mape: after.mape,
      mean_error: after.meanError,
    })
    return {
      ok: true as const,
      changed: true as const,
      round, period: was.period, from: was.forecast, to: F,
      mse: after.mse, mae: after.mae, mape: after.mape, mean_error: after.meanError,
    }
  })
})
