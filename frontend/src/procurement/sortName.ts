// ═══════════════════════════════════════════════════════════════════════════════
// SORTING PEOPLE BY LAST NAME (Elena, 2026-08-07).
//
// ⚠⚠ THE PARSING RULE IS COPIED VERBATIM FROM THE SHARED ONE, NOT INVENTED HERE.
// `@mygames/game-ui`'s `RosterTable.tsx` has sorted the multiplayer roster by last name
// since it shipped:
//
//     function getLastName(name: string): string {
//       const tokens = name.trim().split(/\s+/)
//       return tokens[tokens.length - 1]
//     }
//
// `lastNameOf` below IS that function. It is duplicated rather than imported because
// `getLastName` is module-private inside `RosterTable.tsx` — a MULTIPLAYER component
// (SharedParticipant, group_id, "Negotiating") that no single-player game renders.
// Exporting it would edit a package every game consumes, which is a seven-target deploy
// and Elena's call, not a side effect of a procurement sort. See BUILD_NOTES §6l.
//
// ⚠ THE BEHAVIOUR IS IDENTICAL, so the two cannot drift silently: `sortName.test.ts`
// pins this against the shared source's exact rule, including its known edge cases.
//
// ⚠ LAST WHITESPACE TOKEN, AND ITS LIMITS ARE ACCEPTED DELIBERATELY. "Ana de la Cruz"
// keys on "Cruz", "Kim Jr." keys on "Jr.". A cleverer parser would be a DIFFERENT
// algorithm from the one the rest of the platform uses, and a roster that sorts one way
// in Baxter and another way here is worse than one that is uniformly imperfect.
// Improving it is a shared change, made once, for everybody.
// ═══════════════════════════════════════════════════════════════════════════════

/** ⚠ Byte-for-byte the shared `getLastName`. Do not "improve" this in isolation. */
export function lastNameOf(name: string): string {
  const tokens = name.trim().split(/\s+/)
  return tokens[tokens.length - 1]
}

/**
 * What a roster row is called. ⚠ Falls back to the participant id so an unnamed row
 * still sorts somewhere stable instead of collapsing every one of them to "".
 */
export const displayNameOf = (r: { name: string | null; participantId: string }): string =>
  r.name ?? r.participantId

/**
 * Last name, then the whole name. ⚠ THE FULL-NAME TIEBREAK IS PART OF THE SHARED RULE
 * (`a.lastName.localeCompare(b.lastName) || a.name.localeCompare(b.name)`), not an
 * embellishment: without it two Smiths land in whatever order the server sent, and the
 * roster reshuffles under the instructor between refreshes.
 *
 * ⚠ CASE- AND ACCENT-INSENSITIVE via the collator, not a lowercased copy — "de Souza"
 * and "De Souza" belong next to each other. This is procurement's shipped collation and
 * it is kept; the shared roster passes no options. It changes only which of two spellings
 * of the SAME name comes first, never which name comes first.
 */
export const compareByLastName = (a: string, b: string): number =>
  lastNameOf(a).localeCompare(lastNameOf(b), undefined, { sensitivity: 'base' })
  || a.localeCompare(b, undefined, { sensitivity: 'base' })

/** The row-level comparator every procurement roster column tiebreaks on. */
export const rowsByLastName = (
  a: { name: string | null; participantId: string },
  b: { name: string | null; participantId: string },
): number => compareByLastName(displayNameOf(a), displayNameOf(b))
