import { onCall } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import { extractStudentOnCallIds } from '@mygames/game-server'
import {
  FORECAST_CORS_ORIGINS, INSTANCES_COLLECTION, PARTICIPANTS_SUBCOLLECTION, BONUS_AT_PERFECT,
} from './config'
import { loadInstance } from './instance'
import { parseStoredRounds, toClientHistory, toPoints } from './rounds'
import { runningMetrics, yearComparison } from './metrics'
import { clientParams, clientHistory, phaseOf } from './clientState'

// ═══════════════════════════════════════════════════════════════════════════════
// forecastGetState (student) — WHERE AM I? The student's whole position in one call:
// the parameters, the five-year history every student shares, the months they have
// played, and whether the game is over. The play screen calls this once on mount;
// everything after that comes back from forecastSubmitRound.
//
// ⚠ WHAT THIS MUST NEVER RETURN (spec §4, §12):
//   • THE MODEL — a, b, H, σ, highSeasonMonths. Explaining the systematic component IS
//     the exercise (spec §7); handing it over ends the game.
//   • THE SEED — it derives every future draw, so a student holding it could compute
//     month 12's demand before forecasting month 11.
//   • ANY UNPLAYED MONTH'S DEMAND. Structural rather than filtered: an unplayed month
//     has no stored record to omit (rounds.ts), and `history` below is the COMMON
//     five years, which are revealed to everyone by design.
//
// `clientParams` is the whitelist that enforces the first two, and it enforces them by
// signature: it takes a ForecastConfig and cannot reach a ForecastModel at all
// (clientState.ts). The same whitelist builds forecastSubmitRound's response.
//
// Firestore rules deny the client the truth/ and participants/ paths this data lives
// on, so a callable is the ONLY way a student sees any of it.
// ═══════════════════════════════════════════════════════════════════════════════

export const forecastGetState = onCall({ cors: FORECAST_CORS_ORIGINS }, async (request) => {
  const data = request.data as Record<string, unknown>
  const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true'
  const authHeader = request.rawRequest.headers.authorization as string | undefined

  const { participantId, gameInstanceId } = await extractStudentOnCallIds(data, isEmulator, authHeader)

  const db = admin.firestore()
  // `model` and `seed` are deliberately NOT destructured — see the header. The only
  // thing taken off the instance besides the config is the COMMON history, which is
  // not secret: the opening screen shows all sixty months of it.
  const { config, history } = await loadInstance(db, gameInstanceId)

  const snap = await db
    .collection(INSTANCES_COLLECTION).doc(gameInstanceId)
    .collection(PARTICIPANTS_SUBCOLLECTION).doc(participantId)
    .get()
  const pData = snap.data() ?? {}

  const stored = parseStoredRounds(pData.rounds)
  const points = toPoints(stored)
  const phase = phaseOf(pData)

  return {
    ok: true as const,
    /** Everything the forecast-entry screen prints (spec §4), and nothing else. */
    params: clientParams(config, BONUS_AT_PERFECT),
    /** The COMMON five years — the chart, the month-by-year grid, and the in-play CSV
     *  all render from this one array (spec §2.2, §4). Byte-identical across students
     *  by construction: no participant id enters resolveHistory. */
    history: clientHistory(history),
    /** What they have earned by playing. Months PLAYED only. */
    played: toClientHistory(stored),
    /** MAE · MSE · Standard Error · MAPE · Accuracy · bonus · bias (spec §4, §5). */
    running: runningMetrics(points),
    /** Y6 vs Y7 (spec §5) — `improved` is null until both years exist. */
    years: yearComparison(points),
    roundsPlayed: stored.length,
    /**
     * Where they are in the flow, derived from the stored finish stamp rather than
     * from re-counting months, so the read path and the write path agree on one fact.
     */
    phase,
    gameOver: phase === 'debrief',
  }
})
