import { onCall, HttpsError } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import { FieldValue } from 'firebase-admin/firestore'
import { extractStudentOnCallIds } from '@mygames/game-server'
import {
  PROCUREMENT_CORS_ORIGINS, INSTANCES_COLLECTION, PARTICIPANTS_SUBCOLLECTION,
} from './config'
import { loadInstance } from './instance'
import { PLAYER_ID } from './round'
import { nextOpenRoundPatch } from './openRound'
import {
  parseStoredRounds, toClientHistory, totalProfit, roundsWon,
  type StoredRound,
} from './rounds'
import { phaseOf } from './clientState'
import {
  advanceOne, playerBid, playerDropOut, lastPlayerBid, lastBotBids,
  type OpenSettings, type OpenState,
} from './auction/openAuction'
import {
  ensureRoundOpen, serializeAuction, playedAtNow,
  botCostsDocId, botCostsPatch, drawBotCosts,
} from './openAuctionStore'
import { toClientAuction, type ClientAuction } from './openView'

// ═══════════════════════════════════════════════════════════════════════════════
// OPEN DESCENDING — the three student callables of §4.6:
//
//   procurementAdvance   the client asks "is a bot due?"; the server commits ONE bot bid
//   procurementSubmitBid the player bids            (routed here from submitBid.ts)
//   procurementDropOut   the player quits           (open §4.5 — this format only)
//
// ⚠⚠ ONE BOT BID, ONE SERVER COMMIT. Nothing advances without a commit, so the committed
// standing IS what the screen shows. See `auction/openAuction.ts`'s header for why the
// precomputed-and-animated build is rejected rather than merely disliked.
//
// ⚠⚠ THE CLIENT CONTROLS ONLY *WHEN* TO ASK. `advanceOne` recomputes the decision from
// stored state and checks `nextBotAtMs` itself, so a client that calls early gets its own
// state back and nothing is written (§8.3 case 11). There is no field on any of these
// requests through which a caller could say what a bot bids.
//
// ⚠ ~16 INVOCATIONS PER ROUND, ~128 PER STUDENT PER ASSIGNMENT (§4.6). Recorded as a
// known consequence: trivial at these class sizes, but this is the first single-player
// game with chatty server calls, and the FIRST call of a session is usually a cold start.
//
// ⚠ NO TIMEOUT, EVER (§4.4). A round may wait forever; that is correct rather than a
// compromise, because a single player who sits idle blocks nobody.
// ═══════════════════════════════════════════════════════════════════════════════

/** What a turn did. `rejected` carries a bid refusal — which is NOT an exception: the
 *  screen must show the refusal AND the price that moved under it (§4.6). */
type Turn =
  | { kind: 'advance' }
  | { kind: 'bid'; amount: number; sequence: number | null }
  | { kind: 'dropOut' }

export interface OpenTurnResponse {
  ok: true
  auction: ClientAuction
  /** The student's own drawn cost for the round the auction belongs to. */
  yourCost: number
  /** Set when the bid was refused. The auction above is the CURRENT truth either way. */
  rejected: string | null
  /** Set by the action that ENDED the round. Deliberately spare — §5.2's round-result
   *  screen is CP4b and is not built here. */
  roundOutcome: {
    round: number
    yourCost: number
    yourLastBid: number | null
    won: boolean
    price: number | null
    profit: number
    profitTotal: number
    droppedOut: boolean
  } | null
  history: ReturnType<typeof toClientHistory>
  totalProfit: number
  roundsWon: number
  roundsPlayed: number
  nextRound: number | null
  phase: ReturnType<typeof phaseOf>
  gameOver: boolean
}

/**
 * The resolved round, as stored.
 *
 * ⚠ `eq_bid`/`eq_won`/`eq_profit` ARE NULL/FALSE/0 FOR EVERY OPEN ROUND, and that is the
 * shape rather than a stub. β is the SEALED first-price equilibrium (Part 1 §5.1); there
 * is no equivalent closed form for this mechanism, and the open format's benchmark is the
 * Tier-3 exit-price scatter (§7) instead. Writing β here would put a number the student
 * could not have used into a column labelled "what you should have bid".
 *
 * ⚠ NO EXIT PRICE. §9 step 6 (CP4b) owns exit-price capture including the winner-censoring
 * distinction. `open_history` below is the record it will derive one from for any round
 * played before then. See BUILD_NOTES.
 */
