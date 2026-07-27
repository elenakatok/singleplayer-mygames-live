// ═══════════════════════════════════════════════════════════════════════════════
// Where a returning student re-enters the flow.
//
// Its own module, with NO imports: Play.tsx reaches Firebase through api.ts, so a
// test that imported this from there would initialize Firebase Auth in Node just to
// check two branches. Keeping the one piece of resume logic dependency-free makes it
// directly unit-testable — and getting it wrong puts a student back on a round they
// have already played, which the server would then refuse.
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Both inputs are facts READ FROM THE SERVER (the stored phase, the stored rounds) —
 * never browser state — which is what lets a student close the tab, come back on
 * another device, and land in exactly the same place.
 *
 * ⚠ `finished` COMES FROM THE PHASE, NEVER FROM COUNTING ROUNDS. Deriving it as
 * "roundsPlayed >= someTotal" would need the drawn horizon in the browser, which is
 * precisely what spec §3 forbids. The server decides the game is over and says so.
 *
 * `startIteration` is the 0-based index of the first round NOT yet played, which for
 * a contiguous history is just its length: a student who has played 6 rounds resumes
 * at the ask for round 7.
 *
 * WHAT THIS DELIBERATELY DOES NOT RESTORE: the reveal of the round just played. A
 * student who closes the tab on a results screen returns to the next round's price
 * entry, with the round they just played sitting in the history table. That is PD's
 * behaviour, and it follows from the server storing outcomes rather than screen
 * positions — there is no "they have seen it" fact to read back.
 */
export function pricingResume(args: {
  phase: 'play' | 'debrief'
  roundsPlayed: number
}): { finished: boolean; startIteration: number } {
  return {
    finished: args.phase === 'debrief',
    startIteration: Math.max(0, args.roundsPlayed),
  }
}
