import { onCall } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import { extractStudentOnCallIds } from '@mygames/game-server'
import { PROCUREMENT_CORS_ORIGINS, INSTANCES_COLLECTION, PARTICIPANTS_SUBCOLLECTION } from './config'
import { loadInstance } from './instance'
import {
  parseStoredRounds, toClientHistory, totalProfit, totalEquilibriumProfit, roundsWon,
  toRevealPoints,
} from './rounds'
import { clientParams, phaseOf } from './clientState'
import { ensureOpenRound } from './openRound'

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
// and it is safe for a reason worth stating rather than assuming: the player's cost is
// their own, and it is opened for the CURRENT round only. Round t+1's cost does not exist
// until round t resolves.
//
// ⚠⚠ IT IS RECORDED, NOT DERIVED, AND THIS READ PATH WRITES IT (§4: "drawn and written
// when the round opens"). `ensureOpenRound` draws once, stores it, and returns the stored
// value ever after. CP3a derived it instead and shipped a production bug: with no seed —
// the normal classroom case — `makeRng` falls back to `Math.random` and ignores its key,
// so the screen showed one cost and the round resolved against another. See openRound.ts.
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

  const participantRef = db
    .collection(INSTANCES_COLLECTION).doc(gameInstanceId)
    .collection(PARTICIPANTS_SUBCOLLECTION).doc(participantId)
  const snap = await participantRef.get()
  const pData = snap.data() ?? {}

  const stored = parseStoredRounds(pData.rounds)
  const phase = phaseOf(pData)

  // The round the student is about to play, 1-based. Null once every round is stored —
  // and the cost goes with it, so a finished student is never handed a ninth draw.
  const currentRound = phase === 'play' && stored.length < config.rounds
    ? stored.length + 1
    : null
  // ⚠ WRITES on a read path, deliberately — see the header. The round has to be opened
  // before the student can be shown anything about it.
  const currentCost = currentRound === null
    ? null
    : await ensureOpenRound(db, participantRef, currentRound, seed, participantId, config)

  // ── The §9 scatter's bot series ────────────────────────────────────────────
  //
  // ⚠⚠ THE ONE PLACE A RIVAL COST LEAVES THE SERVER, AND IT IS GATED ON `finished_at`.
  // The stamp is written by the transaction that resolves the LAST round, so this is
  // null for every student who still has a bid to make — including one sitting on the
  // round-8 bidding screen. Gated on the stamp rather than on `stored.length >= rounds`
  // deliberately: the stamp is the fact the server itself wrote, and a config change
  // mid-assignment cannot make a count-based gate open early.
  //
  // Why it is safe here and nowhere else: the rounds are independent (§2), so these
  // points predict no future draw — and the scatter's whole argument is that the bots sit
  // exactly on the optimal line, which requires their costs on the x-axis. See §9.
  const finished = pData.finished_at != null
  const revealRivalPoints = finished ? toRevealPoints(stored) : null

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
    /** ⚠ null until `finished_at` is stamped. See above — this is the gate. */
    revealRivalPoints,
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
