// eslint-disable-next-line @typescript-eslint/no-unused-vars -- classic JSX transform
import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

// api.ts reaches ../firebase, which initializes Firebase on import and throws in Node.
// The components are pure presentation for rendering purposes — nothing is CALLED until
// a control is used, and these tests never use one — so the module is stubbed rather
// than the components being left untested.
vi.mock('../firebase', () => ({ auth: {}, db: {}, functions: {} }))
import { EndScreen } from './EndScreen'
import { PlaceBid } from './RoundScreen'
import { HistoryTable } from './HistoryTable'
import { ScatterSVG, optimalBid } from './ScatterSVG'
import { ecu, signedEcu, bidAmount } from './format'
import type { ProcurementParams, ProcurementPlayedRow, ProcurementRivalPoint } from './api'

// ═══════════════════════════════════════════════════════════════════════════════
// Static-markup render tests. The repo has no jsdom, but everything below is pure
// presentation, which makes renderToStaticMarkup enough to assert what matters: the
// right numbers in the right cells, the config-derived optimal line, and — the one that
// would be expensive to get wrong — that the bot series stays OFF and stays absent when
// the server has not revealed it.
// ═══════════════════════════════════════════════════════════════════════════════

const PARAMS: ProcurementParams = {
  format: 'sealed_first_price',
  rounds: 8,
  rivalCount: 4,
  totalBidders: 5,
  reserve: 110,
  rivalCostMin: 10,
  rivalCostMax: 110,
  bidIncrementUnit: 1,
  currencyLabel: 'ECU',
  decrementSchedule: [],
  botDelayMs: [1000, 2000],
}

const row = (over: Partial<ProcurementPlayedRow> = {}): ProcurementPlayedRow => ({
  round: 1, yourCost: 30, yourBid: 50, won: true, price: 50, profit: 20,
  profitTotal: 20, yourEquilibriumBid: 46, ...over,
})

/** The VISIBLE text of a testid'd element (tags stripped, whitespace collapsed). */
function textOf(html: string, testId: string): string | null {
  const re = new RegExp(`<([a-z0-9]+)[^>]*data-testid="${testId}"[^>]*>([\\s\\S]*?)</\\1>`)
  const m = html.match(re)
  // ⚠ Tags become a SPACE, not nothing: adjacent <td>s carry no whitespace between
  // them, so stripping to '' silently welds "1 of 8" onto "30 ECU" and an assertion
  // written the obvious way fails for a reason that looks like a rendering bug.
  return m ? m[2].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() : null
}

// ── The optimal line ───────────────────────────────────────────────────────────

describe('§9 the optimal line is COMPUTED FROM CONFIG, never hardcoded', () => {
  it('at the shipped numbers it reproduces the slide\'s b = 0.8c + 22', () => {
    // θmax = 110, n = 5 ⇒ β(c) = c + (110 − c)/5 = 0.8c + 22. The slide's constant is a
    // consequence of the config, which is the whole point — it is not the formula.
    for (const c of [10, 25, 40, 55, 60]) {
      expect(optimalBid(c, PARAMS)).toBeCloseTo(0.8 * c + 22, 9)
    }
  })

  it('⚠ a different rival range moves the line — the slide\'s constant would NOT', () => {
    const wider = { ...PARAMS, rivalCostMax: 200, reserve: 200 }
    expect(optimalBid(40, wider)).toBeCloseTo(40 + (200 - 40) / 5, 9)
    expect(optimalBid(40, wider)).not.toBeCloseTo(0.8 * 40 + 22, 6)
  })

  it('⚠ a different bidder count moves it too', () => {
    const eight = { ...PARAMS, rivalCount: 7, totalBidders: 8 }
    expect(optimalBid(40, eight)).toBeCloseTo(40 + (110 - 40) / 8, 9)
    expect(optimalBid(40, eight)).not.toBeCloseTo(0.8 * 40 + 22, 6)
  })

  it('⚠ at a LOWERED reserve it diverges from the simple form — the load-bearing case', () => {
    // The reserve-conditioned second term is what makes this true. Deleting it as "dead
    // arithmetic" leaves every default-reserve check passing and this one failing, which
    // is exactly why this assertion exists here as well as server-side.
    const low = { ...PARAMS, reserve: 70 }
    const simple = 40 + (110 - 40) / 5
    expect(optimalBid(40, low)).not.toBeCloseTo(simple, 6)
    expect(optimalBid(40, low)).toBeLessThan(simple)
  })

  it('returns null above the reserve — there is no bid worth making', () => {
    expect(optimalBid(80, { ...PARAMS, reserve: 70 })).toBeNull()
  })
})

// ── The scatter ────────────────────────────────────────────────────────────────

const RIVALS: ProcurementRivalPoint[] = [
  { round: 1, cost: 80, bid: 86 },
  { round: 1, cost: 40, bid: 54 },
]