function resolvedRoundRecord(
  round: number,
  cost: number,
  botCosts: readonly number[],
  state: OpenState,
  s: OpenSettings,
): StoredRound {
  const won = state.winnerId === PLAYER_ID
  return {
    round,
    cost,
    // ⚠ NULL IS MEANINGFUL: the player never bid at all. It is not a bid of zero, and
    // `parseStoredRounds` preserves the distinction for exactly this reason.
    bid: lastPlayerBid(state, s),
    won,
    price: state.price,
    // Part 1 §7 step 5, unchanged by the mechanism: a LOSING supplier incurs no cost, so
    // a loss is 0 and never negative. A winner's profit CAN be negative — bidding below
    // your own cost is legal and never blocked (§8.3 case 4).
    profit: won && state.price !== null ? state.price - cost : 0,
    played_at: playedAtNow(),
    rival_costs: [...botCosts],
    rival_bids: lastBotBids(state, s),
    winner_id: state.winnerId,
    // ⚠ PRICE TIES ARE IMPOSSIBLE IN THIS FORMAT (§4.3): every bid must undercut by at
    // least the step, so an equal bid is illegal. These are false by construction, not by
    // omission.
    tie: false,
    tied_and_lost: false,
    eq_bid: null,
    eq_won: false,
    eq_profit: 0,
    open_history: serializeAuction(round, state).open_auction.history,
  }
}

/**
 * One turn of the open format: read the truth, apply exactly one action, write once.
 *
 * ⚠ EVERY ACTION IS ONE TRANSACTION. Two tabs, a double-click or a retry cannot both
 * commit the same bot bid, because the read of `open_auction` and the write of its
 * successor are inside one version-checked transaction — the same discipline as
 * `ensureOpenRound`, for the same reason.
 */
async function runOpenTurn(
  request: { data: unknown; rawRequest: { headers: Record<string, unknown> } },
  turn: Turn,
): Promise<OpenTurnResponse> {
  const data = request.data as Record<string, unknown>
  const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true'
  const authHeader = request.rawRequest.headers.authorization as string | undefined

  const { participantId, gameInstanceId } = await extractStudentOnCallIds(data, isEmulator, authHeader)

  const db = admin.firestore()
  const { config, seed } = await loadInstance(db, gameInstanceId)

  // ⚠ THE MIRROR OF submitBid's SEALED GUARD. One mechanism per instance is the whole
  // point of the `format` lock; an open callable must not act on a sealed instance any
  // more than the reverse.
  if (config.format !== 'open_descending') {
    throw new HttpsError('failed-precondition',
      'This instance runs the sealed-bid format, which has no live auction.')
  }

  const instanceRef = db.collection(INSTANCES_COLLECTION).doc(gameInstanceId)
  const participantRef = instanceRef.collection(PARTICIPANTS_SUBCOLLECTION).doc(participantId)
  const truthRef = instanceRef.collection('truth').doc(botCostsDocId(participantId))

  const nowMs = Date.now()

  return db.runTransaction(async (tx) => {
    const [pSnap, tSnap] = await Promise.all([tx.get(participantRef), tx.get(truthRef)])
    const pData = pSnap.data() ?? {}
    const truthData = tSnap.data()

    const stored = parseStoredRounds(pData.rounds)
    if (pData.finished_at != null || stored.length >= config.rounds) {
      throw new HttpsError('failed-precondition', 'Your game is over — there are no more rounds.')
    }
    const round = stored.length + 1

    const opened = ensureRoundOpen(
      tx, participantRef, truthRef, pData, truthData, round, seed, participantId, config, nowMs)
    const { cost, settings } = opened

    // ── apply exactly one action ────────────────────────────────────────────
    let next = opened.state
    let rejected: string | null = null
    let changed = opened.wrote

    if (turn.kind === 'advance') {
      // ⚠ THE TIMING CHECK IS INSIDE `advanceOne`, on the server. An early call returns
      // the same state object and writes nothing.
      const r = advanceOne(opened.state, settings, nowMs)
      next = r.state
      changed = changed || r.committed
    } else if (turn.kind === 'bid') {
      const r = playerBid(opened.state, settings, turn.amount, turn.sequence, nowMs)
      if (r.ok) {
        next = r.state
        changed = true
      } else {
        // ⚠ NOT AN EXCEPTION. The screen must show the refusal AND the price that moved
        // under it — "the price moved to 46… minimum next bid is 44" is useless without
        // the 46 (§4.6). Throwing would discard the payload that makes it actionable.
        rejected = r.reason
      }
    } else {
      const r = playerDropOut(opened.state, settings, nowMs)
      changed = changed || r !== opened.state
      next = r
    }

    // ── the round did NOT end: persist the state and stop ───────────────────
    if (next.status !== 'resolved') {
      if (changed) tx.set(participantRef, serializeAuction(round, next), { merge: true })
      return {
        ok: true as const,
        auction: toClientAuction(round, next, settings),
        yourCost: cost,
        rejected,
        roundOutcome: null,
        history: toClientHistory(stored),
        totalProfit: totalProfit(stored),
        roundsWon: roundsWon(stored),
        roundsPlayed: stored.length,
        nextRound: round,
        phase: phaseOf(pData),
        gameOver: false,
      }
    }

    // ── the round ENDED: append it, and open the next one's draws ───────────
    const record = resolvedRoundRecord(round, cost, opened.botCosts, next, settings)
    const all = [...stored, record]
    const finished = all.length >= config.rounds

    // ⚠ WHOLE-ARRAY WRITE, NOT arrayUnion — the array is read and rewritten inside this
    // transaction so the version check covers it, and arrayUnion would silently
    // de-duplicate two genuinely identical rounds.
    const patch: Record<string, unknown> = {
      participant_id: participantId,
      game_instance_id: gameInstanceId,
      rounds: all,
      rounds_played: all.length,
      profit_total: totalProfit(all),
      rounds_won: roundsWon(all),
      phase: finished ? 'debrief' : 'play',
      // The resolved auction, kept for this response. The NEXT round's state is opened
      // lazily — see `ensureRoundOpen` — and `parseAuction`'s round check makes this one
      // read as absent the moment the student moves on.
      ...serializeAuction(round, next),
      // The next round's own cost, drawn by the transaction that resolved this one, so
      // the advance is atomic. `{}` when the game is over.
      ...nextOpenRoundPatch(finished ? null : round + 1, seed, participantId, config),
    }
    if (finished) patch.finished_at = FieldValue.serverTimestamp()
    tx.set(participantRef, patch, { merge: true })

    // ⚠ AND THE NEXT ROUND'S BOT COSTS, TO THE RULES-DENIED TRUTH DOC. §4 permits costs
    // drawn early precisely on condition that they live there. Nothing student-reachable
    // is written here, and the client payload below carries no cost of any kind.
    if (!finished) {
      tx.set(truthRef,
        botCostsPatch(round + 1, drawBotCosts(seed, participantId, round + 1, config)),
        { merge: true })
    }

    return {
      ok: true as const,
      auction: toClientAuction(round, next, settings),
      yourCost: cost,
      rejected,
      roundOutcome: {
        round,
        yourCost: cost,
        yourLastBid: record.bid,
        won: record.won,
        price: record.price,
        profit: record.profit,
        profitTotal: totalProfit(all),
        droppedOut: next.playerOut,
      },
      history: toClientHistory(all),
      totalProfit: totalProfit(all),
      roundsWon: roundsWon(all),
      roundsPlayed: all.length,
      nextRound: finished ? null : round + 1,
      phase: finished ? ('debrief' as const) : ('play' as const),
      gameOver: finished,
    }
  })
}

