import { onCall, HttpsError } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import { FieldValue, Timestamp } from 'firebase-admin/firestore'
import { extractStudentOnCallIds } from '@mygames/game-server'
import { PRICING_CORS_ORIGINS, INSTANCES_COLLECTION, PARTICIPANTS_SUBCOLLECTION } from './config'
import { initPricingParticipant } from './init'
import { competitorPrice } from './strategy'
import { computeRound, isValidPrice } from './market'
import {
  parseStoredRounds, studentPrices, totals, toClientHistory, type StoredRound,
} from './rounds'
import { phaseOf } from './clientState'

// ═══════════════════════════════════════════════════════════════════════════════
// pricingSubmitPrice (student) — ONE round: the family's COMPUTE STEP (spec §4).
//
//   student's price for round t  →  competitor price = f(student's history through t−1)
//                                →  shares, demands, profits  →  append  →  reveal
//
// SIMULTANEITY, ENFORCED BY CONSTRUCTION (spec §1, §4). The competitor's price is
// computed inside the same transaction that commits the student's price, from
// `stored` — the history BEFORE this round — and is returned only after that
// transaction commits. So there is no moment at which a competitor price exists and
// the student's price does not: no polling, no second callable, no partially-written
// doc can hand a student the competitor's round-t price before they have committed
// their own. The rule itself is pure and takes only the student's own prior PRICES
// (strategy.ts), so the round-t price is not even in scope where it is computed.
//
// SUBMIT-AND-LOCK + IDEMPOTENCY (family rule). A round that is already stored can
// never be revised: a resubmit for round n ≤ what is stored DISCARDS the incoming
// price and returns the stored round untouched. That makes a double-click, a retried
// network call, and a stale tab all no-ops rather than corruption — and it is
// enforced inside the transaction, so two racing submits for the same round cannot
// both write. Self-paced play means a student may close the tab at any point and
// resume; nothing here waits on anyone (family rule).
//
// ⚠ RETURNS ONLY DERIVED, ALREADY-EARNED VALUES: this round's outcome, the running
// history, the running totals, and the phase. No round count, no rounds remaining,
// no competitor rule. The student learns the game ended when it ends — never that it
// is about to.
// ═══════════════════════════════════════════════════════════════════════════════

export const pricingSubmitPrice = onCall({ cors: PRICING_CORS_ORIGINS }, async (request) => {
  const data = request.data as Record<string, unknown>
  const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true'
  const authHeader = request.rawRequest.headers.authorization as string | undefined

  const { participantId, gameInstanceId } = await extractStudentOnCallIds(data, isEmulator, authHeader)

  // Which round the client believes it is playing (1-based). Required, and checked
  // against the server's own count below — the client's number is a claim to verify,
  // never the source of truth. It is what makes a retry idempotent instead of a
  // second round.
  const roundNumber = data.round
  if (typeof roundNumber !== 'number' || !Number.isInteger(roundNumber) || roundNumber < 1) {
    throw new HttpsError('invalid-argument', 'round must be a positive integer.')
  }

  const db = admin.firestore()

  // Truth (this student's round count) + the instance config and competitor rule.
  // Read OUTSIDE the transaction below, which is safe precisely because the round
  // count is once-only and immutable after its first draw (init.ts): a concurrent
  // first-touch cannot change a value that already exists, so there is nothing here
  // for the transaction to have to re-check.
  const { rounds: totalRounds, config, strategy } =
    await initPricingParticipant(db, gameInstanceId, participantId)

  // Price validation needs the instance's bounds, so it happens after the config
  // load — but still before the transaction, so a bad price costs no write.
  const price = data.price
  if (!isValidPrice(price, config.market)) {
    throw new HttpsError('invalid-argument',
      `Enter a whole-dollar price between $${config.market.minPrice} and $${config.market.maxPrice}.`)
  }

  const participantRef = db
    .collection(INSTANCES_COLLECTION).doc(gameInstanceId)
    .collection(PARTICIPANTS_SUBCOLLECTION).doc(participantId)

  const result = await db.runTransaction(async (tx) => {
    const snap = await tx.get(participantRef)
    const pData = snap.data() ?? {}
    // No belongs check — the doc IS under this instance (structural isolation).
    const stored = parseStoredRounds(pData.rounds)

    // ── Already played: return it, write nothing. Submit-and-lock. ──────────────
    if (roundNumber <= stored.length) {
      return { round: stored[roundNumber - 1], all: stored, phase: phaseOf(pData) }
    }

    // ── Past the end: the game is over and no further round exists. ─────────────
    if (pData.finished_at != null) {
      throw new HttpsError('failed-precondition', 'Your game is over — there are no more rounds.')
    }

    // ── Out of step: rounds are played in order, one at a time, no skipping. ────
    if (roundNumber !== stored.length + 1) {
      throw new HttpsError('failed-precondition',
        'That is not the round you are on. Please reload the page.')
    }

    // ── The compute step ───────────────────────────────────────────────────────
    // History through t−1 only: `stored` does not yet contain this round, so the
    // competitor's price cannot be a function of the price being submitted.
    const rivalPrice = competitorPrice(strategy, studentPrices(stored), config.market, config.pmg)
    const outcome = computeRound(price, rivalPrice, config.market, config.pmg)

    const record: StoredRound = {
      round: roundNumber,
      student_price: price,
      competitor_price: rivalPrice,
      effective_price: outcome.effectivePrice,
      student_share: outcome.studentShare,
      competitor_share: outcome.competitorShare,
      student_demand: outcome.studentDemand,
      competitor_demand: outcome.competitorDemand,
      student_profit: outcome.studentProfit,
      competitor_profit: outcome.competitorProfit,
      played_at: Timestamp.now(),
    }
    const all = [...stored, record]
    const sums = totals(all)

    // The LAST round is this student's drawn round count — server-side truth,
    // compared here and never sent anywhere. The student sees only the resulting
    // phase transition.
    const finished = all.length >= totalRounds

    const patch: Record<string, unknown> = {
      participant_id: participantId,
      game_instance_id: gameInstanceId,
      // Whole-array write, not arrayUnion: the array is read and re-written inside the
      // transaction, so the version check covers it. arrayUnion would also silently
      // de-duplicate identical rounds, which here would be data loss — two rounds at
      // the same price against the same competitor price ARE identical documents.
      rounds: all,
      rounds_played: all.length,
      student_profit_total: sums.student,
      competitor_profit_total: sums.competitor,
      phase: finished ? 'debrief' : 'play',
    }
    if (finished) patch.finished_at = FieldValue.serverTimestamp()

    tx.set(participantRef, patch, { merge: true })

    return { round: record, all, phase: finished ? ('debrief' as const) : ('play' as const) }
  })

  const sums = totals(result.all)

  return {
    ok: true as const,
    // This round's outcome — what the round-results screen shows (spec §4: both
    // prices, both shares, both demands, both profits). Built field by field (never
    // spread from the stored record) so storage can grow without leaking.
    round: {
      round: result.round.round,
      yourPrice: result.round.student_price,
      competitorPrice: result.round.competitor_price,
      effectivePrice: result.round.effective_price,
      yourShare: result.round.student_share,
      competitorShare: result.round.competitor_share,
      yourDemand: result.round.student_demand,
      competitorDemand: result.round.competitor_demand,
      yourProfit: result.round.student_profit,
      competitorProfit: result.round.competitor_profit,
    },
    history: toClientHistory(result.all),
    totalProfit: sums.student,
    averageProfit: result.all.length === 0 ? 0 : sums.student / result.all.length,
    phase: result.phase,
    gameOver: result.phase === 'debrief',
  }
})
