import {
  DEFAULT_MODEL, DEFAULT_SEED, type ForecastModel,
} from './demand'
import { DEFAULT_HIGH_SEASON_MONTHS, PUBLISHED_HISTORY_LENGTH } from './history'

// ═══════════════════════════════════════════════════════════════════════════════
// Forecasting — per-game constants and the instance configuration (spec §3).
//
// ⚠⚠ THE CONFIG/TRUTH SPLIT IS INVERTED RELATIVE TO NEWSVENDOR, AND THAT IS THE
// WHOLE POINT OF THIS GAME'S DATA MODEL (spec §4, §12).
//
// Newsvendor keeps its economics in config/main because every one of those numbers is
// printed on the student's own screen; only its determinism seed is secret. Here the
// opposite holds: the model parameters ARE the answer. A student who knows
// a = 560, b = 4, H = 230 can forecast the conditional mean exactly and the exercise —
// "explain the systematic variability" (spec §7) — is over. `config/main` is
// STUDENT-READABLE through the plain Firestore SDK by rules, so:
//
//   config/main  (student-readable)  rounds, numHistory, labels, forecast bounds,
//                                    the KC/debrief switches and prompts
//   truth/main   (rules-denied)      a, b, H, σ, highSeasonMonths, seasonality,
//                                    seasonStructure, monthOffsets, demandDraw, seed
//
// This follows the pricing precedent, where the bot rule ids were moved OUT of
// config/main for exactly this reason. Do not move a model parameter back into config,
// and do not relax the truth/ rules block — ever.
//
// The corollary for reviewers: anything a student may read is in `ForecastConfig`
// below, and anything they must not is in `ForecastModel` (demand.ts). A field in the
// wrong interface is a leak, and the type names are chosen so that reads oddly.
// ═══════════════════════════════════════════════════════════════════════════════

import {
  parseAddedKcQuestion as parseSharedAddedKcQuestion,
  parseKcHidden, parseKcOrder, parseKcOverrides,
  type KcHiddenMap, type KcOrderMap, type KcOverrideMap, type KcIdGuard,
} from '../shared/kcSurface'

export type { KcHiddenMap, KcOrderMap, KcOverrideMap, KcOverride } from '../shared/kcSurface'
export { parseKcHidden, parseKcOrder, parseKcOverrides } from '../shared/kcSurface'

/**
 * forecast's stages.
 *
 * ⚠⚠ `post` IS A GENUINE `post_game` (spec §4 — forecast is the ONLY game in that row).
 * It sits AFTER the student's own results screen but BEFORE the model reveal, and
 * `revealGate` refuses the reveal until the stage is satisfied. That server-side refusal is
 * what makes the stage real: a reveal available first would turn every answer into a
 * description of the right answer.
 */
export const FORECAST_KC_STAGES = ['pre', 'post'] as const
export type ForecastKcStage = (typeof FORECAST_KC_STAGES)[number]

/**
 * ⚠⚠ THE STAGE A STAGE-LESS STORED ADDITION LANDS IN — `pre`.
 *
 * DETERMINED, NOT COPIED (spec D16). `forecastGetQuestions` returns added questions in
 * `kc.added`, and Play.tsx builds its pre-play list as
 * `[...questions.kc.authored, ...questions.kc.added]` — so every addition forecast has ever
 * stored is served BEFORE play. Scorecard defaults to `post`; pd, pricing and newsvendor to
 * `pre`. Each preserves its OWN history and none is transferable.
 */
export const DEFAULT_ADDED_KC_STAGE: ForecastKcStage = 'pre'

/** ⚠ The debrief row's id IS its stored answer key. Nothing moves. */
export const DEBRIEF_ROW_ID = 'debrief_method'


/** game_id — lowercase, never displayed. Drives the collection prefix + fn names. */
export const FORECAST_GAME_ID = 'forecast'

/** Collection prefix — every Firestore collection this game owns (architecture §4.1). */
export const FORECAST_COLLECTION_PREFIX = 'forecast'

