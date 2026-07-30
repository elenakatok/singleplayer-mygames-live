// ═══════════════════════════════════════════════════════════════════════════════
// Newsvendor — per-game constants and the instance config schema (spec §2).
//
// Kept as DATA (never scattered string literals) so a future admin-defaults screen
// and the callables share one source. Mirrors pricing/config.ts and pd/config.ts.
//
// ⚠ THE 4-NUMBER CONFIGURATOR DOES NOT APPLY HERE (spec §2). This is not a 2×2
// matrix game — it has its own scalar config. Nobody should reach for the PD
// configurator when adding a field.
//
// ⚠ WHERE THE SEED LIVES, AND WHY IT DIVERGES FROM PRICING. Pricing keeps its
// determinism seed in config/main; this game keeps it in truth/main. The difference
// is what the seed BUYS you: in pricing it derives a round count the student never
// sees but cannot act on either way, while here it derives EVERY FUTURE DEMAND DRAW.
// config/main is student-readable by Firestore rules, so a seed stored there would
// let a student read the seed with the plain SDK and compute period 12's demand
// before ordering in period 11. It therefore lives in the rules-denied truth doc,
// alongside nothing else.
// ═══════════════════════════════════════════════════════════════════════════════

/** game_id — lowercase, never displayed. Drives the collection prefix + fn names. */
export const NEWSVENDOR_GAME_ID = 'newsvendor'

/** Collection prefix — every Firestore collection this game owns (architecture §4.1). */
export const NEWSVENDOR_COLLECTION_PREFIX = 'newsvendor'

/** Allowed browser origin for this game's callables (its own subdomain). */
export const NEWSVENDOR_CORS_ORIGINS = ['https://newsvendor.mygames.live']

// ── Firestore collection / doc paths (all newsvendor_ prefixed) ────────────────
export const INSTANCES_COLLECTION = 'newsvendor_game_instances'
// Participants are a per-INSTANCE subcollection (structural isolation):
//   newsvendor_game_instances/{iid}/participants/{pid}
export const PARTICIPANTS_SUBCOLLECTION = 'participants'

/** newsvendor_game_instances/{id}/config/main — STUDENT-READABLE. Every value in it
 *  is printed on the place-order screen anyway (spec §7a): the prices, the costs, and
 *  the demand distribution. */
export const CONFIG_DOC = 'main'

/** newsvendor_game_instances/{id}/truth/main — rules-denied to every client, forever.
 *  Holds ONLY the determinism seed. See the header for why it cannot live in config. */
export const TRUTH_DOC = 'main'

// ── Shipped defaults (spec §2, the "Plain default" column) ─────────────────────

export const DEFAULT_P = 3000        // retail price per unit
export const DEFAULT_C = 1000        // production cost per unit
export const DEFAULT_V = 800         // salvage value per leftover unit
export const DEFAULT_G = 150         // goodwill (shortage) cost per unit short
export const DEFAULT_H = 300         // holding cost per leftover unit
export const DEFAULT_PREMIUM = 1000  // dual only (Part 2); parsed and carried, unused here
export const DEFAULT_IS_NORMAL = true
export const DEFAULT_MEAN = 1000
export const DEFAULT_SD = 300
export const DEFAULT_MIN_D = 0
export const DEFAULT_MAX_D = 100
export const DEFAULT_PERIODS = 20

/** Bounds on what any config may set for the period count. */
export const HARD_MIN_PERIODS = 1
export const HARD_MAX_PERIODS = 100

/** The shipped prep prompt (spec §8) — asked BEFORE play, free text, ungraded. */
export const DEFAULT_PREP_PROMPT =
  'Before you start: you order once, before you know demand. If you order too many ' +
  "you're stuck with leftovers; too few and you miss sales (or, later, must buy from " +
  'an expensive backup). In a sentence or two, how will you decide how much to order?'

/** The shipped debrief prompt for REGULAR mode (spec §8). The dual-mode prompt is
 *  Part 2's; this file ships only what this build can actually run. */
export const DEFAULT_DEBRIEF_PROMPT_REGULAR =
  'In a few sentences, explain how you chose your order quantities. Did you aim near ' +
  'average demand, above it, or below it — and why? Did your approach change over the ' +
  'course of the game as you saw how demand came out?'

// ── The instance config ────────────────────────────────────────────────────────

