import type { PrepTextQuestion } from '@mygames/game-server'

// ═══════════════════════════════════════════════════════════════════════════════
// Jar of Pennies — the two question definitions, as DATA OBJECTS (standing platform
// constraint), built on the shared PrepTextQuestion model plus two render-only
// extras the shell needs (`helper` copy, numeric `min`). This is the single source
// penniesGetScreen serves to the client; the client renders whatever it returns.
//
// Both are numeric, ungraded, required, ≥ 0 (penniesSubmit enforces server-side).
// category:'preparation' is the accepted least-wrong fit (Part 1 note — the shared
// enum has no game-play value). Wording: Part-2 spec §3.1 / TASK 2 (pending Gary's
// final confirm, spec §11).
// ═══════════════════════════════════════════════════════════════════════════════

export type JarQuestion = PrepTextQuestion & {
  /** Helper line rendered under the input. */
  helper: string
  /** Minimum accepted value (both fields ≥ 0). */
  min: number
}

const base = {
  type: 'number' as const,
  system: false,
  placeholder: '',
  hidden: false,
  deletable: false,
  category: 'preparation' as const,
  format: 'number' as const,
  role_target: 'all',
  min: 0,
}

export const estimateQuestion: JarQuestion = {
  ...base,
  field:  'estimate',
  order:  1,
  prompt: 'What is your estimate of how much money (in USD) is in the jar?',
  helper: 'Enter your estimate in USD. It will not be used in determining the auction outcome.',
}

export const bidQuestion: JarQuestion = {
  ...base,
  field:  'bid',
  order:  2,
  prompt: 'Enter your bid (in USD) for the amount of money in the jar.',
  helper: 'Bid in USD',
}

/** The jar screen's fields, in order — FORWARD (value auction) mode. */
export const penniesQuestions: JarQuestion[] = [estimateQuestion, bidQuestion]

// ── Reverse (supplier / cost auction) variants ─────────────────────────────────
// Same two fields, reframed for a supplier: they estimate the COST and place a bid,
// both in dollars. The "each penny = $X" context and the shorthand-entry rule live in
// the copy the client renders (JarScreen) from the mode + penny_value, not here.

export const estimateQuestionReverse: JarQuestion = {
  ...base,
  field:  'estimate',
  order:  1,
  prompt: 'Estimate Your Cost',
  helper: 'Your best guess of the actual cost, in dollars. This does not affect who wins — it is for your own reasoning.',
}

export const bidQuestionReverse: JarQuestion = {
  ...base,
  field:  'bid',
  order:  2,
  prompt: 'Place Your Bid',
  helper: 'The price you will supply at, in dollars. The lowest bid wins the contract.',
}

/** The jar screen's fields for the given mode. */
export function penniesQuestionsFor(reverse: boolean): JarQuestion[] {
  return reverse ? [estimateQuestionReverse, bidQuestionReverse] : penniesQuestions
}
