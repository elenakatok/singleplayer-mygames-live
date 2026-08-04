import { Timestamp, type DocumentReference, type Firestore } from 'firebase-admin/firestore'
import { drawPlayerCost } from './round'
import { parseOpenRound, type OpenRound } from './rounds'
import type { ProcurementConfig } from './config'

// ═══════════════════════════════════════════════════════════════════════════════
// OPENING A ROUND — draw the student's own cost ONCE, write it, and read it forever
// after (spec §4: "drawn server-side, per student, per round, at round start", "drawn
// and written when the round opens").
//
// ⚠⚠ THIS EXISTS BECAUSE A DERIVED VALUE IS NOT A RECORDED ONE. CP3a computed the cost
// on demand from (seed, participantId, round) and called it "once-only by construction".
// It is — but only when a seed is set. `makeRng(null, key)` returns `Math.random` and
// ignores the key entirely, and instances created from the classroom have no truth doc,
// so in production the cost was redrawn on every read: the student was shown one number
// and the round resolved against another (found 2026-08-03, in production).
//
// The fix is not a more reliable derivation. It is to stop deriving. A recorded fact
// cannot drift from itself, with or without a seed, and there is no recipe left to break.
//
// ⚠ IT IS TRANSACTIONAL, and that is not incidental. Two concurrent `getState` calls — a
// double-click, two tabs, a retry — would otherwise each draw and each write, and the
// student would see whichever landed last while the other was briefly authoritative.
// Read-then-write inside one transaction makes the FIRST draw the only draw.
//
// ⚠ THE PLAYER'S OWN COST, AND NOTHING ELSE. Storing this early does NOT weaken §4:
// rival costs are still drawn at RESOLUTION, inside the transaction that accepts the
// bid. The distinction is not subtle — this is the number printed on the student's own
// screen; a rival's is the thing they must not have. The harness asserts the participant
// doc holds no rival/bot/seed field at any point before the bid.
// ═══════════════════════════════════════════════════════════════════════════════

/** What a newly opened round is written as. Kept here so the shape has one author. */
function openRoundPatch(round: number, cost: number) {
  return {
    // ⚠ A CONCRETE Timestamp. This is a plain map rather than an array element so a
    // sentinel would be legal here — but keeping it concrete matches StoredRound and
    // means the two timestamps in this game are read the same way.
    open_round: { round, cost, opened_at: Timestamp.now() },
  }
}

/**
 * Resolve the cost for `round`, drawing and writing it if this is the first time.
 *
 * Returns the STORED cost — the one already written for this round if there is one, so a
 * reload, a second tab and a retry all see the same number a student was first shown.
 *
 * ⚠ Call this from a READ path (`getState`). It writes, which is unusual for a read, and
 * that is the point: the round must be opened before the student can see anything about
 * it, and there is no other moment at which that can happen.
 */
export async function ensureOpenRound(
  db: Firestore,
  participantRef: DocumentReference,
  round: number,
  seed: string | null,
  participantId: string,
  config: ProcurementConfig,
): Promise<number> {
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(participantRef)
    const pData = snap.data() ?? {}

    const open = parseOpenRound(pData.open_round)
    // Already opened for THIS round — return what was written. Never redraw.
    if (open !== null && open.round === round) return open.cost

    const cost = drawPlayerCost(seed, participantId, round, config)
    tx.set(participantRef, {
      participant_id: participantId,
      ...openRoundPatch(round, cost),
    }, { merge: true })
    return cost
  })
}

/**
 * The cost to resolve `round` against, from INSIDE the submit transaction.
 *
 * ⚠⚠ THIS IS THE ASSERTION THE BUG WOULD HAVE FAILED: resolution uses the RECORDED cost,
 * so the number the student was shown is the number the round resolves against. Nothing
 * here draws.
 *
 * Returns null when no cost has been recorded for this round — which means the student
 * reached submit without ever loading the bidding screen. The caller opens it rather than
 * failing: a bid is still a bid, and refusing it would strand a student whose first
 * `getState` failed. It is drawn once, inside the same transaction, and written with the
 * round.
 */
export function openCostFor(
  pData: Record<string, unknown>,
  round: number,
): number | null {
  const open = parseOpenRound(pData.open_round)
  return open !== null && open.round === round ? open.cost : null
}

/** The patch that opens the NEXT round, written by the transaction that resolves this
 *  one — so the next bidding screen has its number before it is asked for, and the whole
 *  advance is atomic with the round it follows. */
export function nextOpenRoundPatch(
  round: number | null,
  seed: string | null,
  participantId: string,
  config: ProcurementConfig,
): { open_round: OpenRound & { opened_at: Timestamp } } | Record<string, never> {
  if (round === null) return {}
  return openRoundPatch(round, drawPlayerCost(seed, participantId, round, config))
}
