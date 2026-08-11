// ═══════════════════════════════════════════════════════════════════════════════
// Procurement Auction — per-game constants and the instance configuration.
//
// Authorities: `Procurement_Auction_Specification_v3_sealed_FINAL.md` §3 (Part 1) and
// `Procurement_Auction_Specification_v2_open_FINAL.md` §3 (Part 2). Part 1 is the
// parent document; Part 2 adds `decrementSchedule`, `delaySchedule` and `delayJitterMs`
// and nothing else. ⚠ `botDelayMs` is GONE — open §3 (2026-08-04) replaced the scalar
// pair with a band schedule, for the reason recorded beside DEFAULT_DELAY_SCHEDULE.
//
// ⚠⚠ ONE GAME, TWO FORMATS, ONE game_id (Part 1 §14.1). `format` is INSTANCE CONFIG,
// never a second game_id and never a second set of callables — the Pricing/PMG
// precedent. Everything in this file is shared by both formats; only the keys marked
// "open only" are inert in a sealed instance.
//
// ⚠⚠ THE CONFIG/TRUTH SPLIT FOLLOWS NEWSVENDOR, NOT FORECAST — and the reason is that
// this game's parameters are TAUGHT, not hidden:
//
//   config/main  (student-readable)  format, rounds, rivalCount, reserve, both cost
//                                    distributions, bid increment, the open-format
//                                    pacing keys, labels, KC/debrief switches
//   truth/main   (rules-denied)      seed — and only seed
//
// The rival cost range IS the lesson. Slide 4 states it, and the equilibrium markup the
// scatter plots against (`c + (reserve − c)/n`) is only computable by a student who
// knows the top of that range. Hiding it would hide the answer to the question the
// debrief asks. What must stay hidden is the SEED, because it derives every rival cost
// draw — a student holding it could compute round 5's rivals before bidding in round 4.
// Same discipline as newsvendor/config.ts, for the same reason.
//
// ⚠ PROPOSAL, NOT A SETTLED CALL. Whether `rivalCostDist` is public is a
// general-vs-game-specific decision and it is Elena's. The split above is what the two
// specs imply; if it is wrong the fix is to move the key into truth/ before any
// instance exists, which is cheap now and expensive after 11/01.
// ═══════════════════════════════════════════════════════════════════════════════

import {
  parseAddedKcQuestion as parseSharedAddedKcQuestion,
  parseKcHidden, parseKcOrder, parseKcOverrides,
  type KcHiddenMap, type KcOrderMap, type KcOverrideMap, type KcIdGuard,
} from '../shared/kcSurface'

import type { DecrementBand, DelayBand } from './auction/schedule'

/** game_id — lowercase, never displayed. Drives the collection prefix + fn names. */
export const PROCUREMENT_GAME_ID = 'procurement'

/** Collection prefix — every Firestore collection this game owns (architecture §4.1). */
export const PROCUREMENT_COLLECTION_PREFIX = 'procurement'

/**
 * Allowed browser origin for this game's callables — its own subdomain, and only that.
 *
 * ⚠ ONE ORIGIN FOR BOTH FORMATS. The two instances share a hosting site because they
 * share a game_id; there is no `procurement-open.mygames.live`.
 */
export const PROCUREMENT_CORS_ORIGINS = ['https://procurement.mygames.live']

// ── Firestore collection / doc paths (all procurement_ prefixed) ───────────────
export const INSTANCES_COLLECTION = 'procurement_game_instances'
// Participants are a per-INSTANCE subcollection (architecture §4.2):
//   procurement_game_instances/{iid}/participants/{pid}
// ⚠ NEVER top-level — that was a real v1 bug in both pennies and poll.
export const PARTICIPANTS_SUBCOLLECTION = 'participants'

/** procurement_game_instances/{id}/config/main — STUDENT-READABLE. */
export const CONFIG_DOC = 'main'

/** procurement_game_instances/{id}/truth/main — rules-denied to every client, forever.
 *  Holds the determinism seed and nothing else. See the file header. */
