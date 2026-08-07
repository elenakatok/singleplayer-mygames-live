// ⚠ THE RULE MOVED TO `../shared/sortName.ts` (Elena, 2026-08-07) when all seven
// single-player games adopted it. Only the row-level adapter is procurement's own —
// procurement is the one game that falls back to the PARTICIPANT ID rather than to `''`
// for an unnamed row, which is why the shared module deals in strings. See BUILD_NOTES §6m.
import { compareByLastName } from '../shared/sortName'

export { lastNameOf, compareByLastName } from '../shared/sortName'

/**
 * What a roster row is called. ⚠ Falls back to the participant id so an unnamed row
 * still sorts somewhere stable instead of collapsing every one of them to "".
 */
export const displayNameOf = (r: { name: string | null; participantId: string }): string =>
  r.name ?? r.participantId

/** The row-level comparator every procurement roster column tiebreaks on. */
export const rowsByLastName = (
  a: { name: string | null; participantId: string },
  b: { name: string | null; participantId: string },
): number => compareByLastName(displayNameOf(a), displayNameOf(b))
