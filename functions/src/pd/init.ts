import type { Firestore } from 'firebase-admin/firestore'
import { FieldValue } from 'firebase-admin/firestore'
import { STRATEGIES, isStrategy, type Strategy } from './strategy'
import {
  INSTANCES_COLLECTION, CONFIG_DOC, truthParticipantDoc,
  HARD_MIN_ROUNDS, loadPdConfig, type PdConfig,
} from './config'

// ═══════════════════════════════════════════════════════════════════════════════
// Repeated Prisoner's Dilemma — FIRST-TOUCH INITIALIZATION.
//
// This family has NO instance-creation hook: an instance document is only ever
// created lazily by whatever callable touches it first (audit finding). So the two
// things PD must fix before a student's first round — THAT STUDENT'S round count
// and their bot strategy — are drawn LAZILY, on first touch, inside a transaction,
// and then never redrawn.
//
// ⚠ THE ROUND COUNT IS DRAWN PER PARTICIPANT, not per instance. It used to be an
// instance-level draw shared by the whole class, and that was a leak: PD is played
// async across an assignment week, so the first student to finish could tell
// everyone "it's 14 rounds", and every later student would play a game with a KNOWN
// last round — which is exactly the backward induction the hidden horizon exists to
// prevent (spec §3). A per-student draw makes that leak worth nothing. It also
// costs nothing: each student writes only their own document, so the draw contends
// with nobody. Pricing draws the same way, for the same reason.
//
// ONCE-ONLY is the whole contract. A redraw mid-game would change the length of a
// game already in progress, or switch a student's opponent between rounds and
// silently invalidate their inference — the one thing the pedagogy depends on.
//
// HOW ONCE-ONLY IS GUARANTEED (not by a read-then-write race):
// every draw happens inside db.runTransaction. Firestore transactions are
// serializable: a document READ inside a transaction is version-checked at commit,
// so if two concurrent first-touches both observe "no strategy yet", only one can
// commit — the loser's read is invalidated, it RETRIES, and on retry it observes
// the committed value and returns it instead of drawing again. The write is
// therefore conditional on nothing having changed since the read, which is exactly
// compare-and-set. There is no path that overwrites an existing value: every
// branch that finds a stored value returns it untouched.
//
// CONTENTION: none. Both draws land in ONE document per student
// (truth/participant_{pid}), so 40 students initializing at class start contend
// with nobody at all.
// ═══════════════════════════════════════════════════════════════════════════════

// ── Deterministic draws ────────────────────────────────────────────────────────
// With a seed set, every draw is a pure function of (seed, subject) — reproducible
// across runs and machines, still independent across students. Node's Math.random
// cannot be seeded, so the seeded path derives from a hash instead.

/** FNV-1a (32-bit) followed by murmur3's fmix32 avalanche.
 *
 *  The avalanche step is load-bearing, not decoration: the strategy draw consumes
 *  the LOW BIT (`% 2`), and raw FNV-1a low bits are poorly mixed for short, similar
 *  inputs — exactly what participant ids are. fmix32 diffuses every input bit
 *  across all 32 output bits, so consecutive ids don't alternate strategies. */
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
 * [minRounds, maxRounds], inclusive at both ends.
 * Seeded ⇒ derived from (seed, participantId), so students still differ from each
 * other while the whole run is reproducible. Unseeded ⇒ real randomness.
 * PURE with respect to the seeded path — same inputs, same answer, always.
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

/**
 * One student's bot strategy: ~50/50 across students (spec §5).
 * Seeded ⇒ derived from (seed, participantId), so students still differ from each
 * other while the whole run is reproducible. Unseeded ⇒ real randomness.
 */
export function drawStrategy(seed: string | null, participantId: string): Strategy {
  const k = seed === null
    ? Math.floor(Math.random() * STRATEGIES.length)
    : hash32(`${seed}:strategy:${participantId}`) % STRATEGIES.length
  return STRATEGIES[k]
}

// ── Transactional first-touch init ─────────────────────────────────────────────

