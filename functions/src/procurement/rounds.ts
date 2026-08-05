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
  /**
   * WHO won — `player`, `rival1`..`rivalN`, or null for no award.
   *
   * ⚠ RECORDED, NOT DERIVED. "the bidder whose bid equals `price`" identifies the winner
   * only when there was no tie; in a rival-vs-rival tie two bidders share that price and
   * one of them lost. The Tier-3 class chart colours points by won/lost, so deriving it
   * would mislabel a point on the chart Elena presents. Same lesson as the player's cost
   * (BUILD_NOTES 6e): record the fact.
   *
   * ⚠ ABSENT on rounds stored before 2026-08-03. Consumers fall back to the bid===price
   * heuristic for those and must accept its tie ambiguity — see `toReportRivalPoints`.
   */
  winner_id: string | null
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
  /**
   * OPEN FORMAT ONLY — the player's EXIT PRICE, and whether it is censored (§7).
   *
   * ⚠⚠ RECORDED AT ROUND END, NEVER RECONSTRUCTED (§7). `exit_censored` is stored rather
   * than inferred downstream even though it equals `won` today, and that is deliberate:
   * the two are different FACTS that happen to coincide under the current mechanism.
   * "Did they win" is an outcome; "is this stopping point observed or only bounded" is a
   * statement about what the datum means. A chart that inferred one from the other would
   * silently start lying the first time a round could end some other way — and the whole
   * point of §7's distinction is that a winner's exit is NOT a revealed stopping point.
   *
   * ⚠ `exit_price` is null only when a round somehow recorded no standing price at all.
   * A player who never bid still HAS an exit price: the standing they walked away from.
   */
  exit_price?: number | null
  exit_censored?: boolean
  /**
   * OPEN FORMAT ONLY — every bid and drop-out of the round, in order.
   *
   * ⚠ ABSENT ON EVERY SEALED ROUND, and that is the shape rather than a gap: a sealed
   * round has one simultaneous bid per bidder and nothing to replay. Open §4.6 lists
   * "the round is replayable from its record" as a property that falls out of
   * commit-per-step, and §5.2 needs it.
   *
   * ⚠⚠ IT IS PARSED AND CARRIED THROUGH `parseStoredRounds` EVEN THOUGH NOTHING READS IT
   * YET. `rounds` is rewritten as a WHOLE ARRAY on every submit (see submitBid.ts), so a
   * field the parser dropped would be silently deleted from every earlier round the next
   * time the student played one. Round-tripping it is not optimism about CP4b; it is what
   * stops this build destroying its own data.
   *
   * ⚠ NO EXIT PRICE HERE. Exit-price capture is §9 step 6 (CP4b) and is deliberately not
   * built — see BUILD_NOTES. The history below is what CP4b will derive it from for any
   * round played before then.
   */
  open_history?: OpenEventRecord[]
}

/** One event of an open round, as stored. snake_case to match the rest of the record. */
export interface OpenEventRecord {
  kind: 'bid' | 'dropOut'
  bidder_id: string
  /** Absent on a drop-out. */
  amount?: number
  is_player: boolean
}

/** Defensive read of an open round's history. ⚠ ALL-OR-NOTHING: a partially-parsed
 *  history would be a replay that silently skipped a bid, which is worse than none. */
