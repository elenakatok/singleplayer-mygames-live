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
 *   [the PRE stage, 0…n−1]          ← the authored set, the prep paragraph, pre additions
 *   [the period loop]
 *   [the final-results screen]      ← terminal content
 *   [the POST stage, 0…m−1]         ← the debrief paragraph, post additions
 *
 * A return value past the last screen means everything is behind them.
 *
 * ⚠⚠ BOTH SEGMENTS ARE LISTS NOW. They used to be described by four booleans — prep on/off
 * and submitted, debrief on/off and submitted — because each was a single optional screen.
 * Each stage can now hold its paragraph PLUS any question the instructor put there, so what
 * this needs is one answered-flag per row, in served order.
 *
 * ⚠ THE SHAPE IS `boolean[]`, NOT A COUNT. A count is only equivalent while the answered
 * rows form a solid prefix; `findIndex(!answered)` lands on the FIRST UNANSWERED row
 * whatever the pattern, so a student with rows 1 and 3 stored but not 2 goes back to row 2
 * rather than skipping it and leaving a question permanently unanswerable with the
 * denominator silently short.
 *
 * ⚠ THE KC COMES FIRST, AND THE PREP DEPENDS ON THAT. Students arrive having had the
 * newsvendor lecture: the graded KC checks the lecture, and the prep then asks whether
 * they intend to ORDER the optimal quantity they just computed. That question only
 * makes sense downstream of the KC — which is why the prep is APPENDED to the pre stage
 * rather than prepended, and why an instructor who reorders it is doing so knowingly.
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
  gameOver: boolean
  /** One flag per PRE-stage row, in served order. */
  preAnswered: readonly boolean[]
  /** One flag per POST-stage row, in served order. */
  postAnswered: readonly boolean[]
}): number {
  const { gameOver, preAnswered, postAnswered } = args

  // Still in the pre stage — the first row they have not done.
  const firstPre = preAnswered.findIndex(a => !a)
  if (firstPre !== -1) return firstPre

  const preCount = preAnswered.length
  // The period loop.
  if (!gameOver) return preCount

  // The game is over: the final-results screen sits at preCount + 1, then the post stage.
  const firstPost = postAnswered.findIndex(a => !a)

  // ⚠ A FINISHED STUDENT WITH NOTHING LEFT IS *PAST* THE END, not sitting on the final
  // screen — Play.tsx renders the same component as the terminal state, so returning the
  // final screen's index here would show it twice with a Continue button leading nowhere.
  if (firstPost === -1) return preCount + 2 + postAnswered.length

  // ⚠ NOTHING ANSWERED YET ⇒ THE RESULTS SCREEN FIRST. Arriving from the last period, a
  // student should read their own outcome before being asked to reflect on it; the runner
  // then walks them into the post stage. Once they are PART-WAY through that stage, the
  // results screen is behind them and re-showing it would be a step backwards.
  if (firstPost === 0) return preCount + 1

  return preCount + 2 + firstPost
}

/** How many screens the sequence has, given the same inputs. `newsvendorResumeIndex
 *  >= this` means the student is finished. Keeping the arithmetic in one place stops
 *  the caller re-deriving "kcCount + 2" and getting it wrong when a block is off. */
export function newsvendorScreenCount(preCount: number, postCount: number): number {
  // the pre stage + the loop + the final screen + the post stage
  return preCount + 1 + 1 + postCount
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
