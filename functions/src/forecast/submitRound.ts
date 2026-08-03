import { onCall, HttpsError } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import { FieldValue, Timestamp } from 'firebase-admin/firestore'
import { extractStudentOnCallIds } from '@mygames/game-server'
import { FORECAST_CORS_ORIGINS, INSTANCES_COLLECTION, PARTICIPANTS_SUBCOLLECTION } from './config'
import { loadInstance } from './instance'
import { drawDemand } from './demand'
import { parseStoredRounds, toClientHistory, toClientResult, toPoints, type StoredRound } from './rounds'
import { runningMetrics, yearComparison } from './metrics'
import { phaseOf } from './clientState'

// ═══════════════════════════════════════════════════════════════════════════════
// forecastSubmitRound (student) — ONE month: the family's COMPUTE STEP (spec §4).
//
//   forecast F for month p  →  draw D for (this student, this month)
//                           →  error, AE, SE, APE, and the running scorecard
//                           →  append  →  reveal
//
// ⚠⚠ THE DRAW HAPPENS AFTER THE FORECAST IS COMMITTED, IN THE SAME TRANSACTION
// (spec §2.2, §4, architecture §5.3). There is no moment at which a realization exists
// and the student's forecast does not: no second callable, no pre-generated series, no
// partially-written doc can hand a student month p's demand before they have committed
// month p's forecast. `drawDemand` is called below the submit-and-lock checks, from
// inside the transaction body, and its result is written and returned in one commit.
//
// This is stricter than it looks. In a forecasting game the realization is not merely
// an outcome, it is THE ANSWER — a student who could see next month's demand has no
// game left. So the ordering here is the single most load-bearing sequence in the
// build, and the harness asserts it from the outside (spec §12) rather than trusting
// this comment.
//
// SUBMIT-AND-LOCK + IDEMPOTENCY (family rule). A month that is already stored can never
// be revised: a resubmit for round n ≤ what is stored DISCARDS the incoming forecast
// and returns the stored month untouched — which also means a retry cannot trigger a
// SECOND demand draw and quietly hand the student a friendlier one. Enforced inside the
// transaction, so two racing submits for the same month cannot both write.
//
// ⚠ RETURNS NO MODEL AND NO BENCHMARK. The response is built field by field from the
// whitelists in rounds.ts and clientState.ts. `loadInstance` returns the model and the
// seed; neither is destructured into anything that reaches the return statement.
// ═══════════════════════════════════════════════════════════════════════════════

export const forecastSubmitRound = onCall({ cors: FORECAST_CORS_ORIGINS }, async (request) => {
  const data = request.data as Record<string, unknown>
  const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true'
  const authHeader = request.rawRequest.headers.authorization as string | undefined

  const { participantId, gameInstanceId } = await extractStudentOnCallIds(data, isEmulator, authHeader)

  // Which round the client believes it is playing (1-based). Required, and checked
  // against the server's own count below — the client's number is a claim to verify,
  // never the source of truth. It is what makes a retry idempotent instead of a second
  // month with a second demand draw.
  const roundNumber = data.round
  if (typeof roundNumber !== 'number' || !Number.isInteger(roundNumber) || roundNumber < 1) {
    throw new HttpsError('invalid-argument', 'round must be a positive integer.')
  }

  const db = admin.firestore()
  // ⚠ `drawSeed`, NOT `seed` — see instance.ts. With `demandDraw: 'common'` and a
  // blank seed, using `seed` here made every student draw independently.
  const { config, model, drawSeed } = await loadInstance(db, gameInstanceId)

  // Forecast validation needs the instance's bounds, so it happens after the config
  // load — but still before the transaction, so a bad forecast costs no write and,
  // more importantly, no draw.
  const F = data.forecast
  if (typeof F !== 'number' || !Number.isInteger(F) || F < config.forecastMin || F > config.forecastMax) {
    throw new HttpsError('invalid-argument',
      `Enter a whole number between ${config.forecastMin} and ${config.forecastMax}.`)
  }

  const participantRef = db
    .collection(INSTANCES_COLLECTION).doc(gameInstanceId)
    .collection(PARTICIPANTS_SUBCOLLECTION).doc(participantId)

  const result = await db.runTransaction(async (tx) => {
    const snap = await tx.get(participantRef)
    const pData = snap.data() ?? {}
    // No belongs check — the doc IS under this instance (structural isolation).
    const stored = parseStoredRounds(pData.rounds)

    // ── Already played: return it, write nothing, DRAW NOTHING. ────────────────
    if (roundNumber <= stored.length) {
      return { all: stored.slice(0, roundNumber), full: stored, phase: phaseOf(pData) }
    }

    // ── Past the end: every month has been played. ─────────────────────────────
    if (pData.finished_at != null || stored.length >= config.rounds) {
      throw new HttpsError('failed-precondition', 'Your game is over — there are no more months.')
    }

    // ── Out of step: months are played in order, one at a time, no skipping. ───
    if (roundNumber !== stored.length + 1) {
      throw new HttpsError('failed-precondition',
        'That is not the month you are on. Please reload the page.')
    }

    // ── The compute step (spec §2.2, §4) ───────────────────────────────────────
    // The PERIOD is derived from the history length, not from the round index, so an
    // instance with a non-default numHistory still lands on the right calendar month.
    const period = config.numHistory + roundNumber
    const D = drawDemand(model, drawSeed, participantId, period)

    const record: StoredRound = {
      round: roundNumber,
      period,
      forecast: F,
      actual: D,
      played_at: Timestamp.now(),
    }
    const all = [...stored, record]
    const finished = all.length >= config.rounds
    const running = runningMetrics(toPoints(all))

    const patch: Record<string, unknown> = {
      participant_id: participantId,
      game_instance_id: gameInstanceId,
      // Whole-array write, not arrayUnion: the array is read and re-written inside the
      // transaction, so the version check covers it. arrayUnion would also silently
      // de-duplicate identical months, which here would be data loss — two months with
      // the same forecast and the same drawn demand ARE identical documents.
      rounds: all,
      rounds_played: all.length,
      // Denormalized for the reports' roster, which must not re-derive 24 months of
      // metrics per student per page load. The raw pairs above remain the source of
      // truth; these are a cache and are rewritten from them on every submit and again
      // at Score & Record.
      mse: running.mse,
      mae: running.mae,
      mape: running.mape,
      mean_error: running.meanError,
      phase: finished ? 'debrief' : 'play',
    }
    if (finished) patch.finished_at = FieldValue.serverTimestamp()

    tx.set(participantRef, patch, { merge: true })

    return { all, full: all, phase: finished ? ('debrief' as const) : ('play' as const) }
  })

  const points = toPoints(result.full)

  return {
    ok: true as const,
    // This month's card — what the round-results screen shows (spec §4).
    round: toClientResult(result.all),
    // The whole history so far, so the client never accumulates and cannot drift.
    history: toClientHistory(result.full),
    running: runningMetrics(points),
    /** Y6 vs Y7 (spec §5). Present every round; `improved` stays null until both
     *  years have a month in them. */
    years: yearComparison(points),
    roundsPlayed: result.full.length,
    phase: result.phase,
    gameOver: result.phase === 'debrief',
  }
})