/** Allowed browser origin for this game's callables (its own subdomain, spec §13). */
export const FORECAST_CORS_ORIGINS = ['https://forecast.mygames.live']

// ── Firestore collection / doc paths (all forecast_ prefixed) ──────────────────
export const INSTANCES_COLLECTION = 'forecast_game_instances'
// Participants are a per-INSTANCE subcollection (structural isolation):
//   forecast_game_instances/{iid}/participants/{pid}
export const PARTICIPANTS_SUBCOLLECTION = 'participants'

/** forecast_game_instances/{id}/config/main — STUDENT-READABLE. Nothing in it says
 *  anything about how demand is generated. */
export const CONFIG_DOC = 'main'

/** forecast_game_instances/{id}/truth/main — rules-denied to every client, forever.
 *  Holds the MODEL and the seed. See the file header for why. */
export const TRUTH_DOC = 'main'

// ── Shipped defaults (spec §2, §3) ─────────────────────────────────────────────

/** Months of history shown at the opening screen. Five years (spec §2). */
export const DEFAULT_NUM_HISTORY = PUBLISHED_HISTORY_LENGTH

/** Months played. Two years — DISPLAYED to the student (spec §4, §14). */
export const DEFAULT_ROUNDS = 24

/** Forecast entry bounds (spec §3): generous, deliberately not a hint. */
export const DEFAULT_FORECAST_MIN = 0
export const DEFAULT_FORECAST_MAX = 3000

/** Bounds on what any config may set for the played-month count. */
export const HARD_MIN_ROUNDS = 1
export const HARD_MAX_ROUNDS = 120

/** Bounds on the history length. Below twelve there is no seasonality to see at all. */
export const HARD_MIN_HISTORY = 12
export const HARD_MAX_HISTORY = 240

/** Product and unit labels (spec §3) — editable text, purely cosmetic. */
export const DEFAULT_PRODUCT_NAME = 'this product'
export const DEFAULT_UNIT_LABEL = 'units'
export const DEFAULT_PERIOD_LABEL = 'month'

/**
 * The annual bonus a Forecast Accuracy of 100% would pay (spec §5a).
 *
 * ⚠ THE MAPPING IS THE PLAIN ONE, ON PURPOSE: bonus = BONUS_AT_PERFECT × (1 − MAPE).
 * Spec §5a records that this COMPRESSES the very distinction the game teaches — the
 * analyst beats the do-nothing forecaster 11× on MSE and by under 5% on the bonus —
 * and that Elena accepted the compression on 08-02, because the bonus is motivational
 * framing and MSE is the scoreboard. A steepened mapping (1 − 5·MAPE) and a
 * benchmark-relative one were both considered and rejected. DO NOT RE-LITIGATE.
 */
export const BONUS_AT_PERFECT = 10000

/**
 * The demand floor below which MAPE stops being well-behaved (spec §5a).
 *
 * MAPE divides by actual demand, so it and the bonus destabilize as demand approaches
 * zero. Settings WARNS — never blocks, per the platform rule — when a config edit
 * could produce demand under this level. MSE stays valid either way.
 */
export const MAPE_STABILITY_FLOOR = 50

/**
 * The shipped debrief prompt (spec §9). One free-text question, ungraded, asked after
 * the final results screen; submitting it reveals the true process.
 */
export const DEFAULT_DEBRIEF_PROMPT =
  'In a few sentences, describe how you made your forecasts. What did you look at in '
  + 'the demand history? Did you use a rule or a method — and if you fitted a model, '
  + 'what did you include in it? Did your approach change as the game went on? Looking '
  + 'at your results now, what would you do differently?'

// ── The instance config ────────────────────────────────────────────────────────

/**
 * ONE instructor-added knowledge-check question.
 *
 * Same model as newsvendor's and pricing's, including both traps: an added question
 * may never take a `kc_` id (the authored set owns that namespace), and optional fields
 * are OMITTED rather than set to undefined, which Firestore rejects outright.
 */
