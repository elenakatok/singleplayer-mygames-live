import {
  DEFAULT_MARKET, parseMarket, type PricingMarketConfig,
} from './market'
import {
  DEFAULT_STANDARD_STRATEGY, DEFAULT_PMG_STRATEGY, isPricingStrategy, type PricingStrategy,
} from './strategy'

// ═══════════════════════════════════════════════════════════════════════════════
// Pricing Game (Cheyenne Shipping) — per-game constants. Kept as DATA (not
// scattered string literals) so a future admin-defaults screen and the callables
// share one source. Mirrors pd/config.ts.
//
// Holds identity, collection paths, CORS, and the shape of the per-instance
// documents: config/main (student-readable) and truth/main + truth/participant_*
// (rules-denied). The market VALUES live in market.ts, the competitor rules in
// strategy.ts, and the once-only draw in init.ts.
//
// ⚠ ONE GAME, TWO COURSE INSTANCES (spec §3): Standard and PMG are the SAME game
// with a per-instance `pmg` flag, not two game_ids. The flag switches the market
// computation (§6), the competitor rule (§5), the KC (§8), the instructions copy,
// and the debrief prompt (§9).
// ═══════════════════════════════════════════════════════════════════════════════

/** game_id — lowercase, never displayed. Drives the collection prefix + fn names. */
export const PRICING_GAME_ID = 'pricing'

/** Collection prefix — every Firestore collection this game owns (architecture §4.1). */
export const PRICING_COLLECTION_PREFIX = 'pricing'

/** Allowed browser origin for this game's callables (its own subdomain). */
export const PRICING_CORS_ORIGINS = ['https://pricing.mygames.live']

// ── Firestore collection / doc paths (all pricing_ prefixed) ───────────────────
export const INSTANCES_COLLECTION = 'pricing_game_instances'
// Participants are a per-INSTANCE subcollection (structural isolation):
//   pricing_game_instances/{iid}/participants/{pid}
export const PARTICIPANTS_SUBCOLLECTION = 'participants'

/** pricing_game_instances/{id}/config/main — STUDENT-READABLE. Non-secret settings
 *  only: the market parameters and the PMG flag, every one of which is printed on
 *  the price-entry screen anyway (spec §4). */
export const CONFIG_DOC = 'main'

/**
 * pricing_game_instances/{id}/truth/main — rules-denied to every client, forever.
 *
 * Holds the instance's COMPETITOR RULE IDS (§5). They live here and NOT in
 * config/main for one reason: config/main is client-readable by Firestore rules, so
 * anything in it is effectively public, and spec §5 says the rule's identity is not
 * shown during play — the student is meant to infer the competitor's behaviour and
 * be told what it was only in the debrief. Naming the rule in a readable doc would
 * hand it over through the Firestore SDK without a single callable being involved.
 *
 * Keeping the ids here still satisfies "a future variant is config, not rebuild":
 * an instructor edit is a callable write to this doc, which is how every instructor
 * edit in this family already works.
 */
export const TRUTH_DOC = 'main'

/**
 * Doc id for ONE student's rules-denied truth, in the SAME truth/ collection:
 *   pricing_game_instances/{iid}/truth/participant_{pid}   → { participant_id, rounds }
 *
 * ⚠ DIVERGES FROM PD, DELIBERATELY: PD draws its round count PER INSTANCE; pricing
 * draws it PER PARTICIPANT. This game is played async over an assignment week, so a
 * per-instance horizon is one shared secret across the whole class — the first
 * student to finish can tell everyone "it's 14 rounds", and every later student
 * plays a known-length game (and defects on the last round, which is exactly the
 * end-game reasoning the hidden horizon exists to prevent). A per-participant draw
 * makes that leak worth nothing. It also costs nothing: the draw contends with
 * nobody, since each student writes their own document.
 *
 * The `participant_` prefix keeps the id space disjoint from TRUTH_DOC ('main'), so
 * a student whose participant_id is literally "main" cannot collide with it.
 */