export interface PdInitResult {
  /** THIS STUDENT'S round count. Drawn once; NEVER returned to a student. */
  rounds: number
  /** This student's bot strategy. Drawn once; NEVER returned to a student during play. */
  strategy: Strategy
  /** The effective instance config (payoffs + labels + seed). */
  config: PdConfig
  /** True iff this call performed this student's round-count draw. */
  drewRounds: boolean
  /** True iff this call performed this student's strategy assignment. */
  drewStrategy: boolean
}

/**
 * Ensure this student has a round count and a strategy, drawing either only if
 * absent. Returns what is now stored, whether or not it drew.
 *
 * ⚠ The return value is SERVER-SIDE TRUTH. `rounds` and `strategy` must never be
 * forwarded to a student mid-game (spec §3, §5) — the callables return only derived,
 * already-earned values (e.g. "the game is over") to the client.
 *
 * @param db            an admin Firestore (injected so this is testable directly)
 * @param instanceId    the game instance
 * @param participantId the student
 */
export async function initPdParticipant(
  db: Firestore,
  instanceId: string,
  participantId: string,
): Promise<PdInitResult> {
  const instanceRef = db.collection(INSTANCES_COLLECTION).doc(instanceId)
  const configRef = instanceRef.collection('config').doc(CONFIG_DOC)
  // ONE document holds everything this student's game depends on staying hidden:
  // their round count and their bot strategy. Nothing PD draws is instance-level
  // any more, so there is no shared truth doc to read here at all.
  const studentTruthRef = instanceRef.collection('truth').doc(truthParticipantDoc(participantId))

  return db.runTransaction(async (tx) => {
    // ALL reads must precede ALL writes inside a Firestore transaction.
    const [configSnap, studentSnap] = await Promise.all([
      tx.get(configRef), tx.get(studentTruthRef),
    ])

    const config = loadPdConfig(configSnap.data())
    const studentTruth = studentSnap.data()

    // ── This student's round count ───────────────────────────────────────────
    // ⚠ VALIDITY IS "IS IT A PLAYABLE COUNT", NOT "IS IT INSIDE THE CURRENT RANGE".
    // The range is instructor-configurable (Slice 5), and an already-drawn count must
    // survive a range edit: a student drawn at 13 and then re-ranged to [5,8] keeps
    // 13, because they are mid-game against it and the horizon is fixed once drawn.
    // Range-bounding this check would silently REDRAW those students — which is the
    // one thing init.ts exists to prevent. A range edit therefore reaches only
    // students who have NOT yet launched.
    const storedRounds = studentTruth?.rounds
    const roundsValid = typeof storedRounds === 'number'
      && Number.isInteger(storedRounds)
      && storedRounds >= HARD_MIN_ROUNDS
    const rounds = roundsValid
      ? (storedRounds as number)
      : drawRoundCount(config.seed, participantId, config.minRounds, config.maxRounds)
    const drewRounds = !roundsValid

    // ── This student's bot strategy ──────────────────────────────────────────
    const storedStrategy = studentTruth?.strategy
    const strategyValid = isStrategy(storedStrategy)
    const strategy = strategyValid ? storedStrategy : drawStrategy(config.seed, participantId)
    const drewStrategy = !strategyValid

    // ── Writes: ONLY for what was actually missing. An existing value is never
    //    overwritten — that is the once-only guarantee, and the read above is
    //    version-checked at commit, so a concurrent first-touch cannot slip past.
    //    Both draws land in the same document, so a fresh student costs one write.
    if (drewRounds || drewStrategy) {
      const patch: Record<string, unknown> = { participant_id: participantId }
      if (drewRounds) {
        patch.rounds = rounds
        patch.rounds_drawn_at = FieldValue.serverTimestamp()
      }
      if (drewStrategy) {
        patch.strategy = strategy
        patch.assigned_at = FieldValue.serverTimestamp()
      }
      tx.set(studentTruthRef, patch, { merge: true })
    }

    return { rounds, strategy, config, drewRounds, drewStrategy }
  })
}