/**
 * ONE instructor-added knowledge-check question.
 *
 * Same model as pricing's and PD's, including both traps: an added question may never
 * take a `kc_` id (the authored set owns that namespace), and optional fields are
 * OMITTED rather than set to undefined, which Firestore rejects outright.
 */
export interface NewsvendorAddedKcQuestion {
  id: string
  type: 'mc' | 'text'
  prompt: string
  options?: { value: string; label: string }[]
  /** mc only: the correct option value. Absent ⇒ recorded but UNGRADED. */
  correct_value?: string
  explanation?: string
}

/** The effective instance config (spec §2). Every scalar here is student-facing. */
export interface NewsvendorConfig {
  /** Retail price per unit. */
  P: number
  /** Production cost per unit. */
  c: number
  /** Salvage value per leftover unit. */
  v: number
  /** Goodwill (shortage) cost per unit short. Regular mode only (spec §4). */
  g: number
  /** Holding cost per leftover unit; applied as the net `v − h`. */
  h: number
  /**
   * Second-source premium (spec §2, dual only). Parsed and carried so Part 2 flips a
   * flag rather than migrating every stored config, but it is UNUSED in this build.
   */
  premium: number
  /**
   * Dual-sourcing mode. ⚠ ALWAYS FALSE IN THIS BUILD — Part 1 is the single-source
   * game only. newsvendorUpdateConfig REFUSES an attempt to set it, and the compute
   * step asserts on it, so there is no path by which a half-built dual game can run.
   */
  dual: boolean
  /** true = Normal demand, false = Uniform (spec §3). Both supported. */
  isNormal: boolean
  /** Normal demand parameters (used when isNormal). */
  mean: number
  sd: number
  /** Uniform demand bounds, inclusive (used when !isNormal). */
  minD: number
  maxD: number
  /** Number of periods. Student-facing — the screen says "Period k of N" (spec §7a). */
  periods: number
  /** Display only: the in-screen service-level calculator (spec §7a). */
  showCalculator: boolean
  /** Display only: the demand-proportion column and row (spec §7b, §7c). */
  showServiceLevel: boolean

  /** Is the prep question part of this instance's flow? */
  prepEnabled: boolean
  prepPrompt: string
  /** Is the knowledge check part of this instance's flow? */
  kcEnabled: boolean
  /** Instructor-added KC questions, rendered AFTER the authored ten. */
  addedKcQuestions: NewsvendorAddedKcQuestion[]
  /** Is the debrief paragraph part of this instance's flow? */
  debriefEnabled: boolean
  debriefPrompt: string
}

export const DEFAULT_NEWSVENDOR_CONFIG: NewsvendorConfig = {
  P: DEFAULT_P,
  c: DEFAULT_C,
  v: DEFAULT_V,
  g: DEFAULT_G,
  h: DEFAULT_H,
  premium: DEFAULT_PREMIUM,
  dual: false,
  isNormal: DEFAULT_IS_NORMAL,
  mean: DEFAULT_MEAN,
  sd: DEFAULT_SD,
  minD: DEFAULT_MIN_D,
  maxD: DEFAULT_MAX_D,
  periods: DEFAULT_PERIODS,
  showCalculator: true,
  showServiceLevel: true,
  prepEnabled: true,
  prepPrompt: DEFAULT_PREP_PROMPT,
  kcEnabled: true,
  addedKcQuestions: [],
  debriefEnabled: true,
  debriefPrompt: DEFAULT_DEBRIEF_PROMPT_REGULAR,
}

/** Defensive parse of ONE instructor-added KC question. Returns null if unusable —
 *  loadNewsvendorConfig drops those rather than throwing, so a half-written config can
 *  never make the game unplayable. Copied from pricing's, including its two traps. */