// ── the callables ──────────────────────────────────────────────────────────────

/**
 * "Is a bot due?" — the client's tick. Commits at most ONE bot bid (§4.6).
 *
 * ⚠ SAFE TO CALL AT ANY MOMENT, INCLUDING FROM A TAB THAT HAS BEEN ASLEEP FOR AN HOUR.
 * Early → nothing happens. Late → the one bid that was due, with the next scheduled from
 * now rather than from when it should have been, so nobody comes back to a burst.
 */
export const procurementAdvance = onCall({ cors: PROCUREMENT_CORS_ORIGINS }, (request) =>
  runOpenTurn(request as never, { kind: 'advance' }))

/**
 * Drop Out — a deliberate strategic action, recorded as PLAY (§4.5). This format only:
 * the sealed format requires a bid (Part 1 §6.3).
 *
 * ⚠ FINAL. The price only falls, so re-entry would be incoherent rather than merely
 * inconvenient. The remaining bots then settle immediately among themselves and the
 * player is still shown where it landed — watching the price settle after you quit is
 * most of the lesson.
 */
export const procurementDropOut = onCall({ cors: PROCUREMENT_CORS_ORIGINS }, (request) =>
  runOpenTurn(request as never, { kind: 'dropOut' }))

/**
 * The player's bid, routed here by `procurementSubmitBid` when the instance is open.
 *
 * ⚠ `sequence` IS DECLARED, NOT ENFORCED (§4.6). A stale one never rejects on its own —
 * the bid is re-checked against the CURRENT standing and accepted if it still clears. It
 * changes only the wording of a refusal.
 */
export function openSubmitBid(
  request: { data: unknown; rawRequest: { headers: Record<string, unknown> } },
  amount: number,
  sequence: number | null,
): Promise<OpenTurnResponse> {
  return runOpenTurn(request, { kind: 'bid', amount, sequence })
}
