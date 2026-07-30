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
 * Screen layout, in order (spec §7, §8):
 *
 *   [the prep paragraph, IF ENABLED]
 *   [the period loop]
 *   [the final-results screen]
 *   [KC 0…n−1, IF ENABLED]
 *   [the debrief paragraph, IF ENABLED]
 *
 * A return value past the last screen means everything is behind them.
 *
 * ⚠ THE ORDER IS THE SPEC'S, NOT PRICING'S. Pricing runs its knowledge check BEFORE
 * play, because its KC is about reading the market you are about to price in. This
 * game's KC comes AFTER (spec §8: "prep question before play, graded KC after") — it
 * is the assessed component (spec §9.1) and it tests the newsvendor logic the twenty
 * periods were meant to teach. Do not "align" the two.
 *
 * The FINAL-RESULTS screen is a step in the sequence rather than the terminal state,
 * because the KC and the debrief come after it. There is no server fact recording
 * that it was READ — it is a display screen, and inventing a stamp for it would gate
 * a student out of their own knowledge check if the write ever failed. So its
 * position is derived from what surrounds it: a student whose game is over but who
 * has not started the KC lands on it, and one who is part-way through the KC is past
 * it. A student who re-reads their totals once is not being harmed.
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
  const prepOffset = prepEnabled ? 1 : 0

  // The prep paragraph, if it is on and unanswered.
  if (prepEnabled && !prepSubmitted) return 0
  // The period loop.
  if (!gameOver) return prepOffset
  // The final-results screen, then the knowledge check.
  if (kcAnswered < kcCount) {
    return kcAnswered === 0
      ? prepOffset + 1              // the final screen, not yet read past
      : prepOffset + 2 + kcAnswered // part-way through the KC
  }
  // Everything before the debrief is done.
  if (!debriefEnabled) return prepOffset + 2 + kcCount        // past the end
  if (!debriefSubmitted) return prepOffset + 2 + kcCount      // the debrief
  return prepOffset + 3 + kcCount                             // past the end
}

/** How many screens the sequence has, given the same inputs. `newsvendorResumeIndex
 *  >= this` means the student is finished. Keeping the arithmetic in one place stops
 *  the caller re-deriving "kcCount + 2" and getting it wrong when a block is off. */
export function newsvendorScreenCount(
  prepEnabled: boolean,
  kcCount: number,
  debriefEnabled: boolean,
): number {
  // prep? + the loop + the final screen + the KC questions + the debrief?
  return (prepEnabled ? 1 : 0) + 1 + 1 + kcCount + (debriefEnabled ? 1 : 0)
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
