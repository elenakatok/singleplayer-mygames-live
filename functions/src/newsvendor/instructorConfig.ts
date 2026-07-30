import { onCall, HttpsError } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import { extractInstructorGameId } from '@mygames/game-server'
import {
  NEWSVENDOR_CORS_ORIGINS, INSTANCES_COLLECTION, PARTICIPANTS_SUBCOLLECTION, CONFIG_DOC, TRUTH_DOC,
  HARD_MIN_PERIODS, HARD_MAX_PERIODS,
  loadNewsvendorConfig, loadNewsvendorSeed, parseAddedKcQuestion,
  type NewsvendorConfig, type NewsvendorAddedKcQuestion,
} from './config'
import { criticalRatio, optimalOrder, orderBounds, economicsError } from './economics'
import { resolveNewsvendorKcQuestions, AUTHORED_KC_COUNT } from './questions'

// ═══════════════════════════════════════════════════════════════════════════════
// newsvendorGetConfig / newsvendorUpdateConfig (instructor) — the settings page's
// server side (spec §2). Mirrors pricing's and PD's: read the whole config, write back
// only the fields that were sent, re-read and return what was actually STORED.
//
// WHAT IS AND IS NOT EDITABLE:
//   editable   every scalar in spec §2 — P, c, v, g, h; the demand distribution and
//              its parameters; the period count; the two display toggles; the prep,
//              KC and debrief switches and prompts; instructor-added KC questions;
//              and the determinism SEED (which is written to truth/, not config/).
//   authored   the ten KC questions themselves — fixed teaching numbers by design
//              (questions.ts), so they are RETURNED read-only for preview and cannot
//              be edited into agreement with the instance's market. That is the
//              point: students must recompute.
//   refused    `dual`. Part 1 ships the single-source game; a config with dual set
//              would be scored with the wrong profit formula entirely.
//
// ⚠ CONFIG-EDIT SAFETY, and it bites harder here than in pricing. PD's precedent is
// WARN, NEVER BLOCK. Newsvendor keeps that posture for the ECONOMICS — but note what a
// mid-week edit actually invalidates: every stored period carries a benchmark
// (`q_opt`, `profit_opt`) computed under the OLD parameters, and the reports pool
// those with periods computed under the new ones. So the page reports
// `anyRoundsPlayed` and says plainly what will happen.
//
// ⚠ WHAT IS REFUSED RATHER THAN WARNED ABOUT: a config whose critical ratio does not
// EXIST (net salvage at or above the unit cost, or a non-positive underage cost). That
// is not a hard game, it is a game with no benchmark — every report would compare
// against a quantity that is +∞. economicsError() owns that judgement, and it is run
// against the PROSPECTIVE config, so a save is refused before it can be stored.
// ═══════════════════════════════════════════════════════════════════════════════

/** Reads one optional field; `undefined` means "not being changed". */
const has = (d: Record<string, unknown>, k: string) => Object.prototype.hasOwnProperty.call(d, k)

/** Shape-shared by both callables, so the page can never be handed two different
 *  pictures of the same instance. */
async function readConfigView(db: admin.firestore.Firestore, gameInstanceId: string) {
  const instanceRef = db.collection(INSTANCES_COLLECTION).doc(gameInstanceId)
  const [configSnap, truthSnap, playedSnap] = await Promise.all([
    instanceRef.collection('config').doc(CONFIG_DOC).get(),
    instanceRef.collection('truth').doc(TRUTH_DOC).get(),
    // "Has anyone actually PLAYED?" — one indexed hit, not a scan. The edit warning
    // turns on this, not on having merely launched: a student who opened the tab and
    // left has no stored periods to invalidate.
    instanceRef.collection(PARTICIPANTS_SUBCOLLECTION).where('rounds_played', '>', 0).limit(1).get(),
  ])

  const config = loadNewsvendorConfig(configSnap.data())
  const error = economicsError(config)
  const bounds = orderBounds(config)

  return {
    ok: true as const,
    config: {
      P: config.P, c: config.c, v: config.v, g: config.g, h: config.h,
      isNormal: config.isNormal,
      mean: config.mean, sd: config.sd, minD: config.minD, maxD: config.maxD,
      periods: config.periods,
      showCalculator: config.showCalculator,
      showServiceLevel: config.showServiceLevel,
      prepEnabled: config.prepEnabled,
      prepPrompt: config.prepPrompt,
      kcEnabled: config.kcEnabled,
      addedKcQuestions: config.addedKcQuestions,
      debriefEnabled: config.debriefEnabled,
      debriefPrompt: config.debriefPrompt,
    },
    /** The determinism seed. Instructor-only — it derives every demand draw, so it
     *  lives in truth/ and reaches no student response (config.ts). */
    seed: loadNewsvendorSeed(truthSnap.data()),
    /** The order box's bounds these parameters imply (spec §3), previewed so an
     *  instructor can see what a mean/sd edit does to what students may type. */
    orderBounds: bounds,
    /**
     * What the CURRENT parameters imply (spec §4), so the instructor sees their edit
     * move the benchmark before any student meets it. Null when the config is
     * degenerate — `configError` says why.
     */
    benchmark: error === null ? { Qopt: optimalOrder(config), ...criticalRatio(config) } : null,
    configError: error,
    /**
     * Read-only preview of the AUTHORED knowledge check — the fixed teaching numbers,
     * with the answer key (instructor-side). Not editable: they deliberately use a
     * different market from the game so students must recompute (questions.ts).
     * Resolved with a fixed pseudo-participant so the preview's option order is stable
     * between page loads; every real student gets their own shuffle.
     */
    authoredKcPreview: resolveNewsvendorKcQuestions('__preview__').map(q => ({
      field: q.field,
      prompt: q.prompt,
      options: q.options,
      correct_value: q.correct_value,
    })),
    /** How many graded questions the authored set contributes to the denominator. */
    authoredKcCount: AUTHORED_KC_COUNT,
    /** Has any student actually played a period? Drives the edit warning. */
    anyRoundsPlayed: !playedSnap.empty,
  }
}

