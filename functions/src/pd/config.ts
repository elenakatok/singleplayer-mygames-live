import { DEFAULT_PAYOFFS, parsePayoffs, type PayoffConfig } from './payoff'

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
}

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
  /** Is the knowledge check part of this instance's flow? */
  kcEnabled: boolean
  /** Instructor-added KC questions, rendered AFTER the derived four. */
  addedKcQuestions: PdAddedKcQuestion[]
  /** Is the debrief paragraph part of this instance's flow? */
  debriefEnabled: boolean
  /** The debrief prompt shown to students. */
  debriefPrompt: string
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
}

/** Defensive parse of ONE instructor-added KC question. Returns null if unusable —
 *  loadPdConfig drops those rather than throwing, so a half-written config can never
 *  make the game unplayable (the same posture as parsePayoffs). */
export function parseAddedKcQuestion(raw: unknown): PdAddedKcQuestion | null {
  if (typeof raw !== 'object' || raw === null) return null
  const q = raw as Record<string, unknown>
  const id = typeof q.id === 'string' ? q.id.trim() : ''
  const prompt = typeof q.prompt === 'string' ? q.prompt.trim() : ''
  if (!id || !prompt) return null
  // An added question may NEVER take a derived field's id, or the grader's
  // derived-first lookup would shadow it (and the student would be graded against
  // the matrix instead of the instructor's key).
  if (id.startsWith('kc_')) return null

  // ⚠ OPTIONAL FIELDS ARE OMITTED, NEVER SET TO undefined. These objects are written
  // straight into Firestore, which REJECTS an undefined value outright — so an
  // explanation-less question would fail the whole save rather than store cleanly.
  const explanation = typeof q.explanation === 'string' && q.explanation.trim()
    ? q.explanation.trim() : null

  const type: 'mc' | 'text' = q.type === 'mc' ? 'mc' : 'text'
  if (type === 'text') {
    // Free text cannot be auto-graded, so it is recorded and left UNGRADED — it
    // never enters the KC score's numerator or denominator.
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
      .map(parseAddedKcQuestion)
      .filter((q): q is PdAddedKcQuestion => q !== null),
    debriefEnabled: configData?.debrief_enabled !== false,
    debriefPrompt: typeof promptRaw === 'string' && promptRaw.trim() ? promptRaw.trim() : DEFAULT_DEBRIEF_PROMPT,
    // A number seed is accepted and normalized to its string form, so
    // seed: 7 and seed: "7" produce the SAME draws.
    seed: typeof seedRaw === 'string' && seedRaw.trim() !== '' ? seedRaw.trim()
      : typeof seedRaw === 'number' && Number.isFinite(seedRaw) ? String(seedRaw)
      : null,
  }
}