export interface ForecastAddedKcQuestion {
  id: string
  type: 'mc' | 'text'
  prompt: string
  options?: { value: string; label: string }[]
  /** mc only: the correct option value. Absent ⇒ recorded but UNGRADED. */
  correct_value?: string
  explanation?: string
  /** ⚠ Absent ⇒ `pre`, where every question forecast has already stored is served. */
  stage?: ForecastKcStage
}

/**
 * The STUDENT-SAFE instance config (spec §3).
 *
 * ⚠ EVERY FIELD HERE IS SAFE FOR A STUDENT TO READ off `config/main` with the plain
 * SDK. If you are adding a field and cannot say that sentence about it, it belongs in
 * ForecastModel (demand.ts) and in `truth/main` instead.
 */
export interface ForecastConfig {
  /** Months of history shown before play. Not secret — they see all of them. */
  numHistory: number
  /** Months played. DISPLAYED: the header says "month k of N" (spec §4). */
  rounds: number
  /** Forecast box bounds — the same ones the server enforces. */
  forecastMin: number
  forecastMax: number
  /** Cosmetic labels (spec §3). */
  productName: string
  unitLabel: string
  periodLabel: string
  /** Is the knowledge check part of this instance's flow? */
  /**
   * Is the GRADED knowledge check part of this instance's flow?
   *
   * ⚠ GRADED ONLY (convergence spec D12). Off removes the authored nine and any graded
   * addition. The debrief paragraph, and any ungraded free-text addition, are governed by
   * their own visibility.
   */
  kcEnabled: boolean
  /** Instructor-added KC questions, rendered AFTER the authored nine. */
  addedKcQuestions: ForecastAddedKcQuestion[]
  /** Is the debrief paragraph part of this instance's flow? */
  debriefEnabled: boolean
  debriefPrompt: string
  /**
   * ⚠ THE THREE CONVERGENCE FIELDS (spec §5). All optional, all defaulting to exactly
   * today's behaviour, all honoured in BOTH the serve path and the grader.
   */
  kcHidden: KcHiddenMap
  kcOrder: KcOrderMap
  kcOverrides: KcOverrideMap
}

export const DEFAULT_FORECAST_CONFIG: ForecastConfig = {
  numHistory: DEFAULT_NUM_HISTORY,
  rounds: DEFAULT_ROUNDS,
  forecastMin: DEFAULT_FORECAST_MIN,
  forecastMax: DEFAULT_FORECAST_MAX,
  productName: DEFAULT_PRODUCT_NAME,
  unitLabel: DEFAULT_UNIT_LABEL,
  periodLabel: DEFAULT_PERIOD_LABEL,
  kcEnabled: true,
  addedKcQuestions: [],
  debriefEnabled: true,
  debriefPrompt: DEFAULT_DEBRIEF_PROMPT,
  kcHidden: {},
  kcOrder: {},
  kcOverrides: {},
}

/**
 * The `kc_` PREFIX is forecast's collision-guard strategy — the authored set owns that
 * namespace, and the grader looks them up FIRST, so an added question taking one would be
 * silently shadowed.
 *
 * ⚠ Scorecard passes an explicit id SET instead, because its built-in ids are unprefixed.
 * The shared parser carries both strategies (spec §5); picking one unprotects the other.
 *
 * ⚠⚠ IT DOES NOT COVER `debrief_method`, forecast's one free-text id — exactly as
 * newsvendor's rule does not cover `prep_strategy` / `debrief_regular`. An added question
 * could legally take it. Harmless TODAY only because free-text answers live in
 * `free_text_answers` and KC answers in `kc_static_answers`; spec §6's "do not unify the
 * answer maps" is what keeps it harmless. NOT widened — a test pins the current behaviour
 * as a tripwire, per newsvendor and spec §10.
 */
export const FORECAST_KC_ID_GUARD: KcIdGuard = { kind: 'prefix', prefix: 'kc_' }

/**
 * Defensive parse of ONE instructor-added KC question. Returns null if unusable —
 * loadForecastConfig drops those rather than throwing.
 *
 * ⚠ THE BODY LIVES IN `shared/kcSurface` (spec §5). forecast passes its prefix guard and
 * its two stages; an unrecognised stage is dropped, falling back to DEFAULT_ADDED_KC_STAGE.
 */
