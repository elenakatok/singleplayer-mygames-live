import { onCall, HttpsError } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import { FieldValue, Timestamp } from 'firebase-admin/firestore'
import { extractStudentOnCallIds } from '@mygames/game-server'
import { PROCUREMENT_CORS_ORIGINS, INSTANCES_COLLECTION, PARTICIPANTS_SUBCOLLECTION } from './config'
import { loadInstance } from './instance'
import { drawPlayerCost, resolveRound, validateBid } from './round'
import { openCostFor, nextOpenRoundPatch } from './openRound'
import {
  parseStoredRounds, toClientHistory, toClientResult, totalProfit, totalEquilibriumProfit,
  roundsWon, type StoredRound,
} from './rounds'
import { phaseOf } from './clientState'
import { openSubmitBid } from './openPlay'

// ═══════════════════════════════════════════════════════════════════════════════
// procurementSubmitBid (student) — ONE SEALED ROUND: the family's COMPUTE STEP.
//
//   bid B for round t  →  draw the rival costs for (this student, this round)
//                      →  bot bids from the conditioned rule (Part 1 §5.1)
//                      →  lowest bid wins, paid its own bid
//                      →  append  →  reveal
//
// ⚠⚠ THE RIVAL COSTS ARE DRAWN AFTER THE BID IS COMMITTED, IN THE SAME TRANSACTION
// (Part 1 §4 — "must not exist anywhere reachable before the bid is committed"). This is
// the newsvendor/forecast discipline and it is the single most load-bearing sequence in
// this game: a student who could see the rivals' costs first has no decision left.
//
// `resolveRound` is where the rival stream is opened, and it is called from INSIDE the
// transaction body, below the submit-and-lock checks, with the bid already in hand. Its
// result is written and returned in one commit, so there is no moment — no second
// callable, no pre-generated series, no partially-written doc — at which round t's rival
// costs exist and round t's bid does not. The harness asserts this from the outside
// (§12); this comment is not the guarantee.
//
// ⚠ SUBMIT-AND-LOCK + IDEMPOTENCY (family rule). A round already stored can never be
// revised: a resubmit for round n ≤ what is stored DISCARDS the incoming bid and returns
// the stored round untouched — which also means a retry cannot trigger a SECOND cost
// draw and quietly hand the student friendlier rivals. Enforced inside the transaction,
// so two racing submits for the same round cannot both write.
//
// ⚠⚠ THE PLAYER'S OWN COST IS READ FROM THE RECORD, NOT RECOMPUTED, AND NOT TAKEN FROM
// THE REQUEST. `openCostFor` returns the number written when the round was opened — the
// very number the bidding screen printed. THIS IS THE ASSERTION THE 08-03 PRODUCTION BUG
// WOULD HAVE FAILED: CP3a re-derived it here, and with no seed (the normal classroom
// case) `makeRng` falls back to `Math.random` and ignores its key, so the round resolved
// against a cost the student had never seen. There is no field for a client to send a
// cost in, and now no second derivation to disagree with the first.
//
// ⚠ VALIDATION AT SUBMIT, WITH A VISIBLE REASON (Part 1 §6.2, §13.5): whole numbers at
// or below the reserve. BELOW ONE'S OWN COST IS ALLOWED — see validateBid, that is §6.2
// and not an oversight.
//
// ⚠ THERE IS NO DROP OUT AND NO "DO NOT BID" IN THE SEALED FORMAT (§6.3). A bid is
// required once the bidding screen is reached; a student who abandons has an unfinished
// assignment, not a played round, and nothing is written for them.
//
// ⚠ RETURNS NO SEED AND NO RIVAL COSTS. The response is built field by field from the
// whitelists in rounds.ts and clientState.ts. `loadInstance` returns the seed; it is
// never destructured into anything that reaches the return statement.
// ═══════════════════════════════════════════════════════════════════════════════

