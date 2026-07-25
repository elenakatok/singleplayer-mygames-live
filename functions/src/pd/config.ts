// ═══════════════════════════════════════════════════════════════════════════════
// Repeated Prisoner's Dilemma — per-game constants. Kept as DATA (not scattered
// string literals) so a future admin-defaults screen and the callables share one
// source. Mirrors pennies/config.ts.
//
// SLICE 0 (scaffold) — identity, collection paths, and CORS only. The payoff
// matrix, the [10,20] round draw, and the TFT/GRIM strategy library land in
// Slice 1; nothing here encodes game logic yet.
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
 *  Slice 1 puts the drawn round count (spec §3: never displayed) here. The
 *  per-student bot strategy is likewise never client-readable — see the
 *  `allow read: if false` on this game's participants block in firestore.rules. */
export const TRUTH_DOC = 'main'
