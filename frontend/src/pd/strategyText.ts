import type { PdMoveLabels } from './api'
import type { PdStrategy } from './strategies'

// ═══════════════════════════════════════════════════════════════════════════════
// STRATEGY DISPLAY NAMES — for the SETTINGS PAGE ONLY.
//
// ⚠⚠ WHY A MIRROR EXISTS AT ALL. `functions/src/pd/strategyText.ts` is the source of
// truth and every OTHER surface takes its strings from the server: the reports and the
// debrief read `strategyText` off `pdGetReport`, and hold no label map. The settings
// page cannot, for the same reason the knowledge-check list could not — two of these
// names interpolate the move wording ("Always <first>", "Always <second>"), and an
// instructor renaming the moves must see the checkbox labels change as they type, not
// after a save round-trip. A callable cannot resolve unsaved form state.
//
// ⚠ DRIFT PIN: `pdStrategyText.test.ts` (server) and `strategyText.test.ts` (client)
// assert the SAME literal strings for the SAME fixture. Change either side and its own
// suite fails. Same arrangement as `derivedKc.ts`.
//
// Nothing here is stored, served to a student, or graded.
// ═══════════════════════════════════════════════════════════════════════════════

/** The name shown on a settings checkbox. Mirrors `strategyDisplayName`. */
export function strategyDisplayName(id: PdStrategy, labels: PdMoveLabels): string {
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
 * A one-line description of what the rule does, for the settings list.
 *
 * ⚠ NOT the debrief reveal — that is second-person, past tense, and comes from the
 * server. This is present tense and instructor-facing. They are deliberately different
 * strings for different audiences, so neither is mirrored into the other's place.
 */
export function strategyRuleSummary(id: PdStrategy, labels: PdMoveLabels): string {
  const first = labels.C
  const second = labels.D
  switch (id) {
    case 'tft': return `Plays ${first} first, then copies the student's previous move.`
    case 'grim': return `Plays ${first} until the student's first ${second}, then ${second} forever.`
    case 'random': return `Plays ${first} or ${second} at random each round, 50/50.`
    case 'always_first': return `Plays ${first} every round.`
    case 'always_second': return `Plays ${second} every round.`
    case 'alternate': return `Starts with ${first} and switches every round. Ignores the student.`
  }
}
