import type { PdPayoffs } from './api'

// ═══════════════════════════════════════════════════════════════════════════════
// "THESE NUMBERS ARE NOT A PRISONER'S DILEMMA" — an ADVISORY settings-page check.
//
// ⚠⚠ IT INFORMS, IT NEVER BLOCKS. Saving a matrix that fails this check succeeds, and
// students can play it. A matrix that is not a dilemma is a legitimate thing to run —
// it is just not the one the lecture's dominance argument is about. The check exists
// because an instructor who mistypes a value should find out here rather than in front
// of a class whose results refuse to make the point.
//
// ⚠⚠ THE GAME IS DIRECTION-AGNOSTIC AND MUST STAY THAT WAY. Payoffs may be prison years
// (lower is better) or points/dollars (higher is better); the software never says which,
// because the unit is the instructor's. So the check runs BOTH readings and warns only
// if the numbers fail under BOTH. A dilemma under either orientation is a dilemma.
//
// Higher-is-better reading — defection dominates for each player, yet mutual
// cooperation beats mutual defection:
//     you:   Y(D,C) > Y(C,C),  Y(D,D) > Y(C,D),  Y(C,C) > Y(D,D)
//     other: O(C,D) > O(C,C),  O(D,D) > O(D,C),  O(C,C) > O(D,D)
// Lower-is-better reading: all six inequalities reversed.
//
// ⚠ THE ALTERNATION CONDITION (2·CC vs CD+DC) IS DELIBERATELY NOT CHECKED. It is the
// extra condition that rules out profitable alternating play in a REPEATED game, and
// warning on it would flag matrices Elena may well want to run. Out of scope, on
// purpose — do not "complete" this by adding it.
// ═══════════════════════════════════════════════════════════════════════════════

/** The six inequalities of one reading, as (left, right) pairs to compare. */
function inequalityPairs(p: PdPayoffs): [number, number][] {
  return [
    // Your side: the second move dominates, whatever the other player does…
    [p.you_dc, p.you_cc],
    [p.you_dd, p.you_cd],
    // …yet mutual first-move beats mutual second-move.
    [p.you_cc, p.you_dd],
    // The other player's side, the same three statements from their seat.
    [p.other_cd, p.other_cc],
    [p.other_dd, p.other_dc],
    [p.other_cc, p.other_dd],
  ]
}

/** Is this a dilemma when a BIGGER number is the better outcome? */
export function isDilemmaHigherIsBetter(p: PdPayoffs): boolean {
  return inequalityPairs(p).every(([a, b]) => a > b)
}

/** Is this a dilemma when a SMALLER number is the better outcome? */
export function isDilemmaLowerIsBetter(p: PdPayoffs): boolean {
  return inequalityPairs(p).every(([a, b]) => a < b)
}

/**
 * Should the settings page show the advisory warning?
 *
 * TRUE iff the matrix is a dilemma under NEITHER reading. Ties count as failures under
 * both readings (the comparisons are strict), which is correct: a matrix where two cells
 * are equal has no strict dominance to argue from.
 */
export function warnNotADilemma(p: PdPayoffs): boolean {
  return !isDilemmaHigherIsBetter(p) && !isDilemmaLowerIsBetter(p)
}

/** The advisory sentence, exactly as the settings page renders it. Exported so a test
 *  asserts the words rather than the presence of some element. */
export const NOT_A_DILEMMA_WARNING =
  'These payoffs do not form a prisoner’s dilemma under either reading — whether a bigger '
  + 'number or a smaller one is the better outcome. Students can still play this matrix, and '
  + 'you can save it; the lecture’s dominance argument just will not hold for it.'
