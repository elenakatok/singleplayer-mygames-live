// ═══════════════════════════════════════════════════════════════════════════════
// Pricing Game (Cheyenne Shipping) — per-game constants. Kept as DATA (not
// scattered string literals) so a future admin-defaults screen and the callables
// share one source. Mirrors pd/config.ts.
//
// SLICE 0 (scaffold) — identity, collection paths, and CORS only. The market model
// (M, base shares, unit costs, share slope, price bounds), the [10,20] round draw,
// the PMG toggle, and the competitor strategy library land in later slices;
// nothing here encodes game logic yet.
//
// ⚠ ONE GAME, TWO COURSE INSTANCES (spec §3): Standard and PMG are the SAME game
// with a per-instance `pmg` flag, not two game_ids. So there is exactly one
// collection prefix, one hosting site, and one set of callables — the mode is
// instance config, and it lives in config/main when it arrives.
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
 *  only (the market parameters and the PMG flag, all of which students are shown
 *  on the price-entry screen anyway). */
export const CONFIG_DOC = 'main'

/** pricing_game_instances/{id}/truth/main — rules-denied to every client, forever.
 *  Later slices put the drawn round count here (spec §3: never displayed; students
 *  are told the [10,20] RANGE only). The competitor's pricing rule is likewise
 *  never client-readable — it is recomputed server-side each round and revealed
 *  only in the debrief, so it never enters a callable response during play. */
export const TRUTH_DOC = 'main'
