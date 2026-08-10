import { DEFAULT_PAYOFFS, parsePayoffs, type PayoffConfig } from './payoff'
import {
  parseAddedKcQuestion as parseSharedAddedKcQuestion,
  parseKcHidden, parseKcOrder, parseKcOverrides,
  type KcHiddenMap, type KcOrderMap, type KcOverrideMap, type KcIdGuard,
} from '../shared/kcSurface'

export type { KcHiddenMap, KcOrderMap, KcOverrideMap, KcOverride } from '../shared/kcSurface'
/** Re-exported so the callables import every KC-config concern from one place. */
export { parseKcHidden, parseKcOrder, parseKcOverrides } from '../shared/kcSurface'

// ═══════════════════════════════════════════════════════════════════════════════
// Repeated Prisoner's Dilemma — per-game constants. Kept as DATA (not scattered
// string literals) so a future admin-defaults screen and the callables share one
// source. Mirrors pennies/config.ts.
//
// Holds identity, collection paths, CORS, and the shape of the per-instance
// documents: config/main (student-readable) and truth/participant_* (rules-denied,
// one per student — PD writes no instance-level truth doc). The payoff VALUES live
// in payoff.ts, the strategies in strategy.ts, and the once-only draws in init.ts.
// ═══════════════════════════════════════════════════════════════════════════════

/** game_id — lowercase, never displayed. Drives the collection prefix + fn names. */
export const PD_GAME_ID = 'pd'

/** Collection prefix — every Firestore collection this game owns (architecture §4.1). */
export const PD_COLLECTION_PREFIX = 'pd'

/** Allowed browser origin for this game's callables (its own subdomain). */
export const PD_CORS_ORIGINS = ['https://pd.mygames.live']

// ── Firestore collection / doc paths (all pd_ prefixed) ────────────────────────
export const INSTANCES_COLLECTION = 'pd_game_instances'
// Participants are a per-INSTANCE subcollection (structural isolation):
//   pd_game_instances/{iid}/participants/{pid}
export const PARTICIPANTS_SUBCOLLECTION = 'participants'

/** pd_game_instances/{id}/config/main — STUDENT-READABLE. Non-secret settings only
 *  (the payoff matrix, which students are shown anyway). */
export const CONFIG_DOC = 'main'

/**
 * Doc id for ONE student's rules-denied truth, in the truth/ collection:
 *   pd_game_instances/{iid}/truth/participant_{pid}
 *     → { participant_id, strategy, rounds }
 *
 * ⚠ THIS IS THE ONLY TRUTH DOC PD WRITES. There is deliberately no instance-level
 * `truth/main`: the round count used to live there, shared by the whole class, and
 * that was a leak — PD is played async across an assignment week, so the first
 * student to finish could hand everyone else a KNOWN last round, which is exactly
 * the backward induction the hidden horizon exists to prevent (spec §3). Both draws
 * are now per student. Nothing reads an instance-level count; if you find code that
 * does, it is stale, not a fallback.
 *
 * WHY HERE and not on the participant doc: neither the assigned bot strategy nor the
 * round count may be client-readable — the whole pedagogy is that the student INFERS
 * the strategy from play (spec §5) and never knows when the game ends (spec §3). The
 * participant doc is already read-denied in rules, but truth/ is the family's
 * declared home for "never leaves the server", and putting it here means the
 * EXISTING `match /truth/{doc} { allow read, write: if false }` block covers it with
 * no rules change at all.
 *
 * WHY ONE DOC PER STUDENT and not a shared map: a shared map would put every
 * student's first-touch draw in contention on a single document at class start.
 * Per-student docs make the transaction contend with nobody.
 *
 * The `participant_` prefix keeps the id space disjoint from any future
 * instance-level doc, so a student whose participant_id is literally "main" cannot
 * collide with one.
 */
export function truthParticipantDoc(participantId: string): string {
  return `participant_${participantId}`
}

