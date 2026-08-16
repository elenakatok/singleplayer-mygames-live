import type { Strategy } from './strategy'
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
export function strategyRevealLine(id: Strategy, labels: PdMoveLabels): string {
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
    case 'random':
      return `This opponent chose ${first} or ${second} at random each round, with equal `
        + 'probability. Nothing you did changed what it played.'
    case 'always_first':
      return `This opponent chose ${first} every round, whatever you did.`
    case 'always_second':
      return `This opponent chose ${second} every round, whatever you did.`
    case 'alternate':
      return `This opponent switched between ${first} and ${second} every round, starting `
        + `with ${first}. It never reacted to your choices.`
  }
}
