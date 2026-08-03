import { Timestamp } from 'firebase-admin/firestore'

// ═══════════════════════════════════════════════════════════════════════════════
// Procurement Auction — the ROUND RECORD: how a resolved round is stored, and how it is
// reshaped for the student. Pure and Firestore-free (bar the Timestamp value type).
//
// ⚠⚠ THE CLIENT SHAPE IS A WHITELIST, NOT A RENAME. `toClientHistory` builds a fresh
// object per round with exactly the fields the student has earned by playing. It NEVER
// spreads the stored record — so the rival costs stored alongside (Part 1 §4: drawn at
// resolution, kept for the reports) cannot ride out to a student by accident. Putting
// one on a student screen would take adding it here, deliberately.
//
// This is the family rule, and it is the one thing in this file that must not be
// relaxed when Checkpoint 2 fills in the resolver. See newsvendor/rounds.ts, whose
// benchmark fields are kept off the screen by exactly this arrangement.
//
// ⚠ THE FIELD SET IS SPLIT IN THREE, AND THE SPLIT IS THE SECURITY BOUNDARY:
//   • StoredRound       — everything, INCLUDING `rival_costs`. Report-only.
//   • ClientRound       — the history row. No rival information at all.
//   • ClientRoundResult — the round-result screen. Rival BIDS, never rival COSTS.
// Both formats resolve to `{ winnerId, price, perBidderOutcomes }` (Part 1 §13.4). The
// open format's price path and drop-out round are still to be added at CP4; add them to
// StoredRound, and add to the client shapes ONLY what the student is meant to see.
//
// ⚠ ROUNDS ARE INDEPENDENT (Part 1 §2): fresh costs each round, no carryover state
// beyond a cumulative profit tally which is a DISPLAY concern. Nothing here reads a
// previous round, and nothing should start.
// ═══════════════════════════════════════════════════════════════════════════════

/** One resolved round, AS STORED on the participant doc (snake_case, Firestore style). */
export interface StoredRound {
  /** 1-based round number. */
  round: number
  /** The student's own drawn per-unit cost — shown to them BEFORE they bid (Part 1 §4). */
  cost: number
  /**
   * The student's bid. `null` only in the open format, where a player may Drop Out
   * (Part 2 §4.5) — the sealed format requires a bid (Part 1 §6.3, v3), so a null here
   * in a sealed instance is malformed data, not a legitimate abstention.
   */
  bid: number | null
  /** Did the student win the contract this round? */
  won: boolean
  /** The winning bid — what the contract was actually awarded at. Null if no award. */
  price: number | null
  /** The student's realized profit. Zero when they lost; never negative under a bid
   *  above their own cost, which is why validation refuses one below it. */
  profit: number
  /**
   * When the round resolved. A CONCRETE Timestamp, deliberately not
   * FieldValue.serverTimestamp(): Firestore rejects sentinel values inside array
   * elements, and rounds are stored as an array.
   */
  played_at: Timestamp
  /**
   * The rivals' drawn costs.
   *
   * ⚠⚠ REPORT-ONLY, AND THE SINGLE MOST DANGEROUS FIELD IN THIS FILE. It is written
   * only at resolution, after the bid is committed (Part 1 §4), and it must never appear
   * in ANY student shape — not in the history row, not in the round result, not in the
   * final screen. `toClientHistory` and `toClientResult` are whitelists precisely so
   * this field cannot ride out on a spread.
   */
  rival_costs: number[]
  /** The rivals' bids, in the same order. `null` = priced out by the reserve, i.e.
   *  ABSENT from the auction rather than bidding high (§3.1). Student-visible AFTER
   *  the round resolves — this is the sealed format's reveal. */
  rival_bids: (number | null)[]
  /** Two or more bids tied at the lowest price. */
  tie: boolean
  /** The player was in that tie and did not win it — the only case the round result
   *  must explain itself for. */
  tied_and_lost: boolean
  /** The §8 counterfactual: β at the player's own cost, and how it would have fared
   *  against these SAME realized rival bids. `eq_bid` is null when the player's cost is
   *  above the reserve and there was no bid worth making. */
  eq_bid: number | null
  eq_won: boolean
  /** Profit under β against these rivals. Summed across rounds this is "a perfect
   *  player would have earned X from your draws" (§9). */
  eq_profit: number
}

/** One resolved round, AS SENT TO THE STUDENT (camelCase, client style). Derived only.
 *
 *  ⚠ NOTE WHAT IS ABSENT: no rival costs, and nothing they could be recovered from.
 *  That absence is Part 1 §4's requirement, in the type system. */
