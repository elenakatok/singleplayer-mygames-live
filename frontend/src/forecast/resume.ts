// ═══════════════════════════════════════════════════════════════════════════════
// Where a returning student re-enters the flow (spec §4: "self-paced, closeable,
// resumable").
//
// Its own module, with NO imports: Play.tsx reaches Firebase through api.ts, so a test
// that imported this from there would initialize Firebase Auth in Node just to check
// arithmetic. Keeping the one piece of resume logic dependency-free makes it directly
// unit-testable — and an off-by-one here puts a student back through a KC question the
// server has already locked, or onto a month they have already forecast.
//
// Every input is a fact READ FROM THE SERVER (answers stored, game finished, text
// stored) — never browser state — which is what lets a student resume on a different
// device and land in exactly the same place.
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Screen layout, in order (spec §4):
 *
 *   [KC 0…n−1, IF ENABLED]        ← graded, first
 *   [the month loop]
 *   [the final-results screen]    ← terminal content
 *   [the debrief paragraph, IF ENABLED]
 *
 * A return value past the last screen means everything is behind them.
 *
 * ⚠ THE KC COMES FIRST (spec §4's flow line: instructions → KC → loop). Students
 * arrive having had the forecasting lecture, and the KC checks the LECTURE rather than
 * the play — Q4 and Q5 are read straight off slide 14 and are the skill they need to
 * fit the game's own model (spec §8). Putting it after play would test what they had
 * already been forced to work out for themselves.
 *
 * ⚠ THERE IS NO PREP QUESTION IN THIS GAME. Newsvendor has one; spec §9 gives this game
 * exactly ONE free-text question, the debrief, and the Tier-2 contract follows from
 * that. Do not add a prep screen here without a spec change — the resume arithmetic and
 * the report tiles both count on there being one.
 */
export function forecastResumeIndex(args: {
  gameOver: boolean
  kcCount: number
  kcAnswered: number
  debriefEnabled: boolean
  debriefSubmitted: boolean
}): number {
  const { gameOver, kcCount, kcAnswered, debriefEnabled, debriefSubmitted } = args

  // Still in the knowledge check — it is the first block.
  if (kcAnswered < kcCount) return kcAnswered
  // The month loop.
  if (!gameOver) return kcCount
  // The game is over: the final-results screen, then the debrief.
  //
  // ⚠ A FINISHED STUDENT WITH NO DEBRIEF PENDING IS *PAST* THE END, not sitting on the
  // final screen — Play.tsx renders the same component as the terminal state, so
  // returning the final screen's index here would show it twice with a Continue button
  // that leads nowhere.
  if (!debriefEnabled) return kcCount + 2                     // past the end (== screenCount)
  if (!debriefSubmitted) return kcCount + 1                   // the final screen, then the debrief
  return kcCount + 3                                          // past the end (== screenCount)
}

/** How many screens the sequence has, given the same inputs. `forecastResumeIndex >=
 *  this` means the student is finished. Keeping the arithmetic in one place stops the
 *  caller re-deriving "kcCount + 2" and getting it wrong when a block is off. */
export function forecastScreenCount(kcCount: number, debriefEnabled: boolean): number {
  // the KC questions + the loop + the final screen + the debrief?
  return kcCount + 1 + 1 + (debriefEnabled ? 1 : 0)
}

/** The first month NOT yet played (0-based) — for a contiguous history, its length.
 *
 *  WHAT THIS DELIBERATELY DOES NOT RESTORE: the results screen of the month just
 *  played. A student who closes the tab on a results screen returns to the next
 *  month's forecast entry, with the month they just played sitting in the history
 *  table. That is PD's, pricing's and newsvendor's behaviour, and it follows from the
 *  server storing outcomes rather than screen positions. */
export function forecastStartIteration(roundsPlayed: number): number {
  return Math.max(0, roundsPlayed)
}
