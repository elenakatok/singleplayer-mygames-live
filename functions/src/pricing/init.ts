import type { Firestore } from 'firebase-admin/firestore'
import { FieldValue } from 'firebase-admin/firestore'
import type { PricingStrategy } from './strategy'
import {
  INSTANCES_COLLECTION, CONFIG_DOC, TRUTH_DOC, truthParticipantDoc,
  HARD_MIN_ROUNDS, loadPricingConfig, loadPricingStrategies, activeStrategy,
  type PricingConfig,
} from './config'

// ═══════════════════════════════════════════════════════════════════════════════
// Pricing Game — FIRST-TOUCH INITIALIZATION.
//
// This family has NO instance-creation hook: an instance document is only ever
// created lazily by whatever callable touches it first. So the one thing pricing
// must fix before a student's first round — THAT STUDENT'S round count — is drawn
// LAZILY, on first touch, inside a transaction, and then never redrawn.
//
// ONCE-ONLY is the whole contract. A redraw mid-game would change the length of a
// game already in progress, which is the one thing the hidden horizon depends on.
//
// HOW ONCE-ONLY IS GUARANTEED (not by a read-then-write race): the draw happens
// inside db.runTransaction. Firestore transactions are serializable — a document
// READ inside a transaction is version-checked at commit, so if two concurrent
// first-touches both observe "no round count yet", only one can commit; the loser's
// read is invalidated, it RETRIES, and on retry it observes the committed value and
// returns it instead of drawing again. There is no path that overwrites an existing
// value: every branch that finds one returns it untouched.
//
// CONTENTION: none at all. Unlike PD — where the round count is an INSTANCE-level
// draw that every student's first touch contends for until someone commits it —
// pricing draws PER PARTICIPANT (config.ts explains why), so each student writes
// only their own document and 40 students starting at once contend with nobody.
// ═══════════════════════════════════════════════════════════════════════════════

// ── Deterministic draws ────────────────────────────────────────────────────────
// With a seed set, the draw is a pure function of (seed, participant) — reproducible
// across runs and machines, still independent across students. Node's Math.random
// cannot be seeded, so the seeded path derives from a hash instead.

/**
 * FNV-1a (32-bit) followed by murmur3's fmix32 avalanche.
 *
 * Deliberately duplicated from pd/init.ts rather than shared: the games in this
 * project are isolated by design (own prefix, own callables, own rules block), and a
 * cross-game import would mean a change made for one game's draws silently changes
 * the other's. It is twelve lines.
 *
 * The avalanche step is load-bearing, not decoration: raw FNV-1a low bits are poorly
 * mixed for short, similar inputs — exactly what participant ids are — and the draw
 * below takes a modulus, which reads the low bits. fmix32 diffuses every input bit
 * across all 32 output bits, so consecutive ids don't land on neighbouring counts.
 */
export function hash32(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  // fmix32
  h ^= h >>> 16
  h = Math.imul(h, 0x85ebca6b)
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35)
  h ^= h >>> 16
  return h >>> 0
}

/**
 * ONE STUDENT'S round count: a uniform integer in the instance's configured
 * [minRounds, maxRounds], inclusive at both ends (spec §3).
 * Seeded ⇒ derived from (seed, participantId), so students still differ from each
 * other while the whole run is reproducible. Unseeded ⇒ real randomness.
 */
export function drawRoundCount(
  seed: string | null,
  participantId: string,
  minRounds: number,
  maxRounds: number,
): number {
  const span = maxRounds - minRounds + 1 // inclusive on both ends
  const k = seed === null
    ? Math.floor(Math.random() * span)
    : hash32(`${seed}:rounds:${participantId}`) % span
  return minRounds + k
}

// ── Transactional first-touch init ─────────────────────────────────────────────

export interface PricingInitResult {
  /** THIS STUDENT'S round count. Drawn once; NEVER returned to a student. */
  rounds: number
  /** The effective instance config (market + labels + mode + seed). */
  config: PricingConfig
  /** The competitor rule in force for this instance's mode. NEVER returned to a
   *  student during play (spec §5) — the debrief reveals it. */
  strategy: PricingStrategy
  /** True iff this call performed the draw. */
  drewRounds: boolean
}

/**
 * Ensure this student has a round count, drawing it only if absent. Returns what is
 * now stored, whether or not it drew, plus the instance's config and competitor rule.
 *
 * ⚠ The return value is SERVER-SIDE TRUTH. `rounds` and `strategy` must never be
 * forwarded to a student mid-game (spec §4, §5) — the callables return only derived,
 * already-earned values (e.g. a `gameOver` boolean).
 *
 * @param db            an admin Firestore (injected so this is testable directly)
 * @param instanceId    the game instance
 * @param participantId the student
 */
export async function initPricingParticipant(
  db: Firestore,
  instanceId: string,
  participantId: string,
): Promise<PricingInitResult> {
  const instanceRef = db.collection(INSTANCES_COLLECTION).doc(instanceId)
  const configRef = instanceRef.collection('config').doc(CONFIG_DOC)
  const truthRef = instanceRef.collection('truth').doc(TRUTH_DOC)
  const studentTruthRef = instanceRef.collection('truth').doc(truthParticipantDoc(participantId))

  return db.runTransaction(async (tx) => {
    // ALL reads must precede ALL writes inside a Firestore transaction.
    const [configSnap, truthSnap, studentSnap] = await Promise.all([
      tx.get(configRef), tx.get(truthRef), tx.get(studentTruthRef),
    ])

    const config = loadPricingConfig(configSnap.data())
    const strategy = activeStrategy(config, loadPricingStrategies(truthSnap.data()))

    // ⚠ VALIDITY IS "IS IT A PLAYABLE COUNT", NOT "IS IT INSIDE THE CURRENT RANGE".
    // The range is instructor-configurable, and an already-drawn count must survive a
    // range edit: a student drawn at 13 and then re-ranged to [5,8] keeps 13, because
    // they are mid-game against it and the horizon is fixed once drawn. Range-bounding
    // this check would silently REDRAW those students — which is the one thing init.ts
    // exists to prevent.
    const stored = studentSnap.data()?.rounds
    const valid = typeof stored === 'number' && Number.isInteger(stored) && stored >= HARD_MIN_ROUNDS
    const rounds = valid
      ? (stored as number)
      : drawRoundCount(config.seed, participantId, config.minRounds, config.maxRounds)
    const drewRounds = !valid

    // Write ONLY what was actually missing. An existing value is never overwritten —
    // that is the once-only guarantee, and the read above is version-checked at
    // commit, so a concurrent first-touch cannot slip past.
    if (drewRounds) {
      tx.set(studentTruthRef, {
        participant_id: participantId,
        rounds,
        rounds_drawn_at: FieldValue.serverTimestamp(),
      }, { merge: true })
    }

    return { rounds, config, strategy, drewRounds }
  })
}
