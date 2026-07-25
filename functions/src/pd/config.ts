import { DEFAULT_PAYOFFS, parsePayoffs, type PayoffConfig } from './payoff'

// ═══════════════════════════════════════════════════════════════════════════════
// Repeated Prisoner's Dilemma — per-game constants. Kept as DATA (not scattered
// string literals) so a future admin-defaults screen and the callables share one
// source. Mirrors pennies/config.ts.
//
// Holds identity, collection paths, CORS, and the shape of the two per-instance
// documents: config/main (student-readable) and truth/main (rules-denied). The
// payoff VALUES live in payoff.ts, the strategies in strategy.ts, and the
// once-only draws in init.ts.
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

/** pd_game_instances/{id}/truth/main — rules-denied to every client, forever.
 *  Holds the drawn round count (spec §3: never displayed). */
export const TRUTH_DOC = 'main'

/**
 * Doc id for ONE student's rules-denied truth, in the SAME truth/ collection:
 *   pd_game_instances/{iid}/truth/participant_{pid}   → { participant_id, strategy }
 *
 * WHY HERE and not on the participant doc: the assigned bot strategy must never be
 * client-readable — the whole pedagogy is that the student INFERS it from play
 * (spec §5). The participant doc is already read-denied in rules, but truth/ is the
 * family's declared home for "never leaves the server", and putting it here means
 * the EXISTING `match /truth/{doc} { allow read, write: if false }` block covers it
 * with no rules change at all.
 *
 * WHY ONE DOC PER STUDENT and not a map on truth/main: a shared map would put every
 * student's first-touch assignment in contention on a single document at class
 * start. Per-student docs make the assignment transaction contend with nobody.
 *
 * The `participant_` prefix keeps the id space disjoint from TRUTH_DOC ('main'), so
 * a student whose participant_id is literally "main" cannot collide with it.
 */
export function truthParticipantDoc(participantId: string): string {
  return `participant_${participantId}`
}

// ── Round count (spec §3) ──────────────────────────────────────────────────────
// Drawn uniformly in [MIN_ROUNDS, MAX_ROUNDS] per instance, ONCE, and stored in
// truth/main. Students are told the RANGE and never the draw.
export const MIN_ROUNDS = 10
export const MAX_ROUNDS = 20

// ── The instance config document (config/main — STUDENT-READABLE) ──────────────

/** Display labels for the two moves. Student-facing, hence config not truth. */
export interface PdMoveLabels { C: string; D: string }

export const DEFAULT_MOVE_LABELS: PdMoveLabels = { C: 'Cooperate', D: 'Defect' }

/** The effective instance config. NOTHING secret lives here — config/main is
 *  student-readable by rules, and the payoff matrix is shown to students anyway. */
export interface PdConfig {
  payoffs: PayoffConfig
  labels: PdMoveLabels
  /**
   * Optional determinism seed (architecture §8, Newsvendor notes). Blank/absent =
   * real randomness. Set = every draw is derived from (seed, instance) and
   * (seed, participant_id), so a harness run is reproducible while draws stay
   * independent across students. Non-secret: knowing the seed reveals nothing a
   * student could act on without also knowing the derivation, and the values it
   * drives (round count, strategy) live in truth/ regardless.
   */
  seed: string | null
}

export const DEFAULT_PD_CONFIG: PdConfig = {
  payoffs: DEFAULT_PAYOFFS,
  labels: DEFAULT_MOVE_LABELS,
  seed: null,
}

/** The effective config for an instance: stored values over shipped defaults.
 *  Mirrors poll's loadQuestions — a malformed field falls back, never throws. */
export function loadPdConfig(configData: Record<string, unknown> | undefined): PdConfig {
  const labelsRaw = (typeof configData?.labels === 'object' && configData.labels !== null
    ? configData.labels
    : {}) as Record<string, unknown>
  const seedRaw = configData?.seed
  return {
    payoffs: parsePayoffs(configData?.payoffs),
    labels: {
      C: typeof labelsRaw.C === 'string' && labelsRaw.C.trim() ? labelsRaw.C : DEFAULT_MOVE_LABELS.C,
      D: typeof labelsRaw.D === 'string' && labelsRaw.D.trim() ? labelsRaw.D : DEFAULT_MOVE_LABELS.D,
    },
    // A number seed is accepted and normalized to its string form, so
    // seed: 7 and seed: "7" produce the SAME draws.
    seed: typeof seedRaw === 'string' && seedRaw.trim() !== '' ? seedRaw.trim()
      : typeof seedRaw === 'number' && Number.isFinite(seedRaw) ? String(seedRaw)
      : null,
  }
}
