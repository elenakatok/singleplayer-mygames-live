import { DEFAULT_RANDOM_FIRST_MOVE_PROBABILITY, type Strategy } from './strategy'
import type { PdMoveLabels } from './config'

// ═══════════════════════════════════════════════════════════════════════════════
// HOW A STRATEGY IS NAMED AND DESCRIBED TO A HUMAN (spec §5).
//
// ⚠⚠ EVERY MOVE NAME INTERPOLATES THE INSTANCE WORDING. "Cooperate" and "Defect" are
// instructor-set config, so a strategy called "Always Defect" would be a lie on an
// instance whose second move is called "Boxing". Nothing in this file may hardcode
// either shipped default; `pdStrategyText.test.ts` asserts their absence on a fixture
// renamed to two words that appear nowhere else in the repo.
//
// ⚠ MIRRORED CLIENT-SIDE for the settings page, which must relabel the checkboxes as
// the instructor types rather than after a save round-trip — the same refresh-boundary
// defect that was fixed for the knowledge check. `frontend/src/pd/strategyText.ts` is
// the mirror and the two suites pin the SAME literal strings for the SAME fixture.
// The reports and the debrief take these strings from the SERVER; only the settings
// page uses the mirror.
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * A probability as a percentage for STUDENT-FACING prose: "33%", "12.5%", "50%".
 *
 * Trailing zeros trimmed, so 0.5 reads "50%" rather than "50.0%". One decimal place is
 * as far as it goes — this is a sentence in a debrief, not a specification.
 */
function pct(p: number): string {
  return `${Number((p * 100).toFixed(1))}%`
}

/** The name shown wherever a strategy is listed: settings, reports, debrief. */
export function strategyDisplayName(id: Strategy, labels: PdMoveLabels): string {
  switch (id) {
    case 'tft': return 'Tit-for-tat'
    case 'grim': return 'Grim'
    case 'random': return 'Random'
    case 'alternate': return 'Alternating'
    case 'always_first': return `Always ${labels.C}`
    case 'always_second': return `Always ${labels.D}`
  }
}

/**
 * The sentence the debrief uses to reveal what a student was actually up against.
 *
 * In the existing voice: second person, past tense, one or two sentences, and honest
 * about whether the opponent reacted to the student at all — which is the single most
 * useful thing a student can learn from the reveal.
 */
export function strategyRevealLine(
  id: Strategy,
  labels: PdMoveLabels,
  /** P(first move) for `random`. Absent ⇒ the shipped default, so every existing
   *  caller keeps the sentence it had. */
  randomFirstMoveProbability: number = DEFAULT_RANDOM_FIRST_MOVE_PROBABILITY,
): string {
  const first = labels.C
  const second = labels.D
  switch (id) {
    case 'tft':
      return `This opponent chose ${first} in the first round, and after that simply `
        + `repeated whatever you had chosen in the round before.`
    case 'grim':
      return `This opponent chose ${first} until the first time you chose ${second}, `
        + `and chose ${second} in every round after that. Going back to ${first} never `
        + 'brought it back.'
    case 'random': {
      // ⚠⚠ "WITH EQUAL PROBABILITY" WAS A FALSE STATEMENT THE MOMENT p BECAME
      // CONFIGURABLE. This is a debrief line shown to a STUDENT about the game they
      // just played; it has to say what actually happened. It interpolates the real
      // number, in the instance's own wording.
      //
      // ⚠ PLAIN, NOT PEDAGOGICAL. The student is being told what they faced, not taught
      // a formula — so percentages, not decimals, and no mention of mixing or
      // equilibrium. The equilibrium hint is an INSTRUCTOR surface and lives nowhere
      // near this sentence.
      const p = randomFirstMoveProbability
      if (p === 0.5) {
        return `This opponent chose ${first} or ${second} at random each round, with equal `
          + 'probability. Nothing you did changed what it played.'
      }
      if (p === 0) {
        return `This opponent chose at random each round, but with no chance of ${first} — `
          + `so it played ${second} every time. Nothing you did changed what it played.`
      }
      if (p === 1) {
        return `This opponent chose at random each round, but with no chance of ${second} — `
          + `so it played ${first} every time. Nothing you did changed what it played.`
      }
      return `This opponent chose at random each round: ${pct(p)} of the time it played `
        + `${first}, and ${pct(1 - p)} of the time it played ${second}. Nothing you did `
        + 'changed what it played.'
    }
    case 'always_first':
      return `This opponent chose ${first} every round, whatever you did.`
    case 'always_second':
      return `This opponent chose ${second} every round, whatever you did.`
    case 'alternate':
      return `This opponent switched between ${first} and ${second} every round, starting `
        + `with ${first}. It never reacted to your choices.`
  }
}
