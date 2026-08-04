import { describe, it, expect } from 'vitest'
import { Timestamp } from 'firebase-admin/firestore'
import {
  parseStoredRounds, toClientHistory, toClientResult, totalProfit, totalEquilibriumProfit,
  roundsWon, toRevealPoints, toReportRivalPoints, type StoredRound,
} from '../src/procurement/rounds'

// ═══════════════════════════════════════════════════════════════════════════════
// The round record: the defensive read, and — the reason this file exists — THE TWO
// CLIENT WHITELISTS.
//
// ⚠⚠ `rival_costs` IS THE FIELD UNDER TEST. It sits on every stored round, right beside
// `rival_bids`, and it must never reach a student in any shape. The two pins below are
// EXACT KEY-SET pins rather than value scans: a value scan would false-positive the
// moment a cost happened to equal a bid, and — worse — would PASS if a leaked cost
// happened to be a number nothing else on the record matched. The key set is the
// contract; a new field on a client shape has to be added to these tests deliberately.
// ═══════════════════════════════════════════════════════════════════════════════

const T = Timestamp.fromMillis(1_700_000_000_000)

function round(over: Partial<StoredRound> = {}): StoredRound {
  return {
    round: 1,
    cost: 30,
    bid: 50,
    won: true,
    price: 50,
    profit: 20,
    played_at: T,
    rival_costs: [80, 95, 40, 102],
    rival_bids: [86, 98, 62, 104],
    winner_id: 'player',
    tie: false,
    tied_and_lost: false,
    eq_bid: 46,
    eq_won: true,
    eq_profit: 16,
    ...over,
  }
}

// ── The whitelists ─────────────────────────────────────────────────────────────

describe('§4 no student shape can carry a rival cost', () => {
  it('the history row has EXACTLY these keys — and rival_costs is not one', () => {
    const [row] = toClientHistory([round()])
    expect(Object.keys(row).sort()).toEqual(
      ['profit', 'profitTotal', 'price', 'round', 'won', 'yourBid', 'yourCost',
       'yourEquilibriumBid'].sort(),
    )
  })

  it('the round result has EXACTLY these keys — and rival_costs is not one', () => {
    const res = toClientResult([round()], 110)
    expect(Object.keys(res).sort()).toEqual([
      'round', 'yourCost', 'yourBid', 'bids', 'won', 'price', 'profit', 'profitTotal',
      'noAward', 'costAboveReserve', 'tie', 'tiedAndLost',
      'equilibriumBid', 'equilibriumWouldHaveWon', 'equilibriumProfit',
    ].sort())
  })

  it('a bid line carries no cost — the bids are revealed, the costs behind them are not', () => {
    const res = toClientResult([round()], 110)
    for (const line of res.bids) {
      expect(Object.keys(line).sort()).toEqual(['amount', 'isYou', 'label', 'won'].sort())
    }
  })

  it('adding a field to StoredRound does not add it to the client shapes', () => {
    // The guard against the failure this whole arrangement exists to prevent: a future
    // `{ ...stored }` in either reshaper. A record carrying an obviously-secret extra
    // field must come out the far side without it.
    const sneaky = { ...round(), rival_costs: [7, 7, 7, 7], secret_seed: 'abc' } as StoredRound
    expect(JSON.stringify(toClientHistory([sneaky]))).not.toContain('secret_seed')
    expect(JSON.stringify(toClientResult([sneaky], 110))).not.toContain('secret_seed')
    expect(JSON.stringify(toClientResult([sneaky], 110))).not.toContain('rival_costs')
  })
})

// ── The Tier-3 rival series (INSTRUCTOR-ONLY) ──────────────────────────────────