export function parseAddedKcQuestion(raw: unknown): NewsvendorAddedKcQuestion | null {
  if (typeof raw !== 'object' || raw === null) return null
  const q = raw as Record<string, unknown>
  const id = typeof q.id === 'string' ? q.id.trim() : ''
  const prompt = typeof q.prompt === 'string' ? q.prompt.trim() : ''
  if (!id || !prompt) return null
  // The authored set owns the kc_ namespace; an added question that took one would be
  // shadowed by the grader's authored-first lookup.
  if (id.startsWith('kc_')) return null

  // ⚠ OPTIONAL FIELDS ARE OMITTED, NEVER undefined — Firestore rejects undefined.
  const explanation = typeof q.explanation === 'string' && q.explanation.trim()
    ? q.explanation.trim() : null

  const type: 'mc' | 'text' = q.type === 'mc' ? 'mc' : 'text'
  if (type === 'text') {
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
  if (options.length < 2) return null

  const key = typeof q.correct_value === 'string' ? q.correct_value : ''
  const hasKey = options.some(o => o.value === key)

  return {
    id, type, prompt, options,
    ...(hasKey ? { correct_value: key } : {}),
    ...(explanation ? { explanation } : {}),
  }
}

/** A finite number from a stored field, or the shipped default. */
function num(raw: unknown, fallback: number): number {
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : fallback
}

/** A positive integer from a stored field, clamped to the hard bounds. */
function periodCount(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isInteger(raw)) return DEFAULT_PERIODS
  return Math.max(HARD_MIN_PERIODS, Math.min(HARD_MAX_PERIODS, raw))
}

/**
 * The effective config for an instance: stored values over shipped defaults.
 *
 * A malformed field FALLS BACK, never throws — the same posture as every loader in
 * this family, so a half-written config doc can never make the game unplayable. The
 * strict checks live in newsvendorUpdateConfig, which is where an instructor is
 * actually told what is wrong.
 */
export function loadNewsvendorConfig(configData: Record<string, unknown> | undefined): NewsvendorConfig {
  const d = configData ?? {}
  const prepRaw = d.prep_prompt
  const debriefRaw = d.debrief_prompt

  // Uniform bounds are read as a PAIR: an inverted or unusable pair falls back to the
  // shipped pair rather than to one stored number and one default, which would be a
  // range no instructor ever chose.
  const minRaw = d.min_demand
  const maxRaw = d.max_demand
  const bothNums = typeof minRaw === 'number' && Number.isFinite(minRaw)
    && typeof maxRaw === 'number' && Number.isFinite(maxRaw)
  const usablePair = bothNums && (maxRaw as number) > (minRaw as number) && (minRaw as number) >= 0
  const minD = usablePair ? (minRaw as number) : DEFAULT_MIN_D
  const maxD = usablePair ? (maxRaw as number) : DEFAULT_MAX_D

  return {
    P: num(d.price, DEFAULT_P),
    c: num(d.unit_cost, DEFAULT_C),
    v: num(d.salvage, DEFAULT_V),
    g: num(d.goodwill, DEFAULT_G),
    h: num(d.holding, DEFAULT_H),
    premium: num(d.premium, DEFAULT_PREMIUM),
    // ⚠ Part 1 is single-source only. The stored value is read honestly (so an
    // instance that somehow carries dual=true is VISIBLE rather than silently
    // downgraded), and every consumer refuses to run with it set.
    dual: d.dual === true,
    isNormal: d.is_normal !== false,
    mean: num(d.mean, DEFAULT_MEAN),
    sd: num(d.sd, DEFAULT_SD),
    minD,
    maxD,
    periods: periodCount(d.periods),
    // Absent ⇒ ON. An instance created before a toggle existed keeps the flow it had.
    showCalculator: d.show_calculator !== false,
    showServiceLevel: d.show_service_level !== false,
    prepEnabled: d.prep_enabled !== false,
    prepPrompt: typeof prepRaw === 'string' && prepRaw.trim() ? prepRaw.trim() : DEFAULT_PREP_PROMPT,
    kcEnabled: d.kc_enabled !== false,
    addedKcQuestions: (Array.isArray(d.added_kc_questions) ? d.added_kc_questions : [])
      .map(parseAddedKcQuestion)
      .filter((q): q is NewsvendorAddedKcQuestion => q !== null),
    debriefEnabled: d.debrief_enabled !== false,
    debriefPrompt: typeof debriefRaw === 'string' && debriefRaw.trim()
      ? debriefRaw.trim() : DEFAULT_DEBRIEF_PROMPT_REGULAR,
  }
}

/**
 * The determinism seed, read from the RULES-DENIED truth doc (architecture §8).
 *
 * Blank/absent = real randomness. Set = every demand draw is a pure function of
 * (seed, participant_id, period), so a harness run is reproducible while draws stay
 * independent across students. A number seed is normalized to its string form, so
 * seed: 7 and seed: "7" produce the SAME draws.
 */
export function loadNewsvendorSeed(truthData: Record<string, unknown> | undefined): string | null {
  const raw = truthData?.seed
  if (typeof raw === 'string' && raw.trim() !== '') return raw.trim()
  if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw)
  return null
}
