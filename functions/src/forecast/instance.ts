import type { Firestore } from 'firebase-admin/firestore'
import {
  INSTANCES_COLLECTION, CONFIG_DOC, TRUTH_DOC,
  loadForecastConfig, loadForecastModel, loadForecastSeed, type ForecastConfig,
} from './config'
import { resolveHistory, resolveDrawSeed, type ForecastModel } from './demand'

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
   * ⚠⚠ THE SEED THE DRAWS ACTUALLY USE — and it is NOT always `seed`.
   *
   * THE BUG THIS EXISTS TO FIX (found in production 08-02, instance iPSKmr1a…):
   * `unit()` returns `Math.random()` when the seed is null, IGNORING its key. So with a
   * blank seed, `demandDraw: 'common'` silently did nothing — every student drew
   * independently even though the setting said they should share a series. Instances
   * created from the classroom have no truth doc at all, so a blank seed is the NORMAL
   * case, which made `common` a no-op for every real instance. The reports looked
   * healthy: σ was right, the chart was smooth, nothing errored.
   *
   * THE RULE: a "common" future that differs between two students is not common. So
   * under `common`, a null seed falls back to a deterministic one. This is exactly the
   * precedent `resolveHistory` already set — "blank = random futures" is a statement
   * about the FUTURES, and a history that changed between students would not be a
   * history. The same sentence applies here with "common series" in place of "history".
   *
   * WHY THE INSTANCE ID rather than DEFAULT_SEED: every seedless instance sharing one
   * fallback would give this semester's class the same 24 months as last semester's —
   * a leak across course runs, which is the very thing the flag exists to catch. The
   * instance id is unique, already in hand, and stable for the life of the instance.
   *
   * Under `perStudent` a null seed still means real randomness: students differ anyway,
   * so there is nothing for determinism to protect.
   */
  drawSeed: string | null
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
  // See `drawSeed` above: `common` requires determinism, so a blank seed falls back to
  // the instance id rather than to Math.random().
  const drawSeed = resolveDrawSeed(seed, model.demandDraw, instanceId)

  return {
    config,
    drawSeed,
    model,
    seed,
    history: resolveHistory(model, seed, config.numHistory),
  }
}
