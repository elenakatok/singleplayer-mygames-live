// ═══════════════════════════════════════════════════════════════════════════════
// Where a returning student re-enters the flow.
//
// Its own module, with NO imports: Play.tsx reaches Firebase through api.ts, so a
// test that imported this from there would initialize Firebase Auth in Node just to
// check arithmetic. Keeping the one piece of resume logic dependency-free makes it
// directly unit-testable — and an off-by-one here puts a student back through a KC
// question the server has already locked, or onto a period they have already played.
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Screen layout, in order:
 *
 *   [KC 0…n−1, IF ENABLED]          ← graded, first
 *   [the prep paragraph, IF ENABLED]
 *   [the period loop]
 *   [the final-results screen]      ← terminal content, last
 *   [the debrief paragraph, IF ENABLED]
 *
 * A return value past the last screen means everything is behind them.
 *
 * ⚠ THE KC COMES FIRST, AND THE PREP DEPENDS ON THAT. Students arrive having had the
 * newsvendor lecture: the graded KC checks the lecture, and the prep then asks whether
 * they intend to ORDER the optimal quantity they just computed. That question only
 * makes sense downstream of the KC, so these two cannot be reordered independently —
 * the prep's wording (functions newsvendor/config.ts) is written against this order.
 *
 * ⚠ AND THE FINAL SCREEN MOVED WITH THEM. It used to sit mid-sequence, because the KC
 * came after play; now that the KC is first, nothing follows the game except the
 * debrief, so the final screen is the last content screen. That also removes the odd
 * step it used to be — a display screen with no server fact recording that it was
 * read, wedged between two things that did have one.
 *
 * Every input is a fact READ FROM THE SERVER (answers stored, game finished, text
 * stored) — never browser state — which is what lets a student resume on a different
 * device and land in exactly the same place.
 */
export function newsvendorResumeIndex(args: {
  prepEnabled: boolean
  prepSubmitted: boolean
  gameOver: boolean
  kcCount: number
  kcAnswered: number
  debriefEnabled: boolean
  debriefSubmitted: boolean
}): number {
  const { prepEnabled, prepSubmitted, gameOver, kcCount, kcAnswered, debriefEnabled, debriefSubmitted } = args

  // Still in the knowledge check — it is the first block now.
  if (kcAnswered < kcCount) return kcAnswered
  // The prep paragraph, if it is on and unanswered.
  if (prepEnabled && !prepSubmitted) return kcCount
  const played = kcCount + (prepEnabled ? 1 : 0)
  // The period loop.
  if (!gameOver) return played
  // The game is over: the final-results screen, then the debrief.
  //
  // ⚠ A FINISHED STUDENT WITH NO DEBRIEF PENDING IS *PAST* THE END, not sitting on the
  // final screen — Play.tsx renders the same component as the terminal state, so
  // returning the final screen's index here would show it twice with a Continue button
  // that leads nowhere.
  if (!debriefEnabled) return played + 2                      // past the end (== screenCount)
  if (!debriefSubmitted) return played + 1                    // the final screen, then the debrief
  return played + 3                                           // past the end (== screenCount)
}

/** How many screens the sequence has, given the same inputs. `newsvendorResumeIndex
 *  >= this` means the student is finished. Keeping the arithmetic in one place stops
 *  the caller re-deriving "kcCount + 2" and getting it wrong when a block is off. */
export function newsvendorScreenCount(
  prepEnabled: boolean,
  kcCount: number,
  debriefEnabled: boolean,
): number {
  // the KC questions + prep? + the loop + the final screen + the debrief?
  return kcCount + (prepEnabled ? 1 : 0) + 1 + 1 + (debriefEnabled ? 1 : 0)
}

/** The first period NOT yet played (0-based) — for a contiguous history, its length.
 *
 *  WHAT THIS DELIBERATELY DOES NOT RESTORE: the results screen of the period just
 *  played. A student who closes the tab on a results screen returns to the next
 *  period's order entry, with the period they just played sitting in the history
 *  table. That is PD's and pricing's behaviour, and it follows from the server storing
 *  outcomes rather than screen positions. */
export function newsvendorStartIteration(periodsPlayed: number): number {
  return Math.max(0, periodsPlayed)
}