describe('§9 the scatter', () => {
  const history = [row({ round: 1 }), row({ round: 2, yourCost: 45, yourBid: 58 })]

  it('plots one point per round', () => {
    const html = renderToStaticMarkup(<ScatterSVG params={PARAMS} history={history} rivals={null} />)
    expect(html.match(/data-testid="proc-scatter-you-point"/g)).toHaveLength(2)
  })

  it('draws both reference lines', () => {
    const html = renderToStaticMarkup(<ScatterSVG params={PARAMS} history={history} rivals={null} />)
    expect(html).toContain('data-testid="proc-scatter-optimal"')
    expect(html).toContain('stroke-dasharray="4 3"')
  })

  it('⚠ the bot series DEFAULTS TO OFF, even when the server has revealed it', () => {
    const html = renderToStaticMarkup(<ScatterSVG params={PARAMS} history={history} rivals={RIVALS} />)
    expect(html).toContain('data-testid="proc-scatter-bot-toggle"')
    expect(html).not.toContain('checked=""')
    expect(html).not.toContain('data-testid="proc-scatter-bot-point"')
  })

  it('⚠ and the toggle is ABSENT ENTIRELY while the game is live', () => {
    // `rivals === null` is the server's gate showing through: mid-game there is nothing
    // to toggle, so offering the control would advertise information that does not exist.
    const html = renderToStaticMarkup(<ScatterSVG params={PARAMS} history={history} rivals={null} />)
    expect(html).not.toContain('proc-scatter-bot-toggle')
    expect(html).not.toContain('proc-scatter-bot-point')
  })

  it('a round with no bid contributes no point', () => {
    const html = renderToStaticMarkup(
      <ScatterSVG params={PARAMS} history={[row({ yourBid: null })]} rivals={null} />)
    expect(html).not.toContain('proc-scatter-you-point')
  })
})

// ── The results screen ─────────────────────────────────────────────────────────

describe('§9 the final results screen', () => {
  const history = [
    row({ round: 1, yourCost: 30, yourBid: 50, won: true, price: 50, profit: 20, profitTotal: 20, yourEquilibriumBid: 46 }),
    row({ round: 2, yourCost: 45, yourBid: 58, won: false, price: 51, profit: 0, profitTotal: 20, yourEquilibriumBid: 58 }),
  ]
  const html = renderToStaticMarkup(
    <EndScreen
      params={PARAMS} history={history}
      totalProfit={20} totalEquilibriumProfit={33} roundsWon={1} rivalPoints={null}
    />)

  it('states wins and cumulative profit', () => {
    expect(textOf(html, 'proc-end-wins')).toBe('1')
    expect(textOf(html, 'proc-end-profit')).toBe('+20 ECU')
  })

  it('says what a perfect player would have earned FROM THESE DRAWS', () => {
    const s = textOf(html, 'proc-end-benchmark') ?? ''
    expect(s).toContain('+33 ECU')
    expect(s).toContain('your draws')
    // ⚠ Not a class comparison. A student who drew badly must not be told they did worse
    // than their classmates for it.
    expect(s).not.toMatch(/class|average student|rank|other students/i)
  })

  it('carries every §9 column, including the equilibrium bid', () => {
    expect(html).toContain('Optimal bid')
    expect(textOf(html, 'proc-end-row-1')).toBe('1 30 ECU 50 ECU 46 ECU 50 ECU Yes +20 ECU')
    // ⚠ A losing round reads "0 ECU", not "+0 ECU" — a signed zero implies a gain.
    expect(textOf(html, 'proc-end-row-2')).toBe('2 45 ECU 58 ECU 58 ECU 51 ECU No 0 ECU')
  })

  it('the table total agrees with the headline figure', () => {
    expect(textOf(html, 'proc-end-table-total')).toBe('+20 ECU')
  })

  it('says plainly that profit is not the grade', () => {
    expect(html).toContain('not your grade')
  })

  it('⚠ carries no rival COST anywhere when the reveal is null', () => {
    expect(html).not.toContain('proc-scatter-bot-point')
  })

  it('shows a Continue button only when a debrief follows', () => {
    expect(html).not.toContain('proc-end-continue')
    const withNext = renderToStaticMarkup(
      <EndScreen
        params={PARAMS} history={history}
        totalProfit={20} totalEquilibriumProfit={33} roundsWon={1} rivalPoints={null}
        onContinue={() => {}}
      />)
    expect(withNext).toContain('proc-end-continue')
  })

  it('says "no bid worth making" rather than a dash when the cost beat the reserve', () => {
    const h = renderToStaticMarkup(
      <EndScreen
        params={PARAMS} history={[row({ yourEquilibriumBid: null })]}
        totalProfit={0} totalEquilibriumProfit={0} roundsWon={0} rivalPoints={null}
      />)
    expect(h).toContain('no bid worth making')
  })
})

