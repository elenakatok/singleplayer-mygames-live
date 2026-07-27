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
 *   [the debrief, IF ENABLED]
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
 * the KC segment to nothing — no special case needed. The debrief is different: it is
 * the LAST screen, so when it is off the sequence is simply one shorter, and
 * `debriefEnabled` has to be an input rather than something inferred from
 * `debriefSubmitted` (which is false both when it is pending and when it does not
 * exist).
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
  debriefEnabled: boolean
  debriefSubmitted: boolean
}): number {
  const { pmg, kcCount, kcAnswered, gameOver, debriefEnabled, debriefSubmitted } = args
  const rulesOffset = pmg ? 1 : 0

  if (kcAnswered < kcCount) {
    // Still in the knowledge check. A PMG student who has not answered anything yet
    // is at the rules screen; one part-way through the KC is past it.
    return kcAnswered === 0 ? 0 : rulesOffset + kcAnswered
  }
  if (!gameOver) return rulesOffset + kcCount               // the round loop
  if (!debriefEnabled) return rulesOffset + kcCount + 1     // no debrief ⇒ past the end
  if (!debriefSubmitted) return rulesOffset + kcCount + 1   // the debrief
  return rulesOffset + kcCount + 2                          // past the end
}

/** How many screens the sequence has, given the same inputs. `pricingResumeIndex >=
 *  this` means the student is finished. Keeping the arithmetic in one place stops the
 *  caller re-deriving "kcCount + 2" and getting it wrong when the debrief is off or
 *  the mode has no rules screen. */
export function pricingScreenCount(pmg: boolean, kcCount: number, debriefEnabled: boolean): number {
  return (pmg ? 1 : 0) + kcCount + 1 + (debriefEnabled ? 1 : 0)
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