export const TRUTH_DOC = 'main'

// ── Formats ────────────────────────────────────────────────────────────────────

/** The two mechanisms. Part 1 §3: legal values for `format`. */
export const FORMATS = ['sealed_first_price', 'open_descending'] as const
export type ProcurementFormat = (typeof FORMATS)[number]

export const DEFAULT_FORMAT: ProcurementFormat = 'sealed_first_price'

/**
 * `direction` — Part 1 §3: **only legal value `reverse`**, and NOT instructor-facing.
 *
 * It exists as a named key rather than an assumption because the eventual auction-engine
 * extraction needs one direction-neutral concept (Part 1 §13.1, the SAA lesson), and a
 * value that was never written down is a value the extraction has to re-derive. Settings
 * does not render it.
 */
export const DIRECTION = 'reverse' as const

// ── Shipped defaults (Part 1 §3, Part 2 §3) ────────────────────────────────────

export const DEFAULT_ROUNDS = 8
export const DEFAULT_RIVAL_COUNT = 4
export const DEFAULT_BID_INCREMENT_UNIT = 1

/** Bounds on what any config may set. Wide — these stop nonsense, not choices. */
export const HARD_MIN_ROUNDS = 1
export const HARD_MAX_ROUNDS = 50
export const HARD_MIN_RIVALS = 1
export const HARD_MAX_RIVALS = 20

/** A cost distribution, as an EXPLICIT OBJECT rather than bare min/max fields
 *  (Part 1 §3, the `sigma` → `signalHalfWidth` precedent). */
export interface CostDist {
  distribution: 'uniform'
  min: number
  max: number
  integer: boolean
}

export const DEFAULT_RIVAL_COST_DIST: CostDist =
  { distribution: 'uniform', min: 10, max: 110, integer: true }
export const DEFAULT_PLAYER_COST_DIST: CostDist =
  { distribution: 'uniform', min: 10, max: 60, integer: true }

/**
 * The reserve — the incumbent's per-unit price. Bid ceiling in the sealed format, and
 * the OPENING PRICE in the open one (Part 2 §3: one setting, no separate `openingPrice`).
 *
 * Defaults to the top of the rival cost range, which reproduces the SoPHIE original, but
 * it is a SEPARATE CONCEPT and therefore its own key (Part 1 §3.1). Lowering it makes
 * slide 10's entry decision live — and changes the equilibrium markup, which is why the
 * bot bid function is conditioned on it (Part 1 §5.1) rather than hardcoding the simple
 * form. That conditioning is Checkpoint 2 work; the KEY is here now so Settings is
 * shaped for it.
 */
export const defaultReserve = (rivalCostDist: CostDist): number => rivalCostDist.max

/** Open format only (Part 2 §3). A MINIMUM step per price band, not a fixed step.
 *  ⚠ The band TYPES have one author — `auction/schedule.ts`, which also owns the single
 *  band-lookup both schedules read through. Re-exported here so config consumers do not
 *  have to know that, and so a second, subtly different `{ above, step }` cannot appear. */
export type { DecrementBand, DelayBand }

export const DEFAULT_DECREMENT_SCHEDULE: DecrementBand[] = [
  { above: 80, step: 10 },
  { above: 50, step: 5 },
  { above: 30, step: 2 },
  { above: 0, step: 1 },
]

/**
 * Open format only (Part 2 §3). ⚠⚠ THIS REPLACES v2's `botDelayMs` SCALAR PAIR, and the
 * replacement is the point rather than a refactor: open §2's pacing arithmetic shows a
 * single uniform delay cannot serve both phases — fast enough to keep the ten-step bot
 * cascade from dragging is too fast for a human to decide and click in the endgame duel.
 * Phase 1 lives almost entirely in the coarse bands and Phase 2 always in the fine ones,
 * so band-based pacing separates them with no special-casing at all.
 *
 * ⚠ TUNE FROM THE FIRST LIVE RUN. It is instance config precisely so that costs a
 * settings edit, not a deploy (open §2, §9 step 5).
 */