export function truthParticipantDoc(participantId: string): string {
  return `participant_${participantId}`
}

// ── Round count (spec §3) ──────────────────────────────────────────────────────
// Drawn uniformly in the instance's [minRounds, maxRounds] per PARTICIPANT, ONCE,
// and stored in truth/participant_{pid}. Students are told the RANGE and never the
// draw — no "round N of M", no progress bar, no rounds-remaining (spec §1).
//
// The RANGE is instructor-configurable; these are only the shipped defaults.
// HARD_MIN/HARD_MAX bound what any config may set.
export const DEFAULT_MIN_ROUNDS = 10
export const DEFAULT_MAX_ROUNDS = 20
export const HARD_MIN_ROUNDS = 1
export const HARD_MAX_ROUNDS = 100

// ── The instance config document (config/main — STUDENT-READABLE) ──────────────

/** The two firms' display labels. Student-facing, hence config not truth. */
export interface PricingFirmLabels {
  /** The student's firm. Default 'CSC' (Cheyenne Shipping Corporation). */
  student: string
  /** The automated competitor's firm. Default 'WNS' (Western Nebraska Shipping).
   *  Note this is the FIRM's name — student-facing copy calls the opponent "your
   *  competitor", never "the bot" (spec §1). */
  competitor: string
}

export const DEFAULT_LABELS: PricingFirmLabels = { student: 'CSC', competitor: 'WNS' }

/** The shipped default debrief prompts (spec §9) — one per mode. */
export const DEFAULT_DEBRIEF_PROMPT_STANDARD =
  'In a few sentences, explain your pricing strategy. How did you choose your ' +
  'initial price, and how did you respond to what your competitor did in later ' +
  'rounds? Did your approach change over the course of the game?'

export const DEFAULT_DEBRIEF_PROMPT_PMG =
  'In a few sentences, explain how you set prices under the Price Matching ' +
  'Guarantee. How was your strategy different from the standard game, and why?'

/** The effective instance config. NOTHING secret lives here — config/main is
 *  student-readable by rules. In particular the round RANGE lives here (students
 *  are told it) while each student's drawn round COUNT lives in truth/ (they never
 *  are), and the competitor rule ids live in truth/ too (spec §5). */
export interface PricingConfig {
  /** false = Standard, true = PMG. Switches computation, competitor rule, KC,
   *  instructions copy, and debrief prompt (spec §3, §6). */
  pmg: boolean
  labels: PricingFirmLabels
  market: PricingMarketConfig
  /** Inclusive round-count range each student's count is drawn from. */
  minRounds: number
  maxRounds: number
  /** Is the knowledge check part of this instance's flow? */
  kcEnabled: boolean
  /** Instructor-added KC questions, rendered AFTER the derived set. */
  addedKcQuestions: PricingAddedKcQuestion[]
  /** Is the debrief paragraph part of this instance's flow? */
  debriefEnabled: boolean
  /** The debrief prompt shown to students. Defaults PER MODE (spec §9). */
  debriefPrompt: string
  /**
   * Optional determinism seed (architecture §8). Blank/absent = real randomness.
   * Set = every draw is derived from (seed, participant_id), so a harness run is
   * reproducible while draws stay independent across students. Non-secret in
   * itself, but it is the input the round-count draw derives from, so it never
   * leaves the server either.
   */
  seed: string | null
}

/**
 * ONE instructor-added knowledge-check question.
 *
 * ⚠ DELIBERATELY A SEPARATE SOURCE FROM THE DERIVED SET. The derived questions are
 * computed from the instance's MARKET at serve AND grade time (questions.ts) so they
 * can never drift from the market a student is pricing in. These are hand-authored
 * and carry their own stored answer key. Merging the two lists would mean storing the
 * derived ones as frozen text — exactly the drift the derivation exists to prevent —
 * so they are kept apart end to end: separate config field, separate render segment,
 * separate grading path. Mirrors PD's PdAddedKcQuestion exactly.
 */
