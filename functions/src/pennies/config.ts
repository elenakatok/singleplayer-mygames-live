// ═══════════════════════════════════════════════════════════════════════════════
// Jar of Pennies — per-game constants. Kept as DATA (not scattered string literals)
// so a future admin-defaults screen and the Part 2 callables share one source.
// ═══════════════════════════════════════════════════════════════════════════════

/** game_id — lowercase, never displayed. Drives the collection prefix + fn names. */
export const PENNIES_GAME_ID = 'pennies'

/** Collection prefix — every Firestore collection this game owns (spec §4.1). */
export const PENNIES_COLLECTION_PREFIX = 'pennies'

/** Allowed browser origin for this game's callables (its own subdomain). */
export const PENNIES_CORS_ORIGINS = ['https://pennies.mygames.live']