export const DEFAULT_DELAY_SCHEDULE: DelayBand[] = [
  { above: 80, delayMs: 800 },
  { above: 50, delayMs: 1200 },
  { above: 30, delayMs: 2500 },
  { above: 0, delayMs: 3000 },
]

/** Open format only (Part 2 §3). Randomized ± per bot decision so the rhythm is not
 *  metronomic. ⚠ UX ONLY, NEVER STRATEGIC — it must not reach a bot's decision. */
export const DEFAULT_DELAY_JITTER_MS = 250

/** A jitter wider than this is refused: at some point the "random" wait stops reading as
 *  a person thinking and starts reading as a broken page. Wide enough to be a choice. */
export const HARD_MAX_DELAY_JITTER_MS = 5_000

// ── Labels + question switches ─────────────────────────────────────────────────

export const DEFAULT_CURRENCY_LABEL = 'ECU'
export const DEFAULT_KC_ENABLED = true

// ⚠ THERE IS NO `debriefEnabled` / `debriefPrompt` PAIR, deliberately. The prep and
// debrief paragraphs are POOL ENTRIES (S8/S9, O9/O10) with a `stage` tag, switched on and
// off through `kcVisible` exactly like every graded question, and their wording comes from
// the KC document. A separate enable flag and a separate editable prompt would be a second
// source of truth for questions the pool already owns — and the version that shipped at
// spawn carried placeholder wording that would have gone out over the authored text.

// ── The KC surface (convergence spec §5) ──────────────────────────────────────

export type { KcHiddenMap, KcOrderMap, KcOverrideMap, KcOverride } from '../shared/kcSurface'
export { parseKcHidden, parseKcOrder, parseKcOverrides } from '../shared/kcSurface'

/**
 * Every BUILT-IN id — the collision guard's authority, injected rather than imported so
 * this module stays free of the question pool (the pool imports nothing from here, and the
 * cycle never forms — the same reason `knownKcIds` is a parameter of `loadProcurementConfig`).
 * `questions.ts` calls `setProcurementBuiltInIds(KC_POOL_IDS)` at module load.
 */
let PROCUREMENT_BUILT_IN_IDS: ReadonlySet<string> = new Set()

export function setProcurementBuiltInIds(ids: readonly string[]): void {
  PROCUREMENT_BUILT_IN_IDS = new Set(ids)
}

export function procurementBuiltInIds(): ReadonlySet<string> {
  return PROCUREMENT_BUILT_IN_IDS
}

/**
 * ⚠⚠ D18 — PROCUREMENT'S `kcVisible` IS MIGRATED TO `kc_hidden`, NOT PRESERVED.
 *
 * This game shipped the OPPOSITE polarity from the other five: a WHITELIST ARRAY of the ids
 * an instructor has switched ON, where the family stores a map of the ids switched OFF.
 * One game of six holding the inverse is a trap for whoever reads this code next, and this
 * is the last moment it can be fixed cheaply (Elena, 08-10).
 *
 * ⚠ THE DANGER IS NOT MIGRATING — IT IS MIGRATING CARELESSLY. A conversion that carries the
 * ids across without inverting them flips every live instance: every question deliberately
 * hidden becomes visible and every visible one hides.
 *
 * READ-BOTH / WRITE-NEW, no batch script:
 *   READ  — `kc_hidden` if present; else convert `kcVisible`; else nothing is hidden.
 *   WRITE — every save writes `kc_hidden` and DELETES `kcVisible`. Instances heal on the
 *           first save an instructor makes.
 *   BOTH  — `kc_hidden` wins and `kcVisible` is ignored. Should not happen; pinned anyway.
 *
 * ⚠ THE LEGACY BRANCH IS LIVE CODE WITH A TEST, NOT DEAD WEIGHT. Deleting it strands every
 * instance not yet re-saved. It goes only once no live instance holds `kcVisible`, and that
 * is not this pass.
 */
