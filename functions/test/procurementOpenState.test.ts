import { describe, it, expect } from 'vitest'
import {
  openAuction, advanceOne, playerBid, playerDropOut,
  type OpenSettings, type OpenState,
} from '../src/procurement/auction/openAuction'
import { toClientAuction, bidderLabel } from '../src/procurement/openView'
import {
  serializeAuction, parseAuction, parseBotCosts, drawBotCosts, botCostsDocId, botCostsPatch,
  openSettingsFor,
} from '../src/procurement/openAuctionStore'
import { loadProcurementConfig } from '../src/procurement/config'

// ═══════════════════════════════════════════════════════════════════════════════
// OPEN FORMAT — THE LEAK DEFENCE, and the state's round trip through storage.
//
// ⚠⚠ THE HAZARD IS NEW IN THIS FORMAT. The sealed format's rival costs are drawn at
// RESOLUTION, inside the transaction that accepts the bid, so before the bid they do not
// exist and there is nothing for a payload to leak. The open format cannot do that —
// every bot decision from the first is a function of its cost — so **bot costs exist from
// round open**, and the only thing standing between them and the student is this
// whitelist plus the rules-denied `truth` doc they live in.
//
// ⚠ THE INDIRECT LEAK IS THE ONE TO WATCH: `OpenState.stopped` is a LIST OF BOT IDS
// derived from their costs. "bot3 stopped at a standing of 48" says its cost is above 46.
// Shipped every step, it hands a student each rival's cost to within one step of the
// schedule, which is the entire game. It must never cross into a client payload.
//
// ⚠ A VALUE SCAN WOULD BE UNSOUND HERE and is deliberately not used: a bot's cost is a
// small integer and will frequently coincide with some legitimate bid on the same screen,
// so "no field equals 47" would either pass by luck or fail on a correct payload. The
// control is a recursive KEY-SET PIN — the payload's shape is exactly the contract, so a
// new field cannot appear without this file failing.
// ═══════════════════════════════════════════════════════════════════════════════

const SCHEDULE = [
  { above: 80, step: 10 }, { above: 50, step: 5 },
  { above: 30, step: 2 }, { above: 0, step: 1 },
]
const DELAYS = [
  { above: 80, delayMs: 800 }, { above: 50, delayMs: 1200 },
  { above: 30, delayMs: 2500 }, { above: 0, delayMs: 3000 },
]
const BOTS = [
  { bidderId: 'rival1', cost: 47 },
  { bidderId: 'rival2', cost: 88 },
  { bidderId: 'rival3', cost: 21 },
  { bidderId: 'rival4', cost: 63 },
]

const base = (over: Partial<OpenSettings> = {}): OpenSettings => ({
  reserve: 110,
  schedule: SCHEDULE,
  delaySchedule: DELAYS,
  playerId: 'player',
  playerCost: 34,
  bots: BOTS,
  // ⚠ BLANK SEED — the classroom shape. See procurementOpenAuction.test.ts's header.
  rngAt: () => Math.random,
  jitterAt: () => 0,
  order: 'lowestIndex',
  ...over,
})

const run = (st: OpenState, s: OpenSettings): OpenState => {
  let cur = st
  for (let i = 0; i < 200; i++) {
    const r = advanceOne(cur, s, cur.nextBotAtMs ?? 0)
    if (!r.committed) return r.state
    cur = r.state
  }
  throw new Error('did not settle')
}

const sameKeys = (obj: object, keys: string[]) =>
  JSON.stringify(Object.keys(obj).sort()) === JSON.stringify([...keys].sort())

const AUCTION_KEYS = [
  'round', 'status', 'standing', 'holderLabel', 'youHold', 'yourLastBid', 'youAreOut',
  'sequence', 'nextBotAtMs', 'step', 'minNextBid', 'canBid', 'history',
  'totalBidders', 'winnerLabel', 'youWon', 'price',
]
const EVENT_KEYS = ['kind', 'label', 'amount', 'isYou']

