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
 * Screen layout: [KC 0…n−1] [loop at n] [POST STAGE n+1 … n+m].
 * A return value past the last screen means everything is behind them.
 *
 * `kcCount` is 0 when the instructor turned the knowledge check off, which collapses
 * the KC segment to nothing and puts the loop at index 0 — no special case needed.
 *
 * ⚠⚠ THE POST SEGMENT IS A LIST NOW, NOT ONE SCREEN. It used to be "the debrief, if
 * enabled" — a single optional screen — so the two booleans `debriefEnabled` /
 * `debriefSubmitted` were enough. The `post` stage can now hold the debrief row PLUS any
 * added question the instructor put after play, so what this needs is one answered-flag
 * per row, in served order.
 *
 * ⚠ THE SHAPE IS DELIBERATELY `boolean[]`, NOT A COUNT. A count would resume a student at
 * `postAnswered` screens in, which is only the same thing while the flags are a solid
 * prefix. `findIndex(!answered)` lands on the FIRST UNANSWERED row whatever the pattern —
 * so a student who somehow has row 2 stored but not row 1 goes back to row 1 rather than
 * skipping it. An empty array is the "no post questions at all" case and needs no branch:
 * findIndex returns −1 and the student is past the end.
 *
 * Every input is a fact READ FROM THE SERVER (answers stored, game finished, each post row
 * stored) — never browser state — which is what lets a student resume on a different device
 * and land in exactly the same place.
 */
export function resumeIndex(args: {
  kcCount: number
  kcAnswered: number
  gameOver: boolean
  /** One flag per POST-stage row, in served order. See the note above. */
  postAnswered: readonly boolean[]
}): number {
  const { kcCount, kcAnswered, gameOver, postAnswered } = args
  if (kcAnswered < kcCount) return kcAnswered   // first unanswered KC question
  if (!gameOver) return kcCount                 // the round loop

  const firstUnanswered = postAnswered.findIndex(a => !a)
  // Every post row answered (or there are none) ⇒ past the end, nothing left to do.
  if (firstUnanswered === -1) return kcCount + 1 + postAnswered.length
  return kcCount + 1 + firstUnanswered
}

/** How many screens the sequence has, given the same inputs. `resumeIndex >= this`
 *  means the student is finished. Keeping the arithmetic in one place stops the
 *  caller re-deriving "kcCount + 1 + m" and getting it wrong when the post stage is
 *  empty. */
export function screenCount(kcCount: number, postCount: number): number {
  return kcCount + 1 + postCount
}
