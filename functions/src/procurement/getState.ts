import { onCall } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import { extractStudentOnCallIds } from '@mygames/game-server'
import { PROCUREMENT_CORS_ORIGINS, INSTANCES_COLLECTION, PARTICIPANTS_SUBCOLLECTION } from './config'
import { loadInstance } from './instance'
import {
  parseStoredRounds, toClientHistory, totalProfit, totalEquilibriumProfit, roundsWon,
} from './rounds'
import { clientParams, phaseOf } from './clientState'
import { drawPlayerCost } from './round'

// ═══════════════════════════════════════════════════════════════════════════════
// procurementGetState (student) — WHERE AM I? The student's whole position in one call:
// the auction parameters, the rounds they have played, and whether the game is over.
// The play screen calls this once on mount; everything after comes back from the submit
// callables.
//
// ⚠ WHAT THIS MUST NEVER RETURN (Part 1 §4):
//   • THE SEED — it derives every rival cost draw, so a student holding it could compute
//     round 5's rivals before bidding in round 4.
//   • ANY UNRESOLVED ROUND'S RIVAL COSTS. Structural rather than filtered: rival costs
//     are drawn at resolution time inside the submit transaction and do not exist before
//     it, so there is no unresolved round for a whitelist to have to omit.
//
// ⚠⚠ IT DOES RETURN ONE DRAWN NUMBER: THE PLAYER'S OWN COST FOR THE CURRENT ROUND.
// That is required — the bidding screen prints it before the student bids (§4, §6.1) —
// and it is safe for a reason that is worth stating rather than assuming: the player's
// cost comes off a SEPARATELY KEYED stream (round.ts), so holding it reveals nothing
// about the rivals' stream, and it is drawn for the CURRENT round only. Round t+1's cost
// is not computed here and is not reachable until round t is stored.
//
// It is derived, never stored: `drawPlayerCost` is pure in (seed, participantId, round),
// so a reload returns the same number without a written flag — and a student who reloads
// cannot re-roll into a friendlier cost.
//
// `clientParams` is the whitelist that enforces the first, and it enforces it by
// signature — it takes a ProcurementConfig and cannot reach the seed at all
// (clientState.ts). Firestore rules deny the client the truth/ and participants/ paths
// this data lives on, so a callable is the ONLY way a student sees any of it.
// ═══════════════════════════════════════════════════════════════════════════════

export const procurementGetState = onCall({ cors: PROCUREMENT_CORS_ORIGINS }, async (request) => {
  const data = request.data as Record<string, unknown>
  const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true'
  const authHeader = request.rawRequest.headers.authorization as string | undefined

  const { participantId, gameInstanceId } = await extractStudentOnCallIds(data, isEmulator, authHeader)

  const db = admin.firestore()
  // ⚠ `seed` is destructured for ONE use — `drawPlayerCost` for the current round, see
  // the header — and for nothing else. It is not in `clientParams`' reach and it does
  // not appear in the return below.
  const { config, seed } = await loadInstance(db, gameInstanceId)

  const snap = await db
    .collection(INSTANCES_COLLECTION).doc(gameInstanceId)
    .collection(PARTICIPANTS_SUBCOLLECTION).doc(participantId)
    .get()
  const pData = snap.data() ?? {}

  const stored = parseStoredRounds(pData.rounds)
  const phase = phaseOf(pData)

  // The round the student is about to play, 1-based. Null once every round is stored —
  // and the cost goes with it, so a finished student is never handed a ninth draw.
  const currentRound = phase === 'play' && stored.length < config.rounds
    ? stored.length + 1
    : null
  const currentCost = currentRound === null
    ? null
    : drawPlayerCost(seed, participantId, currentRound, config)

  return {
    ok: true as const,
    /** Everything the bidding screen prints (Part 1 §6.1, Part 2 §5.1), and nothing else. */
    params: clientParams(config),
    /** What they have earned by playing. Resolved rounds only. */
    played: toClientHistory(stored),
    /** The display tally (Part 1 §2) — no carryover state beyond this. */
    totalProfit: totalProfit(stored),
    /** "A perfect player would have earned X from your draws" (§9). Realized rounds
     *  only — it is a benchmark against what actually happened, not a projection. */
    totalEquilibriumProfit: totalEquilibriumProfit(stored),
    roundsWon: roundsWon(stored),
    roundsPlayed: stored.length,
    /** The round to play next, and the cost drawn for it. Both null when there is none. */
    currentRound,
    currentCost,
    /**
     * ⚠ THE ROUND COUNT IS SHOWN IN THIS GAME. Unlike PD and Pricing, there is no hidden
     * horizon to protect: eight rounds are independent, so there is no endgame effect
     * that knowing the count would let a student exploit. `params.rounds` carries it and
     * the screen prints "Round k of N".
     */
    phase,
    gameOver: phase === 'debrief' || phase === 'done',
  }
})
