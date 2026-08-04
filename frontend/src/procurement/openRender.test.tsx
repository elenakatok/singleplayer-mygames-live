// eslint-disable-next-line @typescript-eslint/no-unused-vars -- classic JSX transform
import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

// api.ts reaches ../firebase, which initializes Firebase on import and throws in Node.
// Nothing is CALLED here: `renderToStaticMarkup` does not run effects, so the screen's
// advance tick never fires and no control is ever pressed.
vi.mock('../firebase', () => ({ auth: {}, db: {}, functions: {} }))
import { OpenBidScreen, OpenRoundEnd, OpenAllRoundsDone } from './OpenBidScreen'
import type { ProcurementAuction, ProcurementParams } from './api'

// ═══════════════════════════════════════════════════════════════════════════════
// THE OPEN BIDDING SCREEN — open §5.1, asserted against the document's own sample:
//
//   Current Auction Price is 48 · Round 3 of 8 · 3 of 5 still bidding
//   [ 46 ] [ Bid ] · [ Bid minimum ] · [ Drop Out ]
//   You are not winning (red) / You are winning (green)
//   Minimum next bid: 46 · bids must fall by at least 2 ECU
//   bot 3 — 48 · — steps are now 2 ECU — · bot 1 — 50 · bot 3 — 55 · bot 1 — 60
// ═══════════════════════════════════════════════════════════════════════════════

const PARAMS: ProcurementParams = {
  format: 'open_descending',
  rounds: 8,
  rivalCount: 4,
  totalBidders: 5,
  reserve: 110,
  rivalCostMin: 10,
  rivalCostMax: 110,
  bidIncrementUnit: 1,
  currencyLabel: 'ECU',
  decrementSchedule: [
    { above: 80, step: 10 }, { above: 50, step: 5 },
    { above: 30, step: 2 }, { above: 0, step: 1 },
  ],
  delaySchedule: [
    { above: 80, delayMs: 800 }, { above: 50, delayMs: 1200 },
    { above: 30, delayMs: 2500 }, { above: 0, delayMs: 3000 },
  ],
  delayJitterMs: 250,
}

const auction = (over: Partial<ProcurementAuction> = {}): ProcurementAuction => ({
  round: 3,
  status: 'waiting',
  standing: 48,
  holderLabel: 'Bot 3',
  youHold: false,
  yourLastBid: null,
  youAreOut: false,
  sequence: 10,
  nextBotAtMs: null,
  step: 2,
  minNextBid: 46,
  history: [
    { kind: 'bid', label: 'Bot 1', amount: 60, isYou: false },
    { kind: 'bid', label: 'Bot 3', amount: 55, isYou: false },
    { kind: 'bid', label: 'Bot 1', amount: 50, isYou: false },
    { kind: 'bid', label: 'Bot 3', amount: 48, isYou: false },
  ],
  activeBidders: 3,
  totalBidders: 5,
  winnerLabel: null,
  youWon: false,
  price: null,
  ...over,
})

const render = (a: ProcurementAuction, over: { cost?: number } = {}) =>
  renderToStaticMarkup(
    <OpenBidScreen
      params={PARAMS}
      roundNumber={3}
      cost={over.cost ?? 34}
      auction={a}
      totalProfit={12}
      onRoundEnd={() => { /* never reached: effects do not run */ }}
    />,
  )

/** The VISIBLE text of a testid'd element (tags stripped, whitespace collapsed). */
function textOf(html: string, testId: string): string | null {
  const re = new RegExp(`<([a-z0-9]+)[^>]*data-testid="${testId}"[^>]*>([\\s\\S]*?)</\\1>`)
  const m = html.match(re)
  // ⚠ Tags become a SPACE, not nothing — see render.test.tsx's note.
  return m ? m[2].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() : null
}

describe('§5.1 the live status line', () => {
  const html = render(auction())

  it('prints the standing price, the round, and who holds it', () => {
    expect(textOf(html, 'proc-open-standing')).toBe('48')
    expect(textOf(html, 'proc-open-holder')).toBe('held by Bot 3')
    expect(html).toContain('Round 3 of 8')
  })

  it('says whether the player is winning, in the document\'s words', () => {
    expect(textOf(html, 'proc-open-winning')).toBe('You are not winning')
    expect(textOf(render(auction({ youHold: true, yourLastBid: 46, holderLabel: 'You' })),
      'proc-open-winning')).toBe('You are winning')
  })

  it('prints the active-bidder count as "N of M" (§4.3, §5.1)', () => {
    expect(textOf(html, 'proc-open-active')).toBe('3 of 5')
  })

  it('states the minimum next bid AND the step in force — never left to be inferred', () => {
    expect(textOf(html, 'proc-open-min')).toBe('46 ECU — bids must fall by at least 2 ECU')
  })

  it('prints the student\'s own cost, and never a rival\'s', () => {
    expect(textOf(html, 'proc-open-cost')).toBe('34 ECU')
  })
})

