import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { RevenueEquivalenceSVG, revenueEquivalencePoints } from './RevenueEquivalenceSVG'
import type { ProcurementReport, ProcurementReportRow, ProcurementPlayedRow } from './api'

// ═══════════════════════════════════════════════════════════════════════════════
// The revenue-equivalence chart — selection logic and the three sparse states.
//
// ⚠⚠ THE EXPECTED NUMBERS ARE HAND-COMPUTED FROM THE COSTS, NOT FROM THE CODE.
// β(c) = c + (θmax − c)/n at θmax = 110, n = 5 — the closed form from the spec, worked
// by hand below and written into the fixture as the STORED bids a real report would
// carry. So this file never calls β and never imports it: it asserts that the chart
// picks the right cost and the right bid out of an auction, which is the only thing
// this component decides. Whether β itself is right is `auction/equilibrium.ts`'s job
// and is asserted there, against its own independent oracle.
//
// Worked by hand, once, for every cost the fixtures use:
//   β(15)=34  β(20)=38  β(22)=39.6→40  β(25)=42  β(30)=46  β(45)=58  β(50)=62
//   β(55)=66  β(60)=70  β(65)=74  β(70)=78  β(80)=86  β(90)=94  β(95)=98  β(100)=102
// ═══════════════════════════════════════════════════════════════════════════════

const playedRow = (over: Partial<ProcurementPlayedRow> = {}): ProcurementPlayedRow => ({
  round: 1,
  yourCost: 20,
  yourBid: 34,
  won: true,
  price: 34,
  profit: 14,
  profitTotal: 14,
  yourEquilibriumBid: 38,
  exitPrice: null,
  exitCensored: false,
  ...over,
})

const reportRow = (over: Partial<ProcurementReportRow> = {}): ProcurementReportRow => ({
  participantId: 'S1',
  name: 'Student One',
  externalId: null,
  finished: false,
  roundsPlayed: 1,
  roundsWon: 1,
  profitTotal: 14,
  knowledgeCheckScore: null,
  rawScore: null,
  normalizedScore: null,
  rounds: [],
  rivalPoints: [],
  freeText: {},
  ...over,
})

const report = (rows: ProcurementReportRow[], over: Partial<ProcurementReport> = {}): ProcurementReport => ({
  ok: true,
  format: 'sealed_first_price',
  rounds: 8,
  reserve: 110,
  rivalCostMin: 10,
  rivalCostMax: 110,
  playerCostMin: 10,
  playerCostMax: 60,
  rivalCount: 4,
  totalBidders: 5,
  currencyLabel: 'ECU',
  gradedTotal: 0,
  finalized: false,
  textQuestions: [],
  rows,
  ...over,
})

// ── The reference fixture: three auctions, all numbers hand-derived above ───────
//
// A  S1 r1  student cost 20 (β 38); rivals 30/45/70/90 (β 46/58/78/94)
//           costs sorted 20,30,45,70,90 → second-lowest 30 ⇒ x = 30
//           β's 38,46,58,78,94         → min 38          ⇒ y = 38
//           student WON at 34                              realised = 34
// B  S1 r2  student cost 50 (β 62); rivals 15/60/80/100 (β 34/70/86/102)
//           costs sorted 15,50,60,80,100 → second-lowest 50 ⇒ x = 50
//           β's 62,34,70,86,102         → min 34           ⇒ y = 34
//           student LOST                                    realised = null
// C  S2 r1  student cost 25 (β 42); rivals 25/55/65/95 (β 42/66/74/98)
//           ⚠ TIE AT THE MINIMUM: costs 25,25,55,65,95 → second-lowest 25 ⇒ x = 25
//           β's 42,42,66,74,98          → min 42            ⇒ y = 42
//           student WON at 40                                realised = 40
const FIXTURE = () => report([
  reportRow({
    participantId: 'S1',
    rounds: [
      playedRow({ round: 1, yourCost: 20, yourEquilibriumBid: 38, yourBid: 34, won: true }),
      playedRow({ round: 2, yourCost: 50, yourEquilibriumBid: 62, yourBid: 66, won: false }),
    ],
    rivalPoints: [
      { round: 1, cost: 30, bid: 46, won: false },
      { round: 1, cost: 45, bid: 58, won: false },
      { round: 1, cost: 70, bid: 78, won: false },
      { round: 1, cost: 90, bid: 94, won: false },
      { round: 2, cost: 15, bid: 34, won: true },
      { round: 2, cost: 60, bid: 70, won: false },
      { round: 2, cost: 80, bid: 86, won: false },
      { round: 2, cost: 100, bid: 102, won: false },
    ],
  }),
  reportRow({
    participantId: 'S2',
    rounds: [playedRow({ round: 1, yourCost: 25, yourEquilibriumBid: 42, yourBid: 40, won: true })],
    rivalPoints: [
      { round: 1, cost: 25, bid: 42, won: false },
      { round: 1, cost: 55, bid: 66, won: false },
      { round: 1, cost: 65, bid: 74, won: false },
      { round: 1, cost: 95, bid: 98, won: false },
    ],
  }),
])