export function migrateKcHidden(
  raw: { kcHidden: unknown; kcVisible: unknown },
  /**
   * ⚠⚠ THE IDS THE WHITELIST COULD HAVE SPOKEN ABOUT — the CURRENT FORMAT'S pool, not the
   * whole pool, and this is the single most consequential line in the migration.
   *
   * `kcVisible` was written by a Settings page listing `poolForFormat(format)`, so it is a
   * whitelist over ONE format's questions. Converting against the WHOLE pool would mark every
   * other-format id hidden even while the instance stays in its own format — questions that
   * were never switched off because they were never offered.
   *
   * ⚠⚠ THIS DOES NOT "FIX" THE FORMAT FLIP, AND MUST NOT. A sealed-era whitelist read under
   * the OPEN format still hides the open-only ids, because that is what the legacy reader
   * did: `resolveQuestions` filtered on `on.has(id)`, so flipping format kept the choices
   * that still applied and lost the ones that did not (see `parseKcVisible`'s note). A
   * MIGRATION MUST NOT CHANGE BEHAVIOUR — the point is to change the FIELD, and any
   * behavioural improvement smuggled in with it would be indistinguishable from a bug in the
   * conversion. The instructor's escape hatch is that the settings page now LISTS those
   * questions with their boxes unticked, so an empty check is visible instead of unexplained.
   */
  formatPoolIds: readonly string[],
): KcHiddenMap {
  // ⚠ `kc_hidden` WINS when both are present. The new field is the one a save wrote.
  if (raw.kcHidden !== undefined && raw.kcHidden !== null) return parseKcHidden(raw.kcHidden)

  // ⚠ ABSENT `kcVisible` IS NOT AN EMPTY ONE. A doc with no key has never been configured,
  // and nothing is hidden — the format filter alone decides what is asked, which is exactly
  // what the old `defaultVisibleFor(format)` fallback produced. An EMPTY ARRAY is an
  // instructor who deliberately switched everything off, and every id must convert to
  // hidden: true, or the next load silently turns the knowledge check back on.
  if (!Array.isArray(raw.kcVisible)) return {}

  const visible = new Set(raw.kcVisible.filter((v): v is string => typeof v === 'string'))
  const out: KcHiddenMap = {}
  for (const id of formatPoolIds) {
    // ⚠ ONLY THE HIDDEN ENTRIES ARE WRITTEN. `kcVisible` was FULL — the shipped default is
    // every id for the format — so carrying it across whole would leave procurement holding
    // a map with an entry per question while the other five hold a short one. That is the
    // same inconsistency under a new name, which is the thing D18 exists to end.
    if (!visible.has(id)) out[id] = true
  }
  return out
}

/**
 * procurement's stages, AS THE INSTRUCTOR SEES THEM.
 *
 * ⚠⚠ THE POOL HAS THREE STAGE TAGS AND THE PICKER OFFERS TWO. `kc` and `prep` are both
 * asked BEFORE the first round — the graded questions then the written plan — so they are
 * ONE stage to configure and two tags to serve. `debrief` is asked after the final results
 * screen. A built-in's own `stage` tag is NEVER rewritten; only the display grouping merges
 * `prep` into `kc`.
 */
export const PROCUREMENT_KC_STAGES = ['kc', 'debrief'] as const
export type ProcurementKcStage = (typeof PROCUREMENT_KC_STAGES)[number]

/**
 * ⚠⚠ THE STAGE A STAGE-LESS STORED ADDITION LANDS IN — `kc`, the pre-play stage.
 *
 * ⚠ CHOSEN, NOT MEASURED, AND PROCUREMENT IS THE ONLY GAME WHERE THAT IS TRUE (D16). The
 * other five each measured where their existing additions were already being served and
 * pinned that, because a different value would have relocated live questions. Procurement
 * has never had an `addedKcQuestions` field at all, so there is no history to preserve and
 * nothing to measure. `kc` matches the other four prefixed games and is the stage an
 * instructor adding a question is most likely to mean.
 */
