// ═══════════════════════════════════════════════════════════════════════════════
// Where a returning student re-enters the flow.
//
// Its own module, with NO imports: Play.tsx reaches Firebase through api.ts, so a
// test that imported this from there would initialize Firebase Auth in Node just to
// check arithmetic. Keeping the one piece of resume logic dependency-free makes it
// directly unit-testable — and an off-by-one here puts a student on the wrong screen,
// or back through a KC question the server has already locked.
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Screen layout: [KC 0…n−1] [loop at n] [debrief at n+1].
 * A return value of n+2 means every screen is behind them.
 *
 * Every input is a fact READ FROM THE SERVER (answers stored, game finished, debrief
 * stored) — never browser state — which is what lets a student resume on a different
 * device and land in exactly the same place.
 */
export function resumeIndex(args: {
  kcCount: number
  kcAnswered: number
  gameOver: boolean
  debriefSubmitted: boolean
}): number {
  const { kcCount, kcAnswered, gameOver, debriefSubmitted } = args
  if (kcAnswered < kcCount) return kcAnswered   // first unanswered KC question
  if (!gameOver) return kcCount                 // the round loop
  if (!debriefSubmitted) return kcCount + 1     // the debrief
  return kcCount + 2                            // past the end ⇒ nothing left to do
}