// ── Round count (spec §3) ──────────────────────────────────────────────────────
// Drawn uniformly in the instance's [minRounds, maxRounds] per PARTICIPANT, ONCE,
// and stored in that student's truth/participant_{pid}. Students are told the RANGE
// and never the draw — and, because the draw is per student, knowing a classmate's
// count tells them nothing about their own.
//
// The RANGE is instructor-configurable (Slice 5); these are only the shipped
// defaults. HARD_MIN/HARD_MAX bound what any config may set — a range of [0, 5000]
// would either produce a zero-round game or a game nobody finishes.
export const DEFAULT_MIN_ROUNDS = 10
export const DEFAULT_MAX_ROUNDS = 20
export const HARD_MIN_ROUNDS = 1
export const HARD_MAX_ROUNDS = 100

// ── The instance config document (config/main — STUDENT-READABLE) ──────────────

/** Display labels for the two moves. Student-facing, hence config not truth. */
export interface PdMoveLabels { C: string; D: string }

export const DEFAULT_MOVE_LABELS: PdMoveLabels = { C: 'Cooperate', D: 'Defect' }

/**
 * ONE instructor-added knowledge-check question (Slice 5).
 *
 * ⚠ DELIBERATELY A SEPARATE SOURCE FROM THE DERIVED FOUR. The four
 * matrix-comprehension questions are computed from the payoff matrix at serve AND
 * grade time (questions.ts, resolveKcQuestions) so they can never drift from the
 * matrix a student is shown. These are hand-authored and carry their own stored
 * answer key. Merging the two lists would mean storing the derived four as frozen
 * text — which is exactly the drift the derivation exists to prevent — so they are
 * kept apart end to end: separate config field, separate render segment, separate
 * grading path.
 */
export interface PdAddedKcQuestion {
  /** Stable id, also the answers-map key. Never collides with a derived `kc_*`
   *  field because it is minted with an `akc_` prefix. */
  id: string
  type: 'mc' | 'text'
  prompt: string
  /** mc only: the offered choices, in order. */
  options?: { value: string; label: string }[]
  /** mc only: the correct option value. Absent ⇒ recorded but UNGRADED. */
  correct_value?: string
  /** Shown after answering, like the derived four. */
  explanation?: string
  /**
   * Which stage asks it.
   *
   * ⚠⚠ ABSENT ⇒ `'pre'`, AND THAT IS THE OPPOSITE OF SCORECARD'S DEFAULT. Every added
   * question pd has ever stored was written before this field existed and is served
   * BEFORE play — `pdGetQuestions` has always appended them to the derived four, and
   * Play.tsx concatenates the two into one pre-play list. Defaulting an absent stage to
   * `'post'` (scorecard's rule, for scorecard's reasons) would silently move every
   * existing added question to after the last round. See DEFAULT_ADDED_KC_STAGE.
   */
  stage?: PdKcStage
}

/**
 * pd's stages.
 *
 * ⚠ `post` means AFTER PLAY, NOT "after the reveal" — pd has NO reveal. The other
 * player's assigned strategy is never shown; inferring it from play IS the exercise
 * (spec §5). The settings block's labels say so.
 *
 * ⚠ Declared HERE rather than in questions.ts so `parseAddedKcQuestion` can validate a
 * stored `stage` against it without an import cycle.
 */
export const PD_KC_STAGES = ['pre', 'post'] as const
export type PdKcStage = (typeof PD_KC_STAGES)[number]

/**
 * ⚠⚠ THE STAGE AN ADDED QUESTION LANDS IN WHEN IT DOES NOT NAME ONE — `pre`, which is
 * where every question stored before this field existed is already being served. This
 * one line is the whole backward-compatibility guarantee for the change that let the
 * `post` stage receive questions; a test pins it.
 */
export const DEFAULT_ADDED_KC_STAGE: PdKcStage = 'pre'

