import type { Move } from './strategy'

// ═══════════════════════════════════════════════════════════════════════════════
// Repeated Prisoner's Dilemma — payoff lookup (PD spec §2).
//
// ⚠ PAYOFFS ARE YEARS IN PRISON — LOSSES, NOT GAINS. Lower is better, everywhere:
// the display, the history table, the reports, and the Tier-3 chart all treat a
// smaller cumulative total as the better outcome. There is no "Free" label — the
// defect-while-they-cooperate cell is the number 0.
//
//                  | Other Cooperates | Other Defects
//   You Cooperate  | you  1, other  1 | you 15, other  0
//   You Defect     | you  0, other 15 | you 10, other 10
//
// The four values are CONFIG, not code (spec §2) — every function here takes the
// config object. The constants below are only the defaults a fresh instance gets.
//
// The matrix is SYMMETRIC: what a player suffers depends only on (their own move,
// the other's move), not on which seat they sit in. yearsFor() encodes that once
// and payoff() applies it from both sides, so the two perspectives can never drift
// apart the way two hand-written lookup tables would.
// ═══════════════════════════════════════════════════════════════════════════════

/** The four payoff values, in years of prison. Named by outcome, not by seat. */
export interface PayoffConfig {
  /** Both cooperate. Default 1. */
  both_cooperate: number
  /** You cooperate, they defect — the sucker's payoff, the WORST cell. Default 15. */
  sucker: number
  /** You defect, they cooperate — the temptation, the BEST cell. Default 0. */
  temptation: number
  /** Both defect. Default 10. */
  both_defect: number
}

/** Spec §2's matrix, as shipped. Instances may override all four in config/main. */
export const DEFAULT_PAYOFFS: PayoffConfig = {
  both_cooperate: 1,
  sucker: 15,
  temptation: 0,
  both_defect: 10,
}

/** Years suffered by a player who played `own` against an opponent who played `other`. */
export function yearsFor(own: Move, other: Move, cfg: PayoffConfig): number {
  if (own === 'C') return other === 'C' ? cfg.both_cooperate : cfg.sucker
  return other === 'C' ? cfg.temptation : cfg.both_defect
}

/** One round's outcome, from both sides. */
export interface RoundPayoff {
  /** Years the STUDENT serves this round. */
  studentYears: number
  /** Years the BOT serves this round. */
  botYears: number
}

/**
 * The payoff for one round.
 *
 * @param studentMove the student's move
 * @param botMove     the bot's move (from the strategy library)
 * @param cfg         the instance's four payoff values (config/main)
 *
 * Pure: no Firestore, no defaults baked in — pass the loaded config.
 */
export function payoff(studentMove: Move, botMove: Move, cfg: PayoffConfig): RoundPayoff {
  return {
    studentYears: yearsFor(studentMove, botMove, cfg),
    botYears: yearsFor(botMove, studentMove, cfg),
  }
}

/** Defensive parse of a stored payoff map. Any missing/invalid value falls back to
 *  its default, so a half-written config doc can never make a round unscoreable. */
export function parsePayoffs(raw: unknown): PayoffConfig {
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  const num = (v: unknown, fallback: number) =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fallback
  return {
    both_cooperate: num(r.both_cooperate, DEFAULT_PAYOFFS.both_cooperate),
    sucker:         num(r.sucker,         DEFAULT_PAYOFFS.sucker),
    temptation:     num(r.temptation,     DEFAULT_PAYOFFS.temptation),
    both_defect:    num(r.both_defect,    DEFAULT_PAYOFFS.both_defect),
  }
}
