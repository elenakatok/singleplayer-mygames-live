// ═══════════════════════════════════════════════════════════════════════════════
// Where a returning student re-enters the flow.
//
// Its own module, with NO imports: Play.tsx reaches Firebase through api.ts, so a
// test that imported this from there would initialize Firebase Auth in Node just to
// check arithmetic. Keeping the one piece of resume logic dependency-free makes it
// directly unit-testable — and an off-by-one here puts a student back through a KC
// question the server has already locked, or onto a round they have already played.
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Screen layout, in order:
 *
 *   [PMG rules at 0, IF this is a PMG instance]
 *   [KC 0…n−1]
 *   [the round loop]
 *   [the POST stage, 0…m−1]
 *
 * A return value past the last screen means everything is behind them.
 *
 * The PMG rules screen is a READ, not a submission — there is no server fact saying
 * it was seen, and inventing one would gate a student out of their own game if the
 * write ever failed. So a returning PMG student sees it again, which is harmless: it
 * is one button, and a student who is re-reading the rules is not being harmed by
 * being shown the rules. It is skipped only once they are past the KC, where showing
 * it again would be a step backwards through work they have finished.
 *
 * `kcCount` is 0 when the instructor turned the knowledge check off, which collapses
 * the KC segment to nothing — no special case needed.
 *
 * ⚠⚠ THE POST SEGMENT IS A LIST, NOT ONE SCREEN. It used to be "the debrief, if enabled" —
 * a single optional screen, described by two booleans. The `post` stage can now hold the
 * debrief row PLUS any question the instructor put after the results, so what this needs is
 * one answered-flag per row, in served order.
 *
 * ⚠ THE SHAPE IS `boolean[]`, NOT A COUNT. A count would resume a student `postAnswered`
 * screens in, which is only the same thing while the flags form a solid prefix.
 * `findIndex(!answered)` lands on the FIRST UNANSWERED row whatever the pattern — so a
 * student with rows 1 and 3 stored but not 2 goes back to row 2 rather than skipping it and
 * leaving a question permanently unanswerable with the denominator silently short. An empty
 * array is "no post questions at all" and needs no branch: findIndex returns −1.
 *
 * ⚠ `gameOver` COMES FROM THE SERVER'S PHASE, NEVER FROM COUNTING ROUNDS. Deriving it
 * as "roundsPlayed >= someTotal" would need the drawn horizon in the browser, which
 * is exactly what spec §3 forbids.
 *
 * Every input is a fact READ FROM THE SERVER (answers stored, game finished, debrief
 * stored) — never browser state — which is what lets a student resume on a different
 * device and land in exactly the same place.
 */
export function pricingResumeIndex(args: {
  pmg: boolean
  kcCount: number
  kcAnswered: number
  gameOver: boolean
  /** One flag per POST-stage row, in served order. See the note above. */
  postAnswered: readonly boolean[]
}): number {
  const { pmg, kcCount, kcAnswered, gameOver, postAnswered } = args
  const rulesOffset = pmg ? 1 : 0

  if (kcAnswered < kcCount) {
    // Still in the knowledge check. A PMG student who has not answered anything yet
    // is at the rules screen; one part-way through the KC is past it.
    return kcAnswered === 0 ? 0 : rulesOffset + kcAnswered
  }
  if (!gameOver) return rulesOffset + kcCount               // the round loop

  const firstUnanswered = postAnswered.findIndex(a => !a)
  // Every post row answered (or there are none) ⇒ past the end.
  if (firstUnanswered === -1) return rulesOffset + kcCount + 1 + postAnswered.length
  return rulesOffset + kcCount + 1 + firstUnanswered
}

/** How many screens the sequence has, given the same inputs. `pricingResumeIndex >=
 *  this` means the student is finished. Keeping the arithmetic in one place stops the
 *  caller re-deriving "kcCount + 2" and getting it wrong when the debrief is off or
 *  the mode has no rules screen. */
export function pricingScreenCount(pmg: boolean, kcCount: number, postCount: number): number {
  return (pmg ? 1 : 0) + kcCount + 1 + postCount
}

/** The first round NOT yet played (0-based) — for a contiguous history, its length.
 *
 *  WHAT THIS DELIBERATELY DOES NOT RESTORE: the reveal of the round just played. A
 *  student who closes the tab on a results screen returns to the next round's price
 *  entry, with the round they just played sitting in the history table. That is PD's
 *  behaviour, and it follows from the server storing outcomes rather than screen
 *  positions — there is no "they have seen it" fact to read back. */
export function pricingStartIteration(roundsPlayed: number): number {
  return Math.max(0, roundsPlayed)
}
