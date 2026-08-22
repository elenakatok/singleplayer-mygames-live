// ═══════════════════════════════════════════════════════════════════════════════
// Jar of Pennies — per-game constants. Kept as DATA (not scattered string literals)
// so a future admin-defaults screen and the callables share one source.
// ═══════════════════════════════════════════════════════════════════════════════

/** game_id — lowercase, never displayed. Drives the collection prefix + fn names. */
export const PENNIES_GAME_ID = 'pennies'

/** Collection prefix — every Firestore collection this game owns (spec §4.1). */
export const PENNIES_COLLECTION_PREFIX = 'pennies'

/** Allowed browser origin for this game's callables (its own subdomain). */
export const PENNIES_CORS_ORIGINS = ['https://pennies.mygames.live']

// ── Firestore collection / doc paths (all pennies_ prefixed; spec §4) ───────────
export const INSTANCES_COLLECTION = 'pennies_game_instances'
// Participants are a per-INSTANCE subcollection (structural isolation, spec §4.2):
//   pennies_game_instances/{iid}/participants/{pid}
export const PARTICIPANTS_SUBCOLLECTION = 'participants'
export const CONFIG_DOC = 'main'   // pennies_game_instances/{id}/config/main
export const TRUTH_DOC  = 'main'   // pennies_game_instances/{id}/truth/main  (rules-denied)

// ── Config defaults (spec §4.1.1, §9) ──────────────────────────────────────────
/** The actual amount in the jar. Lives ONLY in truth/main — never in config, never
 *  returned to a student. Default when the instructor has not set it. FORWARD mode. */
export const DEFAULT_TRUE_VALUE = 3.5
/** Site-relative jar image path (config/main.jar_image). Client-readable. */
export const DEFAULT_JAR_IMAGE = '/jarofpennies.jpg'

// ── Reverse (supplier) mode (added 2026) ───────────────────────────────────────
// ONE game, TWO modes on a per-instance flag — the Pricing/PMG precedent. Forward
// (default): common-VALUE auction, highest bid wins, profit = value − bid. Reverse:
// common-COST procurement auction, the student is a supplier, LOWEST bid wins, and
// profit = bid − cost (below-cost bidding loses money — the winner's curse, mirrored).
//
// The mode switches: the scoring rule (scoring.ts), the true-value derivation (below),
// the student copy + input handling, and the report framing. NOTHING here changes the
// forward game — every field defaults to exactly today's behavior.

/** false = forward (value auction), true = reverse (supplier/cost auction). config/main,
 *  client-readable (the student is told which game they are playing). */
export const DEFAULT_REVERSE = false

/** REVERSE only. Dollars represented by ONE penny in the jar — the multiplier the
 *  instructor exposes. config/main, client-readable (it is printed in the student copy
 *  as "each penny represents $1,000"). Drives the true COST (below), the student
 *  shorthand-entry factor, and the on-screen conversions. */
export const DEFAULT_PENNY_VALUE = 1000

/** REVERSE only. The jar's ACTUAL penny count — the secret the suppliers estimate.
 *  Lives ONLY in truth/main (rules-denied), exactly as true_value does for the forward
 *  game. The true cost is `penny_count × penny_value`. */
export const DEFAULT_PENNY_COUNT = 300

/**
 * The instance's true value/cost in DOLLARS — the number every profit is measured
 * against. Forward: the jar's dollar value (truth/main.true_value). Reverse: the jar's
 * true COST = penny_count × penny_value. One helper so scoreAndRecord and getReport can
 * never derive it two different ways.
 */
export function resolveTrueValue(opts: {
  reverse: boolean
  trueValue: number
  pennyCount: number
  pennyValue: number
}): number {
  return opts.reverse ? opts.pennyCount * opts.pennyValue : opts.trueValue
}