/** The effective instance config. NOTHING secret lives here — config/main is
 *  student-readable by rules, and the payoff matrix is shown to students anyway.
 *  In particular the round RANGE lives here (students are told it) while the drawn
 *  round COUNT lives in truth/ (students never are). */
export interface PdConfig {
  payoffs: PayoffConfig
  labels: PdMoveLabels
  /**
   * The unit the payoff numbers are counted in — one word, e.g. 'years', 'points',
   * 'dollars'. The game is DIRECTION-AGNOSTIC: it neither knows nor states whether
   * more is better, it just renders a number followed by this word. Anything that
   * needs to know the direction (the pedagogy) is the instructor's framing, not the
   * software's.
   */
  unit: string
  /** Inclusive round-count range the actual count is drawn from. */
  minRounds: number
  maxRounds: number
  /**
   * Is the GRADED knowledge check part of this instance's flow?
   *
   * ⚠ GRADED ONLY (convergence spec D12). Off removes the derived four and any graded
   * addition. An UNGRADED free-text addition is governed by its own visibility, exactly as
   * the debrief paragraph is — see `resolveAddedKcQuestions`.
   */
  kcEnabled: boolean
  /** Instructor-added KC questions, rendered AFTER the derived four. */
  addedKcQuestions: PdAddedKcQuestion[]
  /** Is the debrief paragraph part of this instance's flow? */
  debriefEnabled: boolean
  /** The debrief prompt shown to students. */
  debriefPrompt: string
  /**
   * ⚠ THE THREE CONVERGENCE FIELDS (spec §5). All optional, all defaulting to exactly
   * today's behaviour, all honoured in BOTH the serve path and the grader. An instance
   * written before they existed reads as {} for each.
   */
  kcHidden: KcHiddenMap
  kcOrder: KcOrderMap
  kcOverrides: KcOverrideMap
  /**
   * Optional determinism seed (architecture §8, Newsvendor notes). Blank/absent =
   * real randomness. Set = both draws are derived from (seed, participant_id), so a
   * harness run is reproducible while draws stay independent across students.
   * Non-secret: knowing the seed reveals nothing a student could act on without also
   * knowing the derivation, and the values it drives (round count, strategy) live in
   * truth/ regardless.
   */
  seed: string | null
}

/** The shipped default unit. One word — it is rendered straight after a number. */
export const DEFAULT_UNIT = 'years'

/** The shipped default debrief prompt (spec §8). */
export const DEFAULT_DEBRIEF_PROMPT =
  'In a short paragraph, explain what you did during the game and why.'

export const DEFAULT_PD_CONFIG: PdConfig = {
  payoffs: DEFAULT_PAYOFFS,
  labels: DEFAULT_MOVE_LABELS,
  unit: DEFAULT_UNIT,
  minRounds: DEFAULT_MIN_ROUNDS,
  maxRounds: DEFAULT_MAX_ROUNDS,
  kcEnabled: true,
  addedKcQuestions: [],
  debriefEnabled: true,
  debriefPrompt: DEFAULT_DEBRIEF_PROMPT,
  seed: null,
  kcHidden: {},
  kcOrder: {},
  kcOverrides: {},
}

/**
 * The `kc_` PREFIX is pd's collision-guard strategy — the derived four own that
 * namespace, and the grader looks them up FIRST, so an added question taking one would be
 * silently shadowed and the student graded against the matrix instead of the instructor's
 * key.
 *
 * ⚠ THE OTHER STRATEGY IS SCORECARD'S. Its built-in ids are unprefixed
 * (`q1_negotiated_ppm`), so a prefix rule protects nothing there and it passes an explicit
 * id SET instead. The shared parser carries both (spec §5); picking one silently
 * unprotects the other family.
 */
export const PD_KC_ID_GUARD: KcIdGuard = { kind: 'prefix', prefix: 'kc_' }