describe('§12 toReportRivalPoints — the class chart\'s rival series', () => {
  it('carries (round, cost, bid, won) and nothing else', () => {
    for (const p of toReportRivalPoints([round()])) {
      expect(Object.keys(p).sort()).toEqual(['bid', 'cost', 'round', 'won'])
    }
  })

  it('marks the winner from the RECORDED winner_id', () => {
    const pts = toReportRivalPoints([round({
      won: false, price: 62, profit: 0, winner_id: 'rival3',
    })])
    expect(pts.filter(p => p.won).map(p => p.bid)).toEqual([62])
  })

  it('⚠ a rival-vs-rival TIE marks exactly ONE winner — which deriving could not do', () => {
    // Two rivals both bid 62 and one of them won. `bid === price` would call both
    // winners; the recorded id knows which. This is the case the field exists for.
    const pts = toReportRivalPoints([round({
      won: false, price: 62, profit: 0, tie: true,
      rival_bids: [62, 98, 62, 104], winner_id: 'rival3',
    })])
    expect(pts.filter(p => p.won)).toHaveLength(1)
  })

  it('falls back to bid===price on rounds stored before winner_id existed', () => {
    const pts = toReportRivalPoints([round({
      won: false, price: 62, profit: 0, winner_id: null,
    })])
    expect(pts.filter(p => p.won).map(p => p.bid)).toEqual([62])
  })

  it('⚠ and the fallback\'s KNOWN limitation: a tie marks BOTH — documented, not hidden', () => {
    const pts = toReportRivalPoints([round({
      won: false, price: 62, profit: 0, tie: true,
      rival_bids: [62, 98, 62, 104], winner_id: null,
    })])
    expect(pts.filter(p => p.won)).toHaveLength(2)
  })

  it('marks no rival a winner when the PLAYER won', () => {
    const pts = toReportRivalPoints([round({ won: true, price: 50, winner_id: 'player' })])
    expect(pts.every(p => !p.won)).toBe(true)
  })

  it('omits a rival who made no bid', () => {
    const pts = toReportRivalPoints([round({ rival_bids: [86, null, 62, null] })])
    expect(pts.map(p => p.cost)).toEqual([80, 40])
  })
})

// ── The one gated exception ────────────────────────────────────────────────────

describe('§9 toRevealPoints — the ONLY rival cost that ever leaves the server', () => {
  it('pairs each rival cost with its own bid, in order', () => {
    const pts = toRevealPoints([round()])
    expect(pts).toEqual([
      { round: 1, cost: 80, bid: 86 },
      { round: 1, cost: 95, bid: 98 },
      { round: 1, cost: 40, bid: 62 },
      { round: 1, cost: 102, bid: 104 },
    ])
  })

  it('OMITS a rival who made no bid rather than plotting them at zero', () => {
    // They were ABSENT from the auction (§3.1). A point at (cost, 0) would be a lie
    // about a bid that was never made — and it would sit far below the optimal line,
    // which is exactly the claim this chart exists to support.
    const pts = toRevealPoints([round({ rival_bids: [86, null, 62, null] })])
    expect(pts.map(p => p.cost)).toEqual([80, 40])
  })

  it('omits a point whose cost went missing in a defensive parse', () => {
    // `rival_costs` parses all-or-nothing, so a corrupt doc yields bids with no costs.
    // Half a coordinate pair is not a point.
    const pts = toRevealPoints([round({ rival_costs: [] })])
    expect(pts).toEqual([])
  })

  it('spans every round', () => {
    const pts = toRevealPoints([round({ round: 1 }), round({ round: 2 })])
    expect(pts).toHaveLength(8)
    expect(new Set(pts.map(p => p.round))).toEqual(new Set([1, 2]))
  })

  it('a point carries EXACTLY round, cost and bid', () => {
    for (const p of toRevealPoints([round()])) {
      expect(Object.keys(p).sort()).toEqual(['bid', 'cost', 'round'])
    }
  })
})

// ── The result screen's own logic ──────────────────────────────────────────────

