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
 *   [the PRE stage: the authored nine + any pre-stage addition]   ← graded, first
 *   [the month loop]
 *   [the final-results screen]                                     ← the student's own outcome
 *   [the POST stage: the debrief paragraph + any post-stage addition]
 *   → the REVEAL
 *
 * A return value past the last screen means everything is behind them.
 *
 * ⚠ THE KC COMES FIRST (spec §4's flow line: instructions → KC → loop). Students
 * arrive having had the forecasting lecture, and the KC checks the LECTURE rather than
 * the play — Q4 and Q5 are read straight off slide 14 and are the skill they need to
 * fit the game's own model (spec §8). Putting it after play would test what they had
 * already been forced to work out for themselves.
 *
 * ⚠⚠ BOTH STAGES ARE `boolean[]`, ONE FLAG PER SERVED ROW — never a COUNT. A count
 * assumes the answered rows are a PREFIX of the list, and the moment an instructor
 * reorders or hides a row that stops being true: a student who answered rows 1 and 3
 * would resume at row 2 under a count and correctly at row 2 under `findIndex`, but one
 * who answered only row 2 would resume at row 3 under a count and at row 1 here. The
 * server sends `answered` per row for exactly this reason.
 *
 * ⚠ THE POST STAGE IS NOT JUST THE DEBRIEF ANY MORE. It was one paragraph and is now a
 * stage an instructor can add to, which is why the argument is a list. The REVEAL is
 * gated server-side on the whole of it (functions forecast/reveal.ts), so a student who
 * stops part-way through resumes into the stage rather than onto a reveal they have not
 * earned.
 */
export function forecastResumeIndex(args: {
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
  // The month loop.
  if (!gameOver) return preCount

  // The game is over: the final-results screen sits at preCount + 1, then the post stage.
  const firstPost = postAnswered.findIndex(a => !a)

  // ⚠ A FINISHED STUDENT WITH NOTHING LEFT IS *PAST* THE END, not sitting on the final
  // screen — Play.tsx renders the same component as the terminal state, so returning the
  // final screen's index here would show it twice with a Continue button leading nowhere.
  if (firstPost === -1) return preCount + 2 + postAnswered.length

  // ⚠ NOTHING ANSWERED YET ⇒ THE RESULTS SCREEN FIRST. Arriving from the last month, a
  // student should read their own outcome before being asked to reflect on it; the runner
  // then walks them into the post stage. Once they are PART-WAY through that stage the
  // results screen is behind them, and re-showing it would be a step backwards.
  if (firstPost === 0) return preCount + 1

  return preCount + 2 + firstPost
}

/** How many screens the sequence has, given the same inputs. `forecastResumeIndex >=
 *  this` means the student is finished. Keeping the arithmetic in one place stops the
 *  caller re-deriving "preCount + 2" and getting it wrong when a stage is empty. */
export function forecastScreenCount(preCount: number, postCount: number): number {
  // the pre stage + the loop + the final screen + the post stage
  return preCount + 1 + 1 + postCount
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