export const procurementSubmitBid = onCall({ cors: PROCUREMENT_CORS_ORIGINS }, async (request) => {
  const data = request.data as Record<string, unknown>
  const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true'
  const authHeader = request.rawRequest.headers.authorization as string | undefined

  const { participantId, gameInstanceId } = await extractStudentOnCallIds(data, isEmulator, authHeader)

  const db = admin.firestore()
  const { config, seed } = await loadInstance(db, gameInstanceId)

  // ⚠⚠ THE OPEN FORMAT IS ROUTED, NOT REFUSED — replacing the CP3-era refusal that lived
  // here ("This instance runs the open-bid format, which does not use sealed
  // submissions.") and threw `failed-precondition`.
  //
  // A player's bid is a player's bid under either mechanism, so it keeps one callable and
  // one client entry point. What differs is everything AFTER it: the sealed path below
  // draws the rivals and resolves the round in this one transaction, while the open path
  // commits one bid into a live auction that may run for another dozen commits (§4.6).
  //
  // ⚠ THE ROUND NUMBER IS NOT PART OF THE OPEN CONTRACT. Sealed needs it for
  // submit-and-lock idempotency — a resubmit for a stored round must not redraw. The open
  // format's round is whatever the server's own auction state says it is, and a bid
  // carries a `sequence` instead, which is a claim about the PRICE rather than the round.
  if (config.format === 'open_descending') {
    const amount = data.bid
    if (typeof amount !== 'number' || !Number.isFinite(amount)) {
      throw new HttpsError('invalid-argument', 'Enter a whole number of ECU.')
    }
    const seq = data.sequence
    return openSubmitBid(
      request as never,
      amount,
      typeof seq === 'number' && Number.isInteger(seq) ? seq : null,
    )
  }

  // Which round the client believes it is playing (1-based). Required, and checked
  // against the server's own count below — the client's number is a claim to verify,
  // never the source of truth. It is what makes a retry idempotent instead of a second
  // round with a second cost draw.
  const roundNumber = data.round
  if (typeof roundNumber !== 'number' || !Number.isInteger(roundNumber) || roundNumber < 1) {
    throw new HttpsError('invalid-argument', 'round must be a positive integer.')
  }

  // Bid validation needs the instance's reserve, so it happens after the config load —
  // but still before the transaction, so a rejected bid costs no write and, far more
  // importantly, NO DRAW. A student who is told "above the reserve" has not silently
  // burned their round's rivals.
  const check = validateBid(data.bid, config)
  if (!check.ok) throw new HttpsError('invalid-argument', check.reason)
  const bid = check.bid

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
      return {
        all: stored.slice(0, roundNumber), full: stored, phase: phaseOf(pData),
        // ⚠ Whatever is currently open — a resubmit must not open, advance or redraw
        // anything. It reports the state, it does not change it.
        nextCost: openCostFor(pData, stored.length + 1),
      }
    }

    // ── Past the end: every round has been played. ─────────────────────────────
    if (pData.finished_at != null || stored.length >= config.rounds) {
      throw new HttpsError('failed-precondition', 'Your game is over — there are no more rounds.')
    }

    // ── Out of step: rounds are played in order, one at a time, no skipping. ───
    if (roundNumber !== stored.length + 1) {
      throw new HttpsError('failed-precondition',
        'That is not the round you are on. Please reload the page.')
    }

    // ── The compute step (Part 1 §4, §5, §7) ───────────────────────────────────
    // The player's cost comes from the RECORD. Only if none was ever written — a student
    // who reached submit without the bidding screen ever loading — is one drawn, once,
    // here inside this transaction. A bid is still a bid; refusing it would strand a
    // student whose first getState failed.
    const playerCost = openCostFor(pData, roundNumber)
      ?? drawPlayerCost(seed, participantId, roundNumber, config)

    // ⚠ THEN the rivals, from their own stream, with the bid already in hand. Recording
    // the player's own cost early does NOT pull this forward — see openRound.ts.
    const res = resolveRound(seed, participantId, roundNumber, config, playerCost, bid)

    const record: StoredRound = {
      round: roundNumber,
      cost: playerCost,
      bid,
      won: res.playerWon,
      price: res.price,
      profit: res.playerProfit,
      // ⚠ A CONCRETE Timestamp, never FieldValue.serverTimestamp(): Firestore rejects
      // sentinel values inside array elements, and rounds are stored as an array.
      played_at: Timestamp.now(),
      rival_costs: res.rivalCosts,
      rival_bids: res.rivalBids,
      // ⚠ RECORDED, not left to be derived from `price` — a rival-vs-rival tie has two
      // bidders at the winning price and only one of them won (rounds.ts).
      winner_id: res.winnerId,
      tie: res.tie,
      tied_and_lost: res.tiedAndLost,
      eq_bid: res.equilibriumBid,
      eq_won: res.equilibriumWouldHaveWon,
      eq_profit: res.equilibriumProfit,
    }

    const all = [...stored, record]
    const finished = all.length >= config.rounds

    // Open the next round HERE, so its cost is written by the same commit that stored
    // this one and the response can return the very number that was written.
    const nextPatch = nextOpenRoundPatch(
      finished ? null : roundNumber + 1, seed, participantId, config)

    const patch: Record<string, unknown> = {
      participant_id: participantId,
      game_instance_id: gameInstanceId,
      // ⚠ WHOLE-ARRAY WRITE, NOT arrayUnion: the array is read and re-written inside the
      // transaction, so the version check covers it. arrayUnion would also silently
      // de-duplicate identical rounds — and here two rounds with the same cost, the same
      // bid and the same outcome ARE identical documents, so that is data loss.
      rounds: all,
      rounds_played: all.length,
      // Denormalized for the reports' roster, which must not re-derive every round for
      // every student on every page load. `rounds` above stays the source of truth;
      // these are a cache, rewritten from it on every submit and again at Score & Record.
      profit_total: totalProfit(all),
      rounds_won: roundsWon(all),
      phase: finished ? 'debrief' : 'play',
      // ⚠ OPEN THE NEXT ROUND IN THE SAME TRANSACTION that resolved this one. The advance
      // is then atomic: there is no instant at which this round is stored and the next
      // has no recorded cost, so nothing downstream has to cope with a half-advanced
      // student. `{}` when the game is over — a finished student gets no ninth cost.
      ...nextPatch,
    }
    if (finished) patch.finished_at = FieldValue.serverTimestamp()

    tx.set(participantRef, patch, { merge: true })

    return {
      all, full: all,
      phase: finished ? ('debrief' as const) : ('play' as const),
      // The cost just written for the next round, so the response carries the SAME
      // number the next getState will return.
      nextCost: 'open_round' in nextPatch ? nextPatch.open_round.cost : null,
    }
  })

  // The NEXT round and the cost RECORDED for it by the transaction above, so the loop
  // starts without a second round trip — and so the number here is the same one the next
  // `getState` will read back, because both come from the same written record.
  const nextRound = result.phase === 'play' && result.full.length < config.rounds
    ? result.full.length + 1
    : null
  const nextCost = nextRound === null ? null : result.nextCost

  return {
    ok: true as const,
    nextRound,
    nextCost,
    // This round's card — the round-result screen (§6.4, §8). A whitelist; no rival costs.
    round: toClientResult(result.all, config.reserve),
    // The whole history so far, so the client never accumulates and cannot drift.
    history: toClientHistory(result.full),
    totalProfit: totalProfit(result.full),
    /** "A perfect player would have earned X from your draws" (§9). */
    totalEquilibriumProfit: totalEquilibriumProfit(result.full),
    roundsWon: roundsWon(result.full),
    roundsPlayed: result.full.length,
    phase: result.phase,
    gameOver: result.phase !== 'play',
  }
})
