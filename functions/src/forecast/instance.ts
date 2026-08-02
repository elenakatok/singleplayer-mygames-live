import type { Firestore } from 'firebase-admin/firestore'
import {
  INSTANCES_COLLECTION, CONFIG_DOC, TRUTH_DOC,
  loadForecastConfig, loadForecastModel, loadForecastSeed, type ForecastConfig,
} from './config'
import { resolveHistory, type ForecastModel } from './demand'

// ═══════════════════════════════════════════════════════════════════════════════
// Forecasting — reading one instance's settings.
//
// ⚠ NO FIRST-TOUCH DRAW, DELIBERATELY. Pricing and PD both have an init.ts, because
// each student's ROUND COUNT is a hidden per-student draw that must be fixed once and
// never redrawn. This game has no such secret: `rounds` is config, and the header tells
// the student "month k of N" (spec §4). The only per-student randomness is the demand
// draw, which is made fresh at each resolution and revealed immediately, so there is
// nothing to fix in advance and nothing to guard against a concurrent redraw.
//
// What remains is a two-document read, kept in one place so every callable loads the
// same trio — the student-readable config, the rules-denied model, and the seed.
//
// ⚠ THE HISTORY IS RESOLVED HERE, ONCE. Every caller that needs it (getState,
// submitRound, both CSVs, the reports) takes it from this one function rather than
// rebuilding it, so there is exactly one answer to "what are the first sixty months"
// and it cannot drift between the screen, the download and the report.
// ═══════════════════════════════════════════════════════════════════════════════

export interface ForecastInstance {
  /** The student-safe half (spec §3). Safe to forward wholesale? No — see clientState. */
  config: ForecastConfig
  /**
   * The generating model.
   *
   * ⚠ SERVER-SIDE ONLY. Every field is an answer key (spec §4, §12): a, b, H, σ and
   * the high season are exactly what the student is being asked to infer. It must
   * never be forwarded to a student — `clientParams()` omits it, and no student
   * callable response carries any of it.
   */
  model: ForecastModel
  /**
   * The determinism seed, or null for real randomness.
   *
   * ⚠ SERVER-SIDE ONLY. It derives every future demand draw, so a student holding it
   * could compute month 12's demand before forecasting month 11.
   */
  seed: string | null
  /**
   * The common history, p = 1…config.numHistory (spec §2.2).
   *
   * NOT secret — the opening screen shows all of it, the chart plots it and the
   * in-play CSV is exactly this. Identical for every student in the instance by
   * construction (no participant id enters resolveHistory).
   */
  history: number[]
}

/** The instance's effective config, model, seed and history. Missing docs read as
 *  shipped defaults, so an instance that has never been opened in Settings is
 *  playable at the published parameters. */
export async function loadInstance(
  db: Firestore,
  instanceId: string,
): Promise<ForecastInstance> {
  const instanceRef = db.collection(INSTANCES_COLLECTION).doc(instanceId)
  const [configSnap, truthSnap] = await Promise.all([
    instanceRef.collection('config').doc(CONFIG_DOC).get(),
    instanceRef.collection('truth').doc(TRUTH_DOC).get(),
  ])

  const config = loadForecastConfig(configSnap.data())
  const model = loadForecastModel(truthSnap.data())
  const seed = loadForecastSeed(truthSnap.data())

  return {
    config,
    model,
    seed,
    history: resolveHistory(model, seed, config.numHistory),
  }
}