export const DEFAULT_ADDED_KC_STAGE: ProcurementKcStage = 'kc'

/**
 * ⚠⚠ PROCUREMENT NEEDS THE EXPLICIT ID SET, NOT THE `kc_` PREFIX RULE.
 *
 * Its built-in ids are `S1`…`S9` and `O1`…`O10` — none carries a `kc_` prefix, so the
 * prefix rule would protect NOTHING here: an added question could take `S3` and silently
 * shadow a built-in in the grader's lookup. Scorecard is in the same position for the same
 * reason (`q1_negotiated_ppm`). pd, pricing, newsvendor and forecast use the prefix rule.
 * The shared parser carries both strategies precisely so neither game has to fork it.
 *
 * ⚠ AND HERE THE GUARD COVERS THE FREE-TEXT QUESTIONS TOO, unlike every other game. S8/S9
 * and O9/O10 are ordinary pool entries, so they are in this set and an added question
 * cannot take one of their ids. Elsewhere the free-text ids sit outside the guard and are
 * kept safe only by the answer maps being separate (spec §6).
 */
export function procurementKcIdGuard(): KcIdGuard {
  return { kind: 'idSet', ids: PROCUREMENT_BUILT_IN_IDS }
}

/**
 * Defensive parse of ONE instructor-added KC question. Returns null if unusable —
 * `loadProcurementConfig` drops those rather than throwing.
 *
 * ⚠ THE BODY LIVES IN `shared/kcSurface` (spec §5). procurement passes its id SET and its
 * two stages; an unrecognised stage is dropped, falling back to DEFAULT_ADDED_KC_STAGE.
 */
export function parseAddedKcQuestion(
  raw: unknown,
  guard: KcIdGuard = procurementKcIdGuard(),
): ProcurementAddedKcQuestion | null {
  const q = parseSharedAddedKcQuestion(raw, { guard, stages: PROCUREMENT_KC_STAGES })
  return q === null ? null : (q as ProcurementAddedKcQuestion)
}

/** The stage a stored added question is asked in. ⚠ Absent ⇒ `kc` — see the constant. */
export function addedKcStage(q: ProcurementAddedKcQuestion): ProcurementKcStage {
  return q.stage ?? DEFAULT_ADDED_KC_STAGE
}

/** ONE instructor-added knowledge-check question. */
export interface ProcurementAddedKcQuestion {
  id: string
  type: 'mc' | 'text'
  prompt: string
  options?: { value: string; label: string }[]
  /** mc only: the correct option value. Absent ⇒ recorded but UNGRADED. */
  correct_value?: string
  explanation?: string
  /** ⚠ Absent ⇒ `kc`, the pre-play stage. */
  stage?: ProcurementKcStage
}

// ── The effective config ───────────────────────────────────────────────────────

/** Everything a student may read. Anything they must not is absent BY TYPE — the seed
 *  lives in `ProcurementTruth` (instance.ts) and never enters this interface. */
