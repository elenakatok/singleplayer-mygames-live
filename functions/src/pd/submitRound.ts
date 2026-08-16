import { onCall, HttpsError } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import { FieldValue, Timestamp } from 'firebase-admin/firestore'
import { extractStudentOnCallIds } from '@mygames/game-server'
import { PD_CORS_ORIGINS, INSTANCES_COLLECTION, PARTICIPANTS_SUBCOLLECTION } from './config'
import { initPdParticipant } from './init'
import { botMove } from './strategy'
import { payoff } from './payoff'
import {
  isMove, parseStoredRounds, studentMoves, botMoves, totals, toClientHistory, type StoredRound,
} from './rounds'

// ═══════════════════════════════════════════════════════════════════════════════
// pdSubmitRound (student) — ONE round: the family's COMPUTE STEP (spec §4).
//
//   student's move for round t  →  bot move = f(student's history through t−1)
//                               →  payoffs  →  append  →  reveal
//
// SIMULTANEITY, ENFORCED BY CONSTRUCTION (spec §1). The bot's move is computed
// inside the same transaction that commits the student's move, from `stored` — the
// history BEFORE this round — and is returned only after that transaction commits.
// So there is no moment at which a bot move exists and the student's move does not:
// no polling, no second callable, no partially-written doc can hand a student the
// bot's round-t choice before they have committed their own. The strategy function
// itself is pure and takes only the student's own prior moves (strategy.ts).
//
// SUBMIT-AND-LOCK + IDEMPOTENCY (family rule; pollSubmitAnswer's shape). A round that
// is already stored can never be revised: a resubmit for round n ≤ what is stored
// DISCARDS the incoming move and returns the stored round untouched. That makes a
// double-click, a retried network call, and a stale tab all no-ops rather than
// corruption — and it is enforced inside the transaction, so two racing submits for
// the same round cannot both write.
//
// ⚠ RETURNS ONLY DERIVED, ALREADY-EARNED VALUES: this round's outcome, the running
// history, and a `gameOver` boolean. No round count, no rounds remaining, no strategy.
// The student learns the game ended when it ends — never that it is about to.
// ═══════════════════════════════════════════════════════════════════════════════

export const pdSubmitRound = onCall({ cors: PD_CORS_ORIGINS }, async (request) => {
  const data = request.data as Record<string, unknown>
  const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true'
  const authHeader = request.rawRequest.headers.authorization as string | undefined

  const { participantId, gameInstanceId } = await extractStudentOnCallIds(data, isEmulator, authHeader)

  const move = data.move
  if (!isMove(move)) {
    throw new HttpsError('invalid-argument', 'Please choose one of the two options.')
  }

  // Which round the client believes it is playing (1-based). Required, and checked
  // against the server's own count below — the client's number is a claim to verify,
  // never the source of truth. It is what makes a retry idempotent instead of a
  // second round (poll sends question_id for the same reason).
  const roundNumber = data.round
  if (typeof roundNumber !== 'number' || !Number.isInteger(roundNumber) || roundNumber < 1) {
    throw new HttpsError('invalid-argument', 'round must be a positive integer.')
  }

  const db = admin.firestore()

  // Truth (round count + strategy). Read OUTSIDE the transaction below, which is safe
  // precisely because both values are once-only and immutable after their first draw
  // (init.ts): a concurrent first-touch cannot change a value that already exists, so
  // there is nothing here for the transaction to have to re-check.
  const { rounds: totalRounds, strategy, config } = await initPdParticipant(db, gameInstanceId, participantId)

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
      const r = stored[roundNumber - 1]
      return {
        round: r,
        history: toClientHistory(stored),
        gameOver: pData.finished_at != null,
      }
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
    // History through t−1 only: `stored` does not yet contain this round.
    // ⚠⚠ BOTH HISTORIES COME FROM `stored` — the round records as written. `botMoves`
    // is the bot's own past moves read off the `bot_move` fields, NEVER a replay of the
    // strategy: `random`'s past moves are draws and `match_stay` reads its own last
    // move, so a replay would rewrite history rather than describe it (spec §5).
    const bot = botMove(strategy, studentMoves(stored), botMoves(stored),
      { seed: config.seed, participantId })
    const { studentYears, botYears } = payoff(move, bot, config.payoffs)

    const record: StoredRound = {
      round: roundNumber,
      student_move: move,
      bot_move: bot,
      student_years: studentYears,
      bot_years: botYears,
      played_at: Timestamp.now(),
    }
    const all = [...stored, record]
    const sums = totals(all)

    // The LAST round is the drawn round count — server-side truth, compared here and
    // never sent anywhere. The student sees only the resulting `gameOver` boolean.
    const finished = all.length >= totalRounds

    const patch: Record<string, unknown> = {
      participant_id: participantId,
      game_instance_id: gameInstanceId,
      // Whole-array write, not arrayUnion: the array is read and re-written inside the
      // transaction, so the version check covers it. arrayUnion would also silently
      // de-duplicate identical rounds, which here would be data loss.
      rounds: all,
      rounds_played: all.length,
      student_years_total: sums.student,
      bot_years_total: sums.bot,
    }
    if (finished) patch.finished_at = FieldValue.serverTimestamp()

    tx.set(participantRef, patch, { merge: true })

    return { round: record, history: toClientHistory(all), gameOver: finished }
  })

  return {
    ok: true as const,
    // This round's outcome — the four values the reveal shows. Built field by field
    // (never spread from the stored record) so storage can grow without leaking.
    round: {
      studentMove: result.round.student_move,
      botMove: result.round.bot_move,
      studentYears: result.round.student_years,
      botYears: result.round.bot_years,
    },
    history: result.history,
    gameOver: result.gameOver,
  }
})