export interface PricingAddedKcQuestion {
  /** Stable id, also the answers-map key. Never collides with a derived `kc_*` field
   *  because it is minted with an `akc_` prefix. */
  id: string
  type: 'mc' | 'text'
  prompt: string
  /** mc only: the offered choices, in order. */
  options?: { value: string; label: string }[]
  /** mc only: the correct option value. Absent ⇒ recorded but UNGRADED. */
  correct_value?: string
  /** Shown after answering, like the derived ones. */
  explanation?: string
}

/** The instance's competitor rules — ONE per mode (spec §5). Stored in truth/main,
 *  never in config/main; see TRUTH_DOC for why. */
export interface PricingStrategies {
  /** The rule in force when pmg = false. */
  standard: PricingStrategy
  /** The rule in force when pmg = true. */
  pmg: PricingStrategy
}

export const DEFAULT_STRATEGIES: PricingStrategies = {
  standard: DEFAULT_STANDARD_STRATEGY,
  pmg: DEFAULT_PMG_STRATEGY,
}

export const DEFAULT_PRICING_CONFIG: PricingConfig = {
  pmg: false,
  labels: DEFAULT_LABELS,
  market: DEFAULT_MARKET,
  minRounds: DEFAULT_MIN_ROUNDS,
  maxRounds: DEFAULT_MAX_ROUNDS,
  kcEnabled: true,
  addedKcQuestions: [],
  debriefEnabled: true,
  debriefPrompt: DEFAULT_DEBRIEF_PROMPT_STANDARD,
  seed: null,
}

/** Defensive parse of ONE instructor-added KC question. Returns null if unusable —
 *  loadPricingConfig drops those rather than throwing, so a half-written config can
 *  never make the game unplayable (the same posture as parseMarket). Copied from PD's
 *  parseAddedKcQuestion, including its two traps. */
export function parseAddedKcQuestion(raw: unknown): PricingAddedKcQuestion | null {
  if (typeof raw !== 'object' || raw === null) return null
  const q = raw as Record<string, unknown>
  const id = typeof q.id === 'string' ? q.id.trim() : ''
  const prompt = typeof q.prompt === 'string' ? q.prompt.trim() : ''
  if (!id || !prompt) return null
  // An added question may NEVER take a derived field's id, or the grader's
  // derived-first lookup would shadow it (and the student would be graded against the
  // market instead of the instructor's key).
  if (id.startsWith('kc_')) return null

  // ⚠ OPTIONAL FIELDS ARE OMITTED, NEVER SET TO undefined. These objects are written
  // straight into Firestore, which REJECTS an undefined value outright — so an
  // explanation-less question would fail the whole save rather than store cleanly.
  const explanation = typeof q.explanation === 'string' && q.explanation.trim()
    ? q.explanation.trim() : null

  const type: 'mc' | 'text' = q.type === 'mc' ? 'mc' : 'text'
  if (type === 'text') {
    // Free text cannot be auto-graded, so it is recorded and left UNGRADED — it never
    // enters the KC score's numerator or denominator.
    return { id, type, prompt, ...(explanation ? { explanation } : {}) }
  }

  const optionsRaw = Array.isArray(q.options) ? q.options : []
  const options: { value: string; label: string }[] = []
  for (const o of optionsRaw) {
    if (typeof o !== 'object' || o === null) continue
    const oo = o as Record<string, unknown>
    const value = typeof oo.value === 'string' ? oo.value : ''
    const label = typeof oo.label === 'string' ? oo.label : ''
    if (value && label) options.push({ value, label })
  }
  if (options.length < 2) return null   // an mc question needs something to choose between

  const key = typeof q.correct_value === 'string' ? q.correct_value : ''
  // A key that names no offered option is dropped rather than kept: it would mark
  // every student wrong, silently.
  const hasKey = options.some(o => o.value === key)

  return {
    id, type, prompt, options,
    ...(hasKey ? { correct_value: key } : {}),
    ...(explanation ? { explanation } : {}),
  }
}

/** Clamp + sanity-check a stored round range. Returns the shipped defaults when the
 *  stored pair is unusable, and never returns min > max. */