describe('§5.1 the bid box is live and PRE-FILLED with the minimum legal bid', () => {
  it('defaults to the minimum next bid', () => {
    // "the player's window to act is a click rather than a decision-plus-typing".
    expect(render(auction())).toMatch(/data-testid="proc-open-bid-input"[^>]*value="46"/)
  })

  it('re-defaults as the standing moves', () => {
    expect(render(auction({ standing: 44, minNextBid: 42, step: 2 })))
      .toMatch(/data-testid="proc-open-bid-input"[^>]*value="42"/)
  })

  it('the one-click Bid minimum button names the amount', () => {
    expect(textOf(render(auction()), 'proc-open-bid-min')).toBe('Bid minimum (46)')
  })

  it('⚠ the pre-fill is a DEFAULT, not a limit — jump bidding is invited in words', () => {
    expect(render(auction())).toContain('You may bid lower than the minimum')
  })

  it('Drop Out is present — this format and only this format (§4.5)', () => {
    expect(textOf(render(auction()), 'proc-open-dropout')).toBe('Drop Out')
  })

  it('both controls are live while the BOTS are bidding, not only when it halts', () => {
    // §5.1: "The bid box is live and pre-filled at all times, including while bots are
    // bidding." A screen that disabled itself during the cascade would make the 2–3s
    // window unusable, which is the whole pacing argument.
    const html = render(auction({ status: 'bot_turn', nextBotAtMs: Date.now() + 1200 }))
    expect(html).not.toMatch(/data-testid="proc-open-bid-input"[^>]*disabled/)
    expect(html).not.toMatch(/data-testid="proc-open-dropout"[^>]*disabled/)
  })

  it('⚠ §4.2 but bidding CLOSES while the player holds the low bid', () => {
    // The holder may not undercut themselves — including the player, who holds their own
    // bid for a second or two while the bots are answering with the box still live. Two
    // clicks would otherwise walk them down against nobody.
    const html = render(auction({
      status: 'bot_turn', youHold: true, holderLabel: 'You', yourLastBid: 46,
      standing: 46, minNextBid: 44, nextBotAtMs: Date.now() + 1200,
    }))
    expect(html).toMatch(/data-testid="proc-open-bid"[^>]*disabled/)
    expect(html).toMatch(/data-testid="proc-open-bid-min"[^>]*disabled/)
    expect(textOf(html, 'proc-open-holding')).toContain('cannot outbid yourself')
    // ⚠ AND DROP OUT STAYS LIVE — quitting while ahead is a real, if unwise, decision.
    expect(html).not.toMatch(/data-testid="proc-open-dropout"[^>]*disabled/)
  })

  it('and they are refused once the player has dropped out', () => {
    const html = render(auction({ youAreOut: true, status: 'resolved', minNextBid: null }))
    expect(html).toMatch(/data-testid="proc-open-dropout"[^>]*disabled/)
    expect(textOf(html, 'proc-open-winning')).toBe('You have dropped out of this auction')
  })
})