export interface ProcurementConfig {
  format: ProcurementFormat
  /** Not instructor-facing; always `reverse`. Carried for the extraction. */
  direction: typeof DIRECTION
  rounds: number
  rivalCount: number
  reserve: number
  rivalCostDist: CostDist
  playerCostDist: CostDist
  bidIncrementUnit: number
  /** Open format only. Inert in a sealed instance, never removed from the shape. */
  decrementSchedule: DecrementBand[]
  /** Open format only. ⚠ Replaces v2's `botDelayMs` scalar pair — see the default above. */
  delaySchedule: DelayBand[]
  /** Open format only. ± ms around the scheduled delay. UX only, never strategic. */
  delayJitterMs: number
  currencyLabel: string
  /**
   * Is the reserve still FOLLOWING the top of the rival cost range?
   *
   * ⚠⚠ RECORDED, NOT DERIVED. The tempting shortcut is "the reserve is following iff
   * `reserve === rivalCostDist.max`" — but an instructor who deliberately sets the reserve
   * TO the rival max is indistinguishable from one who never touched it, and their setting
   * would silently start moving the next time the range changed. Same lesson as the
   * player's cost and `winner_id` (BUILD_NOTES 6e): record the fact.
   *
   * True until the instructor edits the reserve; false from then on. Resetting the reserve
   * (sending null) turns it back on.
   *
   * Why it matters: `reserve` defaults to the rival max, and a rival whose cost exceeds
   * the reserve makes NO BID (§3.1). So raising the rival max from 110 to 130 with a
   * fixed reserve turns the instance into a lowered-reserve game with bots absent from
   * the auction — legal (§3.1 teaches it), but never something that should happen by
   * accident.
   */
  reserveAuto: boolean
  kcEnabled: boolean
  /**
   * ⚠ THE KC IS ONE MERGED POOL WITH PER-QUESTION VISIBILITY (Part 1 §10 / KC v3).
   * This holds the ids the instructor has switched ON. The GRADED DENOMINATOR IS
   * COMPUTED FROM THE VISIBLE GRADED QUESTIONS AT SCORING TIME AND IS NEVER STORED —
   * see questions.ts. There is no `/17` anywhere in this game.
   */
  kcVisible: string[]
  /**
   * ⚠⚠ THE THREE CONVERGENCE FIELDS (spec §5). `kcHidden` REPLACES `kcVisible` (D18) — the
   * legacy field above is still READ, and still parsed, but nothing writes it any more and
   * nothing downstream consults it. It stays only so the migration has something to read.
   */
  kcHidden: KcHiddenMap
  kcOrder: KcOrderMap
  kcOverrides: KcOverrideMap
  addedKcQuestions: ProcurementAddedKcQuestion[]
}

export const DEFAULT_CONFIG: ProcurementConfig = {
  format: DEFAULT_FORMAT,
  direction: DIRECTION,
  rounds: DEFAULT_ROUNDS,
  rivalCount: DEFAULT_RIVAL_COUNT,
  reserve: defaultReserve(DEFAULT_RIVAL_COST_DIST),
  rivalCostDist: DEFAULT_RIVAL_COST_DIST,
  playerCostDist: DEFAULT_PLAYER_COST_DIST,
  bidIncrementUnit: DEFAULT_BID_INCREMENT_UNIT,
  decrementSchedule: DEFAULT_DECREMENT_SCHEDULE,
  delaySchedule: DEFAULT_DELAY_SCHEDULE,
  delayJitterMs: DEFAULT_DELAY_JITTER_MS,
  currencyLabel: DEFAULT_CURRENCY_LABEL,
  reserveAuto: true,
  kcEnabled: DEFAULT_KC_ENABLED,
  kcVisible: [],
  kcHidden: {},
  kcOrder: {},
  kcOverrides: {},
  addedKcQuestions: [],
}

// ── Defensive parsing ──────────────────────────────────────────────────────────
//
// Same posture as every other game in this family: anything malformed falls back to the
// shipped default rather than throwing, so a half-written config doc can never make an
// instance unplayable. An instance that has never been opened in Settings is playable.

const int = (v: unknown, fallback: number, min: number, max: number): number => {
  if (typeof v !== 'number' || !Number.isInteger(v)) return fallback
  return Math.max(min, Math.min(max, v))
}

const bool = (v: unknown, fallback: boolean): boolean =>
  typeof v === 'boolean' ? v : fallback

const str = (v: unknown, fallback: string): string =>
  typeof v === 'string' && v.trim() !== '' ? v : fallback

export function isFormat(v: unknown): v is ProcurementFormat {
  return typeof v === 'string' && (FORMATS as readonly string[]).includes(v)
}

/** A cost distribution, read defensively. A malformed or inverted range reads as the
 *  shipped default in full — never half of one and half of the other, which would be a
 *  range nobody chose. */
