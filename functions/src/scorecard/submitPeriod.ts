import { onCall, HttpsError } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import { FieldValue, Timestamp } from 'firebase-admin/firestore'
import { extractStudentOnCallIds } from '@mygames/game-server'
import {
  SCORECARD_CORS_ORIGINS, INSTANCES_COLLECTION, PARTICIPANTS_SUBCOLLECTION, renderLabel,
} from './config'
import { loadInstance, ensureStartsWith } from './instance'
import { resolvePeriod, settleContract, type EffortAction } from './resolve'
import { periodDraw } from './rng'
import {
  parseStoredContracts, positionOf, phaseOf, upcomingContract, toPeriodRecords,
  totalEarnings, legalSubmit, type StoredContract, type StoredPeriod,
} from './state'
import { toClientContract, toClientResult, screenId, clientParams } from './clientState'

// ═══════════════════════════════════════════════════════════════════════════════
// scorecardSubmitPeriod (student) — ONE period: the family's COMPUTE STEP (spec §4).
//
//   choose High or Low  →  draw u for (this student, this contract, this period)
//                       →  acceptable?  →  score, balance
//                       →  append  →  settle if this was the last period  →  reveal
//
// ⚠⚠ THE DRAW HAPPENS AFTER THE CHOICE IS COMMITTED, IN THE SAME TRANSACTION (S5,
// architecture §5.3). There is no moment at which an outcome exists and the student's
// choice does not: no second callable, no pre-generated draws, no partially-written doc
// can hand a student this period's result before they have committed this period's
// action. `resolvePeriod` is called below the submit-and-lock checks, inside the
// transaction body, and its result is written and returned in one commit.
//
// ⚠⚠ THE DRAW IS WRITTEN, NOT DERIVED (S1). `u` and `reliability_used` both go into the
// stored record. This is the CP3 production blocker's rule: `unit()` returns
// `Math.random()` when the seed is null, and CLASSROOM INSTANCES SET NO SEED — so
// anything re-derived on read comes back different every time, in production only.
//
// SUBMIT-AND-LOCK + IDEMPOTENCY (S6, family rule). A period already stored can never be
// revised: a resubmit for a period ≤ what is stored DISCARDS the incoming action and
// returns the stored state untouched, so a retry cannot trigger a SECOND draw and quietly
// hand the student a friendlier one. Enforced inside the transaction.
//
// ⚠ THE NEXT CONTRACT'S RELIABILITY IS NOT IN THE RESPONSE. When a contract settles this
// returns the contract-result screen and stops. The next contract's condition is not
// omitted from the payload — it is never computed on this path at all (state.ts, S8).
// ═══════════════════════════════════════════════════════════════════════════════

