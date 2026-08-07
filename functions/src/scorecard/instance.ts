import type { Firestore, Transaction } from 'firebase-admin/firestore'
import {
  INSTANCES_COLLECTION, CONFIG_DOC, TRUTH_DOC,
  loadScorecardConfig, loadScorecardTruth,
  type ScorecardConfig, type ScorecardTruth, type Condition,
} from './config'
import { assignStartsWith } from './schedule'

// ═══════════════════════════════════════════════════════════════════════════════
// Reading one instance's settings, and the ONE per-student value that must be fixed
// before play: `startsWith`.
//
// ⚠ MISSING DOCS READ AS SHIPPED DEFAULTS. An instance created from the classroom has no
// `truth/main` at all — that is the normal case, not a degenerate one (T4).
// ═══════════════════════════════════════════════════════════════════════════════

export interface ScorecardInstance {
  /** The student-readable half. Safe to forward wholesale? No — see clientState.ts. */
  config: ScorecardConfig
  /**
   * The treatment.
   *
   * ⚠ SERVER-SIDE ONLY. Holding BOTH reliabilities, both labels and the schedule is
   * exactly what spec §8 says the student is not told. `clientParams()` cannot reach it.
   */
  truth: ScorecardTruth
}

export async function loadInstance(db: Firestore, instanceId: string): Promise<ScorecardInstance> {
  const ref = db.collection(INSTANCES_COLLECTION).doc(instanceId)
  const [configSnap, truthSnap] = await Promise.all([
    ref.collection('config').doc(CONFIG_DOC).get(),
    ref.collection('truth').doc(TRUTH_DOC).get(),
  ])
  return {
    config: loadScorecardConfig(configSnap.data()),
    truth: loadScorecardTruth(truthSnap.data()),
  }
}

/** `scorecard_game_instances/{iid}/truth/roster` — the join counter. Rules-denied. */
const ROSTER_DOC = 'roster'

// ═══════════════════════════════════════════════════════════════════════════════
// ⚠⚠ `startsWith` — WRITTEN ONCE AT JOIN, NEVER RECOMPUTED (spec §2.2, §14.1, S1)
//
// Spec §2.2 requires assignment to alternate over the roster IN JOIN ORDER: deterministic,
// exactly balanced, no RNG. That rules out the PD/pricing pattern of hashing the
// participant id — a hash is well-distributed but NOT exactly balanced, and a 40-student
// section can land 25/15, skewing the class-level counterbalancing the entire
// within-subject design rests on.
//
// So there is a COUNTER, on a rules-denied doc, incremented in the same transaction that
// creates the participant. Firestore transactions are serializable: the counter read is
// version-checked at commit, so two concurrent first-touches cannot both take ordinal n —
// the loser retries and observes the committed value.
//
// ⚠ THE COST, ACCEPTED KNOWINGLY: unlike PD (which notes "CONTENTION: none" as a virtue),
// every student's FIRST touch contends on this one document. Forty students joining at
// class start serialise through it. That is fine — a join is once per student and
// Firestore sustains far more than that — and it is the price of the exact balance spec
// §2.2 requires. Do not "optimise" it into a hash; that trades the design for throughput
// nobody needs.
//
// ⚠ ONCE-ONLY IS THE CONTRACT. Every branch that finds an existing `starts_with` returns
// it untouched. A recompute mid-session would silently rewrite a student's whole
// treatment history — the schedule for contract k derives from this one field.
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * The student's `startsWith`, assigning it on first touch.
 *
 * MUST be called inside a transaction, with `participantSnapData` already read in that
 * same transaction — otherwise the once-only guarantee is a read-then-write race.
 */
export async function ensureStartsWith(
  tx: Transaction,
  db: Firestore,
  instanceId: string,
  participantSnapData: Record<string, unknown>,
): Promise<{ startsWith: Condition; assignedNow: boolean }> {
  const existing = participantSnapData.starts_with
  if (existing === 'high' || existing === 'low') {
    return { startsWith: existing, assignedNow: false }
  }

  const rosterRef = db
    .collection(INSTANCES_COLLECTION).doc(instanceId)
    .collection('truth').doc(ROSTER_DOC)
  const rosterSnap = await tx.get(rosterRef)
  const joined = rosterSnap.data()?.joined
  const ordinal = typeof joined === 'number' && Number.isFinite(joined) && joined >= 0
    ? Math.floor(joined)
    : 0

  tx.set(rosterRef, { joined: ordinal + 1 }, { merge: true })
  return { startsWith: assignStartsWith(ordinal), assignedNow: true }
}
