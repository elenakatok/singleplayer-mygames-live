import { onCall } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import { extractStudentOnCallIds } from '@mygames/game-server'
import { PRICING_CORS_ORIGINS, INSTANCES_COLLECTION, PARTICIPANTS_SUBCOLLECTION } from './config'
import { initPricingParticipant } from './init'
import { parseStoredRounds, toClientHistory, totals } from './rounds'
import { clientMarket, phaseOf } from './clientState'

// ═══════════════════════════════════════════════════════════════════════════════
// pricingGetState (student) — WHERE AM I? The student's whole position in one call:
// the market they are pricing in, what they have played so far, and whether they are
// finished. The play screen calls this once on mount; everything after that comes
// back from pricingSubmitPrice.
//
// FIRST TOUCH: this is where initPricingParticipant is wired up. This student's
// round count is drawn here, once, before round 1 — see init.ts for why that is safe
// under concurrency.
//
// ⚠ WHAT THIS MUST NEVER RETURN (spec §4, §5 — the pedagogy depends on it):
//   • the drawn round count, or anything it can be recovered from
//     (no total, no rounds-remaining, no "round N of M", no progress fraction);
//   • the competitor's rule, or any hint of it — the student is meant to infer the
//     competitor's behaviour from play and be told what it was in the debrief;
//   • the config SEED — non-secret in itself, but it is the input the round-count
//     draw is derived from, so it stays server-side too.
// initPricingParticipant returns all three. This function destructures ONLY `config`
// out of that result, and returns only what the price-entry screen prints anyway
// (spec §4: market size, both base shares, both unit costs, the formulas, the
// bounds).
//
// Firestore rules deny the client the truth/ and participants/ paths this data lives
// on, so a callable is the ONLY way a student sees any of it, and this whitelist is
// the whole gate.
// ═══════════════════════════════════════════════════════════════════════════════

export const pricingGetState = onCall({ cors: PRICING_CORS_ORIGINS }, async (request) => {
  const data = request.data as Record<string, unknown>
  const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true'
  const authHeader = request.rawRequest.headers.authorization as string | undefined

  const { participantId, gameInstanceId } = await extractStudentOnCallIds(data, isEmulator, authHeader)

  const db = admin.firestore()

  // First touch draws this student's round count (no-op on every later call).
  // `rounds` and `strategy` are deliberately NOT destructured — see the header.
  const { config } = await initPricingParticipant(db, gameInstanceId, participantId)

  const participantRef = db
    .collection(INSTANCES_COLLECTION).doc(gameInstanceId)
    .collection(PARTICIPANTS_SUBCOLLECTION).doc(participantId)
  const snap = await participantRef.get()
  const pData = snap.data() ?? {}

  const stored = parseStoredRounds(pData.rounds)
  const sums = totals(stored)
  const phase = phaseOf(pData)

  return {
    ok: true as const,
    /** Which rules are in force (spec §6). Student-facing by design: under PMG the
     *  rules screen has to explain price matching before they can play. */
    pmg: config.pmg,
    /** The two firms' names. */
    labels: config.labels,
    /** Everything the price-entry screen prints (spec §4) — including the
     *  competitor's base share and unit cost, which the case gives students. */
    market: clientMarket(config.market),
    /**
     * The round-count RANGE — the only thing about the schedule a student may be
     * told (spec §3). This is the configured [min, max], NOT their drawn count,
     * which stays in truth/ and appears in no student response. Sent so the framing
     * copy can say "between {min} and {max} rounds" from config instead of
     * hardcoding 10 and 20.
     */
    minRounds: config.minRounds,
    maxRounds: config.maxRounds,
    // What they have earned by playing. Rounds PLAYED only.
    history: toClientHistory(stored),
    /** Running totals (spec §4 — the history table's cumulative and average). */
    totalProfit: sums.student,
    averageProfit: stored.length === 0 ? 0 : sums.student / stored.length,
    /**
     * Where they are in the flow. Derived from the stored finish stamp — NOT from
     * comparing history.length to the round count, which is exactly the comparison
     * the client must never be able to make.
     */
    phase,
    /** Same fact as `phase === 'debrief'`, as the boolean the round-loop UI branches
     *  on. A BOOLEAN, never a count: it says the game ended, not how long it was. */
    gameOver: phase === 'debrief',
  }
})