// ── The history table ──────────────────────────────────────────────────────────

describe('the in-play history table', () => {
  it('shows rounds played out of the configured total', () => {
    const html = renderToStaticMarkup(
      <HistoryTable history={[row()]} currency="ECU" totalRounds={8} />)
    expect(textOf(html, 'proc-history-row-1')).toBe('1 of 8 30 ECU 50 ECU 50 ECU Won +20 ECU +20 ECU')
  })

  it('renders nothing at all before the first round', () => {
    expect(renderToStaticMarkup(
      <HistoryTable history={[]} currency="ECU" totalRounds={8} />)).toBe('')
  })

  it('⚠ has no rival column, and the row type cannot supply one', () => {
    const html = renderToStaticMarkup(
      <HistoryTable history={[row()]} currency="ECU" totalRounds={8} />)
    expect(html).not.toMatch(/rival/i)
  })
})

// ── Formatting ─────────────────────────────────────────────────────────────────

describe('formatting', () => {
  it('uses the configured currency label, never a hardcoded ECU', () => {
    expect(ecu(48, 'credits')).toBe('48 credits')
  })

  it('signs profits, and a loss keeps its own minus', () => {
    expect(signedEcu(12, 'ECU')).toBe('+12 ECU')
    expect(signedEcu(0, 'ECU')).toBe('0 ECU')
    expect(signedEcu(-4, 'ECU')).toBe('-4 ECU')
  })

  it('a bidder who made no bid reads as "no bid", not as zero', () => {
    expect(bidAmount(null, 'ECU')).toBe('no bid')
    expect(bidAmount(0, 'ECU')).toBe('0 ECU')
  })
})

// ── §4: the player's own cost range is never shown ─────────────────────────────

describe('⚠ §4 the student is told the RIVAL distribution only', () => {
  // "Students are told the rival distribution only; their own range is never mentioned
  // because it is not needed to bid well." It follows from §5.2: a bidder's own cost
  // DISTRIBUTION does not enter their optimization, because the cost is realized before
  // they bid. Naming it invites reasoning about an irrelevant quantity and hints at the
  // deliberate U[10,60] vs U[10,110] asymmetry the spec keeps quiet.
  //
  // ⚠ The strongest guard is the TYPE: `ProcurementParams` has no playerCostMin/Max, so
  // a screen cannot print what it cannot reach. These render checks are the second line.

  it('the bidding screen prints the rival range and NOT a player range', () => {
    const html = renderToStaticMarkup(
      <PlaceBid roundNumber={1} cost={30} params={PARAMS} history={[]} onSubmitted={() => {}} />)
    expect(html).toContain('10 to 110')          // the rivals' — the lesson
    expect(html).not.toMatch(/10 to 60|between 10 and 60/)
    // The realized cost IS shown; it is the range that is not.
    expect(html).toContain('30 ECU')
  })

  it('the scatter takes its x-axis from the RIVAL range', () => {
    // ⚠ THE HONEST FORM OF THIS CHECK. My first version asserted the axis showed no "60"
    // tick — but 60 is an ordinary gradation on a 10–110 axis and carries nothing about
    // the player's range, and at the shipped config the axis was already 10–110 because
    // the rival max exceeds the player max. Asserting a tick's absence would have been a
    // test that passed for the wrong reason and failed on a cosmetic tick change.
    //
    // What is worth pinning is the DEPENDENCE: move the rival range and the axis moves
    // with it. The player's bounds cannot influence it — they are not on the type.
    const wide = { ...PARAMS, rivalCostMax: 200, reserve: 200 }
    const a = renderToStaticMarkup(<ScatterSVG params={PARAMS} history={[row()]} rivals={null} />)
    const b = renderToStaticMarkup(<ScatterSVG params={wide} history={[row()]} rivals={null} />)
    expect(a).not.toBe(b)
    expect(b).toContain('>200<')
    expect(a).not.toContain('>200<')
  })

  it('no student screen mentions a player cost range anywhere', () => {
    const screens = [
      renderToStaticMarkup(
        <PlaceBid roundNumber={1} cost={30} params={PARAMS} history={[row()]} onSubmitted={() => {}} />),
      renderToStaticMarkup(
        <EndScreen params={PARAMS} history={[row()]} totalProfit={20}
          totalEquilibriumProfit={33} roundsWon={1} rivalPoints={null} />),
      renderToStaticMarkup(<HistoryTable history={[row()]} currency="ECU" totalRounds={8} />),
    ]
    for (const html of screens) {
      expect(html).not.toMatch(/your cost.{0,40}(drawn from|between|range)/i)
      expect(html).not.toMatch(/10 to 60/)
    }
  })
})