export const newsvendorGetConfig = onCall({ cors: NEWSVENDOR_CORS_ORIGINS }, async (request) => {
  const data = request.data as Record<string, unknown>
  const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true'
  const authHeader = request.rawRequest.headers.authorization as string | undefined

  const gameInstanceId = await extractInstructorGameId(data, isEmulator, authHeader)

  return readConfigView(admin.firestore(), gameInstanceId)
})

/** A finite number, or a thrown error naming the field so the settings page can show
 *  the instructor which box is wrong. */
function requireNumber(v: unknown, label: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new HttpsError('invalid-argument', `${label} must be a number.`)
  }
  return v
}

export const newsvendorUpdateConfig = onCall({ cors: NEWSVENDOR_CORS_ORIGINS }, async (request) => {
  const data = request.data as Record<string, unknown>
  const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true'
  const authHeader = request.rawRequest.headers.authorization as string | undefined

  const gameInstanceId = await extractInstructorGameId(data, isEmulator, authHeader)

  const db = admin.firestore()
  const instanceRef = db.collection(INSTANCES_COLLECTION).doc(gameInstanceId)
  const configSnap = await instanceRef.collection('config').doc(CONFIG_DOC).get()
  const current = loadNewsvendorConfig(configSnap.data())

  // ── Dual is Part 2, and is refused outright ───────────────────────────────
  if (has(data, 'dual') && data.dual === true) {
    throw new HttpsError('invalid-argument',
      'Dual sourcing is not built yet — this build ships the single-source game only.')
  }

  const patch: Record<string, unknown> = {}
  /** The config this save WOULD produce. Validated as a whole before anything is
   *  written, because the §2 rules are relationships (P > c, c > v − h), not
   *  per-field ranges — checking each box on its own would let a legal price and a
   *  legal salvage combine into an instance with no benchmark. */
  const next: NewsvendorConfig = { ...current }

  const scalar = (key: string, label: string, apply: (v: number) => void, store: string) => {
    if (!has(data, key)) return
    const v = requireNumber(data[key], label)
    apply(v)
    patch[store] = v
  }

  scalar('P', 'The retail price', v => { next.P = v }, 'price')
  scalar('c', 'The unit cost', v => { next.c = v }, 'unit_cost')
  scalar('v', 'The salvage value', v => { next.v = v }, 'salvage')
  scalar('g', 'The goodwill cost', v => { next.g = v }, 'goodwill')
  scalar('h', 'The holding cost', v => { next.h = v }, 'holding')
  scalar('mean', 'Mean demand', v => { next.mean = v }, 'mean')
  scalar('sd', 'The standard deviation', v => { next.sd = v }, 'sd')
  scalar('minD', 'Minimum demand', v => { next.minD = v }, 'min_demand')
  scalar('maxD', 'Maximum demand', v => { next.maxD = v }, 'max_demand')

  if (has(data, 'isNormal')) {
    if (typeof data.isNormal !== 'boolean') {
      throw new HttpsError('invalid-argument', 'The demand distribution must be Normal or Uniform.')
    }
    next.isNormal = data.isNormal
    patch.is_normal = data.isNormal
  }

  if (has(data, 'periods')) {
    const p = data.periods
    if (typeof p !== 'number' || !Number.isInteger(p)) {
      throw new HttpsError('invalid-argument', 'The number of periods must be a whole number.')
    }
    if (p < HARD_MIN_PERIODS || p > HARD_MAX_PERIODS) {
      throw new HttpsError('invalid-argument',
        `The number of periods must be between ${HARD_MIN_PERIODS} and ${HARD_MAX_PERIODS}.`)
    }
    next.periods = p
    patch.periods = p
  }

  const toggle = (key: string, store: string, label: string) => {
    if (!has(data, key)) return
    if (typeof data[key] !== 'boolean') {
      throw new HttpsError('invalid-argument', `${label} must be true or false.`)
    }
    patch[store] = data[key]
  }
  toggle('showCalculator', 'show_calculator', 'The calculator toggle')
  toggle('showServiceLevel', 'show_service_level', 'The service-level toggle')
  toggle('prepEnabled', 'prep_enabled', 'prepEnabled')
  toggle('kcEnabled', 'kc_enabled', 'kcEnabled')
  toggle('debriefEnabled', 'debrief_enabled', 'debriefEnabled')

  const prompt = (key: string, store: string, label: string) => {
    if (!has(data, key)) return
    const text = typeof data[key] === 'string' ? (data[key] as string).trim() : ''
    if (!text) throw new HttpsError('invalid-argument', `${label} is required.`)
    patch[store] = text
  }
  prompt('prepPrompt', 'prep_prompt', 'The prep prompt')
  prompt('debriefPrompt', 'debrief_prompt', 'The debrief prompt')

  if (has(data, 'addedKcQuestions')) {
    if (!Array.isArray(data.addedKcQuestions)) {
      throw new HttpsError('invalid-argument', 'addedKcQuestions must be an array.')
    }
    const parsed: NewsvendorAddedKcQuestion[] = []
    const seen = new Set<string>()
    for (const raw of data.addedKcQuestions) {
      const q = parseAddedKcQuestion(raw)
      if (!q) {
        throw new HttpsError('invalid-argument',
          'An added question is incomplete — every question needs a prompt, and a multiple-choice question needs at least two options and a correct answer among them.')
      }
      // The authored set owns the kc_ namespace; parseAddedKcQuestion already refuses
      // it, and this second check keeps the error message specific.
      if (q.id.startsWith('kc_')) {
        throw new HttpsError('invalid-argument', 'An added question cannot use a reserved kc_ id.')
      }
      if (seen.has(q.id)) throw new HttpsError('invalid-argument', `Duplicate question id: ${q.id}`)
      seen.add(q.id)
      parsed.push(q)
    }
    patch.added_kc_questions = parsed
  }

  // ── The whole-config check (spec §2 + the two CR requirements) ─────────────
  const error = economicsError(next)
  if (error) throw new HttpsError('invalid-argument', error)

  // ── The seed — written to TRUTH, never to config ──────────────────────────
  // Its own document because it derives every demand draw; config/main is
  // student-readable (config.ts). An empty string CLEARS it (back to real randomness),
  // which is why this is handled outside the `patch` map.
  let seedWrite: string | null | undefined
  if (has(data, 'seed')) {
    const raw = data.seed
    if (raw === null || (typeof raw === 'string' && raw.trim() === '')) {
      seedWrite = null
    } else if (typeof raw === 'string') {
      seedWrite = raw.trim()
    } else if (typeof raw === 'number' && Number.isFinite(raw)) {
      seedWrite = String(raw)
    } else {
      throw new HttpsError('invalid-argument', 'The seed must be text, a number, or blank.')
    }
  }

  if (Object.keys(patch).length === 0 && seedWrite === undefined) {
    throw new HttpsError('invalid-argument', 'Nothing to update.')
  }

  const writes: Promise<unknown>[] = []
  if (Object.keys(patch).length > 0) {
    // merge:true — a settings save touches only the fields it was given, so it can
    // never clobber a sibling setting.
    writes.push(instanceRef.collection('config').doc(CONFIG_DOC).set(patch, { merge: true }))
  }
  if (seedWrite !== undefined) {
    writes.push(instanceRef.collection('truth').doc(TRUTH_DOC)
      .set({ seed: seedWrite }, { merge: true }))
  }
  await Promise.all(writes)

  // Return the re-read effective config, so the page shows what was actually stored
  // (including any defaulting) and the re-derived benchmark the new parameters produce.
  return readConfigView(db, gameInstanceId)
})
