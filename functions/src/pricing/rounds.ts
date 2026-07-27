import { Timestamp } from 'firebase-admin/firestore'

// ═══════════════════════════════════════════════════════════════════════════════
// Pricing Game — the ROUND RECORD: how a played round is stored, and how it is
// (re)shaped for the student.
//
// Pure and Firestore-free (bar the Timestamp value type), so the round-loop logic is
// unit-testable without an emulator — same split as market.ts / strategy.ts.
//
// ⚠ THE CLIENT SHAPE IS A WHITELIST, NOT A RENAME. toClientHistory() constructs a
// fresh object per round with exactly the fields a student has already earned by
// playing. It never spreads the stored record, so a field added to storage later (a
// rule stamp, a phase marker, anything) CANNOT reach a student by accident — it
// would have to be added here, deliberately. Spec §4/§5: the drawn round count and
// the competitor's rule never leave the server.
// ═══════════════════════════════════════════════════════════════════════════════

/** One played round, AS STORED on the participant doc (snake_case, Firestore style). */
export interface StoredRound {
  /** 1-based round number. */
  round: number
  /** The two POSTED prices. */
  student_price: number
  competitor_price: number
  /**
   * Under PMG, the single price every customer actually paid = min of the two
   * posted (spec §6.4). Under Standard, null — there is no one price.
   * NULL, never undefined: Firestore rejects undefined outright, and rounds are
   * stored as an array element.
   */
  effective_price: number | null
  student_share: number
  competitor_share: number
  /** Containers won this round. */
  student_demand: number
  competitor_demand: number
  /** Dollars. MAY BE NEGATIVE (pricing below unit cost). */
  student_profit: number
  competitor_profit: number
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
  yourPrice: number
  competitorPrice: number
  /** PMG only; null under Standard (spec §6.4). */
  effectivePrice: number | null
  yourShare: number
  competitorShare: number
  yourDemand: number
  competitorDemand: number
  yourProfit: number
  competitorProfit: number
  /** Your cumulative profit through this round — the history table's running total. */
  yourTotal: number
  /** Your average profit per round through this round (spec §4). */
  yourAverage: number
}

/**
 * Defensive read of the stored rounds array. Anything malformed is DROPPED rather
 * than thrown on — same posture as parseMarket/loadPricingConfig: a half-written doc
 * must never make the game unplayable. Stops at the first bad element so the
 * surviving prefix stays a contiguous round history (round 1..n with no hole), which
 * is what every consumer assumes.
 */
export function parseStoredRounds(raw: unknown): StoredRound[] {
  if (!Array.isArray(raw)) return []
  const out: StoredRound[] = []
  const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

  for (const el of raw) {
    const r = (typeof el === 'object' && el !== null ? el : {}) as Record<string, unknown>
    const expected = out.length + 1
    if (r.round !== expected) break
    if (!num(r.student_price) || !num(r.competitor_price)) break
    if (!num(r.student_share) || !num(r.competitor_share)) break
    if (!num(r.student_demand) || !num(r.competitor_demand)) break
    if (!num(r.student_profit) || !num(r.competitor_profit)) break
    // effective_price is legitimately null in Standard mode, so only a WRONG type
    // is disqualifying. Absent reads as null (a doc written before the field
    // existed), never as a price.
    if (r.effective_price != null && !num(r.effective_price)) break

    out.push({
      round: expected,
      student_price: r.student_price,
      competitor_price: r.competitor_price,
      effective_price: num(r.effective_price) ? r.effective_price : null,
      student_share: r.student_share,
      competitor_share: r.competitor_share,
      student_demand: r.student_demand,
      competitor_demand: r.competitor_demand,
      student_profit: r.student_profit,
      competitor_profit: r.competitor_profit,
      played_at: r.played_at instanceof Timestamp ? r.played_at : Timestamp.fromMillis(0),
    })
  }
  return out
}

/** The student's OWN posted prices, in round order — the only input any competitor
 *  rule takes (strategy.ts). */
export function studentPrices(rounds: readonly StoredRound[]): number[] {
  return rounds.map(r => r.student_price)
}

/** Cumulative profit after every stored round: both sides. */
export function totals(rounds: readonly StoredRound[]): { student: number; competitor: number } {
  return rounds.reduce(
    (acc, r) => ({ student: acc.student + r.student_profit, competitor: acc.competitor + r.competitor_profit }),
    { student: 0, competitor: 0 },
  )
}

/** The student-facing history: one row per round PLAYED, with running total and
 *  average. Never carries rounds REMAINING — there is no such field to carry
 *  (spec §4: the table shows rounds played, never rounds remaining). */
export function toClientHistory(rounds: readonly StoredRound[]): ClientRound[] {
  let yourTotal = 0
  return rounds.map(r => {
    yourTotal += r.student_profit
    return {
      round: r.round,
      yourPrice: r.student_price,
      competitorPrice: r.competitor_price,
      effectivePrice: r.effective_price,
      yourShare: r.student_share,
      competitorShare: r.competitor_share,
      yourDemand: r.student_demand,
      competitorDemand: r.competitor_demand,
      yourProfit: r.student_profit,
      competitorProfit: r.competitor_profit,
      yourTotal,
      yourAverage: yourTotal / r.round,
    }
  })
}