export function parseAddedKcQuestion(
  raw: unknown,
  guard: KcIdGuard | undefined = FORECAST_KC_ID_GUARD,
): ForecastAddedKcQuestion | null {
  const q = parseSharedAddedKcQuestion(raw, { guard, stages: FORECAST_KC_STAGES })
  return q === null ? null : (q as ForecastAddedKcQuestion)
}

/** The stage a stored added question is asked in. ⚠ Absent ⇒ `pre` — see the constant. */
export function addedKcStage(q: ForecastAddedKcQuestion): ForecastKcStage {
  return q.stage ?? DEFAULT_ADDED_KC_STAGE
}

/** A finite number from a stored field, or the shipped default. */
function num(raw: unknown, fallback: number): number {
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : fallback
}

/** A string from a stored field, trimmed, or the shipped default. */
function str(raw: unknown, fallback: string): string {
  return typeof raw === 'string' && raw.trim() ? raw.trim() : fallback
}

/** A positive integer from a stored field, clamped to hard bounds. */
function intIn(raw: unknown, fallback: number, lo: number, hi: number): number {
  if (typeof raw !== 'number' || !Number.isInteger(raw)) return fallback
  return Math.max(lo, Math.min(hi, raw))
}

/**
 * The effective STUDENT-SAFE config for an instance: stored values over shipped
 * defaults.
 *
 * A malformed field FALLS BACK, never throws — the same posture as every loader in
 * this family, so a half-written config doc can never make the game unplayable. The
 * strict checks live in forecastUpdateConfig, which is where an instructor is actually
 * told what is wrong.
 */
export function loadForecastConfig(configData: Record<string, unknown> | undefined): ForecastConfig {
  const d = configData ?? {}

  // The forecast bounds are read as a PAIR: an inverted or unusable pair falls back to
  // the shipped pair rather than to one stored number and one default, which would be
  // a range no instructor ever chose.
  const loRaw = d.forecast_min
  const hiRaw = d.forecast_max
  const bothNums = typeof loRaw === 'number' && Number.isFinite(loRaw)
    && typeof hiRaw === 'number' && Number.isFinite(hiRaw)
  const usablePair = bothNums && (hiRaw as number) > (loRaw as number) && (loRaw as number) >= 0
  const forecastMin = usablePair ? Math.round(loRaw as number) : DEFAULT_FORECAST_MIN
  const forecastMax = usablePair ? Math.round(hiRaw as number) : DEFAULT_FORECAST_MAX

  return {
    numHistory: intIn(d.num_history, DEFAULT_NUM_HISTORY, HARD_MIN_HISTORY, HARD_MAX_HISTORY),
    rounds: intIn(d.rounds, DEFAULT_ROUNDS, HARD_MIN_ROUNDS, HARD_MAX_ROUNDS),
    forecastMin,
    forecastMax,
    productName: str(d.product_name, DEFAULT_PRODUCT_NAME),
    unitLabel: str(d.unit_label, DEFAULT_UNIT_LABEL),
    periodLabel: str(d.period_label, DEFAULT_PERIOD_LABEL),
    // Absent ⇒ ON. An instance created before a toggle existed keeps the flow it had.
    kcEnabled: d.kc_enabled !== false,
    addedKcQuestions: (Array.isArray(d.added_kc_questions) ? d.added_kc_questions : [])
      .map(q => parseAddedKcQuestion(q))
      .filter((q): q is ForecastAddedKcQuestion => q !== null),
    debriefEnabled: d.debrief_enabled !== false,
    // ⚠ Total on absent — an instance written before these existed reads as "no hides,
    // authored order, no rewrites", which is exactly the behaviour it already had.
    kcHidden: parseKcHidden(d.kc_hidden),
    kcOrder: parseKcOrder(d.kc_order),
    kcOverrides: parseKcOverrides(d.kc_overrides),
    debriefPrompt: str(d.debrief_prompt, DEFAULT_DEBRIEF_PROMPT),
  }
}

