import { onCall, HttpsError } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import { extractStudentOnCallIds } from '@mygames/game-server'
import {
  SCORECARD_CORS_ORIGINS, INSTANCES_COLLECTION, PARTICIPANTS_SUBCOLLECTION, renderLabel,
} from './config'
import { loadInstance, ensureStartsWith } from './instance'
import {
  parseStoredContracts, positionOf, phaseOf, upcomingContract, totalEarnings,
} from './state'
import {
  clientParams, toClientContract, toClientResult, freshClientContract, screenId,
} from './clientState'

// ═══════════════════════════════════════════════════════════════════════════════
// scorecardGetState (student) — WHERE AM I? The whole position in one call: the
// parameters, the contract in play, the contracts finished, and whether the session is
// over. The play screen calls this on mount; everything after comes from
// scorecardSubmitPeriod.
//
// ⚠⚠ WHAT THIS MUST NEVER RETURN (spec §8, §13):
//   • BOTH RELIABILITIES. The student is not told there are exactly two conditions.
//     `clientParams` takes a ScorecardConfig and cannot reach a ScorecardTruth at all.
//   • THE SCHEDULE, or that reliability alternates, or the counterbalancing.
//   • THE NEXT CONTRACT'S RELIABILITY before that contract starts — see `advance` below.
//   • ANY FIELD ANNOUNCING THAT THE TARGET IS UNREACHABLE (spec §4.1). The reached-target
//     flag DOES ship; the asymmetry is deliberate (clientState.ts).
//   • THE SEED, the DP, or any benchmark.
//
// ── ⚠ THE `advance` ARGUMENT ─────────────────────────────────────────────────
//
// A student sitting at contract-result presses Continue; the client calls this with
// `advance: true` and gets the NEXT contract's period 1, with its label. Nothing is
// written — the condition is derived from the stored `startsWith` on the spot — so the
// next contract's reliability does not exist in the database until its first period is
// submitted (state.ts, S8).
//
// ⚠ IT IS GATED, WHICH IS WHAT STOPS IT BEING A PEEK-AHEAD. It is honoured ONLY when the
// student is genuinely at contract-result. A mid-contract student who calls it is
// refused and learns nothing; a student at contract-result learns the condition of the
// contract they are entitled to begin, and nothing about the one after it.
// ═══════════════════════════════════════════════════════════════════════════════

export const scorecardGetState = onCall({ cors: SCORECARD_CORS_ORIGINS }, async (request) => {
  const data = request.data as Record<string, unknown>
  const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true'
  const authHeader = request.rawRequest.headers.authorization as string | undefined

  const { participantId, gameInstanceId } = await extractStudentOnCallIds(data, isEmulator, authHeader)
  const advance = data.advance === true

  const db = admin.firestore()
  // `truth` is loaded but NEVER forwarded: only `renderLabel` and `upcomingContract`
  // touch it, and each returns one contract's worth of information.
  const { config, truth } = await loadInstance(db, gameInstanceId)

  const participantRef = db
    .collection(INSTANCES_COLLECTION).doc(gameInstanceId)
    .collection(PARTICIPANTS_SUBCOLLECTION).doc(participantId)

  // ⚠ `startsWith` is assigned on FIRST TOUCH — and a student's first touch is normally
  // this call, not a submit. It is a transaction because the join counter must not be
  // taken twice (instance.ts); on every later call the transaction reads the existing
  // value and writes nothing to the counter.
  const { startsWith } = await db.runTransaction(async (tx) => {
    const snap = await tx.get(participantRef)
    const pData = snap.data() ?? {}
    const assigned = await ensureStartsWith(tx, db, gameInstanceId, pData)
    if (assigned.assignedNow) {
      tx.set(participantRef, {
        participant_id: participantId,
        game_instance_id: gameInstanceId,
        starts_with: assigned.startsWith,
      }, { merge: true })
    }
    return assigned
  })

  const snap = await participantRef.get()
  const pData = snap.data() ?? {}
  const contracts = parseStoredContracts(pData.contracts, config)
  const position = positionOf(contracts, config, pData.finished_at != null)

  const labelFor = (condition: 'high' | 'low') =>
    config.showReliabilityLabel ? renderLabel(truth, condition) : null

  // ── The advance transition (see the header) ────────────────────────────────
  let effective = position
  let upcoming: ReturnType<typeof upcomingContract> | null = null
  if (advance) {
    if (position.kind !== 'contract-result') {
      throw new HttpsError('failed-precondition',
        'There is no finished contract to move on from. Please reload the page.')
    }
    const next = contracts.length + 1
    upcoming = upcomingContract(next, startsWith, config, truth)
    effective = { kind: 'effort-choice', contract: next, period: 1 }
  }

  const current = contracts[contracts.length - 1]
  const completed = contracts.filter(c => c.periods.length >= config.periodsPerContract)

  return {
    ok: true as const,
    params: clientParams(config),
    screen: { id: screenId(effective), kind: effective.kind },
    /**
     * The contract in play. Three cases: a fresh session (no stored contract yet), an
     * in-progress contract, or the one just advanced into.
     */
    contract:
      effective.kind !== 'effort-choice' ? null
      : upcoming ? freshClientContract(
          effective.contract!, upcoming.reliability, labelFor(upcoming.condition), config)
      : current && current.periods.length < config.periodsPerContract
        ? toClientContract(current, config, labelFor(current.condition))
      : freshClientContract(
          1,
          upcomingContract(1, startsWith, config, truth).reliability,
          labelFor(upcomingContract(1, startsWith, config, truth).condition),
          config,
        ),
    /** The finished contract being looked at, on the contract-result screen. */
    result: effective.kind === 'contract-result' && current
      ? toClientResult(current, config, labelFor(current.condition))
      : null,
    /** ⚠ Contracts already PLAYED carry their reliability — spec §4's session summary
     *  requires the column, and these contracts are over. */
    completed: completed.map(c => toClientResult(c, config, labelFor(c.condition))),
    totalEarnings: totalEarnings(contracts, config),
    contractsCompleted: completed.length,
    phase: phaseOf(effective),
    gameOver: effective.kind === 'session-summary',
  }
})