export const scorecardSubmitPeriod = onCall({ cors: SCORECARD_CORS_ORIGINS }, async (request) => {
  const data = request.data as Record<string, unknown>
  const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true'
  const authHeader = request.rawRequest.headers.authorization as string | undefined

  const { participantId, gameInstanceId } = await extractStudentOnCallIds(data, isEmulator, authHeader)

  const action = data.action
  if (action !== 'high' && action !== 'low') {
    throw new HttpsError('invalid-argument', 'action must be "high" or "low".')
  }
  // Which contract and period the client believes it is on. Both are CLAIMS TO VERIFY
  // against the server's own count — never the source of truth. They are what make a
  // retry idempotent instead of a second period with a second draw.
  const contractNumber = data.contract
  const periodNumber = data.period
  const posInt = (v: unknown): v is number =>
    typeof v === 'number' && Number.isInteger(v) && v >= 1
  if (!posInt(contractNumber) || !posInt(periodNumber)) {
    throw new HttpsError('invalid-argument', 'contract and period must be positive integers.')
  }

  const db = admin.firestore()
  const { config, truth } = await loadInstance(db, gameInstanceId)

  const participantRef = db
    .collection(INSTANCES_COLLECTION).doc(gameInstanceId)
    .collection(PARTICIPANTS_SUBCOLLECTION).doc(participantId)

  const result = await db.runTransaction(async (tx) => {
    const snap = await tx.get(participantRef)
    const pData = snap.data() ?? {}
    // No belongs check — the doc IS under this instance (S2, structural isolation).

    // ⚠ Assigned on FIRST TOUCH and never again (instance.ts). Inside this transaction,
    // so two concurrent first submits cannot both take the same join ordinal.
    const { startsWith } = await ensureStartsWith(tx, db, gameInstanceId, pData)

    const contracts = parseStoredContracts(pData.contracts, config)
    const finishedAlready = pData.finished_at != null
    const position = positionOf(contracts, config, finishedAlready)

    // ── Already played: return it, write nothing, DRAW NOTHING. ────────────────
    const existing = contracts[contractNumber - 1]
    if (existing && periodNumber <= existing.periods.length) {
      return { contracts, startsWith, replayed: true as const }
    }

    // ── Ordering: periods are played in order, one at a time, no skipping. ────
    // ⚠ THE RULE LIVES IN `legalSubmit` (state.ts), pure and unit-tested — including the
    // contract-boundary case that broke every session at contract 2 period 1 during CP2.
    // Do not re-inline it here.
    const verdict = legalSubmit(position, contractNumber, periodNumber, config)
    if (!verdict.legal) {
      throw new HttpsError('failed-precondition', verdict.reason === 'session-over'
        ? 'Your session is over — there are no more contracts.'
        : 'That is not the period you are on. Please reload the page.')
    }

    // ── Materialise the contract on its first period ──────────────────────────
    // ⚠ THE CONDITION IS FIXED HERE, ONCE, AND WRITTEN. From this point the contract
    // carries its own condition and reliability; nothing re-derives them. An instructor
    // who edits `reliabilitySchedule` mid-session cannot retroactively rewrite what a
    // student already played (spec §14.1).
    let contract: StoredContract
    if (contractNumber <= contracts.length) {
      contract = contracts[contractNumber - 1]
    } else {
      const upcoming = upcomingContract(contractNumber, startsWith, config, truth)
      contract = {
        contract: contractNumber,
        condition: upcoming.condition,
        reliability: upcoming.reliability,
        periods: [],
      }
      contracts.push(contract)
    }

    // ── The compute step (S5) ─────────────────────────────────────────────────
    const prev = contract.periods[contract.periods.length - 1]
    const record = resolvePeriod(
      {
        period: periodNumber,
        action: action as EffortAction,
        // ⚠ THE CONTRACT'S OWN STORED RELIABILITY, not a freshly derived one.
        reliability: contract.reliability,
        condition: contract.condition,
        score: prev?.score ?? 0,
        balance: prev?.balance ?? config.endowmentPerContract,
        rules: config,
      },
      periodDraw(truth.seed, participantId, contractNumber, periodNumber),
    )

    const stored: StoredPeriod = {
      period: record.period,
      action: record.action,
      u: record.u,                                  // ⚠ WRITTEN (S1)
      acceptable: record.acceptable,
      reliability_used: record.reliabilityUsed,     // ⚠ WRITTEN (spec §14.1)
      score: record.score,
      balance: record.balance,
    }
    contract.periods.push(stored)

    // ── Settle the contract if that was its last period (spec §1) ─────────────
    const contractComplete = contract.periods.length >= config.periodsPerContract
    if (contractComplete) {
      const settled = settleContract(toPeriodRecords(contract), config)
      contract.high_effort_periods = settled.highEffortPeriods
      contract.score = settled.score
      contract.met_target = settled.metTarget
      contract.earnings = settled.earnings
      contract.completed_at = Timestamp.now()
    }

    const sessionOver = contractComplete && contracts.length >= config.contracts

    const patch: Record<string, unknown> = {
      participant_id: participantId,
      game_instance_id: gameInstanceId,
      starts_with: startsWith,
      // Whole-array write, not arrayUnion: the array is read and re-written inside the
      // transaction, so the version check covers it. arrayUnion would also de-duplicate
      // identical elements, which here would be data loss.
      contracts,
      contracts_completed: contracts.filter(c => c.periods.length >= config.periodsPerContract).length,
      // Denormalised for the reports' roster, rewritten from the periods on every submit.
      total_earnings: totalEarnings(contracts, config),
      phase: sessionOver ? 'debrief' : 'play',
    }
    if (sessionOver) patch.finished_at = FieldValue.serverTimestamp()

    tx.set(participantRef, patch, { merge: true })
    return { contracts, startsWith, replayed: false as const }
  })

  // ── Shape the response (clientState.ts whitelist) ──────────────────────────
  const contracts = result.contracts
  const finished = contracts.length >= config.contracts
    && contracts[contracts.length - 1].periods.length >= config.periodsPerContract
  const position = positionOf(contracts, config, finished)
  const labelFor = (condition: 'high' | 'low') =>
    config.showReliabilityLabel ? renderLabel(truth, condition) : null

  const current = contracts[contracts.length - 1]

  return {
    ok: true as const,
    params: clientParams(config),
    screen: { id: screenId(position), kind: position.kind },
    /** The contract in play — present only while one is open. */
    contract: position.kind === 'effort-choice'
      ? toClientContract(current, config, labelFor(current.condition))
      : null,
    /** The just-finished contract — present on the contract-result screen. */
    result: position.kind !== 'effort-choice'
      ? toClientResult(current, config, labelFor(current.condition))
      : null,
    /** Completed contracts, for the prior-contracts panel and the session summary. */
    completed: contracts
      .filter(c => c.periods.length >= config.periodsPerContract)
      .map(c => toClientResult(c, config, labelFor(c.condition))),
    totalEarnings: totalEarnings(contracts, config),
    contractsCompleted: contracts.filter(c => c.periods.length >= config.periodsPerContract).length,
    phase: phaseOf(position),
    gameOver: position.kind === 'session-summary',
  }
})
