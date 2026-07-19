import type { Screen } from '../shared/sequence'
import { penniesQuestions } from './questions'

// ═══════════════════════════════════════════════════════════════════════════════
// Jar of Pennies — the screen sequence, as DATA (architecture §2.4). This game is a
// SINGLE question screen: `question`. No loop, no display, no compute (spec §2).
// The runner walks this list in order.
// ═══════════════════════════════════════════════════════════════════════════════

export const penniesScreens: Screen[] = [
  {
    kind:      'question',
    id:        'jar',
    title:     'Jar of Pennies',
    questions: penniesQuestions,
  },
]