describe('the client payload is a whitelist (open §4.3, §5.1)', () => {
  /** Four states worth pinning: opening, mid-cascade, halted, resolved. A payload built
   *  by a spread would pass a check made only at the opening, where `stopped` is empty. */
  const states = () => {
    const s = base()
    const opened = openAuction(s, 1_000)
    const mid = advanceOne(advanceOne(opened, s, 1_800).state, s, 1e9).state
    const halted = run(opened, s)
    const resolved = playerDropOut(halted, s, 1e9)
    return { s, opened, mid, halted, resolved }
  }

  it('⚠ the key set is EXACTLY the contract, at every stage of a round', () => {
    const { s, opened, mid, halted, resolved } = states()
    for (const [label, st] of Object.entries({ opened, mid, halted, resolved })) {
      const view = toClientAuction(3, st, s)
      expect(sameKeys(view, AUCTION_KEYS), `${label}: auction key set`).toBe(true)
      expect(view.history.every(e => sameKeys(e, EVENT_KEYS)), `${label}: event key set`).toBe(true)
    }
    // The scenario must CONTAIN the condition: by the halt, bots really have stopped.
    expect(halted.stopped.length).toBeGreaterThan(0)
    expect(resolved.history.length).toBeGreaterThan(0)
  })

  it('⚠⚠ `stopped` never crosses the boundary, under any name', () => {
    const { s, halted } = states()
    const view = toClientAuction(3, halted, s) as unknown as Record<string, unknown>
    // Named, because this is the field the whole file exists for.
    expect('stopped' in view).toBe(false)
    // And nothing that IS the stopped list under another name.
    const stoppedIds = halted.stopped
    expect(stoppedIds.length).toBeGreaterThan(0)
    const json = JSON.stringify(view)
    for (const id of stoppedIds) {
      // A bot id appears in the history only as a LABEL ("Bot 3"), never as `rival3`.
      expect(json.includes(`"${id}"`), `raw id ${id} must not appear`).toBe(false)
    }
  })

  it('the history carries labels and amounts only — no cost, under any spelling', () => {
    const { s, halted } = states()
    const view = toClientAuction(3, halted, s)
    expect(view.history.length).toBeGreaterThan(0)
    for (const e of view.history) {
      expect(Object.keys(e).some(k => /cost/i.test(k))).toBe(false)
      expect(e.label).toMatch(/^(You|Bot \d+)$/)
    }
  })

  it('bidder labels are the spec\'s (§5.1: "bot 3"), and the player is "You"', () => {
    expect(bidderLabel('player')).toBe('You')
    expect(bidderLabel('rival3')).toBe('Bot 3')
  })
})

describe('⚠⚠ there is NO active-bidder count, anywhere (Elena, 2026-08-04)', () => {
  // A competitor's departure is not announced in a live auction. The player infers it from
  // silence, and silence is ambiguous between "priced out" and "still thinking". A running
  // count destroys that ambiguity, and it was the last client-side field derived from bot
  // COST state. This supersedes open §4.3's count note and §5.1's "3 of 5 still bidding".
  //
  // ⚠ THE DERIVATION WAS DELETED, NOT UNEXPORTED — `activeBidderCount` no longer exists in
  // `auction/openAuction.ts`, so there is nothing to call. These tests guard the payload;
  // the module's absence guards against someone re-deriving it.

  it('the payload has no count of who is still in, under any spelling', () => {
    const s = base({ reserve: 60 })          // ⚠ two bots priced out: the case that leaked
    const halted = run(openAuction(s, 0), s)
    for (const [label, st] of Object.entries({ opening: openAuction(s, 0), halted })) {
      const view = toClientAuction(1, st, s) as unknown as Record<string, unknown>
      expect('activeBidders' in view, label).toBe(false)
      // ⚠ `youAreOut` is deliberately NOT matched: it is about the PLAYER's own decision,
      // which they took and already know about. The names hunted here are the ones that
      // would describe the FIELD's state — how many are active, remaining, still bidding.
      const counts = Object.keys(view).filter(k => /active|remaining|still|bidding|count/i.test(k))
      expect(counts, `${label}: no field names a running count`).toEqual([])
    }
    // The scenario contains the condition: bots really are out by the halt.
    expect(halted.stopped.length).toBeGreaterThan(0)
  })

  it('⚠ and no OTHER field reproduces it — the payload cannot be differenced back', () => {
    // The real question is not "is the field named activeBidders" but "can the number be
    // recovered". Two auctions with the SAME standing price and the SAME history, whose
    // bots have stopped in different numbers, must be INDISTINGUISHABLE on the wire.
    //
    // Constructed so both open at 110 and neither has bid: one field is fully alive, the
    // other has three of four bots priced out by a lowered reserve.
    const alive = base({ reserve: 110 })
    const mostlyOut = base({
      reserve: 110,
      bots: [
        { bidderId: 'rival1', cost: 47 },
        { bidderId: 'rival2', cost: 105 },   // above the first legal bid of 100
        { bidderId: 'rival3', cost: 107 },
        { bidderId: 'rival4', cost: 109 },
      ],
    })
    const a = toClientAuction(1, openAuction(alive, 1_000), alive)
    const b = toClientAuction(1, openAuction(mostlyOut, 1_000), mostlyOut)

    // The states genuinely differ in how many are out — the condition is present.
    expect(openAuction(alive, 0).stopped.length).toBe(0)
    expect(openAuction(mostlyOut, 0).stopped.length).toBe(3)

    // ⚠ AND THE PAYLOADS ARE IDENTICAL. `status` is 'bot_turn' in both — the one boundary
    // it does carry is "ALL stopped", which neither of these is. See BUILD_NOTES §6h.
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })

  it('the opening TOTAL stays, and never moves — it is a parameter, not a commentary', () => {
    // "There are 5 bidders in this auction" is public and the player needs n to reason at
    // all. What matters is that it is the same number before and after bots drop away.
    const s = base({ reserve: 60 })
    const opening = toClientAuction(1, openAuction(s, 0), s)
    const halted = toClientAuction(1, run(openAuction(s, 0), s), s)
    const droppedOut = toClientAuction(1, playerDropOut(run(openAuction(s, 0), s), s, 0), s)
    expect(opening.totalBidders).toBe(5)
    expect(halted.totalBidders).toBe(5)
    expect(droppedOut.totalBidders).toBe(5)
  })
})

