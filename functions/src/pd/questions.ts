import type { PrepTextQuestion } from '@mygames/game-server'
import { yearsFor, type PayoffConfig } from './payoff'
import type { Move } from './strategy'

// ═══════════════════════════════════════════════════════════════════════════════
// Repeated PD — the KNOWLEDGE CHECK (spec §7) and the DEBRIEF (spec §8), as DATA
// OBJECTS (standing platform constraint: never an inline array in student-flow
// code). Built on the shared PrepTextQuestion model and the shared `kc_` / `debrief_`
// field-prefix convention, so moving these into an admin-defaults config doc later is
// a read-and-merge, not a rewrite.
//
// FOUR QUESTIONS, ONE ANSWER EACH — "how many years do YOU serve?" for each of the
// four cells. Options are the four payoff values (0/1/10/15 on the shipped matrix).
//
// NO GATE (Elena's call, this game): the family has no roles, and this is a
// play-to-learn exercise. A wrong answer is RECORDED and SCORED, and the student
// proceeds anyway. Nothing here can block entry to the round loop.
//
// ⚠ CORRECTNESS IS DERIVED FROM CONFIG, NOT FROZEN IN THE DATA OBJECT. Each question
// carries the CELL it asks about ({ you, other }); resolveKcQuestions() then computes
// its options and its correct answer from the instance's own payoff matrix. The
// literals below are the shipped defaults and are asserted to agree with the default
// matrix in the unit tests. Why bother: the KC screen renders the matrix FROM CONFIG
// (spec §7 — the point is checking they can read it), so an instructor who edits the
// four values would otherwise be grading students against a matrix that is no longer
// the one on their screen.
// ═══════════════════════════════════════════════════════════════════════════════

/** A PD knowledge-check question: the shared model plus the matrix cell it asks about. */
export type PdKcQuestion = PrepTextQuestion & {
  /** The cell: the student's own move, and the other player's. */
  cell: { you: Move; other: Move }
}

const kcBase = {
  type: 'mc' as const,
  format: 'multiple_choice' as const,
  category: 'knowledge_check' as const,
  grading: 'static' as const,
  system: false,
  placeholder: '',
  hidden: false,
  deletable: false,
  role_target: 'all',
}

/** The shipped option set — the four values of the default matrix (spec §7). */
const DEFAULT_YEAR_OPTIONS = ['0', '1', '10', '15']

const yearLabel = (v: string) => `${v} ${v === '1' ? 'year' : 'years'}`

export const kcQuestions: PdKcQuestion[] = [
  {
    ...kcBase,
    field: 'kc_cc',
    order: 1,
    cell: { you: 'C', other: 'C' },
    prompt: 'You cooperate and the other player also cooperates. How many years do YOU serve?',
    options: DEFAULT_YEAR_OPTIONS.map(v => ({ value: v, label: yearLabel(v) })),
    correct_value: '1',
    explanation: 'When you both cooperate, you each serve 1 year — the shared best outcome.',
  },
  {
    ...kcBase,
    field: 'kc_cd',
    order: 2,
    cell: { you: 'C', other: 'D' },
    prompt: 'You cooperate but the other player defects. How many years do YOU serve?',
    options: DEFAULT_YEAR_OPTIONS.map(v => ({ value: v, label: yearLabel(v) })),
    correct_value: '15',
    explanation: 'Cooperating against a defector is the worst cell for you — 15 years, the sucker’s payoff. They go free.',
  },
  {
    ...kcBase,
    field: 'kc_dc',
    order: 3,
    cell: { you: 'D', other: 'C' },
    prompt: 'You defect and the other player cooperates. How many years do YOU serve?',
    options: DEFAULT_YEAR_OPTIONS.map(v => ({ value: v, label: yearLabel(v) })),
    correct_value: '0',
    explanation: 'Defecting against a cooperator is the best cell for you — 0 years. They serve 15.',
  },
  {
    ...kcBase,
    field: 'kc_dd',
    order: 4,
    cell: { you: 'D', other: 'D' },
    prompt: 'You defect and the other player also defects. How many years do YOU serve?',
    options: DEFAULT_YEAR_OPTIONS.map(v => ({ value: v, label: yearLabel(v) })),
    correct_value: '10',
    explanation: 'When you both defect, you each serve 10 years — worse for both of you than if you had both cooperated.',
  },
]

/** The debrief (spec §8): ONE open-ended paragraph, UNGRADED. Feeds the Tier-2 report. */
export const debriefQuestion: PrepTextQuestion = {
  field: 'debrief_reflection',
  order: 1,
  type: 'text',
  format: 'text',
  category: 'debrief',
  system: false,
  placeholder: 'A short paragraph is plenty.',
  hidden: false,
  deletable: false,
  role_target: 'all',
  prompt: 'In a short paragraph, explain what you did during the game and why.',
  // No `grading` and no `correct_value` — ungraded by construction, so it can never
  // reach calcKCScore's denominator (which counts grading:'static' questions only).
}

/**
 * The KC questions resolved against ONE instance's payoff matrix: each question's
 * options become that matrix's distinct values (ascending) and its correct answer
 * becomes the years the student actually serves in that cell.
 *
 * Pure — no Firestore. Both the serve path and the grade path call this, so the
 * options a student sees and the answer they are graded against cannot disagree.
 */
export function resolveKcQuestions(payoffs: PayoffConfig): PdKcQuestion[] {
  const distinct = [...new Set([
    payoffs.both_cooperate, payoffs.sucker, payoffs.temptation, payoffs.both_defect,
  ])].sort((a, b) => a - b)
  const options = distinct.map(v => ({ value: String(v), label: yearLabel(String(v)) }))

  return kcQuestions.map(q => ({
    ...q,
    options,
    correct_value: String(yearsFor(q.cell.you, q.cell.other, payoffs)),
  }))
}

/** The KC as sent to the STUDENT — the answer key removed.
 *  `correct_value` and `explanation` are stripped: the explanation is earned by
 *  answering (the submit callable returns it), and the key is never client-side. */
export function toClientKcQuestions(resolved: PdKcQuestion[]) {
  return resolved.map(q => ({
    field: q.field,
    prompt: q.prompt,
    options: (q.options ?? []).map(o => ({ value: o.value, label: o.label })),
  }))
}
