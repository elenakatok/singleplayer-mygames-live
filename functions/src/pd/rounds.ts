import { Timestamp } from 'firebase-admin/firestore'
import type { Move } from './strategy'

// ═══════════════════════════════════════════════════════════════════════════════
// Repeated Prisoner's Dilemma — the ROUND RECORD: how a played round is stored, and
// how it is (re)shaped for the student.
//
// Pure and Firestore-free (bar the Timestamp value type), so the round-loop logic is
// unit-testable without an emulator — same split as payoff.ts / strategy.ts.
//
// ⚠ THE CLIENT SHAPE IS A WHITELIST, NOT A RENAME. toClientHistory() constructs a
// fresh object per round with exactly the six derived fields a student has already
// earned by playing. It never spreads the stored record, so a field added to storage
// later (a strategy stamp, a phase marker, anything) CANNOT reach a student by
// accident — it would have to be added here, deliberately. Spec §3/§5: the round
// count and the assigned strategy never leave the server.
// ═══════════════════════════════════════════════════════════════════════════════

/** One played round, AS STORED on the participant doc (snake_case, Firestore style). */
export interface StoredRound {
  /** 1-based round number. */
  round: number
  student_move: Move
  bot_move: Move
  /** Years the student serves for this round. */
  student_years: number
  /** Years the bot serves for this round. */
  bot_years: number
  /**
   * When the round was played. A CONCRETE Timestamp, deliberately not
   * FieldValue.serverTimestamp(): Firestore rejects sentinel values inside array
   * elements, and rounds are stored as an array. The rounds are self-paced and this
   * stamp is descriptive only — nothing orders or scores by it.
   */
  played_at: Timestamp
}

/** One played round, AS SENT TO THE STUDENT (camelCase, client style). Derived only. */
export interface ClientRound {
  round: number
  studentMove: Move
  botMove: Move
  studentYears: number
  botYears: number
  /** Cumulative years through this round — the history table's running totals. */
  studentTotal: number
  botTotal: number
}

/** Type guard for a submitted / stored move. */
export function isMove(v: unknown): v is Move {
  return v === 'C' || v === 'D'
}

/**
 * Defensive read of the stored rounds array. Anything malformed is DROPPED rather
 * than thrown on — same posture as parsePayoffs/loadPdConfig: a half-written doc must
 * never make the game unplayable. Stops at the first bad element so the surviving
 * prefix stays a contiguous round history (round 1..n with no hole), which is what
 * every consumer assumes.
 */
export function parseStoredRounds(raw: unknown): StoredRound[] {
  if (!Array.isArray(raw)) return []
  const out: StoredRound[] = []
  for (const el of raw) {
    const r = (typeof el === 'object' && el !== null ? el : {}) as Record<string, unknown>
    const expected = out.length + 1
    if (r.round !== expected) break
    if (!isMove(r.student_move) || !isMove(r.bot_move)) break
    if (typeof r.student_years !== 'number' || !Number.isFinite(r.student_years)) break
    if (typeof r.bot_years !== 'number' || !Number.isFinite(r.bot_years)) break
    out.push({
      round: expected,
      student_move: r.student_move,
      bot_move: r.bot_move,
      student_years: r.student_years,
      bot_years: r.bot_years,
      played_at: r.played_at instanceof Timestamp ? r.played_at : Timestamp.fromMillis(0),
    })
  }
  return out
}

/** The student's OWN moves, in round order. */
export function studentMoves(rounds: readonly StoredRound[]): Move[] {
  return rounds.map(r => r.student_move)
}

/**
 * The BOT's own moves, in round order, READ STRAIGHT OFF THE STORED RECORDS.
 *
 * ⚠⚠ THIS IS THE WHOLE POINT — the bot's past moves are DATA, not something to
 * recompute. `random` draws its move once and it is written here; replaying the
 * strategy to reconstruct this list would silently rewrite an unseeded random game's
 * history. There is exactly one source, and it is the `bot_move` field of the round
 * that was played.
 */
export function botMoves(rounds: readonly StoredRound[]): Move[] {
  return rounds.map(r => r.bot_move)
}

/** Cumulative years after every stored round: [student, bot]. */
export function totals(rounds: readonly StoredRound[]): { student: number; bot: number } {
  return rounds.reduce(
    (acc, r) => ({ student: acc.student + r.student_years, bot: acc.bot + r.bot_years }),
    { student: 0, bot: 0 },
  )
}

/** The student-facing history: one row per round PLAYED, with running totals.
 *  Never carries rounds REMAINING — there is no such field to carry (spec §4). */
export function toClientHistory(rounds: readonly StoredRound[]): ClientRound[] {
  let studentTotal = 0
  let botTotal = 0
  return rounds.map(r => {
    studentTotal += r.student_years
    botTotal += r.bot_years
    return {
      round: r.round,
      studentMove: r.student_move,
      botMove: r.bot_move,
      studentYears: r.student_years,
      botYears: r.bot_years,
      studentTotal,
      botTotal,
    }
  })
}
