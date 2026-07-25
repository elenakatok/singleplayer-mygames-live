// ═══════════════════════════════════════════════════════════════════════════════
// Repeated Prisoner's Dilemma — the bot strategy library (PD spec §5).
//
// Every strategy is a PURE, DETERMINISTIC function of the student's OWN prior
// moves. No Firestore, no randomness, no clock, no other student's data. This is
// what keeps history carryover legal inside the single-player family: the bot
// reads exactly one student's history and nothing else (architecture §2.3).
//
// The compute step calls botMove() AFTER the student's round-t move is accepted
// and committed, passing history through t−1 — so the bot's move for round t can
// never depend on the student's round-t choice, and can never be reachable by the
// student before they commit (spec §1, architecture §5.3).
// ═══════════════════════════════════════════════════════════════════════════════

/** A move. C = Cooperate (stay silent), D = Defect (confess). */
export type Move = 'C' | 'D'

/** The v1 strategy library. Assigned between-students, ~50/50 (spec §5). */
export type Strategy = 'tft' | 'grim'

/** Every strategy id, in a stable order. The assignment draw indexes into this. */
export const STRATEGIES: readonly Strategy[] = ['tft', 'grim'] as const

/** Type guard for a stored/config-supplied strategy id. */
export function isStrategy(v: unknown): v is Strategy {
  return v === 'tft' || v === 'grim'
}

/**
 * The bot's move for the round whose history is `studentHistory`.
 *
 * @param strategy       which bot this student faces (fixed for all their rounds)
 * @param studentHistory the student's OWN prior moves, in round order, through
 *                       round t−1. Empty ⇒ this is round 1.
 * @returns the bot's move for round t
 *
 * Pure: same inputs ⇒ same output, always. Never mutates `studentHistory`.
 */
export function botMove(strategy: Strategy, studentHistory: readonly Move[]): Move {
  switch (strategy) {
    // TIT-FOR-TAT — cooperate first, then mirror the student's most recent move.
    // Teaches: reciprocity rewards cooperation, and punishment is proportionate
    // and forgiving (one cooperative move buys the bot back).
    case 'tft':
      if (studentHistory.length === 0) return 'C'
      return studentHistory[studentHistory.length - 1]

    // GRIM (classic / unforgiving) — cooperate until the student's FIRST defection,
    // then defect forever. Teaches: betrayal can be permanent. Deliberately NOT
    // forgiving: returning to cooperation never brings the bot back (spec §5, §11).
    case 'grim':
      return studentHistory.includes('D') ? 'D' : 'C'
  }
}