describe('§6.4 the round result', () => {
  it('sorts every bid ascending and marks the player', () => {
    const res = toClientResult([round({ bid: 50, rival_bids: [86, 98, 62, 104] })], 110)
    expect(res.bids.map(b => b.amount)).toEqual([50, 62, 86, 98, 104])
    expect(res.bids.filter(b => b.isYou)).toHaveLength(1)
    expect(res.bids[0].isYou).toBe(true)
  })

  it('marks exactly one winner, and it is the bidder at the winning price', () => {
    const res = toClientResult(
      [round({ bid: 70, won: false, price: 62, profit: 0, eq_won: false, eq_profit: 0 })],
      110,
    )
    const winners = res.bids.filter(b => b.won)
    expect(winners).toHaveLength(1)
    expect(winners[0].amount).toBe(62)
    expect(winners[0].isYou).toBe(false)
  })

  it('a rival priced out by the reserve shows as no bid, and sorts LAST', () => {
    const res = toClientResult([round({ rival_bids: [86, null, 62, null] })], 110)
    expect(res.bids.map(b => b.amount)).toEqual([50, 62, 86, null, null])
  })

  it('costAboveReserve fires only when the player\'s own cost exceeds the reserve', () => {
    expect(toClientResult([round({ cost: 96 })], 90).costAboveReserve).toBe(true)
    expect(toClientResult([round({ cost: 30 })], 90).costAboveReserve).toBe(false)
    // The boundary is INCLUSIVE — a cost exactly at the reserve still has a bid worth
    // making (a zero-margin one), so the "no bid worth making" line must not fire.
    expect(toClientResult([round({ cost: 90 })], 90).costAboveReserve).toBe(false)
  })

  it('noAward reflects a round nobody won', () => {
    expect(toClientResult([round()], 110).noAward).toBe(false)
    expect(
      toClientResult([round({ won: false, price: null, profit: 0 })], 110).noAward,
    ).toBe(true)
  })

  it('tiedAndLost passes through — it is the line the screen owes the student', () => {
    const res = toClientResult(
      [round({ bid: 62, won: false, price: 62, profit: 0, tie: true, tied_and_lost: true })],
      110,
    )
    expect(res.tie).toBe(true)
    expect(res.tiedAndLost).toBe(true)
    // Both bids at 62 are present; without the flag the screen would show two identical
    // lowest bids with the other one marked winner.
    expect(res.bids.filter(b => b.amount === 62)).toHaveLength(2)
  })

  it('profitTotal is cumulative across every round, not just this one', () => {
    const res = toClientResult(
      [round({ round: 1, profit: 20 }), round({ round: 2, profit: 5 })],
      110,
    )
    expect(res.round).toBe(2)
    expect(res.profit).toBe(5)
    expect(res.profitTotal).toBe(25)
  })
})

// ── The defensive read ─────────────────────────────────────────────────────────

describe('parseStoredRounds', () => {
  it('drops a malformed element and every round after it, keeping a contiguous prefix', () => {
    const raw = [round({ round: 1 }), { round: 2, cost: 'nope' }, round({ round: 3 })]
    const out = parseStoredRounds(raw)
    expect(out.map(r => r.round)).toEqual([1])
  })

  it('stops at a round number that is out of sequence', () => {
    const out = parseStoredRounds([round({ round: 1 }), round({ round: 3 })])
    expect(out.map(r => r.round)).toEqual([1])
  })

  it('a malformed REVEAL field costs that round its bid table, not the history', () => {
    // The reveal detail is presentation on top of the core outcome, so it degrades
    // rather than truncating the student's record.
    const out = parseStoredRounds([
      { ...round({ round: 1 }), rival_bids: 'garbage', eq_profit: 'garbage' },
      round({ round: 2 }),
    ])
    expect(out.map(r => r.round)).toEqual([1, 2])
    expect(out[0].rival_bids).toEqual([])
    expect(out[0].eq_profit).toBe(0)
    expect(out[1].rival_bids).toEqual([86, 98, 62, 104])
  })

  it('rival_costs is ALL-OR-NOTHING, so it can never re-pair against rival_bids', () => {
    // ⚠ A filter here would drop the bad element and shift every later cost onto the
    // wrong rival's bid in the reports — silently, and only for corrupt docs.
    const out = parseStoredRounds([{ ...round(), rival_costs: [80, 'x', 40, 102] }])
    expect(out[0].rival_costs).toEqual([])
    expect(out[0].rival_bids).toHaveLength(4)
  })

  it('preserves a null bid rather than coercing it to zero', () => {
    // A 0 bid would read as "bid nothing and won", a different and much better outcome.
    const out = parseStoredRounds([{ ...round(), bid: null }])
    expect(out[0].bid).toBeNull()
  })

  it('returns empty for anything that is not an array', () => {
    expect(parseStoredRounds(undefined)).toEqual([])
    expect(parseStoredRounds({ 0: round() })).toEqual([])
  })
})

// ── The tallies ────────────────────────────────────────────────────────────────

describe('the tallies', () => {
  const rs = [
    round({ round: 1, profit: 20, won: true, eq_profit: 16 }),
    round({ round: 2, profit: 0, won: false, eq_profit: 9 }),
    round({ round: 3, profit: -4, won: true, eq_profit: 0 }),
  ]

  it('totalProfit sums realized profit, losses included', () => {
    // A bid below one's own cost is legal (§6.2), so a negative round is a real state.
    expect(totalProfit(rs)).toBe(16)
  })

  it('roundsWon counts wins', () => {
    expect(roundsWon(rs)).toBe(2)
  })

  it('totalEquilibriumProfit is the §9 benchmark, and is NOT the realized total', () => {
    expect(totalEquilibriumProfit(rs)).toBe(25)
    expect(totalEquilibriumProfit(rs)).not.toBe(totalProfit(rs))
  })
})
