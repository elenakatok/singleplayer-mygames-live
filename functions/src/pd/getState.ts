import { onCall } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import { extractStudentOnCallIds } from '@mygames/game-server'
import { PD_CORS_ORIGINS, INSTANCES_COLLECTION, PARTICIPANTS_SUBCOLLECTION } from './config'
import { initPdParticipant } from './init'
import { parseStoredRounds, toClientHistory } from './rounds'

// ═══════════════════════════════════════════════════════════════════════════════
// pdGetState (student) — WHERE AM I? The student's whole position in one call:
// what they have played so far, and whether they are finished. The play screen calls
// this once on mount; everything after that comes back from pdSubmitRound.
//
// FIRST TOUCH: this is where initPdParticipant (Slice 1) is finally wired up. The
// instance's round count and this student's bot strategy are drawn here, once, before
// round 1 — see init.ts for why that is safe under concurrency.
//
// ⚠ WHAT THIS MUST NEVER RETURN (spec §3, §5 — the pedagogy depends on it):
//   • the drawn round count, or anything it can be recovered from
//     (no total, no rounds-remaining, no "round N of M", no progress fraction);
//   • the assigned strategy, or any hint of it;
//   • the config SEED — non-secret in itself, but it is the input the strategy draw
//     is derived from, so it stays server-side too.
// initPdParticipant returns all three. This function destructures ONLY `config` out
// of that result, and returns only `labels` and `payoffs` from it — both of which
// the student is shown on the play screen anyway (spec §2).
//
// Firestore rules deny the client every path this data lives on, so a callable is
// the ONLY way a student sees any of it, and this whitelist is the whole gate.
// ═══════════════════════════════════════════════════════════════════════════════

export const pdGetState = onCall({ cors: PD_CORS_ORIGINS }, async (request) => {
  const data = request.data as Record<string, unknown>
  const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true'
  const authHeader = request.rawRequest.headers.authorization as string | undefined

  const { participantId, gameInstanceId } = await extractStudentOnCallIds(data, isEmulator, authHeader)

  const db = admin.firestore()

  // First touch draws the round count + strategy (no-op on every later call).
  // `rounds` and `strategy` are deliberately NOT destructured — see the header.
  const { config } = await initPdParticipant(db, gameInstanceId, participantId)

  const participantRef = db
    .collection(INSTANCES_COLLECTION).doc(gameInstanceId)
    .collection(PARTICIPANTS_SUBCOLLECTION).doc(participantId)
  const snap = await participantRef.get()
  const pData = snap.data() ?? {}

  const stored = parseStoredRounds(pData.rounds)

  return {
    ok: true as const,
    // Student-facing settings (spec §2 — the matrix is shown to students).
    labels: config.labels,
    payoffs: config.payoffs,
    /** The word the payoff numbers are counted in. Carries no direction. */
    unit: config.unit,
    /**
     * The round-count RANGE — the only thing about the schedule a student may be told
     * (spec §3). This is the configured [min, max], NOT the drawn count, which stays
     * in truth/ and appears in no student response. Sent so the framing copy can say
     * "between {min} and {max} rounds" from config instead of hardcoding 10 and 20.
     */
    minRounds: config.minRounds,
    maxRounds: config.maxRounds,
    // What they have earned by playing. Rounds PLAYED only.
    history: toClientHistory(stored),
    // Derived from the stored finish stamp — NOT from comparing history.length to the
    // round count, which is exactly the comparison the client must never be able to make.
    gameOver: pData.finished_at != null,
  }
})
