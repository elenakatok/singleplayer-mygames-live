import type { Firestore } from 'firebase-admin/firestore'
import {
  INSTANCES_COLLECTION, CONFIG_DOC, TRUTH_DOC,
  loadNewsvendorConfig, loadNewsvendorSeed, type NewsvendorConfig,
} from './config'

// ═══════════════════════════════════════════════════════════════════════════════
// Newsvendor — reading one instance's settings.
//
// ⚠ NO FIRST-TOUCH DRAW, DELIBERATELY. Pricing and PD both have an init.ts, because
// each student's ROUND COUNT is a hidden per-student draw that has to be fixed once
// and never redrawn. This game has no such secret: `periods` is config, and the
// screen tells the student "Period k of N" (spec §7a). The only per-student
// randomness is the demand draw, which is made fresh at each resolution and revealed
// immediately, so there is nothing to fix in advance and nothing to guard against a
// concurrent redraw.
//
// What remains is a two-document read, kept in one place so every callable loads the
// same pair — the student-readable config and the rules-denied seed.
// ═══════════════════════════════════════════════════════════════════════════════

export interface NewsvendorInstance {
  config: NewsvendorConfig
  /**
   * The determinism seed, or null for real randomness.
   *
   * ⚠ SERVER-SIDE ONLY. It derives every demand draw, so it must never be forwarded
   * to a student — clientParams() omits it, and no callable response carries it.
   */
  seed: string | null
}

/** The instance's effective config and seed. Missing docs read as shipped defaults
 *  and no seed, so an instance that has never been opened in Settings is playable. */
export async function loadInstance(
  db: Firestore,
  instanceId: string,
): Promise<NewsvendorInstance> {
  const instanceRef = db.collection(INSTANCES_COLLECTION).doc(instanceId)
  const [configSnap, truthSnap] = await Promise.all([
    instanceRef.collection('config').doc(CONFIG_DOC).get(),
    instanceRef.collection('truth').doc(TRUTH_DOC).get(),
  ])
  return {
    config: loadNewsvendorConfig(configSnap.data()),
    seed: loadNewsvendorSeed(truthSnap.data()),
  }
}
