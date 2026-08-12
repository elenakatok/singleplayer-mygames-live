import { describe, it, expect, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

// api.ts reaches ../firebase, which initializes Firebase on import and throws in Node.
// Nothing is CALLED here: `renderToStaticMarkup` does not run effects, so the screen's
// advance tick never fires and no control is ever pressed.
vi.mock('../firebase', () => ({ auth: {}, db: {}, functions: {} }))
import { OpenBidScreen, OpenRoundEnd } from './OpenBidScreen'
import { OpenEndScreen } from './OpenEndScreen'
import { ExitScatterSVG } from './ExitScatterSVG'
import type { ProcurementAuction, ProcurementParams } from './api'

// ═══════════════════════════════════════════════════════════════════════════════
// THE OPEN BIDDING SCREEN — open §5.1, asserted against the document's own sample:
//
//   Current Auction Price is 48 · Round 3 of 8
//   [ 46 ] [ Bid ] · [ Bid minimum ] · [ Drop Out ]
//   You are not winning (red) / You are winning (green)
//   Minimum next bid: 46 · bids must fall by at least 2 ECU
//   bot 3 — 48 · — steps are now 2 ECU — · bot 1 — 50 · bot 3 — 55 · bot 1 — 60
//
// ⚠⚠ ONE DELIBERATE DEPARTURE FROM THE MOCK: "3 of 5 still bidding" IS GONE (Elena,
// 2026-08-04), along with the field behind it and the server-side derivation. A
// competitor's departure is not announced in a live auction — the player infers it from
// silence, and silence is ambiguous between "priced out" and "still thinking". The
// OPENING TOTAL stays ("There are 5 bidders in this auction"), because it is a parameter
// the player needs and it never moves. The spec is being updated to match.
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
  exitKind: null,
  sequence: 10,
  nextBotAtMs: null,
  step: 2,
  minNextBid: 46,
  // ⚠ SERVER-COMPUTED (2026-08-04). It folds in both closures — the holder may not
  // undercut themselves, and no bidder may bid below their own cost — so the screen never
  // forms a second opinion about a rule the server will enforce.
  canBid: true,
  history: [
    { kind: 'bid', label: 'Bot 1', amount: 60, isYou: false },
    { kind: 'bid', label: 'Bot 3', amount: 55, isYou: false },
    { kind: 'bid', label: 'Bot 1', amount: 50, isYou: false },
    { kind: 'bid', label: 'Bot 3', amount: 48, isYou: false },
  ],
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

  it('⚠⚠ prints the OPENING TOTAL, and no running count of who is left', () => {
    expect(textOf(html, 'proc-open-bidders')).toBe('5 in this auction, including you')
    // The row that used to say "Still bidding — 3 of 5" is gone, and so is the field.
    expect(html).not.toContain('proc-open-active')
    expect(html).not.toMatch(/still bidding/i)
  })

  it('⚠ and the total does not move as bots drop away', () => {
    // It is a PARAMETER of the auction. Rendering it from a payload that never changes is
    // the point: nothing about who is still in can be read off the screen.
    const late = render(auction({
      standing: 36, holderLabel: 'Bot 3', step: 2, minNextBid: 34,
      history: [{ kind: 'bid', label: 'Bot 3', amount: 36, isYou: false }],
    }))
    expect(textOf(late, 'proc-open-bidders')).toBe('5 in this auction, including you')
  })

  it('⚠ and the screen never says why the price stopped moving', () => {
    // The earlier wording — "Nobody else will go lower" — announced in words exactly what
    // removing the count exists to withhold: that every remaining supplier has stopped.
    expect(html).not.toMatch(/nobody else will go lower/i)
    expect(html).not.toMatch(/priced out|no longer bidding|has stopped|dropped out of the/i)
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
    const html = render(auction({ status: 'bot_turn', nextBotAtMs: Date.now() + 1200, canBid: true }))
    expect(html).not.toMatch(/data-testid="proc-open-bid-input"[^>]*disabled/)
    expect(html).not.toMatch(/data-testid="proc-open-dropout"[^>]*disabled/)
  })

  it('⚠ §4.2 but bidding CLOSES while the player holds the low bid', () => {
    // The holder may not undercut themselves — including the player, who holds their own
    // bid for a second or two while the bots are answering with the box still live. Two
    // clicks would otherwise walk them down against nobody.
    const html = render(auction({
      status: 'bot_turn', youHold: true, holderLabel: 'You', yourLastBid: 46,
      standing: 46, minNextBid: 44, nextBotAtMs: Date.now() + 1200, canBid: false,
    }))
    expect(html).toMatch(/data-testid="proc-open-bid"[^>]*disabled/)
    expect(html).toMatch(/data-testid="proc-open-bid-min"[^>]*disabled/)
    expect(textOf(html, 'proc-open-holding')).toContain('cannot outbid yourself')
    // ⚠ AND DROP OUT STAYS LIVE — quitting while ahead is a real, if unwise, decision.
    expect(html).not.toMatch(/data-testid="proc-open-dropout"[^>]*disabled/)
  })

  it('⚠⚠ the COST FLOOR closes bidding, and the screen says why with both numbers', () => {
    // No bidder may bid below their own cost (Elena, 2026-08-04) — §4.3's rule for the
    // bots, now one rule for everybody. A disabled button with no explanation reads as a
    // broken page, and this is the moment a student most needs the rule, because it is
    // the moment it costs them the round.
    const html = render(auction({
      standing: 35, minNextBid: 33, step: 2, canBid: false, holderLabel: 'Bot 3',
    }), { cost: 34 })
    expect(html).toMatch(/data-testid="proc-open-bid"[^>]*disabled/)
    expect(html).toMatch(/data-testid="proc-open-bid-min"[^>]*disabled/)
    // ⚠ Apostrophes come back HTML-escaped from renderToStaticMarkup — unescape before
    // asserting on prose (same trap as the §4.1 opening-row test).
    expect((textOf(html, 'proc-open-cost-floor') ?? '').replace(/&#x27;/g, "'")).toBe(
      "The next bid would be 33, below your cost of 34. You can't bid lower — no bidder "
      + 'in this auction may go below their own cost. Drop Out is your only move.')
    // ⚠ DROP OUT STAYS LIVE — it is now their only move, so it had better work.
    expect(html).not.toMatch(/data-testid="proc-open-dropout"[^>]*disabled/)
  })

  it('⚠⚠ AN AUTO-DROPPED PLAYER IS NEVER TOLD THEY "DROPPED OUT"', () => {
    // MUTANT: render the status line off `youAreOut` alone, ignoring `exitKind`. → fails.
    // That was the shipped behaviour until 2026-08-11: the status line said "You have
    // dropped out of this auction" while the history row directly below it said the price
    // had passed them. One event, two descriptions, one of them a lie about what they did.
    const html = render(auction({
      youAreOut: true, exitKind: 'autoDrop', status: 'resolved', minNextBid: null, canBid: false,
    }))
    expect(textOf(html, 'proc-open-winning'))
      .toBe('You are out of this auction — the price is at or below your cost')
    expect(textOf(html, 'proc-open-winning')).not.toContain('dropped out')
  })

  it('⚠ and the SAME phrasing is used in the history row — one event, one sentence', () => {
    // MUTANT: reword either site independently. → fails. Both read AUTO_DROP_REASON.
    const html = render(auction({
      youAreOut: true, exitKind: 'autoDrop', status: 'resolved', minNextBid: null, canBid: false,
      history: [{ kind: 'autoDrop', label: 'You', amount: null, isYou: true }],
    }))
    expect(textOf(html, 'proc-open-history'))
      .toContain('You — out: the price is at or below your cost')
  })

  it('a VOLUNTARY drop still reads as one — the two must not converge', () => {
    // MUTANT: return the auto-drop sentence for every exit kind. → fails.
    const html = render(auction({
      youAreOut: true, exitKind: 'dropOut', status: 'resolved', minNextBid: null, canBid: false,
    }))
    expect(textOf(html, 'proc-open-winning')).toBe('You have dropped out of this auction')
  })

  it('and they are refused once the player has dropped out', () => {
    const html = render(auction({ youAreOut: true, exitKind: 'dropOut', status: 'resolved', minNextBid: null, canBid: false }))
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

  it('⚠ the OLDEST row is the auction opening, always', () => {
    // §4.1: the auction opens with the incumbent's price STANDING and UNOWNED — a real
    // standing bid for the purpose of the decrement rule, and the thing the first bid has
    // to undercut. Without it the history starts mid-story.
    expect(textOf(html, 'proc-open-opened')).toBe('Auction opened at 110 ECU')
    const list = textOf(html, 'proc-open-history') ?? ''
    expect(list.indexOf('Auction opened at')).toBeGreaterThan(list.indexOf('Bot 1 — 60'))
  })

  it('and on a round nobody has bid in, it is the ONLY row — never an empty list', () => {
    const html2 = render(auction({ history: [], standing: 110, holderLabel: null, minNextBid: 100, step: 10 }))
    expect(textOf(html2, 'proc-open-opened')).toBe('Auction opened at 110 ECU')
    // ⚠ Apostrophes come back HTML-escaped from renderToStaticMarkup — unescape before
    // asserting on prose, or the assertion fails for a reason that is not a bug.
    expect(html2.replace(/&#x27;/g, "'"))
      .toContain("the incumbent's price — nobody has bid yet")
  })

  it('⚠ the opening row is rendered from config, NOT from a fabricated server event', () => {
    // A synthetic event would end up in `open_history` and in §5.2's replay as a bid
    // nobody made. The row tracks `params.reserve`; the payload's history stays exactly
    // what the server committed.
    const lowered: ProcurementParams = { ...PARAMS, reserve: 90 }
    const html2 = renderToStaticMarkup(
      <OpenBidScreen params={lowered} roundNumber={3} cost={34} auction={auction({ history: [] })}
        totalProfit={0} onRoundEnd={() => {}} />,
    )
    expect(textOf(html2, 'proc-open-opened')).toBe('Auction opened at 90 ECU')
  })

  it('a drop-out shows as one, not as a bid of nothing', () => {
    const html2 = render(auction({
      history: [{ kind: 'dropOut', label: 'You', amount: null, isYou: true }],
    }))
    expect(textOf(html2, 'proc-open-history')).toContain('You — dropped out')
  })

  it('⚠ an AUTO-DROP row does not say the student quit', () => {
    // Two different events: one says they left, the other says the price left them behind.
    const html2 = render(auction({
      history: [{ kind: 'autoDrop', label: 'You', amount: null, isYou: true }],
    }))
    // ⚠ WORDING CHANGED 2026-08-11 from "the price went below your cost". Auto-drop now
    // also fires when a bot bids AT the player's cost, so "went below" is wrong in exactly
    // the case that motivated the change. Same sentence as the status line, deliberately.
    expect(textOf(html2, 'proc-open-history')).toContain('You — out: the price is at or below your cost')
    expect(textOf(html2, 'proc-open-history')).not.toContain('dropped out')
  })

  it('⚠⚠ every row is an ACTION SOMEBODY TOOK, or the opening — no "Bot 3 has stopped"', () => {
    // This is the invariant that lets the history stay fully public while the
    // active-bidder count does not: a bid is an announcement, a departure is silence. The
    // server never emits a bot stop or a bot drop-out (see `OpenEvent`), so there is no
    // such row to render — and no wording here that could imply one.
    const text = (textOf(html, 'proc-open-history') ?? '').replace(/&#x27;/g, "'")
    expect(text.length).toBeGreaterThan(0)
    expect(text).not.toMatch(/stopped|withdrew|priced out|out of the auction|no longer/i)
    // Only the PLAYER can drop out, so no bot label may carry that word.
    expect(text).not.toMatch(/Bot \d+ — dropped out/)
  })
})

describe('§4.6 the screen says something rather than sitting silent', () => {
  it('while the bots are bidding', () => {
    expect(textOf(render(auction({ status: 'bot_turn', nextBotAtMs: 1 })), 'proc-open-bots'))
      .toBe('The other suppliers are bidding…')
  })

  it('and when the cascade halts, it says it is the player\'s move — WITHOUT saying why', () => {
    const html = render(auction())
    expect(textOf(html, 'proc-open-waiting'))
      .toBe('It is your move — bid, or drop out. There is no clock.')
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
    // ⚠ null is the CORRECT value here, not a placeholder: this player neither pressed
    // Drop Out nor was auto-dropped (`droppedOut: false`), and the winning overrides
    // below inherit it — which api.ts documents as right for a winner ("Null when they
    // won"). The three cases are 'dropOut' | 'autoDrop' | null; see openAuction.ts.
    exitKind: null,
    exitPrice: 36, exitCensored: false, perfectProfit: 2, perfectWon: true,
  }
  const html = renderToStaticMarkup(
    <OpenRoundEnd params={PARAMS} outcome={outcome} auction={auction()} done={false} onContinue={() => {}} />)

  it('says what happened and what it earned', () => {
    expect(html).toContain('Round 3 — you did not win')
    expect(textOf(html, 'proc-open-final-price')).toBe('36 ECU')
    expect(textOf(html, 'proc-open-round-profit')).toBe('0 ECU')
  })

  it('⚠ §5.2 the GAP sentence — their last bid, their cost, and the room left', () => {
    // The spec's own wording: "You stopped at 38. Your cost was 34, so you had 4 ECU of
    // room left." ⚠ It names their LAST BID (38), not their exit price (36) — different
    // numbers, and the sentence is about the decision they made, not where it settled.
    expect(textOf(html, 'proc-open-gap'))
      .toBe('You stopped at 38. Your cost was 34, so you had 4 ECU of room left.')
  })

  it('⚠⚠ §5.2 the counterfactual, when there WAS more to win', () => {
    expect(textOf(html, 'proc-open-counterfactual'))
      .toBe('The contract went for 36. You could profitably have bid down to 36.')
  })

  it('⚠⚠ §5.2 and the OTHER form — "you lost correctly", which is the important one', () => {
    // §5.2: "it tells a player they lost correctly, which is the hardest thing to learn
    // from losing." Without it a student who played perfectly and lost concludes they
    // were too timid, and bids below cost next round.
    const lostRight = renderToStaticMarkup(
      <OpenRoundEnd params={PARAMS} done={false} onContinue={() => {}} auction={auction()}
        outcome={{ ...outcome, price: 30, perfectWon: false, perfectProfit: 0 }} />)
    expect(textOf(lostRight, 'proc-open-counterfactual')).toBe(
      'The contract went for 30, which was below your cost — there was nothing more to win here.')
    // ⚠ THE BENCHMARK IS THE FRICTIONLESS OUTCOME, and when somebody else was cheaper
    // there was nothing to take at this cost either way.
    expect(textOf(lostRight, 'proc-open-perfect')).toBe(
      'Another supplier could bid lower than you here, so there was nothing to win at '
      + 'your cost — with or without bid increments.')
  })

  it('⚠ a WINNER is told their exit price is an upper bound', () => {
    const won = renderToStaticMarkup(
      <OpenRoundEnd params={PARAMS} done={false} onContinue={() => {}} auction={auction()}
        outcome={{ ...outcome, won: true, price: 46, profit: 12, yourLastBid: 46,
          exitPrice: 46, exitCensored: true }} />)
    expect(textOf(won, 'proc-open-gap'))
      .toBe('You won at 46 with a cost of 34 — 12 ECU of profit.')
    expect(textOf(won, 'proc-open-censored')).toMatch(/nobody pushed you any lower/i)
  })

  it('⚠⚠ §5.2 the benchmark reads as the FRICTIONLESS outcome, not a ceiling', () => {
    // outcome: perfectWon, perfectProfit 2, actual profit 0 — the common direction.
    expect(textOf(html, 'proc-open-perfect')).toBe(
      'With no bid increments the contract goes to the lowest-cost supplier at the '
      + 'second-lowest cost. On your draws that is 2 ECU. You earned 0.')
  })

  it('⚠⚠ and works in the OTHER direction — a player ABOVE it is not told off', () => {
    // ~19% of the rounds a student wins land here, because the runner-up stops a whole
    // step short and the winner keeps the difference. Nothing in this sentence may imply
    // an error: the gap IS the lesson.
    const above = renderToStaticMarkup(
      <OpenRoundEnd params={PARAMS} done={false} onContinue={() => {}} auction={auction()}
        outcome={{ ...outcome, won: true, price: 46, profit: 12, yourLastBid: 46,
          exitPrice: 46, exitCensored: true, perfectWon: true, perfectProfit: 10 }} />)
    expect(textOf(above, 'proc-open-perfect')).toBe(
      'With no bid increments the contract goes to the lowest-cost supplier at the '
      + 'second-lowest cost. On your draws that is 10 ECU. You earned 12 — the increments '
      + 'left a little on the table for you.')
    // ⚠ NOT ONE WORD OF BLAME, and no suggestion the figures are wrong.
    expect(above).not.toMatch(/mistake|error|should have|too much|incorrect/i)
  })

  it('and says so plainly when the two agree', () => {
    const same = renderToStaticMarkup(
      <OpenRoundEnd params={PARAMS} done={false} onContinue={() => {}} auction={auction()}
        outcome={{ ...outcome, won: true, price: 46, profit: 12, yourLastBid: 46,
          exitPrice: 46, exitCensored: true, perfectWon: true, perfectProfit: 12 }} />)
    expect(textOf(same, 'proc-open-perfect')).toContain('You earned exactly that.')
  })

  it('§5.2 the full bid history for the round is replayed', () => {
    expect(textOf(html, 'proc-open-result-history')).toContain('Bot 3 — 48')
    expect(textOf(html, 'proc-open-result-history')).toContain('Auction opened at 110 ECU')
  })

  it('a winning round prints a positive profit with its sign', () => {
    const won = renderToStaticMarkup(
      <OpenRoundEnd params={PARAMS} done={false} onContinue={() => {}} auction={auction()}
        outcome={{ ...outcome, won: true, price: 46, profit: 12, yourLastBid: 46,
          exitPrice: 46, exitCensored: true }} />)
    expect(won).toContain('Round 3 — you won the contract')
    expect(textOf(won, 'proc-open-round-profit')).toBe('+12 ECU')
  })
})

describe('§5.3 the open results screen', () => {
  const rows = [
    { round: 1, yourCost: 34, yourBid: 38, won: false, price: 36, profit: 0, profitTotal: 0,
      yourEquilibriumBid: null, exitPrice: 36, exitCensored: false },
    { round: 2, yourCost: 20, yourBid: 46, won: true, price: 46, profit: 26, profitTotal: 26,
      yourEquilibriumBid: null, exitPrice: 46, exitCensored: true },
  ]
  const html = renderToStaticMarkup(
    <OpenEndScreen params={PARAMS} history={rows} totalProfit={26} totalPerfectProfit={34}
      roundsWon={1} botCosts={[47, 88, 21, 63]} onContinue={() => {}} />)

  it('reports the totals and the frictionless benchmark', () => {
    expect(html).toContain('Your 2 auctions')
    expect(textOf(html, 'proc-open-end-profit')).toBe('+26 ECU')
    expect(textOf(html, 'proc-open-end-perfect')).toBe('+34 ECU')
    // ⚠ THE LABEL NAMES WHAT THE NUMBER IS, not a grade.
    expect(html).toContain('With no bid increments')
    expect(html).not.toMatch(/Perfect play would have earned/)
  })

  it('⚠⚠ §5.3 the benchmark note works in BOTH directions and blames nobody', () => {
    // Below: the common case.
    expect(textOf(html, 'proc-open-end-benchmark-note'))
      .toMatch(/You earned less than that/i)
    expect(textOf(html, 'proc-open-end-benchmark-note'))
      .toMatch(/increment size is an auction-design decision/i)

    // Above: ~19% of winning rounds. Must read as the increments working for them.
    const over = renderToStaticMarkup(
      <OpenEndScreen params={PARAMS} history={rows} totalProfit={40} totalPerfectProfit={34}
        roundsWon={1} botCosts={null} />)
    const note = textOf(over, 'proc-open-end-benchmark-note') ?? ''
    expect(note).toMatch(/You earned more than that/i)
    expect(note).toMatch(/not a mistake in the numbers/i)
    expect(over).not.toMatch(/you should have|error|incorrect/i)
  })

  it('⚠⚠ the per-round table shows EXIT PRICE, and no optimal-bid column', () => {
    const table = textOf(html, 'proc-open-end-table') ?? ''
    expect(table).toContain('Where you stopped')
    expect(table).not.toMatch(/optimal/i)
    expect(table).not.toMatch(/equilibrium/i)
  })

  it('⚠ and marks the winning round\'s exit as censored, in the TABLE as well as the chart', () => {
    // A table that hid the distinction would undo the chart\'s careful separation one
    // column over.
    expect(textOf(html, 'proc-open-end-table')).toMatch(/46\s*↑/)
  })

  it('⚠⚠ draws the 45° line and NO β line — the refusal this screen exists for', () => {
    expect(html).toContain('data-testid="proc-exit-45"')
    expect(html).not.toMatch(/optimal bid at each cost|β/i)
    expect(html).not.toMatch(/0\.8c \+ 22/)
  })

  it('winners and losers are SEPARATE SERIES, and the caption says why (§7)', () => {
    expect(html).toContain('data-testid="proc-exit-won"')
    expect(html).toContain('data-testid="proc-exit-lost"')
    expect(textOf(html, 'proc-exit-censored-note'))
      .toMatch(/plotted separately because their exit price is not a\s+stopping point/i)
  })

  it('⚠ the bot series is DEFAULT OFF (§7)', () => {
    expect(html).not.toContain('data-testid="proc-exit-bot"')
    expect(html).toContain('data-testid="proc-open-end-show-bots"')
  })
})


// ── ITEM 2 — the rounds that cannot be plotted ───────────────────────────────

describe('⚠⚠ rounds with no exit price are COUNTED, not silently dropped', () => {
  // ⚠ REPRODUCED BEFORE IT WAS WRITTEN. An emulator cohort produced 4 such rounds in 76:
  // `exit_price` absent, zero player bids, end event `dropOut`, record otherwise
  // well-formed. Null is the SPECIFIED value for "dropped out having never bid" — a
  // winner always has a bid, and an auto-drop records the student's cost — so the chart's
  // filter is correct and the fix is to say where the missing points went.
  const pts = [
    { cost: 30, exitPrice: 36, censored: false },
    { cost: 20, exitPrice: 46, censored: true },
  ]

  it('says how many are missing, and what the total was', () => {
    const html = renderToStaticMarkup(
      <ExitScatterSVG points={pts} min={10} max={110} currencyLabel="ECU"
        subjectLabel="Every student in the class" neverBidCount={4} />)
    const note = textOf(html, 'proc-exit-never-bid') ?? ''
    expect(note).toContain('4 rounds are not plotted')
    expect(note).toContain('without a single bid')
    // ⚠ THE TOTAL RECONCILES — 2 plotted + 4 unplotted = 6. A chart whose numbers do not
    // add up is what sent us looking for these in the first place.
    expect(note).toContain('6 rounds in total')
  })

  it('⚠ and says NOTHING when there are none — never a permanent "0 rounds" line', () => {
    const html = renderToStaticMarkup(
      <ExitScatterSVG points={pts} min={10} max={110} currencyLabel="ECU"
        subjectLabel="Your rounds" />)
    expect(html).not.toContain('proc-exit-never-bid')
    expect(html).not.toMatch(/not plotted/)
  })

  it('singular reads correctly', () => {
    const html = renderToStaticMarkup(
      <ExitScatterSVG points={pts} min={10} max={110} currencyLabel="ECU"
        subjectLabel="Your rounds" neverBidCount={1} />)
    expect(textOf(html, 'proc-exit-never-bid')).toContain('1 round is not plotted')
  })

  it('⚠ the student screen counts its OWN null rounds from the data', () => {
    const rows = [
      { round: 1, yourCost: 34, yourBid: 38, won: false, price: 36, profit: 0, profitTotal: 0,
        yourEquilibriumBid: null, exitPrice: 38, exitCensored: false },
      // Dropped out without ever bidding — no stopping point to plot.
      { round: 2, yourCost: 55, yourBid: null, won: false, price: 24, profit: 0, profitTotal: 0,
        yourEquilibriumBid: null, exitPrice: null, exitCensored: false },
    ]
    const html = renderToStaticMarkup(
      <OpenEndScreen params={PARAMS} history={rows} totalProfit={0} totalPerfectProfit={0}
        roundsWon={0} botCosts={null} />)
    expect(textOf(html, 'proc-exit-never-bid')).toContain('1 round is not plotted')
    // ⚠ AND THE TABLE STILL SHOWS THE ROUND — it is not plotted, not hidden.
    expect(textOf(html, 'proc-open-end-table')).toContain('55')
  })
})

// ── ITEM 1 — column sorting on the instructor tables ─────────────────────────
//
// ⚠⚠ AN ADOPTION, NOT A RESTORATION. `git log` over every commit that ever touched
// procurement's Dashboard.tsx and Reports.tsx shows neither file has EVER contained
// `SortableTable` — procurement shipped a plain `<table>` at CP1 and never had column
// sorting. Five of the seven single-player games use the shared widget; forecast's
// dashboard has never used it either. See BUILD_NOTES §6k for the full audit.
//
// ⚠ THE COLUMN SETS ARE FORMAT-NEUTRAL — name, status, rounds, won, profit (+ KC on the
// dashboard) are roster facts both mechanisms produce, so the sorting is not wired to a
// sealed-only or open-only column. The format-specific detail is one level down, in the
// per-student rounds modal, which already has the gate.

import { rosterColumns, rosterRank } from './Reports'
import { buildColumns as dashColumns } from './Dashboard'

const row = (over: Record<string, unknown> = {}) => ({
  participantId: 'p1', name: 'Bravo', externalId: null, finished: false,
  roundsPlayed: 3, roundsWon: 1, profitTotal: 20, knowledgeCheckScore: 0.5,
  rawScore: null, normalizedScore: null, rounds: [], rivalPoints: [], freeText: {},
  ...over,
} as never)

describe('the instructor tables sort by column', () => {
  const dash = dashColumns(8)
  const roster = rosterColumns(() => {})

  it('every named column is present on each table', () => {
    expect(dash.map(c => c.key)).toEqual(['name', 'status', 'rounds', 'won', 'profit', 'kc'])
    expect(roster.map(c => c.key)).toEqual(['name', 'status', 'rounds', 'won', 'profit'])
  })

  it('⚠ NUMERIC columns compare numbers, not strings', () => {
    // The string-sort bug pennies' header records shipping twice: "10" < "9".
    const nine = row({ roundsPlayed: 9, roundsWon: 9, profitTotal: 9 })
    const ten = row({ roundsPlayed: 10, roundsWon: 10, profitTotal: 10 })
    for (const key of ['rounds', 'won', 'profit'] as const) {
      const d = dash.find(c => c.key === key)!
      const r = roster.find(c => c.key === key)!
      expect(d.compare(nine, ten), `dashboard ${key}`).toBeLessThan(0)
      expect(r.compare(nine, ten), `roster ${key}`).toBeLessThan(0)
    }
  })

  it('⚠ Name sorts case-insensitively', () => {
    const lower = row({ name: 'alpha' })
    const upper = row({ name: 'Bravo' })
    expect(dash.find(c => c.key === 'name')!.compare(lower, upper)).toBeLessThan(0)
    expect(roster.find(c => c.key === 'name')!.compare(lower, upper)).toBeLessThan(0)
    // A case-SENSITIVE compare would put every capital before every lower-case letter.
    expect(dash.find(c => c.key === 'name')!.compare(row({ name: 'Zulu' }), row({ name: 'alpha' })))
      .toBeGreaterThan(0)
  })

  it('⚠⚠ Status sorts by PROGRESS, not alphabetically', () => {
    // Alphabetically: Finished < In progress < Not started — the exact reverse of useful.
    const notStarted = row({ roundsPlayed: 0, finished: false })
    const inProgress = row({ roundsPlayed: 3, finished: false })
    const finished = row({ roundsPlayed: 8, finished: true })
    const finalized = row({ roundsPlayed: 8, finished: true, normalizedScore: 0.9 })

    const st = dash.find(c => c.key === 'status')!
    expect(st.compare(notStarted, inProgress)).toBeLessThan(0)
    expect(st.compare(inProgress, finished)).toBeLessThan(0)
    expect(st.compare(finished, finalized)).toBeLessThan(0)

    // The report has no `finalized` state of its own; the other three still rank.
    expect(rosterRank(notStarted)).toBeLessThan(rosterRank(inProgress))
    expect(rosterRank(inProgress)).toBeLessThan(rosterRank(finished))
  })

  it('⚠ a student who has not sat the KC sorts LAST, not among the zeroes', () => {
    const kc = dash.find(c => c.key === 'kc')!
    expect(kc.nullsLast).toBe(true)
    expect(kc.isNull!(row({ knowledgeCheckScore: null }))).toBe(true)
    expect(kc.isNull!(row({ knowledgeCheckScore: 0 }))).toBe(false)
  })

  it('⚠ "See rounds" is an ACTION, not a sortable column', () => {
    // It lives inside the Name cell. `SortableTable` makes every column header clickable,
    // so a column of buttons would advertise a sort that means nothing.
    expect(roster.map(c => c.key)).not.toContain('actions')
    expect(roster.map(c => c.label)).not.toContain('')
  })
})