export function parseRoundRange(rawMin: unknown, rawMax: unknown): { minRounds: number; maxRounds: number } {
  const int = (v: unknown): number | null =>
    typeof v === 'number' && Number.isInteger(v) ? v : null
  let min = int(rawMin)
  let max = int(rawMax)
  if (min === null || max === null) return { minRounds: DEFAULT_MIN_ROUNDS, maxRounds: DEFAULT_MAX_ROUNDS }
  min = Math.max(HARD_MIN_ROUNDS, Math.min(HARD_MAX_ROUNDS, min))
  max = Math.max(HARD_MIN_ROUNDS, Math.min(HARD_MAX_ROUNDS, max))
  if (min > max) return { minRounds: DEFAULT_MIN_ROUNDS, maxRounds: DEFAULT_MAX_ROUNDS }
  return { minRounds: min, maxRounds: max }
}

/** The effective config for an instance: stored values over shipped defaults.
 *  Mirrors loadPdConfig — a malformed field falls back, never throws, so a
 *  half-written config doc can never make the game unplayable. */
export function loadPricingConfig(configData: Record<string, unknown> | undefined): PricingConfig {
  const labelsRaw = (typeof configData?.labels === 'object' && configData.labels !== null
    ? configData.labels
    : {}) as Record<string, unknown>
  const seedRaw = configData?.seed
  const promptRaw = configData?.debrief_prompt

  // The mode first — it selects the DEFAULT debrief prompt below (spec §9), so a
  // PMG instance that has never had its prompt edited still asks the PMG question.
  const pmg = configData?.pmg === true

  return {
    pmg,
    labels: {
      student: typeof labelsRaw.student === 'string' && labelsRaw.student.trim()
        ? labelsRaw.student.trim() : DEFAULT_LABELS.student,
      competitor: typeof labelsRaw.competitor === 'string' && labelsRaw.competitor.trim()
        ? labelsRaw.competitor.trim() : DEFAULT_LABELS.competitor,
    },
    market: parseMarket(configData?.market),
    ...parseRoundRange(configData?.min_rounds, configData?.max_rounds),
    // Absent ⇒ ON. An instance created before a toggle existed keeps the flow it
    // had, rather than silently losing its knowledge check.
    kcEnabled: configData?.kc_enabled !== false,
    addedKcQuestions: (Array.isArray(configData?.added_kc_questions) ? configData.added_kc_questions : [])
      .map(parseAddedKcQuestion)
      .filter((q): q is PricingAddedKcQuestion => q !== null),
    debriefEnabled: configData?.debrief_enabled !== false,
    debriefPrompt: typeof promptRaw === 'string' && promptRaw.trim()
      ? promptRaw.trim()
      : (pmg ? DEFAULT_DEBRIEF_PROMPT_PMG : DEFAULT_DEBRIEF_PROMPT_STANDARD),
    // A number seed is accepted and normalized to its string form, so
    // seed: 7 and seed: "7" produce the SAME draws.
    seed: typeof seedRaw === 'string' && seedRaw.trim() !== '' ? seedRaw.trim()
      : typeof seedRaw === 'number' && Number.isFinite(seedRaw) ? String(seedRaw)
      : null,
  }
}

/** The instance's competitor rules, read from truth/main. An unknown or missing id
 *  falls back to the shipped rule for that mode rather than throwing — the same
 *  posture as every other loader here. */
export function loadPricingStrategies(truthData: Record<string, unknown> | undefined): PricingStrategies {
  const std = truthData?.standard_strategy
  const pmg = truthData?.pmg_strategy
  return {
    standard: isPricingStrategy(std) ? std : DEFAULT_STRATEGIES.standard,
    pmg: isPricingStrategy(pmg) ? pmg : DEFAULT_STRATEGIES.pmg,
  }
}

/** The rule actually in force for an instance: the mode picks one of the two. */
export function activeStrategy(config: PricingConfig, strategies: PricingStrategies): PricingStrategy {
  return config.pmg ? strategies.pmg : strategies.standard
}