export function parseOpenHistory(raw: unknown): OpenEventRecord[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out: OpenEventRecord[] = []
  for (const el of raw) {
    if (typeof el !== 'object' || el === null) return undefined
    const e = el as Record<string, unknown>
    if (e.kind !== 'bid' && e.kind !== 'dropOut') return undefined
    if (typeof e.bidder_id !== 'string') return undefined
    const isPlayer = e.is_player === true
    if (e.kind === 'dropOut') {
      out.push({ kind: 'dropOut', bidder_id: e.bidder_id, is_player: isPlayer })
      continue
    }
    if (typeof e.amount !== 'number' || !Number.isFinite(e.amount)) return undefined
    out.push({ kind: 'bid', bidder_id: e.bidder_id, amount: e.amount, is_player: isPlayer })
  }
  return out
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
  /**
   * OPEN FORMAT ONLY — where this student stopped, and whether that is observed or only
   * bounded (§7). Null on every sealed round: a sealed bid is not a stopping point.
   *
   * ⚠ THE STUDENT'S OWN NUMBER, so it is safe on their own screen — and it is the y-axis
   * of both the student's §5.3 chart and the instructor's Tier-3 class chart.
   */
  exitPrice: number | null
  /** ⚠ TRUE IFF THEY WON. Carried from the record, NOT re-derived from `won` — see the
   *  stored field's note. A winner sits above the 45° line even playing perfectly. */
  exitCensored: boolean
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
      winner_id: typeof r.winner_id === 'string' ? r.winner_id : null,
      tie: r.tie === true,
      tied_and_lost: r.tied_and_lost === true,
      eq_bid: num(r.eq_bid) ? r.eq_bid : null,
      eq_won: r.eq_won === true,
      eq_profit: num(r.eq_profit) ? r.eq_profit : 0,
      // ⚠ Round-tripped like `open_history`, and for the same reason: `rounds` is
      // rewritten as a WHOLE ARRAY on every submit, so a field the parser dropped would
      // be deleted from every earlier round the next time the student played one.
      ...(num(r.exit_price) ? { exit_price: r.exit_price } : {}),
      ...(typeof r.exit_censored === 'boolean' ? { exit_censored: r.exit_censored } : {}),
      // ⚠ Round-tripped, never dropped — see the field's note. `undefined` on a sealed
      // round, and Firestore is told to ignore undefined properties (index.ts), so an
      // absent history stays absent rather than becoming a null.
      ...(parseOpenHistory(r.open_history) !== undefined
        ? { open_history: parseOpenHistory(r.open_history) }
        : {}),
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

/**
 * THE OPEN ROUND — the round the student is on, and the cost drawn for it.
 *
 * ⚠⚠ THE PLAYER'S COST IS RECORDED, NOT RECOMPUTED (spec §4: "drawn and written when the
 * round opens"). This is the fix for the 08-03 production blocker and it is the whole
 * point of this type, so it is worth stating why rather than leaving it to look like
 * caching.
 *
 * CP3a derived the cost instead — a pure function of (seed, participantId, round) — and
 * noted it as "(derived, never stored)". That is exact ONLY when a seed is set.
 * `makeRng(null, key)` returns `Math.random` and IGNORES THE KEY, and a classroom-created
 * instance has no truth doc, so in production the cost was re-drawn on every single read:
 * the bidding screen showed one number and the round resolved against another. A student
 * could win a contract at a loss they had no way to see coming.
 *
 * Recording it removes the failure mode rather than making the derivation reliable again.
 * There is no recipe left to go wrong — with or without a seed, the number the student was
 * shown IS the number stored, and resolution reads it.
 *
 * ⚠ THE PLAYER'S OWN COST ONLY. This does NOT pull rival data forward: rival costs are
 * still drawn at RESOLUTION, inside the transaction that accepts the bid (§4). This is
 * the student's own number and they are looking at it on screen; a rival's is neither.
 */
export interface OpenRound {
  /** 1-based. The round this cost belongs to — a cost without its round number is a
   *  cost that could be applied to the wrong one. */
  round: number
  cost: number
}

/** Defensive read of the open round. Anything malformed reads as ABSENT, so the caller
 *  opens the round afresh rather than resolving against a half-written number. */
export function parseOpenRound(raw: unknown): OpenRound | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  if (typeof r.round !== 'number' || !Number.isInteger(r.round) || r.round < 1) return null
  if (typeof r.cost !== 'number' || !Number.isFinite(r.cost)) return null
  return { round: r.round, cost: r.cost }
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

/** One rival's (cost, bid, won) triple for the TIER-3 CLASS CHART. */
export interface ReportRivalPoint {
  round: number
  cost: number
  bid: number
  won: boolean
}

/**
 * The rivals each student faced, for the instructor's Tier-3 chart.
 *
 * ⚠⚠ INSTRUCTOR-ONLY, AND THIS IS A DELIBERATE CHANGE FROM CP3b. Tier 3 previously
 * carried no rival figure at all; Elena asked (08-03) for the simulated rivals to be
 * plotted on the class chart, coloured by whether they won. The report callable is
 * instructor-authenticated and nothing it returns reaches a student, so this does not
 * touch §4 — the STUDENT path's `revealRivalPoints` is still gated on `finished_at`
 * per student, and that gate is asserted separately.
 *
 * ⚠ RESOLVED ROUNDS ONLY, by construction: these come off the stored round record, and a
 * round is only there once it resolved.
 *
 * ⚠ THE TIE CAVEAT. `winner_id` is recorded from 08-03 onward and is exact. For rounds
 * stored before that it is absent, and the fallback — "this rival's bid equals the
 * winning price" — marks BOTH bidders as winners in a rival-vs-rival tie (~3% of rounds).
 * Stated rather than hidden: a chart that quietly overstates winners is worse than one
 * whose limitation is written down.
 */
export function toReportRivalPoints(rounds: readonly StoredRound[]): ReportRivalPoint[] {
  const out: ReportRivalPoint[] = []
  for (const r of rounds) {
    r.rival_bids.forEach((bid, i) => {
      const cost = r.rival_costs[i]
      if (bid === null || typeof cost !== 'number') return
      const id = rivalIdFor(i)
      const won = r.winner_id !== null
        ? r.winner_id === id
        : (!r.won && r.price !== null && bid === r.price)
      out.push({ round: r.round, cost, bid, won })
    })
  }
  return out
}

/** ⚠ Must match `rivalId` in round.ts — the ids `winner_id` is compared against are
 *  written by the resolver, so the two spellings cannot diverge without mislabelling
 *  every winner on the chart. */
const rivalIdFor = (i: number) => `rival${i + 1}`

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
      exitPrice: r.exit_price ?? null,
      exitCensored: r.exit_censored === true,
    }
  })
}