describe('⚠⚠ the invariant that lets the bid history stay fully public', () => {
  // A BOT NEVER EMITS ANYTHING BUT A BID. There is no "stopped" event and no bot drop-out
  // event, so every row of the history is an action somebody publicly took. A bid is an
  // announcement; a departure is silence, and silence stays ambiguous.
  it('no bot ever produces a non-bid event — across reserves that strand bots mid-cascade', () => {
    let sawStoppedBots = false
    let events = 0
    for (const reserve of [110, 90, 60, 48, 30]) {
      for (let i = 0; i < 12; i++) {
        const s = base({ reserve, order: 'random', rngAt: () => Math.random })
        const st = playerDropOut(run(openAuction(s, 0), s), s, 0)
        if (st.stopped.length > 0) sawStoppedBots = true
        for (const e of st.history) {
          events++
          if (e.kind !== 'bid') {
            // ⚠ TWO NON-BID KINDS NOW: `dropOut` (they left) and `autoDrop` (the price
            // went below their cost and they were removed). BOTH are the player's — the
            // invariant this test exists for is that a BOT emits nothing but a bid.
            expect(['dropOut', 'autoDrop']).toContain(e.kind)
            expect(e.bidderId).toBe('player')
          }
        }
      }
    }
    // ⚠ Assert the scenario contained the condition before trusting the loop above.
    expect(events).toBeGreaterThan(50)
    expect(sawStoppedBots).toBe(true)
  })

  it('and the client history carries the same shape — bids, plus the player\'s drop-out', () => {
    const s = base({ reserve: 60 })
    const st = playerDropOut(run(openAuction(s, 0), s), s, 0)
    const view = toClientAuction(1, st, s)
    expect(view.history.length).toBeGreaterThan(0)
    const exits = view.history.filter(e => e.kind !== 'bid')
    expect(exits.length).toBe(1)
    expect(exits[0].isYou).toBe(true)
    expect(exits[0].label).toBe('You')
    expect(view.history.filter(e => e.kind === 'bid').every(e => typeof e.amount === 'number'))
      .toBe(true)
  })
})

describe('the screen fields §5.1 names', () => {
  it('the step in force and the minimum next bid are both computed server-side', () => {
    const s = base()
    const halted = run(openAuction(s, 0), s)
    const view = toClientAuction(3, halted, s)
    expect(view.standing).toBe(48)
    expect(view.step).toBe(2)
    expect(view.minNextBid).toBe(46)
    expect(view.holderLabel).toBe('Bot 3')
    expect(view.youHold).toBe(false)
    expect(view.yourLastBid).toBeNull()
  })

  it('a resolved round has no minimum next bid and names the winner', () => {
    const s = base()
    const st = playerDropOut(run(openAuction(s, 0), s), s, 0)
    const view = toClientAuction(3, st, s)
    expect(view.status).toBe('resolved')
    expect(view.minNextBid).toBeNull()
    expect(view.winnerLabel).toBe('Bot 3')
    expect(view.youWon).toBe(false)
    expect(view.price).toBe(48)
  })

  it('the player\'s own last bid comes back so the box can re-default around it', () => {
    const s = base()
    let st = run(openAuction(s, 0), s)
    st = (playerBid(st, s, 46, st.sequence, 0) as { state: OpenState }).state
    const view = toClientAuction(3, st, s)
    expect(view.yourLastBid).toBe(46)
    expect(view.youHold).toBe(true)
    expect(view.holderLabel).toBe('You')
  })
})

// ── the round trip through Firestore ──────────────────────────────────────────