describe('§5.1 the history, most recent first, with band markers', () => {
  const html = render(auction())

  it('lists the bids newest first', () => {
    const list = textOf(html, 'proc-open-history') ?? ''
    expect(list.indexOf('Bot 3 — 48')).toBeLessThan(list.indexOf('Bot 1 — 60'))
  })

  it('⚠ marks the moment the step size changed — where the endgame starts', () => {
    // 55 → 50 crosses the band boundary at 50, so the step becomes 2. "A player who
    // misses it will misjudge how much room is left."
    expect(textOf(html, 'proc-open-band')).toBe('— steps are now 2 ECU —')
    const list = textOf(html, 'proc-open-history') ?? ''
    expect(list.indexOf('steps are now 2')).toBeGreaterThan(list.indexOf('Bot 1 — 50'))
    expect(list.indexOf('steps are now 2')).toBeLessThan(list.indexOf('Bot 3 — 55'))
  })

  it('the marker is computed from the SCHEDULE, so a retuned band moves it', () => {
    // The §9 step-5 checkpoint retunes these from Settings; a marker hardcoded at 50
    // would then point at the wrong row on the very screen being tuned.
    const coarse: ProcurementParams = {
      ...PARAMS,
      decrementSchedule: [{ above: 58, step: 5 }, { above: 0, step: 2 }],
    }
    const html2 = renderToStaticMarkup(
      <OpenBidScreen params={coarse} roundNumber={3} cost={34} auction={auction()}
        totalProfit={0} onRoundEnd={() => {}} />,
    )
    const list = textOf(html2, 'proc-open-history') ?? ''
    expect(list.indexOf('steps are now 2')).toBeGreaterThan(list.indexOf('Bot 3 — 55'))
  })

  it('an empty history says the auction opens at the incumbent\'s price', () => {
    const html2 = render(auction({ history: [], standing: 110, holderLabel: null, minNextBid: 100, step: 10 }))
    // ⚠ Apostrophes come back HTML-escaped from renderToStaticMarkup — unescape before
    // asserting on prose, or the assertion fails for a reason that is not a bug.
    const text = html2.replace(/&#x27;/g, "'")
    expect(text).toContain("the incumbent's price — nobody has bid yet")
    expect(text).toContain("The auction opens at the incumbent's price of 110 ECU")
  })

  it('a drop-out shows as one, not as a bid of nothing', () => {
    const html2 = render(auction({
      history: [{ kind: 'dropOut', label: 'You', amount: null, isYou: true }],
    }))
    expect(textOf(html2, 'proc-open-history')).toContain('You — dropped out')
  })
})

describe('§4.6 the screen says something rather than sitting silent', () => {
  it('while the bots are bidding', () => {
    expect(textOf(render(auction({ status: 'bot_turn', nextBotAtMs: 1 })), 'proc-open-bots'))
      .toBe('The other suppliers are bidding…')
  })

  it('and when the cascade halts, it says it is the player\'s move — with no clock', () => {
    const html = render(auction())
    expect(textOf(html, 'proc-open-waiting'))
      .toBe('Nobody else will go lower. It is your move — bid, or drop out.')
    // ⚠ NO TIMEOUT ANYWHERE (§4.4). Nothing on this screen counts down.
    expect(html).not.toMatch(/seconds remaining|time remaining|countdown/i)
  })

  it('there is no "Time Remaining" box — the deck\'s one deliberate omission (§5.1)', () => {
    expect(render(auction())).not.toMatch(/Time Remaining/i)
  })
})

describe('the round end is deliberately spare — §5.2 is CP4b', () => {
  const outcome = {
    round: 3, yourCost: 34, yourLastBid: 38, won: false,
    price: 36, profit: 0, profitTotal: 12, droppedOut: false,
  }
  const html = renderToStaticMarkup(
    <OpenRoundEnd params={PARAMS} outcome={outcome} done={false} onContinue={() => {}} />)

  it('says what happened and what it earned', () => {
    expect(html).toContain('Round 3 — you did not win')
    expect(textOf(html, 'proc-open-final-price')).toBe('36 ECU')
    expect(textOf(html, 'proc-open-round-profit')).toBe('0 ECU')
  })

  it('⚠ and does NOT yet carry §5.2\'s gap message or counterfactual', () => {
    // Named so the absence reads as scope rather than as an oversight when CP4b lands.
    expect(html).not.toMatch(/room left|could profitably have bid/i)
  })

  it('a winning round prints a positive profit with its sign', () => {
    const won = renderToStaticMarkup(
      <OpenRoundEnd params={PARAMS} done={false} onContinue={() => {}}
        outcome={{ ...outcome, won: true, price: 46, profit: 12 }} />)
    expect(won).toContain('Round 3 — you won the contract')
    expect(textOf(won, 'proc-open-round-profit')).toBe('+12 ECU')
  })
})

describe('the end of the loop does not borrow the sealed format\'s results screen', () => {
  const html = renderToStaticMarkup(
    <OpenAllRoundsDone params={PARAMS} roundsPlayed={8} roundsWon={3}
      totalProfit={41} onContinue={() => {}} />)

  it('reports the totals', () => {
    expect(html).toContain('That is all 8 auctions')
    expect(textOf(html, 'proc-open-total')).toBe('+41 ECU')
  })

  it('⚠ and asserts NO optimal line — β is the sealed mechanism\'s benchmark (§7)', () => {
    expect(html).not.toMatch(/optimal|equilibrium|perfect player/i)
  })
})
