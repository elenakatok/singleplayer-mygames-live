import { onCall } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import { extractStudentOnCallIds } from '@mygames/game-server'
import { NEWSVENDOR_CORS_ORIGINS, INSTANCES_COLLECTION, PARTICIPANTS_SUBCOLLECTION } from './config'
import { loadInstance } from './instance'
import { parseStoredRounds, toClientHistory, totals, averageOrder, averageServiceLevel } from './rounds'
import { clientParams, phaseOf } from './clientState'

// ═══════════════════════════════════════════════════════════════════════════════
// newsvendorGetState (student) — WHERE AM I? The student's whole position in one
// call: the parameters they are ordering against, what they have played so far, and
// whether the game is over. The play screen calls this once on mount; everything
// after that comes back from newsvendorSubmitRound.
//
// ⚠ WHAT THIS MUST NEVER RETURN:
//   • the BENCHMARK — Q_opt, the critical ratio, profitOpt, or the optimality gap
//     (spec §9.2: computed and stored for reports only, never shown to the student,
//     not during play and not on the final screen);
//   • the SEED — it derives every future demand draw (demand.ts), so a student who
//     held it could compute period 12's demand before ordering in period 11.
// clientParams() is the whitelist that enforces both, and it is the same one
// newsvendorSubmitRound builds its response from.
//
// ⚠ UNLIKE PRICING, THE PERIOD COUNT IS PUBLIC. `periods` is config and the screen
// says "Period k of N" (spec §7a). This game has no hidden horizon and no end-game
// reasoning to protect against — the thing kept hidden here is the benchmark, not
// the length.
//
// Firestore rules deny the client the truth/ and participants/ paths this data lives
// on, so a callable is the ONLY way a student sees any of it.
// ═══════════════════════════════════════════════════════════════════════════════

export const newsvendorGetState = onCall({ cors: NEWSVENDOR_CORS_ORIGINS }, async (request) => {
  const data = request.data as Record<string, unknown>
  const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true'
  const authHeader = request.rawRequest.headers.authorization as string | undefined

  const { participantId, gameInstanceId } = await extractStudentOnCallIds(data, isEmulator, authHeader)

  const db = admin.firestore()
  // `seed` is deliberately NOT destructured — see the header.
  const { config } = await loadInstance(db, gameInstanceId)

  const snap = await db
    .collection(INSTANCES_COLLECTION).doc(gameInstanceId)
    .collection(PARTICIPANTS_SUBCOLLECTION).doc(participantId)
    .get()
  const pData = snap.data() ?? {}

  const stored = parseStoredRounds(pData.rounds)
  const sums = totals(stored)
  const phase = phaseOf(pData)

  return {
    ok: true as const,
    /** Everything the place-order screen prints (spec §7a), and nothing else. */
    params: clientParams(config),
    /** What they have earned by playing. Periods PLAYED only. */
    history: toClientHistory(stored),
    /** Running totals (spec §7c, §7d) — realized only; the benchmark total is not here. */
    totalProfit: sums.student,
    averageProfit: stored.length === 0 ? 0 : sums.student / stored.length,
    averageOrder: averageOrder(stored) ?? 0,
    averageServiceLevel: averageServiceLevel(stored) ?? 0,
    periodsPlayed: stored.length,
    /**
     * Where they are in the flow, derived from the stored finish stamp rather than
     * from re-counting periods, so the read path and the write path agree on one fact.
     */
    phase,
    gameOver: phase === 'debrief',
  }
})
