import type { Move } from './strategy'

// ═══════════════════════════════════════════════════════════════════════════════
// Repeated Prisoner's Dilemma — payoff lookup (PD spec §2).
//
// NOTATION, used everywhere in this game from here on:
//
//   Y(a,b)  your payoff when YOU play a and the OTHER player plays b
//   O(a,b)  the OTHER player's payoff in that SAME cell
//   a,b ∈ { first move, second move } — the two abstract actions.
//
// ⚠ "Cooperate" and "Defect" are instructor-set WORDING, never identifiers. The
// identifiers are 'C' (first move) and 'D' (second move) and they mean nothing beyond
// "the first one" and "the second one". Nothing in this file names a real-world action.
//
// ⚠ EIGHT VALUES, NOT FOUR. The matrix used to be SYMMETRIC — one number per cell,
// with the other player's payoff DERIVED as Y(b,a) — and an instructor could therefore
// only ever configure a symmetric game. It is now eight independent numbers, so
// asymmetric matrices are expressible:
//
//                  | Other plays C    | Other plays D
//   You play C     | Y(C,C)  O(C,C)   | Y(C,D)  O(C,D)
//   You play D     | Y(D,C)  O(D,C)   | Y(D,D)  O(D,D)
//
// THE SYMMETRIC DERIVE IS GONE from every consumer. It survives in exactly ONE place,
// `parsePayoffs` below, where it is the MIGRATION RULE for an instance still storing
// the legacy four — and nowhere else. See the note there.
//
// The values are CONFIG, not code (spec §2) — every function here takes the config
// object. The constants below are only the defaults a fresh instance gets.
//
// ⚠ DIRECTION-AGNOSTIC. Nothing here knows or states whether a bigger number is better;
// the shipped defaults happen to be prison-years (lower is better), but an instance may
// be run in points or dollars. Anything that needs a direction is the instructor's
// framing, not the software's.
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * The EIGHT payoff values. Named by CELL and by WHOSE payoff it is:
 * `you_ab` is Y(a,b) and `other_ab` is O(a,b), with the suffix read as
 * (your move, the other player's move).
 */
export interface PayoffConfig {
  /** Y(C,C) — you play the first move, they play the first move. Default 1. */
  you_cc: number
  /** Y(C,D). Default 15. */
  you_cd: number
  /** Y(D,C). Default 0. */
  you_dc: number
  /** Y(D,D). Default 10. */
  you_dd: number
  /** O(C,C) — the other player's payoff in the same cell as `you_cc`. Default 1. */
  other_cc: number
  /** O(C,D). Default 0. */
  other_cd: number
  /** O(D,C). Default 15. */
  other_dc: number
  /** O(D,D). Default 10. */
  other_dd: number
}

/**
 * Spec §2's matrix, as shipped, in the eight-value shape. It is the symmetric
 * prisoner's dilemma it always was — O is the transpose of Y — but it is now STORED
 * that way rather than derived, so an instructor can break the symmetry.
 */
export const DEFAULT_PAYOFFS: PayoffConfig = {
  you_cc: 1,  you_cd: 15, you_dc: 0,  you_dd: 10,
  other_cc: 1, other_cd: 0, other_dc: 15, other_dd: 10,
}

/** Every field of the eight-value shape, in the settings page's column order. */
export const PAYOFF_KEYS: readonly (keyof PayoffConfig)[] = [
  'you_cc', 'you_cd', 'you_dc', 'you_dd',
  'other_cc', 'other_cd', 'other_dc', 'other_dd',
] as const

/** The cell suffix for one (your move, their move) pair: 'cc' | 'cd' | 'dc' | 'dd'. */
type CellKey = 'cc' | 'cd' | 'dc' | 'dd'
function cellKey(a: Move, b: Move): CellKey {
  return `${a === 'C' ? 'c' : 'd'}${b === 'C' ? 'c' : 'd'}` as CellKey
}

/** Y(a,b) — YOUR payoff when you play `a` and the other player plays `b`. */
export function yourPayoff(a: Move, b: Move, cfg: PayoffConfig): number {
  return cfg[`you_${cellKey(a, b)}` as keyof PayoffConfig]
}

/**
 * O(a,b) — the OTHER player's payoff in the cell where you played `a` and they
 * played `b`.
 *
 * ⚠ NOT `yourPayoff(b, a, cfg)`. That transpose was the old symmetric derive and it is
 * WRONG on an asymmetric matrix. The two values it confuses are O(C,D) and O(D,C),
 * which are equal under every symmetric matrix — so the bug is invisible on the shipped
 * defaults and on every legacy instance. `pdPayoff.test.ts` pins it.
 */
export function otherPayoff(a: Move, b: Move, cfg: PayoffConfig): number {
  return cfg[`other_${cellKey(a, b)}` as keyof PayoffConfig]
}

/** One round's outcome, from both sides. */
export interface RoundPayoff {
  /** Payoff the STUDENT receives this round. */
  studentYears: number
  /** Payoff the BOT receives this round. */
  botYears: number
}

/**
 * The payoff for one round.
 *
 * @param studentMove the student's move — the `a` of Y(a,b) / O(a,b)
 * @param botMove     the bot's move (from the strategy library) — the `b`
 * @param cfg         the instance's eight payoff values (config/main, normalized)
 *
 * ⚠ BOTH NUMBERS COME FROM THE SAME CELL. The student gets Y(a,b) and the bot gets
 * O(a,b) — the bot is "the other player", so its number is the O of the cell the two
 * moves land in, NOT Y of the transposed cell.
 *
 * Pure: no Firestore, no defaults baked in — pass the loaded config.
 */
export function payoff(studentMove: Move, botMove: Move, cfg: PayoffConfig): RoundPayoff {
  return {
    studentYears: yourPayoff(studentMove, botMove, cfg),
    botYears: otherPayoff(studentMove, botMove, cfg),
  }
}

/**
 * ⚠⚠ THE NORMALIZER — AND THE ONLY PLACE IN THE CODEBASE THAT READS THE LEGACY
 * FOUR-VALUE FIELD. Every other consumer takes a `PayoffConfig` that came out of here.
 *
 * It accepts EITHER stored shape and always returns eight values:
 *
 *   • Eight-value doc (written by any save since this pass): used as given.
 *   • Legacy four-value doc: the four are the Y values, and the O values are the
 *     TRANSPOSE, which is exactly what the old symmetric derive computed —
 *         O(C,C) = Y(C,C)   O(C,D) = Y(D,C)
 *         O(D,C) = Y(C,D)   O(D,D) = Y(D,D)
 *     so a legacy instance plays IDENTICALLY to how it played before this change.
 *     `pdPayoff.test.ts` and `pdMigration.test.ts` both pin that identity.
 *
 * LAZY, NOT BACKFILLED. Nothing rewrites a live instance; an instance keeps its four
 * values until an instructor next saves settings, at which point all eight are written.
 *
 * Defensive in the same way it always was: any missing/invalid value falls back (to its
 * legacy counterpart, then to its default), so a half-written config doc can never make
 * a round unscoreable.
 */
export function parsePayoffs(raw: unknown): PayoffConfig {
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  const num = (v: unknown, fallback: number) =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fallback

  // ── The legacy four, read HERE AND NOWHERE ELSE. These are Y values. ──────────
  const yCC = num(r.both_cooperate, DEFAULT_PAYOFFS.you_cc)
  const yCD = num(r.sucker,         DEFAULT_PAYOFFS.you_cd)
  const yDC = num(r.temptation,     DEFAULT_PAYOFFS.you_dc)
  const yDD = num(r.both_defect,    DEFAULT_PAYOFFS.you_dd)

  return {
    you_cc: num(r.you_cc, yCC),
    you_cd: num(r.you_cd, yCD),
    you_dc: num(r.you_dc, yDC),
    you_dd: num(r.you_dd, yDD),
    // ⚠ THE TRANSPOSE, and note the CROSS: other_cd falls back to Y(D,C) and other_dc
    // to Y(C,D). Writing the obvious-looking `other_cd → yCD` here would transpose the
    // off-diagonal and is the single most likely bug in this whole change.
    other_cc: num(r.other_cc, yCC),
    other_cd: num(r.other_cd, yDC),
    other_dc: num(r.other_dc, yCD),
    other_dd: num(r.other_dd, yDD),
  }
}
