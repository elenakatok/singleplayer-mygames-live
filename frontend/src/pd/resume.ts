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
 * Screen layout: [KC 0…n−1] [loop at n] [debrief at n+1, IF ENABLED].
 * A return value past the last screen means everything is behind them.
 *
 * `kcCount` is 0 when the instructor turned the knowledge check off, which collapses
 * the KC segment to nothing and puts the loop at index 0 — no special case needed.
 * The debrief is different: it is the LAST screen, so when it is off the sequence is
 * simply one shorter, and `debriefEnabled` has to be an input rather than something
 * inferred from `debriefSubmitted` (which is false both when it is pending and when
 * it does not exist).
 *
 * Every input is a fact READ FROM THE SERVER (answers stored, game finished, debrief
 * stored) — never browser state — which is what lets a student resume on a different
 * device and land in exactly the same place.
 */
export function resumeIndex(args: {
  kcCount: number
  kcAnswered: number
  gameOver: boolean
  debriefEnabled: boolean
  debriefSubmitted: boolean
}): number {
  const { kcCount, kcAnswered, gameOver, debriefEnabled, debriefSubmitted } = args
  if (kcAnswered < kcCount) return kcAnswered   // first unanswered KC question
  if (!gameOver) return kcCount                 // the round loop
  if (!debriefEnabled) return kcCount + 1       // no debrief screen ⇒ already past the end
  if (!debriefSubmitted) return kcCount + 1     // the debrief
  return kcCount + 2                            // past the end ⇒ nothing left to do
}

/** How many screens the sequence has, given the same inputs. `resumeIndex >= this`
 *  means the student is finished. Keeping the arithmetic in one place stops the
 *  caller re-deriving "kcCount + 2" and getting it wrong when the debrief is off. */
export function screenCount(kcCount: number, debriefEnabled: boolean): number {
  return kcCount + 1 + (debriefEnabled ? 1 : 0)
}