describe('the auction state survives storage exactly (§4.6: resume is exact)', () => {
  it('serialize → parse is the identity, at every stage', () => {
    const s = base()
    const opened = openAuction(s, 1_000)
    const mid = advanceOne(opened, s, 1_800).state
    const halted = run(opened, s)
    const resolved = playerDropOut(halted, s, 1e9)

    for (const [label, st] of Object.entries({ opened, mid, halted, resolved })) {
      const stored = JSON.parse(JSON.stringify(serializeAuction(4, st))).open_auction
      expect(parseAuction(stored, 4), label).toEqual(st)
    }
  })

  it('⚠ a state from ANOTHER round reads as absent', () => {
    // A stale round-3 auction applied in round 4 would resolve round 4 against round 3's
    // standing price. Same discipline as `parseOpenRound`.
    const s = base()
    const stored = serializeAuction(3, run(openAuction(s, 0), s)).open_auction
    expect(parseAuction(stored, 4)).toBeNull()
    expect(parseAuction(stored, 3)).not.toBeNull()
  })

  it('anything malformed reads as absent rather than half a record', () => {
    const s = base()
    const good = serializeAuction(2, run(openAuction(s, 0), s)).open_auction
    expect(parseAuction(null, 2)).toBeNull()
    expect(parseAuction({ ...good, status: 'nonsense' }, 2)).toBeNull()
    expect(parseAuction({ ...good, standing: 'x' }, 2)).toBeNull()
    expect(parseAuction({ ...good, history: 'x' }, 2)).toBeNull()
    // ⚠ A BID EVENT WITH NO AMOUNT breaks the whole history, not just that row: a replay
    // that silently skipped a bid is worse than no replay.
    expect(parseAuction({ ...good, history: [{ kind: 'bid', bidder_id: 'rival1' }] }, 2)).toBeNull()
    // `decisions` is the ordering stream's index — a state without it would restart the
    // stream and make every later choice in the round the same one.
    const { decisions: _drop, ...noDecisions } = good
    expect(parseAuction(noDecisions, 2)).toBeNull()
  })
})

describe('the bot costs live in the rules-denied truth doc', () => {
  const config = loadProcurementConfig({ format: 'open_descending' })

  it('the doc id can never collide with truth/main, which holds the seed', () => {
    expect(botCostsDocId('main')).toBe('bots_main')
    expect(botCostsDocId('abc123')).not.toBe('main')
  })

  it('one field per round, so drawing round t+1 cannot disturb round t', () => {
    const a = botCostsPatch(3, [1, 2, 3, 4])
    const b = botCostsPatch(4, [5, 6, 7, 8])
    expect(Object.keys(a)).toEqual(['r3'])
    expect(Object.keys(b)).toEqual(['r4'])
    expect(Object.keys({ ...a, ...b }).sort()).toEqual(['r3', 'r4'])
  })

  it('⚠ a vector of the WRONG LENGTH reads as absent, not as a shorter auction', () => {
    // Silently running with three bots in a four-rival instance would make the "N of M"
    // counter a lie and change the price the auction settles at.
    expect(parseBotCosts([1, 2, 3, 4], 4)).toEqual([1, 2, 3, 4])
    expect(parseBotCosts([1, 2, 3], 4)).toBeNull()
    expect(parseBotCosts([1, 2, 3, 'x'], 4)).toBeNull()
    expect(parseBotCosts(undefined, 4)).toBeNull()
  })

  it('the draw is per student, and — under a seed — is the sealed format\'s own', () => {
    // The same stream key as `resolveRound`'s rival draw, so a seeded side-by-side of the
    // two mechanisms faces the same suppliers. That is what makes the revenue-equivalence
    // comparison in the debrief honest rather than a coincidence of two RNGs.
    const a = drawBotCosts('s', 'alice', 1, config)
    const b = drawBotCosts('s', 'bob', 1, config)
    expect(a.length).toBe(4)
    expect(a).not.toEqual(b)
    expect(drawBotCosts('s', 'alice', 1, config)).toEqual(a)
    expect(drawBotCosts('s', 'alice', 2, config)).not.toEqual(a)
  })

  it('the settings the machine runs on carry costs, and the payload built from them '
    + 'does not', () => {
    const costs = [47, 88, 21, 63]
    const s = openSettingsFor(config, costs, null, 'alice', 1)
    expect(s.bots.map(b => b.cost)).toEqual(costs)
    const view = toClientAuction(1, openAuction(s, 0), s) as unknown as Record<string, unknown>
    expect(Object.keys(view).some(k => /cost/i.test(k))).toBe(false)
  })
})