export function parseCostDist(raw: unknown, fallback: CostDist): CostDist {
  if (typeof raw !== 'object' || raw === null) return fallback
  const d = raw as Record<string, unknown>
  if (d.distribution !== 'uniform') return fallback
  const min = typeof d.min === 'number' && Number.isFinite(d.min) ? d.min : null
  const max = typeof d.max === 'number' && Number.isFinite(d.max) ? d.max : null
  if (min === null || max === null || min > max) return fallback
  return { distribution: 'uniform', min, max, integer: bool(d.integer, fallback.integer) }
}

/**
 * A band schedule, read defensively and SORTED DESCENDING BY BAND.
 *
 * ⚠ ORDER IS LOAD-BEARING — `bandAt` takes the FIRST band whose `above` the current price
 * exceeds — so it is normalized here rather than trusted from the doc. An instructor who
 * types the bands bottom-up gets the schedule they meant rather than a silently inverted
 * one, and the two schedules cannot disagree about it because they share this parser.
 *
 * ⚠ A schedule that parses to NOTHING falls back to the shipped default in full, never to
 * an empty array: `bandAt` throws on an empty schedule, and a config edit must not be able
 * to make an instance unplayable.
 */
function parseBands<T extends { above: number }>(
  raw: unknown,
  fallback: T[],
  readValue: (b: Record<string, unknown>) => Partial<T> | null,
): T[] {
  if (!Array.isArray(raw)) return fallback
  const out: T[] = []
  for (const el of raw) {
    if (typeof el !== 'object' || el === null) continue
    const b = el as Record<string, unknown>
    if (typeof b.above !== 'number' || !Number.isFinite(b.above) || b.above < 0) continue
    const value = readValue(b)
    if (value === null) continue
    out.push({ above: b.above, ...value } as T)
  }
  if (out.length === 0) return fallback
  return out.sort((a, b) => b.above - a.above)
}

export function parseDecrementSchedule(raw: unknown): DecrementBand[] {
  return parseBands<DecrementBand>(raw, DEFAULT_DECREMENT_SCHEDULE, b =>
    // ⚠ A step of 0 is refused, not clamped. It would make `maxLegalBid` return the
    // standing price itself, so a bot would "undercut" without moving and the cascade
    // would never terminate — the case `settle`'s loop guard exists to shout about.
    typeof b.step === 'number' && Number.isInteger(b.step) && b.step >= 1
      ? { step: b.step }
      : null)
}

/** The DELAY schedule (open §3) — same shape, same parser, same lookup as the decrement
 *  schedule. ⚠ A delay of 0 is legal: an instructor testing pacing may want the cascade
 *  to run flat out, and nothing breaks if it does. */
export function parseDelaySchedule(raw: unknown): DelayBand[] {
  return parseBands<DelayBand>(raw, DEFAULT_DELAY_SCHEDULE, b =>
    typeof b.delayMs === 'number' && Number.isFinite(b.delayMs) && b.delayMs >= 0
      ? { delayMs: Math.round(b.delayMs) }
      : null)
}

/**
 * The visible-KC id list. Unknown ids are DROPPED rather than carried, so a question
 * removed from the pool cannot keep counting toward a denominator it no longer has a
 * question for.
 *
 * ⚠ ABSENT IS NOT THE SAME AS EMPTY. A doc with no `kcVisible` key has never been
 * configured, and falls back to the format's default set (S in a sealed instance, O in an
 * open one). A doc with an EMPTY ARRAY is an instructor who deliberately switched
 * everything off, and must stay switched off — re-defaulting it would silently turn the
 * knowledge check back on the next time anyone loaded the config.
 */
function parseKcVisible(raw: unknown, known: readonly string[], fallback: () => string[]): string[] {
  if (raw === undefined || raw === null) return fallback()
  if (!Array.isArray(raw)) return fallback()
  const set = new Set(known)
  return raw.filter((v): v is string => typeof v === 'string' && set.has(v))
}