export interface ClientRound {
  round: number
  yourCost: number
  yourBid: number | null
  won: boolean
  price: number | null
  profit: number
  /** Cumulative profit through this round — the history table's running total. */
  profitTotal: number
  /**
   * What β would have bid at THIS student's own cost (§8) — the "your equilibrium bid"
   * column of the §9 results table. Null when their cost was above the reserve.
   *
   * ⚠ THIS IS NOT NEW INFORMATION. It is a function of the student's own cost and the
   * instance's public parameters, and the round-result screen already showed it. It is
   * carried here so the results table and the scatter read one number rather than
   * re-deriving β on the client, where it would drift from the server's.
   */
  yourEquilibriumBid: number | null
}

/**
 * Defensive read of the stored rounds array. Anything malformed is DROPPED rather than
 * thrown on — the same posture as loadProcurementConfig: a half-written doc must never
 * make the game unplayable. Stops at the first bad element so the surviving prefix stays
 * a contiguous round history (round 1..n with no hole), which every consumer assumes.
 */
export function parseStoredRounds(raw: unknown): StoredRound[] {
  if (!Array.isArray(raw)) return []
  const out: StoredRound[] = []
  const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

  for (const el of raw) {
    const r = (typeof el === 'object' && el !== null ? el : {}) as Record<string, unknown>
    const expected = out.length + 1
    if (r.round !== expected) break
    if (!num(r.cost) || !num(r.profit)) break
    if (typeof r.won !== 'boolean') break

    out.push({
      round: expected,
      cost: r.cost,
      // ⚠ Null is MEANINGFUL here (dropped out), so it is preserved rather than
      // coerced to 0 — a 0 bid would read as "bid nothing and won", which is a
      // different and much better outcome than the one that happened.
      bid: num(r.bid) ? r.bid : null,
      won: r.won,
      price: num(r.price) ? r.price : null,
      profit: r.profit,
      played_at: r.played_at instanceof Timestamp ? r.played_at : Timestamp.fromMillis(0),
      // ⚠ THE REVEAL FIELDS DO NOT BREAK CONTIGUITY. A round is identified by its core
      // outcome (round/cost/won/profit); the reveal detail is presentation on top of it.
      // A malformed `rival_bids` costs that round its bid table, not the student's
      // history — which is the same posture the core fields take toward a half-written
      // doc, applied at the right granularity.
      rival_costs: numArray(r.rival_costs),
      rival_bids: nullableNumArray(r.rival_bids),
      tie: r.tie === true,
      tied_and_lost: r.tied_and_lost === true,
      eq_bid: num(r.eq_bid) ? r.eq_bid : null,
      eq_won: r.eq_won === true,
      eq_profit: num(r.eq_profit) ? r.eq_profit : 0,
    })
  }
  return out
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
// ⚠ ALL-OR-NOTHING, never a filter: `rival_costs[i]` pairs with `rival_bids[i]` in the
// reports, so dropping one bad element would silently re-pair every element after it.
const numArray = (raw: unknown): number[] =>
  Array.isArray(raw) && raw.every(isNum) ? (raw as number[]) : []
const nullableNumArray = (raw: unknown): (number | null)[] =>
  Array.isArray(raw) ? raw.map(v => (isNum(v) ? v : null)) : []

/** One bidder's line on the round-result table (§6.4). Sorted ascending by the caller.
 *
 *  ⚠ NOTE WHAT IS ABSENT: `cost`. The bids are revealed; the costs behind them never
 *  are, in this round or any later one. */
export interface ClientBidLine {
  /** "You", or "Rival 1".."Rival k". A display label, not an id — nothing downstream
   *  keys on it. */
  label: string
  /** null = this rival was priced out by the reserve and made no bid (§3.1). */
  amount: number | null
  isYou: boolean
  won: boolean
}

/** The round-result screen (§6.4, §8). Built field by field — see the file header. */
export interface ClientRoundResult {
  round: number
  yourCost: number
  yourBid: number | null
  /** Every bidder, LOWEST FIRST, with the player's line and the winner's line marked.
   *  Bidders who made no bid sort last. */
  bids: ClientBidLine[]
  won: boolean
  price: number | null
  profit: number
  profitTotal: number
  /** No admissible bid at all — nobody won. Reachable only when an instructor sets the
   *  reserve below the cost ranges. */
  noAward: boolean
  /** ⚠ The player's OWN cost was above the reserve, so there was no bid worth making.
   *  The screen says so explicitly; without it the round reads as broken. */
  costAboveReserve: boolean
  tie: boolean
  /** Fires the "two bids tied at the lowest price" line. */
  tiedAndLost: boolean
  /** The §8 counterfactual. */
  equilibriumBid: number | null
  equilibriumWouldHaveWon: boolean
  equilibriumProfit: number
}

/**
 * Reshape ONE stored round for the result screen.
 *
 * ⚠ Built field by field from named locals. It never spreads `r`, so `rival_costs` —
 * which sits right beside `rival_bids` on the same record — cannot reach a student.
 */
export function toClientResult(
  rounds: readonly StoredRound[],
  reserve: number,
): ClientRoundResult {
  const r = rounds[rounds.length - 1]
  const you: ClientBidLine = {
    label: 'You',
    amount: r.bid,
    isYou: true,
    won: r.won,
  }
  const rivals: ClientBidLine[] = r.rival_bids.map((amount, i) => ({
    label: `Rival ${i + 1}`,
    amount,
    isYou: false,
    // ⚠ A rival won iff the player did NOT and this rival's bid IS the winning price.
    // With ties already resolved server-side at most one rival can carry the flag, so
    // the first match takes it — computed below rather than here.
    won: false,
  }))

  const lines = [you, ...rivals]
  // Ascending, with "no bid" last. A stable sort keeps rival order among equal bids.
  lines.sort((a, b) => {
    if (a.amount === null && b.amount === null) return 0
    if (a.amount === null) return 1
    if (b.amount === null) return -1
    return a.amount - b.amount
  })

  // Mark the winning rival: the player already carries `won`, so this only runs when
  // they lost and there was an award.
  if (!r.won && r.price !== null) {
    const w = lines.find(l => !l.isYou && l.amount === r.price)
    if (w) w.won = true
  }

  return {
    round: r.round,
    yourCost: r.cost,
    yourBid: r.bid,
    bids: lines,
    won: r.won,
    price: r.price,
    profit: r.profit,
    profitTotal: totalProfit(rounds),
    noAward: r.price === null,
    costAboveReserve: r.cost > reserve,
    tie: r.tie,
    tiedAndLost: r.tied_and_lost,
    equilibriumBid: r.eq_bid,
    equilibriumWouldHaveWon: r.eq_won,
    equilibriumProfit: r.eq_profit,
  }
}

/** One rival's (cost, bid) pair, for the §9 scatter's bot series. */
export interface ClientRivalPoint {
  round: number
  cost: number
  bid: number
}

/**
 * The rivals' (cost, bid) pairs — THE ONLY PLACE A RIVAL COST EVER LEAVES THE SERVER.
 *
 * ⚠⚠ THE CALLER MUST GATE THIS ON `finished_at`. It is a function, not a field, precisely
 * so that gating is an explicit decision at one call site (getState) rather than a
 * property of a record that gets passed around. Nothing here checks the gate, because a
 * pure reshaper cannot see the stamp — see getState.ts, where the check lives and where
 * the harness asserts it.
 *
 * Why it is safe once the game is over: the rounds are independent (§2) and every one of
 * them is resolved. There is no future draw these points predict, and the scatter is the
 * §9 debrief's whole point — the bots sit exactly on the optimal line, so the plot
 * DOCUMENTS its benchmark instead of asserting it. That only works if the bots' costs are
 * on the x-axis.
 *
 * ⚠ A rival with no bid is OMITTED, not plotted at zero. It was absent from the auction
 * (§3.1); a point at (cost, 0) would be a lie about a bid that was never made.
 */
export function toRevealPoints(rounds: readonly StoredRound[]): ClientRivalPoint[] {
  const out: ClientRivalPoint[] = []
  for (const r of rounds) {
    r.rival_bids.forEach((bid, i) => {
      const cost = r.rival_costs[i]
      // Both must be present: a defensive parse may have emptied `rival_costs` without
      // emptying `rival_bids`, and a point with half its coordinates is not a point.
      if (bid === null || typeof cost !== 'number') return
      out.push({ round: r.round, cost, bid })
    })
  }
  return out
}

/** Cumulative profit the §8 benchmark bid would have earned against the SAME realized
 *  rival bids — "a perfect player would have earned X from your draws" (§9). */
export function totalEquilibriumProfit(rounds: readonly StoredRound[]): number {
  return rounds.reduce((acc, r) => acc + r.eq_profit, 0)
}

/** Cumulative realized profit across the stored rounds — the display tally (Part 1 §2). */
export function totalProfit(rounds: readonly StoredRound[]): number {
  return rounds.reduce((acc, r) => acc + r.profit, 0)
}

/** Rounds won, for the roster column. Report-only. */
export function roundsWon(rounds: readonly StoredRound[]): number {
  return rounds.reduce((acc, r) => acc + (r.won ? 1 : 0), 0)
}

/** The student-facing history: one row per round PLAYED, with the running total.
 *  ⚠ Built field by field. See the file header — this is the whitelist. */
export function toClientHistory(rounds: readonly StoredRound[]): ClientRound[] {
  let profitTotal = 0
  return rounds.map(r => {
    profitTotal += r.profit
    return {
      round: r.round,
      yourCost: r.cost,
      yourBid: r.bid,
      won: r.won,
      price: r.price,
      profit: r.profit,
      profitTotal,
      yourEquilibriumBid: r.eq_bid,
    }
  })
}
