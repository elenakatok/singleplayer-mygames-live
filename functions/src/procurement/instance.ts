import type { Firestore } from 'firebase-admin/firestore'
import {
  INSTANCES_COLLECTION, PARTICIPANTS_SUBCOLLECTION, CONFIG_DOC, TRUTH_DOC,
  loadProcurementConfig, loadProcurementSeed, type ProcurementConfig,
} from './config'
import { KC_POOL_IDS, defaultVisibleFor } from './questions'

// ═══════════════════════════════════════════════════════════════════════════════
// Procurement Auction — the ONE place an instance's config and its seed are read
// together, so no caller assembles that pair itself and gets the split wrong.
//
// ⚠⚠ THE SEED IS SERVER-SIDE ONLY. It derives every rival cost draw, so it must never
// be forwarded into a student response. It is returned here as its own field, never
// folded into `config`, so a `return { ...config }` cannot leak it — the leak would have
// to be written deliberately.
//
// Missing docs read as shipped defaults and no seed, so an instance that has never been
// opened in Settings is playable. Same posture as newsvendor/instance.ts.
// ═══════════════════════════════════════════════════════════════════════════════

export interface ProcurementInstance {
  config: ProcurementConfig
  /**
   * The determinism seed, or null for real randomness.
   *
   * ⚠ SERVER-SIDE ONLY. Under a null seed the draws are genuinely random and differ per
   * student, which is the normal case: instances created from the classroom have no
   * truth doc at all.
   *
   * ⚠ NOTE FOR CHECKPOINT 2 — the forecast lesson. `unit()`-style helpers that return
   * `Math.random()` on a null seed IGNORE their key, so any "common draw across
   * students" mode must resolve a deterministic fallback seed rather than passing null
   * through. This game has no common-draw mode today. If one is ever added, read
   * `forecast/instance.ts`'s `drawSeed` note first.
   */
  seed: string | null
}

export async function loadInstance(
  db: Firestore,
  gameInstanceId: string,
): Promise<ProcurementInstance> {
  const instanceRef = db.collection(INSTANCES_COLLECTION).doc(gameInstanceId)
  const [configSnap, truthSnap] = await Promise.all([
    instanceRef.collection('config').doc(CONFIG_DOC).get(),
    instanceRef.collection('truth').doc(TRUTH_DOC).get(),
  ])

  return {
    config: loadProcurementConfig(configSnap.data(), KC_POOL_IDS, defaultVisibleFor),
    seed: loadProcurementSeed(truthSnap.data()),
  }
}

/**
 * Has anyone in this instance submitted anything yet?
 *
 * ⚠ THIS IS THE `format` LOCK (Part 1 §3, §14.1). Rounds resolved under two different
 * mechanisms in one result set would be incoherent — the reports could not say what the
 * numbers mean — so `format` stops being editable the moment the first bid lands.
 *
 * Deliberately a QUERY over the participants rather than a flag on the instance doc: a
 * flag is a second source of truth that a failed write can leave disagreeing with the
 * data, and this check runs only on the instructor's Settings save, where one extra read
 * costs nothing.
 */
export async function hasAnySubmission(
  db: Firestore,
  gameInstanceId: string,
): Promise<boolean> {
  const snap = await db
    .collection(INSTANCES_COLLECTION).doc(gameInstanceId)
    .collection(PARTICIPANTS_SUBCOLLECTION)
    .where('rounds_played', '>', 0)
    .limit(1)
    .get()
  return !snap.empty
}
