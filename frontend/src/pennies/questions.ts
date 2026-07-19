import type { PrepTextQuestion } from '@mygames/game-ui'

// ═══════════════════════════════════════════════════════════════════════════════
// Jar of Pennies — the two question definitions, as DATA OBJECTS (standing platform
// constraint: never hardcoded inline arrays in a component). Built on the shared
// PrepTextQuestion model (type reuse only — no change to @mygames/game-ui).
//
// Both are numeric, ungraded, required, ≥ 0 (server enforces in Part 2's penniesSubmit;
// spec §3.1 / §5.1). Prompt wording is from spec §3.1 (pending Gary's final confirm —
// spec §11).
//
// NOTE (flagged in the Part-1 report): PrepTextQuestion.category is constrained to
// 'knowledge_check' | 'preparation' | 'debrief' — none of which names a single-player
// GAME-PLAY question. 'preparation' is the least-wrong fit; the mismatch is a type-fit
// question for Elena, not something to work around silently.
// ═══════════════════════════════════════════════════════════════════════════════

export const estimateQuestion: PrepTextQuestion = {
  field:       'estimate',
  type:        'number',
  system:      false,
  prompt:      'What is your estimate of how much money (in USD) is in the jar?',
  placeholder: '',
  order:       1,
  hidden:      false,
  deletable:   false,
  category:    'preparation',
  format:      'number',
  role_target: 'all',
}

export const bidQuestion: PrepTextQuestion = {
  field:       'bid',
  type:        'number',
  system:      false,
  prompt:      'Enter your bid (in USD) for the amount of money in the jar.',
  placeholder: '',
  order:       2,
  hidden:      false,
  deletable:   false,
  category:    'preparation',
  format:      'number',
  role_target: 'all',
}

export const penniesQuestions: PrepTextQuestion[] = [estimateQuestion, bidQuestion]
