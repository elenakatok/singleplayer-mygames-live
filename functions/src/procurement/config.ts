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
  }
}

/** The determinism seed, read from the RULES-DENIED truth doc.
 *  Blank = real randomness. Set = deterministic from (seed, participantId, round). */
export function loadProcurementSeed(raw: unknown): string | null {
  const d = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  return typeof d.seed === 'string' && d.seed.trim() !== '' ? d.seed.trim() : null
}
