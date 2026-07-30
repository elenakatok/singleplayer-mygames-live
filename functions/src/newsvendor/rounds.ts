import { Timestamp } from 'firebase-admin/firestore'

// ═══════════════════════════════════════════════════════════════════════════════
// Newsvendor — the PERIOD RECORD: how a played period is stored, and how it is
// reshaped for the student. Pure and Firestore-free (bar the Timestamp value type).
//
// ⚠⚠ THE CLIENT SHAPE IS A WHITELIST, AND IT IS WHAT KEEPS THE BENCHMARK OFF THE
// SCREEN. Every period stores `q_opt` and `profit_opt` (spec §6) so the instructor's
// reports can show the optimality gap — and spec §9.2 says the student never sees
// either, during play or on the final screen. toClientHistory() builds a fresh object
// per period with exactly the fields a student has earned, and NEVER spreads the
// stored record, so the benchmark cannot ride along by accident: putting it on a
// student screen would take adding it here, deliberately.
// ═══════════════════════════════════════════════════════════════════════════════

/** One played period, AS STORED on the participant doc (snake_case, Firestore style). */
export interface StoredRound {
  /** 1-based period number. */
  round: number
  /** The student's order quantity. */
  q: number
  /** The realized demand drawn for this student, this period (spec §3). */
  d: number
  /** min(Q, D). */
  sales: number
  /** max(Q − D, 0) — salvaged at the net (v − h). */
  leftover: number
  /** max(D − Q, 0) — each unit costs goodwill g. */
  units_short: number
  /** Realized profit. MAY BE NEGATIVE. */
  profit: number
  /** Demand proportion met, capped at 1; 1 when D = 0 (spec §6). */
  service_level: number
  /**
   * ⚠ REPORTS ONLY (spec §9.2) — the benchmark order and the profit it would have
   * earned against THIS SAME demand draw. Stored so the optimality gap is auditable
   * period by period; never returned to a student.
   */
  q_opt: number
  profit_opt: number
  /**
   * When the period was played. A CONCRETE Timestamp, deliberately not
   * FieldValue.serverTimestamp(): Firestore rejects sentinel values inside array
   * elements, and periods are stored as an array.
   */
  played_at: Timestamp
}

/**
 * One played period, AS SENT TO THE STUDENT (camelCase, client style).
 *
 * ⚠ NOTE WHAT IS ABSENT: no `qOpt`, no `profitOpt`, no gap, and nothing they could be
 * recovered from. That absence is the spec §9.2 requirement, in the type system.
 */
export interface ClientRound {
  round: number
  yourOrder: number
  demand: number
  sales: number
  unitsOver: number
  unitsShort: number
  profit: number
  /** Demand proportion met, 0–1. Rendered only when showServiceLevel (spec §7c). */
  serviceLevel: number
  /** Cumulative profit through this period — the history table's running total. */
  yourTotal: number
  /** Average profit per period through this period. */
  yourAverage: number
}

/**
 * Defensive read of the stored periods array. Anything malformed is DROPPED rather
 * than thrown on — the same posture as loadNewsvendorConfig. Stops at the first bad
 * element so the surviving prefix stays a contiguous history (period 1..n with no
 * hole), which is what every consumer assumes.
 */
export function parseStoredRounds(raw: unknown): StoredRound[] {
  if (!Array.isArray(raw)) return []
  const out: StoredRound[] = []
  const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

  for (const el of raw) {
    const r = (typeof el === 'object' && el !== null ? el : {}) as Record<string, unknown>
    const expected = out.length + 1
    if (r.round !== expected) break
    if (!num(r.q) || !num(r.d)) break
    if (!num(r.sales) || !num(r.leftover) || !num(r.units_short)) break
    if (!num(r.profit) || !num(r.service_level)) break
    // The benchmark fields are required too: a period without them cannot be reported
    // on, and silently reading them as 0 would put a fabricated gap in Elena's table.
    if (!num(r.q_opt) || !num(r.profit_opt)) break

    out.push({
      round: expected,
      q: r.q,
      d: r.d,
      sales: r.sales,
      leftover: r.leftover,
      units_short: r.units_short,
      profit: r.profit,
      service_level: r.service_level,
      q_opt: r.q_opt,
      profit_opt: r.profit_opt,
      played_at: r.played_at instanceof Timestamp ? r.played_at : Timestamp.fromMillis(0),
    })
  }
  return out
}

/** Cumulative realized profit, and the benchmark's cumulative profit beside it.
 *  `benchmark` is REPORT-ONLY — no student response carries it. */
export function totals(rounds: readonly StoredRound[]): { student: number; benchmark: number } {
  return rounds.reduce(
    (acc, r) => ({ student: acc.student + r.profit, benchmark: acc.benchmark + r.profit_opt }),
    { student: 0, benchmark: 0 },
  )
}

/** Mean order quantity over periods played, or null when none have been. */
export function averageOrder(rounds: readonly StoredRound[]): number | null {
  if (rounds.length === 0) return null
  return rounds.reduce((a, r) => a + r.q, 0) / rounds.length
}

/** Mean demand proportion met over periods played, or null when none have been. */
export function averageServiceLevel(rounds: readonly StoredRound[]): number | null {
  if (rounds.length === 0) return null
  return rounds.reduce((a, r) => a + r.service_level, 0) / rounds.length
}

/**
 * The student-facing history: one row per period PLAYED, with running total and
 * average (spec §7c).
 *
 * ⚠ Built field by field. See the file header — this is where the benchmark is kept
 * off the student's screen.
 */
export function toClientHistory(rounds: readonly StoredRound[]): ClientRound[] {
  let yourTotal = 0
  return rounds.map(r => {
    yourTotal += r.profit
    return {
      round: r.round,
      yourOrder: r.q,
      demand: r.d,
      sales: r.sales,
      unitsOver: r.leftover,
      unitsShort: r.units_short,
      profit: r.profit,
      serviceLevel: r.service_level,
      yourTotal,
      yourAverage: yourTotal / r.round,
    }
  })
}
