import { onCall, HttpsError } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import { FieldValue, Timestamp } from 'firebase-admin/firestore'
import { extractStudentOnCallIds } from '@mygames/game-server'
import { NEWSVENDOR_CORS_ORIGINS, INSTANCES_COLLECTION, PARTICIPANTS_SUBCOLLECTION } from './config'
import { loadInstance } from './instance'
import { drawDemand } from './demand'
import { computePeriod, benchmarkProfit, isValidOrder, orderBounds, economicsError } from './economics'
import { parseStoredRounds, totals, toClientHistory, type StoredRound } from './rounds'
import { phaseOf } from './clientState'

// ═══════════════════════════════════════════════════════════════════════════════
// newsvendorSubmitRound (student) — ONE period: the family's COMPUTE STEP (spec §1).
//
//   order Q for period t  →  draw D for (this student, this period)
//                         →  sales, profit, service level, and the benchmark
//                         →  append  →  reveal
//
// ⚠⚠ THE DRAW HAPPENS AFTER THE ORDER IS COMMITTED, IN THE SAME TRANSACTION (spec §3,
// architecture §5.3). There is no moment at which a demand realization exists and the
// student's order does not: no second callable, no pre-generated sequence, no
// partially-written doc can hand a student period t's demand before they have
// committed period t's order. `drawDemand` is called below the submit-and-lock checks,
// from inside the transaction body, and its result is written and returned in one
// commit.
//
// SUBMIT-AND-LOCK + IDEMPOTENCY (family rule). A period that is already stored can
// never be revised: a resubmit for period n ≤ what is stored DISCARDS the incoming
// order and returns the stored period untouched — which also means a retry cannot
// trigger a SECOND demand draw and quietly give the student a better one. Enforced
// inside the transaction, so two racing submits for the same period cannot both write.
//
// ⚠ RETURNS NO BENCHMARK. `q_opt` and `profit_opt` are computed and stored here for
// the instructor's reports (spec §9.2), and the response is built field by field from
// the whitelist in rounds.ts, so neither reaches the student.
// ═══════════════════════════════════════════════════════════════════════════════

export const newsvendorSubmitRound = onCall({ cors: NEWSVENDOR_CORS_ORIGINS }, async (request) => {
  const data = request.data as Record<string, unknown>
  const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true'
  const authHeader = request.rawRequest.headers.authorization as string | undefined

  const { participantId, gameInstanceId } = await extractStudentOnCallIds(data, isEmulator, authHeader)

  // Which period the client believes it is playing (1-based). Required, and checked
  // against the server's own count below — the client's number is a claim to verify,
  // never the source of truth. It is what makes a retry idempotent instead of a
  // second period with a second demand draw.
  const periodNumber = data.round
  if (typeof periodNumber !== 'number' || !Number.isInteger(periodNumber) || periodNumber < 1) {
    throw new HttpsError('invalid-argument', 'round must be a positive integer.')
  }

  const db = admin.firestore()
  const { config, seed } = await loadInstance(db, gameInstanceId)

  // A degenerate config would produce a benchmark that does not exist (economics.ts),
  // so it is refused before anything is written rather than stored and discovered in
  // the reports a week later.
  const configError = economicsError(config)
  if (configError) throw new HttpsError('failed-precondition', configError)

  // Order validation needs the instance's bounds, so it happens after the config load
  // — but still before the transaction, so a bad order costs no write and no draw.
  const Q = data.order
  if (!isValidOrder(Q, config)) {
    const { min, max } = orderBounds(config)
    throw new HttpsError('invalid-argument',
      `Enter a whole number of units between ${min} and ${max}.`)
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
    if (periodNumber <= stored.length) {
      return { round: stored[periodNumber - 1], all: stored, phase: phaseOf(pData) }
    }

    // ── Past the end: every period has been played. ────────────────────────────
    if (pData.finished_at != null || stored.length >= config.periods) {
      throw new HttpsError('failed-precondition', 'Your game is over — there are no more periods.')
    }

    // ── Out of step: periods are played in order, one at a time, no skipping. ──
    if (periodNumber !== stored.length + 1) {
      throw new HttpsError('failed-precondition',
        'That is not the period you are on. Please reload the page.')
    }

    // ── The compute step (spec §3, §4) ─────────────────────────────────────────
    const D = drawDemand(seed, participantId, periodNumber, config)
    const outcome = computePeriod(Q, D, config)
    // The benchmark, against the SAME D the student just faced (spec §4). Stored,
    // never returned — see the header.
    const { Qopt, profitOpt } = benchmarkProfit(D, config)

    const record: StoredRound = {
      round: periodNumber,
      q: Q,
      d: D,
      sales: outcome.sales,
      leftover: outcome.leftover,
      units_short: outcome.unitsShort,
      topup: outcome.topup,
      profit: outcome.profit,
      service_level: outcome.serviceLevel,
      q_opt: Qopt,
      profit_opt: profitOpt,
      played_at: Timestamp.now(),
    }
    const all = [...stored, record]
    const sums = totals(all)

    const finished = all.length >= config.periods

    const patch: Record<string, unknown> = {
      participant_id: participantId,
      game_instance_id: gameInstanceId,
      // Whole-array write, not arrayUnion: the array is read and re-written inside the
      // transaction, so the version check covers it. arrayUnion would also silently
      // de-duplicate identical periods, which here would be data loss — two periods
      // with the same order and the same drawn demand ARE identical documents.
      rounds: all,
      rounds_played: all.length,
      profit_total: sums.student,
      // Report-only running benchmark, alongside the realized total (spec §9.2).
      benchmark_profit_total: sums.benchmark,
      phase: finished ? 'debrief' : 'play',
    }
    if (finished) patch.finished_at = FieldValue.serverTimestamp()

    tx.set(participantRef, patch, { merge: true })

    return { round: record, all, phase: finished ? ('debrief' as const) : ('play' as const) }
  })

  const sums = totals(result.all)
  const played = result.all.length

  return {
    ok: true as const,
    // This period's outcome — what the round-results screen shows (spec §7b).
    // Built field by field (never spread from the stored record) so the benchmark
    // stored alongside it cannot ride along.
    round: {
      round: result.round.round,
      yourOrder: result.round.q,
      demand: result.round.d,
      sales: result.round.sales,
      unitsOver: result.round.leftover,
      unitsShort: result.round.units_short,
      unitsFromSecondSource: result.round.topup,
      profit: result.round.profit,
      serviceLevel: result.round.service_level,
    },
    history: toClientHistory(result.all),
    totalProfit: sums.student,
    averageProfit: played === 0 ? 0 : sums.student / played,
    averageOrder: played === 0 ? 0 : result.all.reduce((a, r) => a + r.q, 0) / played,
    averageServiceLevel: played === 0 ? 0 : result.all.reduce((a, r) => a + r.service_level, 0) / played,
    periodsPlayed: played,
    phase: result.phase,
    gameOver: result.phase === 'debrief',
  }
})
