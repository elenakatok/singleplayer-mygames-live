// ═══════════════════════════════════════════════════════════════════════════════
// ONE BUNDLE, MANY HOSTING SITES — the hostname → game routing table.
//
// ⚠ ITS OWN MODULE, DELIBERATELY, AND NOT PART OF App.tsx. The table is the one piece of
// the app that can break a game other than the one being worked on, so it needs a test —
// and importing App.tsx into a test pulls in `firebase.ts`, which calls `initializeApp`
// at module load and throws without the production env. Keeping the table here means the
// thing that most needs testing is the thing easiest to test. Nothing in this file
// imports anything.
// ═══════════════════════════════════════════════════════════════════════════════

export type Game =
  | 'pennies' | 'poll' | 'pd' | 'pricing' | 'newsvendor' | 'forecast' | 'procurement'
  | 'scorecard'

/**
 * Hostname prefix → game. Checked IN ORDER; the first match wins.
 *
 * These are PREFIXES, not exact labels, because a site's Firebase default domain carries
 * a suffix and the suffixes are not uniform: `pennies`, `poll-mygames`, `pd-mygames-live`,
 * `pricing-mygames-live`, `newsvendor-mygames-live`, `forecast-mygames`,
 * `procurement-mygames` — three conventions, because each name was whatever was still
 * globally free on the day. Matching by prefix is what tolerates that.
 *
 * ⚠ ADDING AN ENTRY CHANGES EVERY OTHER GAME'S ROUTING. A new prefix that shadows an
 * existing one sends that game's students to the wrong screens, and it fails SILENTLY —
 * the page renders, it is just the wrong game. `hostRouting.test.ts` pins every live host
 * and asserts that no entry is shadowed; add a game there in the same commit.
 */
export const HOST_PREFIXES: ReadonlyArray<readonly [string, Game]> = [
  ['pennies', 'pennies'],
  ['poll', 'poll'],
  ['pd', 'pd'],
  ['pricing', 'pricing'],
  ['newsvendor', 'newsvendor'],
  ['forecast', 'forecast'],
  // ⚠ 'procurement' shares no prefix with any entry above it ('pennies', 'poll', 'pd' and
  // 'pricing' all diverge by the second character), so its position is not load-bearing
  // today — but a future game whose name begins 'pro…' would be shadowed by this line
  // rather than by a bug. Add such a game ABOVE this one, or make both exact.
  ['procurement', 'procurement'],
  // ⚠ 'scorecard' shares no prefix with any entry above it, so its position is not
  // load-bearing today. Host: scorecard.mygames.live (spec §14).
  ['scorecard', 'scorecard'],
]

/** host → game, or null when nothing matches (the caller decides the fallback). */
export function gameForHost(host: string): Game | null {
  for (const [prefix, game] of HOST_PREFIXES) {
    if (host.startsWith(prefix)) return game
  }
  return null
}