/**
 * The instance's effective student-readable config: stored values over shipped defaults.
 *
 * `knownKcIds` is injected rather than imported so this module stays free of the
 * question pool — the pool imports nothing from here, and the cycle never forms.
 */
export function loadProcurementConfig(
  raw: unknown,
  knownKcIds: readonly string[] = [],
  defaultVisible: (f: ProcurementFormat) => string[] = () => [],
): ProcurementConfig {
  const d = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>

  const rivalCostDist = parseCostDist(d.rivalCostDist, DEFAULT_RIVAL_COST_DIST)
  const playerCostDist = parseCostDist(d.playerCostDist, DEFAULT_PLAYER_COST_DIST)
  const format = isFormat(d.format) ? d.format : DEFAULT_FORMAT

  return {
    format,
    direction: DIRECTION,
    rounds: int(d.rounds, DEFAULT_ROUNDS, HARD_MIN_ROUNDS, HARD_MAX_ROUNDS),
    rivalCount: int(d.rivalCount, DEFAULT_RIVAL_COUNT, HARD_MIN_RIVALS, HARD_MAX_RIVALS),
    // ⚠ The reserve DEFAULTS FROM the rival range but is not clamped to it — lowering it
    // below the cost max is a legitimate instructor choice (Part 1 §3.1), and clamping
    // would silently undo the very setting the slide teaches.
    reserve: typeof d.reserve === 'number' && Number.isFinite(d.reserve)
      ? d.reserve
      : defaultReserve(rivalCostDist),
    rivalCostDist,
    playerCostDist,
    bidIncrementUnit: int(d.bidIncrementUnit, DEFAULT_BID_INCREMENT_UNIT, 1, 1000),
    decrementSchedule: parseDecrementSchedule(d.decrementSchedule),
    delaySchedule: parseDelaySchedule(d.delaySchedule),
    delayJitterMs: int(d.delayJitterMs, DEFAULT_DELAY_JITTER_MS, 0, HARD_MAX_DELAY_JITTER_MS),
    currencyLabel: str(d.currencyLabel, DEFAULT_CURRENCY_LABEL),
    // ⚠ Defaults TRUE, so an instance written before this field existed behaves as it
    // always did: its reserve equals the rival max and follows it.
    reserveAuto: bool(d.reserveAuto, true),
    kcEnabled: bool(d.kcEnabled, DEFAULT_KC_ENABLED),
    kcVisible: parseKcVisible(d.kcVisible, knownKcIds, () => defaultVisible(format)),
    // ⚠⚠ D18 — THE MIGRATION, in ONE extracted function rather than inline here. It is a
    // DECISION ("which field wins, and how does the old one convert"), and a decision
    // inlined in a config reader is a decision no unit test can reach: forecast lost two
    // mutants to exactly that (spec §7). `migrateKcHidden` is called here and tested
    // directly.
    kcHidden: migrateKcHidden(
      { kcHidden: d.kc_hidden, kcVisible: d.kcVisible },
      // ⚠ THE CURRENT FORMAT'S POOL, not the whole pool. See migrateKcHidden's own note —
      // converting against every id would hide the other format's questions outright.
      defaultVisible(format),
    ),
    kcOrder: parseKcOrder(d.kc_order),
    kcOverrides: parseKcOverrides(d.kc_overrides),
    addedKcQuestions: Array.isArray(d.added_kc_questions)
      ? d.added_kc_questions
        .map(q => parseAddedKcQuestion(q))
        .filter((q): q is ProcurementAddedKcQuestion => q !== null)
      : [],
  }
}

/** The determinism seed, read from the RULES-DENIED truth doc.
 *  Blank = real randomness. Set = deterministic from (seed, participantId, round). */
export function loadProcurementSeed(raw: unknown): string | null {
  const d = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  return typeof d.seed === 'string' && d.seed.trim() !== '' ? d.seed.trim() : null
}
