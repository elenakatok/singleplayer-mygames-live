// ═══════════════════════════════════════════════════════════════════════════════
// SORTING PEOPLE BY LAST NAME — the single-player family's one rule (Elena, 2026-08-07).
//
// ⚠⚠ THE PARSING RULE IS COPIED VERBATIM FROM THE PLATFORM'S OWN, NOT INVENTED HERE.
// `@mygames/game-ui`'s `RosterTable.tsx` has sorted the MULTIPLAYER roster by surname
// since it shipped:
//
//     function getLastName(name: string): string {
//       const tokens = name.trim().split(/\s+/)
//       return tokens[tokens.length - 1]
//     }
//
// `lastNameOf` below IS that function. It is duplicated rather than imported because
// `getLastName` is module-private inside `RosterTable.tsx` — a multiplayer component
// (`SharedParticipant`, `group_id`, "Negotiating") that no single-player game renders.
// Exporting it would edit a package EVERY family consumes (Baxter, Winemaster, …), which
// is a wider blast radius than this change needs: living here, the fix is confined to the
// single-player repo and to `singleplayer-mygames-live`'s seven hosting targets.
//
// ⚠ THE TWO COPIES CANNOT DRIFT SILENTLY: `sortName.test.ts` pins this against an
// independent restatement of the shared source's exact rule. If game-ui's parsing ever
// changes, that test fails here.
//
// ⚠ LAST WHITESPACE TOKEN, AND ITS LIMITS ARE ACCEPTED DELIBERATELY. "Ana de la Cruz"
// keys on "Cruz"; "Kim Jr." keys on "Jr.". A cleverer parser would be a DIFFERENT
// algorithm from the one the rest of the platform uses, and a roster that sorts one way
// in Baxter and another way here is worse than one that is uniformly imperfect.
// Improving it is a shared change, made once, for everybody.
//
// ⚠⚠ WHY THIS TAKES *STRINGS* AND NOT ROWS. The seven games disagree about what an
// unnamed row is called — most fall back to `''`, procurement falls back to the
// participant id — and that fallback decides whether unnamed students clump at the top or
// scatter by id. Changing it would be a behaviour change riding along on a sorting change,
// so each caller keeps its OWN fallback expression and this module changes only the
// ORDERING RULE. `lastNameOf('')` is `''`, so an empty name still sorts first.
// ═══════════════════════════════════════════════════════════════════════════════

/** ⚠ Byte-for-byte game-ui's `getLastName`. Do not "improve" this in isolation. */
export function lastNameOf(name: string): string {
  const tokens = name.trim().split(/\s+/)
  return tokens[tokens.length - 1]
}

/**
 * Last name, then the whole name.
 *
 * ⚠ THE FULL-NAME TIEBREAK IS PART OF THE SHARED RULE
 * (`a.lastName.localeCompare(b.lastName) || a.name.localeCompare(b.name)`), not an
 * embellishment: without it two Smiths land in whatever order the server sent, and the
 * roster reshuffles under the instructor between refreshes.
 *
 * ⚠ CASE- AND ACCENT-INSENSITIVE via the collator, not a lowercased copy — "de Souza"
 * and "De Souza" belong next to each other. This is procurement's shipped collation,
 * promoted here; the multiplayer roster passes no options. It changes only which SPELLING
 * of the same name comes first, never which name comes first.
 */
export const compareByLastName = (a: string, b: string): number =>
  lastNameOf(a).localeCompare(lastNameOf(b), undefined, { sensitivity: 'base' })
  || a.localeCompare(b, undefined, { sensitivity: 'base' })