/**
 * Defensive parse of ONE instructor-added KC question. Returns null if unusable —
 * loadPdConfig drops those rather than throwing, so a half-written config can never make
 * the game unplayable (the same posture as parsePayoffs).
 *
 * ⚠ THE BODY LIVES IN `shared/kcSurface` (convergence spec §5 — five near-copies, no two
 * byte-identical). pd passes its prefix guard and its two stages; an unrecognised stage is
 * dropped by the shared parser, so it falls back to `DEFAULT_ADDED_KC_STAGE`.
 *
 * ⚠ `stages` USED TO BE OMITTED HERE, which dropped every incoming `stage`. That was
 * correct while nothing rendered a post-play question list — the settings block did not
 * offer the choice either. Both halves changed together; offering the picker without this
 * would store a stage the serve path ignores, and passing this without the picker would
 * accept a stage no instructor could set.
 */
export function parseAddedKcQuestion(
  raw: unknown,
  guard: KcIdGuard | undefined = PD_KC_ID_GUARD,
): PdAddedKcQuestion | null {
  const q = parseSharedAddedKcQuestion(raw, { guard, stages: PD_KC_STAGES })
  return q === null ? null : (q as PdAddedKcQuestion)
}

/** The stage a stored added question is asked in. ⚠ Absent ⇒ `pre` — see the interface. */
export function addedKcStage(q: PdAddedKcQuestion): PdKcStage {
  return q.stage ?? DEFAULT_ADDED_KC_STAGE
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
 *  Mirrors poll's loadQuestions — a malformed field falls back, never throws. */
export function loadPdConfig(configData: Record<string, unknown> | undefined): PdConfig {
  const labelsRaw = (typeof configData?.labels === 'object' && configData.labels !== null
    ? configData.labels
    : {}) as Record<string, unknown>
  const seedRaw = configData?.seed
  const unitRaw = configData?.unit
  const promptRaw = configData?.debrief_prompt
  const addedRaw = Array.isArray(configData?.added_kc_questions) ? configData.added_kc_questions : []

  return {
    payoffs: parsePayoffs(configData?.payoffs),
    labels: {
      C: typeof labelsRaw.C === 'string' && labelsRaw.C.trim() ? labelsRaw.C : DEFAULT_MOVE_LABELS.C,
      D: typeof labelsRaw.D === 'string' && labelsRaw.D.trim() ? labelsRaw.D : DEFAULT_MOVE_LABELS.D,
    },
    unit: typeof unitRaw === 'string' && unitRaw.trim() ? unitRaw.trim() : DEFAULT_UNIT,
    ...parseRoundRange(configData?.min_rounds, configData?.max_rounds),
    // Absent ⇒ ON. An instance created before this slice existed keeps the flow it
    // had, rather than silently losing its knowledge check.
    kcEnabled: configData?.kc_enabled !== false,
    addedKcQuestions: addedRaw
      .map(q => parseAddedKcQuestion(q))
      .filter((q): q is PdAddedKcQuestion => q !== null),
    // ⚠ Total on absent — an instance written before these existed reads as "no hides,
    // authored order, no rewrites", which is exactly the behaviour it already had.
    kcHidden: parseKcHidden(configData?.kc_hidden),
    kcOrder: parseKcOrder(configData?.kc_order),
    kcOverrides: parseKcOverrides(configData?.kc_overrides),
    debriefEnabled: configData?.debrief_enabled !== false,
    debriefPrompt: typeof promptRaw === 'string' && promptRaw.trim() ? promptRaw.trim() : DEFAULT_DEBRIEF_PROMPT,
    // A number seed is accepted and normalized to its string form, so
    // seed: 7 and seed: "7" produce the SAME draws.
    seed: typeof seedRaw === 'string' && seedRaw.trim() !== '' ? seedRaw.trim()
      : typeof seedRaw === 'number' && Number.isFinite(seedRaw) ? String(seedRaw)
      : null,
  }
}