const at = (pts: ReturnType<typeof revenueEquivalencePoints>, pid: string, round: number) =>
  pts.find(p => p.participantId === pid && p.round === round)!

describe('both series, hand-computed from the costs', () => {
  it('series 1 — every auction, x = second-lowest cost and y = lowest β-bid', () => {
    const pts = revenueEquivalencePoints(FIXTURE())
    expect(pts).toHaveLength(3)

    expect(at(pts, 'S1', 1)).toMatchObject({ openPrice: 30, sealedPrice: 38 })
    expect(at(pts, 'S1', 2)).toMatchObject({ openPrice: 50, sealedPrice: 34 })
    expect(at(pts, 'S2', 1)).toMatchObject({ openPrice: 25, sealedPrice: 42 })
  })

  it('series 2 — ONLY auctions the student won, at the SAME x', () => {
    const pts = revenueEquivalencePoints(FIXTURE())

    expect(at(pts, 'S1', 1).actualBid).toBe(34)
    expect(at(pts, 'S2', 1).actualBid).toBe(40)
    // ⚠ Lost auctions carry a bid but not a PRICE — nobody paid it.
    expect(at(pts, 'S1', 2).actualBid).toBeNull()

    // Same x by construction, which is what makes the gap vertical and readable.
    expect(at(pts, 'S1', 1).openPrice).toBe(30)
  })

  it('⚠ a tie at the cheapest cost prices the auction AT that cost', () => {
    // S2's auction has two bidders at 25. The clock stops there — one is still in when
    // the other leaves — so second-lowest is 25, not the next DISTINCT value (55).
    expect(at(revenueEquivalencePoints(FIXTURE()), 'S2', 1).openPrice).toBe(25)
  })

  it('an auction with fewer than two active bidders is excluded, not priced at the reserve', () => {
    const lonely = report([reportRow({
      participantId: 'S9',
      rounds: [playedRow({ round: 1, yourCost: 20, yourEquilibriumBid: 38 })],
      rivalPoints: [],   // every rival above a lowered reserve ⇒ absent from the report
    })])
    expect(revenueEquivalencePoints(lonely)).toHaveLength(0)
  })

  it('a student above the reserve is not a bidder, and the auction prices on the rivals alone', () => {
    const out = report([reportRow({
      participantId: 'S8',
      rounds: [playedRow({ round: 1, yourCost: 105, yourEquilibriumBid: null, yourBid: null, won: false })],
      rivalPoints: [
        { round: 1, cost: 30, bid: 46, won: true },
        { round: 1, cost: 45, bid: 58, won: false },
      ],
    })])
    // costs 30,45 → second-lowest 45; β's 46,58 → min 46. The student enters neither.
    expect(revenueEquivalencePoints(out)[0]).toMatchObject({ openPrice: 45, sealedPrice: 46 })
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// NEGATIVE CONTROL. ⚠ A test that stays green when a change should have moved something
// is not watching. Each half below perturbs ONE input and asserts BOTH what moves and
// what must not — a pair that passes under a change affecting only one series would
// otherwise look identical to a pair that passes because nothing is wired at all.
// ═══════════════════════════════════════════════════════════════════════════════
describe('negative control', () => {
  it('perturbing an auction’s COSTS moves that auction’s point and no other', () => {
    const base = revenueEquivalencePoints(FIXTURE())

    const moved = FIXTURE()
    // S1 r1: rival cost 30 → 22, so the second-lowest cost falls to 22. The cheapest
    // bidder (the student at 20) is untouched, so the sealed price must NOT move.
    moved.rows[0].rivalPoints[0] = { round: 1, cost: 22, bid: 40, won: false }
    const after = revenueEquivalencePoints(moved)

    expect(at(after, 'S1', 1).openPrice).toBe(22)          // moved
    expect(at(base, 'S1', 1).openPrice).toBe(30)           // and was not 22 before
    expect(at(after, 'S1', 1).sealedPrice).toBe(38)        // unmoved — still β(20)

    // ⚠ THE OTHER AUCTIONS MUST BE BYTE-IDENTICAL. Without this the test would pass on a
    // function that recomputed every point from the last row it saw.
    expect(at(after, 'S1', 2)).toEqual(at(base, 'S1', 2))
    expect(at(after, 'S2', 1)).toEqual(at(base, 'S2', 1))
  })

  it('perturbing the student’s BID moves ONLY series 2', () => {
    const base = revenueEquivalencePoints(FIXTURE())

    const moved = FIXTURE()
    moved.rows[0].rounds[0].yourBid = 31   // won at 31 instead of 34
    const after = revenueEquivalencePoints(moved)

    expect(at(after, 'S1', 1).actualBid).toBe(31)          // series 2 moved
    expect(at(base, 'S1', 1).actualBid).toBe(34)

    // ⚠ SERIES 1 IS THEORY AND MUST BE DEAF TO WHAT THE STUDENT ACTUALLY DID. If this
    // ever fails, the counterfactual has been contaminated by the observation.
    expect(at(after, 'S1', 1).openPrice).toBe(at(base, 'S1', 1).openPrice)
    expect(at(after, 'S1', 1).sealedPrice).toBe(at(base, 'S1', 1).sealedPrice)
  })

  it('a losing bid never becomes a series-2 point, however it moves', () => {
    const moved = FIXTURE()
    moved.rows[0].rounds[1].yourBid = 1    // absurdly low, but still a LOSS
    expect(at(revenueEquivalencePoints(moved), 'S1', 2).actualBid).toBeNull()
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// THE THREE SPARSE STATES. ⚠ One human against four suppliers means most auctions go to
// a bot, so an empty realised series is the ORDINARY case in a played instance — not a
// fault, and not something Elena can be shown a broken-looking chart for.
// ═══════════════════════════════════════════════════════════════════════════════
describe('sparse states', () => {
  it('NO ROUNDS AT ALL — a sentence, not an empty pair of axes', () => {
    const html = renderToStaticMarkup(<RevenueEquivalenceSVG report={report([])} />)
    expect(html).toContain('proc-revequiv-empty')
    expect(html).not.toContain('data-testid="proc-revequiv"')
    expect(html).toMatch(/No auctions have been played yet/)
  })

  it('ROUNDS BUT ZERO STUDENT WINS — the chart draws, and says why it is green-only', () => {
    const noWins = report([reportRow({
      participantId: 'S1',
      rounds: [playedRow({ round: 1, yourCost: 50, yourEquilibriumBid: 62, yourBid: 66, won: false })],
      rivalPoints: [
        { round: 1, cost: 15, bid: 34, won: true },
        { round: 1, cost: 60, bid: 70, won: false },
      ],
    })])
    const html = renderToStaticMarkup(<RevenueEquivalenceSVG report={noWins} />)

    expect(html).toContain('data-testid="proc-revequiv"')          // it renders
    expect(html).toContain('proc-revequiv-theory')                 // series 1 present
    expect(html).not.toContain('proc-revequiv-realised')           // series 2 absent
    expect(html).not.toContain('proc-revequiv-gap')                // and no dangling gaps
    // ⚠ THE SENTENCE IS THE POINT. Without it the empty blue series reads as a bug.
    expect(html).toContain('proc-revequiv-nowins')
    expect(html).toMatch(/No student has won an auction yet/)
  })

  it('EXACTLY ONE STUDENT WIN — one realised dot, one gap, singular wording', () => {
    const oneWin = report([reportRow({
      participantId: 'S2',
      rounds: [playedRow({ round: 1, yourCost: 25, yourEquilibriumBid: 42, yourBid: 40, won: true })],
      rivalPoints: [
        { round: 1, cost: 55, bid: 66, won: false },
        { round: 1, cost: 65, bid: 74, won: false },
      ],
    })])
    const html = renderToStaticMarkup(<RevenueEquivalenceSVG report={oneWin} />)

    expect(html.match(/proc-revequiv-realised/g) ?? []).toHaveLength(1)
    expect(html.match(/proc-revequiv-gap/g) ?? []).toHaveLength(1)
    expect(html).not.toContain('proc-revequiv-nowins')
    // ⚠ THIS ASSERTION USED TO READ `toContain('one auction')`, checking the caption's
    // singular wording. The 2026-08-12 caption rewrite made that VACUOUS: the new static
    // body contains the phrase "one auction priced two ways", so it matched for every
    // fixture regardless of win count — a green that distinguished nothing. It asserts
    // the COUNT now, which is the thing that actually varies with the data.
    expect(html).toMatch(/1 won by a student/)
  })

  it('the legend names both series and marks the computed one as computed', () => {
    const html = renderToStaticMarkup(<RevenueEquivalenceSVG report={FIXTURE()} />)
    expect(html).toContain('proc-revequiv-legend')
    // ⚠ NOBODY MAY READ THEORY POINTS AS OBSERVED DATA. Both words must be on screen.
    expect(html).toContain('(computed)')
    expect(html).toContain('(observed)')
    // The diagonal is a guide, never labelled as revenue equivalence.
    expect(html).toContain('Equal prices')
    expect(html).not.toMatch(/revenue equivalence/i)
  })

  it('⚠ the caption explains the scatter by the ORDER STATISTICS, not by the cost ranges', () => {
    const html = renderToStaticMarkup(<RevenueEquivalenceSVG report={FIXTURE()} />)

    // ⚠⚠ THE POINT OF THIS TEST IS THE SECOND HALF. The caption first said the greens
    // sit off the diagonal because students draw from a narrower range than the
    // suppliers. That is not the reason: revenue equivalence holds IN EXPECTATION, so
    // fixing x (the second-lowest cost) still leaves the sealed price riding on the
    // LOWEST cost, a different draw — points must straddle the line even with identical
    // ranges. The wrong explanation reads as a caveat about this instance and would send
    // a reader looking for a defect in a chart that is working.
    expect(html).toContain('agree on average, not auction by auction')
    expect(html).toContain('the open price is set by the second-lowest cost while the sealed price is set by the lowest')
    // And the caveat about the blue series being conditional on winning.
    expect(html).toContain('not a straight read of how much they underbid')

    // ⚠ THE REVERT GUARD. If the narrower-range sentence ever comes back, this fails.
    expect(html).not.toMatch(/narrower range/i)
    expect(html).not.toMatch(/not expected to coincide/i)
  })

  it('counts every auction and the wins among them', () => {
    const html = renderToStaticMarkup(<RevenueEquivalenceSVG report={FIXTURE()} />)
    expect(html).toMatch(/3 auctions/)
    expect(html).toMatch(/2 won by a student/)
  })
})