// ── The secret half: the model and the seed, from truth/main ───────────────────

/** A finite-number array of exactly `len` entries, or null when unusable. */
function numArray(raw: unknown, len: number): number[] | null {
  if (!Array.isArray(raw) || raw.length !== len) return null
  const out: number[] = []
  for (const v of raw) {
    if (typeof v !== 'number' || !Number.isFinite(v)) return null
    out.push(v)
  }
  return out
}

/**
 * The generating MODEL, read from the RULES-DENIED truth doc.
 *
 * ⚠ SERVER-SIDE ONLY. Every field here is an answer key. No student callable response
 * carries any of it — the whitelist in clientState.ts is what enforces that, and the
 * harness audits every response tree for these values (spec §12).
 *
 * Malformed fields fall back to the shipped default, same posture as the config
 * loader: a half-written truth doc yields a playable game at the published parameters
 * rather than an unplayable one.
 */
export function loadForecastModel(truthData: Record<string, unknown> | undefined): ForecastModel {
  const d = truthData ?? {}

  // The high season is read as a whole SET: any unusable entry rejects the whole
  // array back to the shipped {Nov, Dec}, rather than silently keeping a partial
  // season that no instructor chose.
  const monthsRaw = Array.isArray(d.high_season_months) ? d.high_season_months : null
  const months = monthsRaw !== null
    && monthsRaw.every(m => typeof m === 'number' && Number.isInteger(m) && m >= 1 && m <= 12)
    ? (monthsRaw as number[])
    : [...DEFAULT_HIGH_SEASON_MONTHS]

  const H = num(d.high_season_lift, DEFAULT_MODEL.H)

  return {
    a: num(d.intercept, DEFAULT_MODEL.a),
    b: num(d.trend, DEFAULT_MODEL.b),
    H,
    highSeasonMonths: months,
    // Negative noise is meaningless and would make Box–Muller produce a mirrored
    // draw rather than an error, so it is taken as an absolute value.
    sigma: Math.abs(num(d.sigma, DEFAULT_MODEL.sigma)),
    seasonality: d.seasonality === 'multiplicative' ? 'multiplicative' : 'additive',
    seasonStructure: d.season_structure === 'perMonth' ? 'perMonth' : 'twoSeason',
    // Absent ⇒ the two-season pattern implied by THIS instance's own lift and season,
    // not the shipped one, so flipping to perMonth on an edited instance is still the
    // no-op it is on a default one.
    monthOffsets: numArray(d.month_offsets, 12)
      ?? Array.from({ length: 12 }, (_, i) => (months.includes(i + 1) ? H : 0)),
    // ⚠ ABSENT ⇒ 'common', matching the shipped default (demand.ts, Elena 08-02).
    // The loader and DEFAULT_MODEL must agree: if this still said 'perStudent' an
    // instance whose truth doc predates the field would quietly run the OTHER draw
    // mode from the one the defaults advertise — and nothing on screen would say so.
    demandDraw: d.demand_draw === 'perStudent' ? 'perStudent' : 'common',
  }
}

/**
 * The determinism seed, from the same rules-denied truth doc.
 *
 * Blank/absent = real randomness for the FUTURES. The history stays fixed regardless —
 * but "fixed" here means fixed WITH RESPECT TO THE SEED, not fixed absolutely: the sixty
 * months are generated from a, b, H, σ and the high season, so they move when those do
 * (see resolveHistory). Set = every draw is a pure function of
 * (seed, participant_id, period), so a harness run is reproducible while draws stay
 * independent across students. A number seed is normalized to its string form, so
 * seed: 7 and seed: "7" produce the SAME draws.
 */
export function loadForecastSeed(truthData: Record<string, unknown> | undefined): string | null {
  const raw = truthData?.seed
  if (typeof raw === 'string' && raw.trim() !== '') return raw.trim()
  if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw)
  return null
}

/** The seed a brand-new instance is provisioned with (spec §2: "1 for the published
 *  history"). Settings can clear it to get real randomness. */
export { DEFAULT_SEED }
