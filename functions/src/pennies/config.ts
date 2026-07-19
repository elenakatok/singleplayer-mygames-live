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
 *  returned to a student. Default when the instructor has not set it. */
export const DEFAULT_TRUE_VALUE = 3.5
/** Site-relative jar image path (config/main.jar_image). Client-readable. */
export const DEFAULT_JAR_IMAGE = '/jarofpennies.jpg'
