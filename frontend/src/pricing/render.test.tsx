// eslint-disable-next-line @typescript-eslint/no-unused-vars -- classic JSX transform
import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

// DebriefScreen imports the callables (not just their types), and api.ts reaches
// ../firebase, which initializes Firebase Auth on import — in Node that throws. The
// component is still pure presentation for rendering purposes: nothing is CALLED
// until a button is clicked, and these tests never click. So the module is stubbed
// rather than the component being left untested.
vi.mock('../firebase', () => ({ auth: {}, db: {}, functions: {} }))
import { HistoryTable } from './HistoryTable'
import { EndScreen } from './EndScreen'
import { MarketFacts, Formulas, PmgRules, Framing } from './MarketPanel'
import { PmgRulesScreen } from './PmgRulesScreen'
import { DebriefScreen } from './DebriefScreen'
import { formatPrice, formatProfitM, formatShare, formatDemand } from './format'
import { pricingResumeIndex, pricingScreenCount, pricingStartIteration } from './resume'
import type { PricingHistoryRow, PricingLabels, PricingMarket } from './api'

// Static-markup render tests. The repo has no jsdom/testing-library, but every
// component here is pure presentation (they import only TYPES from api.ts, so nothing
// touches Firebase), which makes renderToStaticMarkup enough to assert the things
// that actually matter: the numbers land in the right cells, the PMG variant swaps
// what it should, and nothing the student must not see is in the output.

const MARKET: PricingMarket = {
  marketSize: 190_000,
  studentBaseShare: 0.35,
  competitorBaseShare: 0.65,
  studentUnitCost: 966,
  competitorUnitCost: 900,
  slope: 1000,
  minPrice: 900,
  maxPrice: 2000,
}
const LABELS: PricingLabels = { student: 'CSC', competitor: 'WNS' }

/** The VISIBLE text of a testid'd element (tags stripped, whitespace collapsed).
 *  Asserting on text rather than raw markup keeps inline styles from colliding with
 *  the words being looked for.
 *
 *  Unlike PD's copy of this helper, data-testid need not be the FIRST attribute —
 *  a grouped header carries colSpan/rowSpan ahead of it, and a regex that assumed
 *  otherwise would silently return null and pass a `not.toContain` assertion for the
 *  wrong reason. */
const textOf = (html: string, testid: string) => {
  const m = html.match(new RegExp(`<(\\w+)[^>]*\\bdata-testid="${testid}"[^>]*>([\\s\\S]*?)</\\1>`))
  return m ? m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : null
}

/** All visible text in the markup. */
const visibleText = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()

function row(n: number, over: Partial<PricingHistoryRow> = {}): PricingHistoryRow {
  return {
    round: n,
    yourPrice: 1800,
    competitorPrice: 2000,
    effectivePrice: null,
    yourShare: 0.55,
    competitorShare: 0.45,
    yourDemand: 104_500,
    competitorDemand: 85_500,
    yourProfit: 87_153_000,
    competitorProfit: 94_050_000,
    yourTotal: 87_153_000,
    yourAverage: 87_153_000,
    ...over,
  }
}

describe('number formatting (spec §4 — the case table’s own format)', () => {
  it('profits are millions to two decimals', () => {
    expect(formatProfitM(87_153_000)).toBe('$87.15M')
    expect(formatProfitM(94_050_000)).toBe('$94.05M')
    expect(formatProfitM(37_110_000)).toBe('$37.11M')
  })

  it('a LOSS reads as a loss, with the sign outside the dollar sign', () => {
    expect(formatProfitM(-12_540_000)).toBe('−$12.54M')
    expect(formatProfitM(-4_389_000)).toBe('−$4.39M')
  })

  it('zero is never rendered as a negative zero', () => {
    expect(formatProfitM(0)).toBe('$0.00M')
    expect(formatProfitM(-1)).toBe('$0.00M')     // −$0.000001M rounds to nothing
    expect(formatProfitM(-10_000)).toBe('−$0.01M')
  })

  it('prices are whole dollars with separators; shares one decimal; demand whole containers', () => {
    expect(formatPrice(1600)).toBe('$1,600')
    expect(formatPrice(900)).toBe('$900')
    expect(formatShare(0.55)).toBe('55.0%')
    expect(formatShare(0.4873)).toBe('48.7%')
    expect(formatDemand(104_500)).toBe('104,500')
    expect(formatDemand(92_587.4)).toBe('92,587')
  })
})

describe('HistoryTable — grouped headers, rounds PLAYED only (spec §4)', () => {
  const html = renderToStaticMarkup(
    <HistoryTable history={[row(1), row(2, { yourProfit: -12_540_000, yourTotal: 74_613_000, yourAverage: 37_306_500 })]}
      labels={LABELS} pmg={false} />,
  )

  it('has the two firm blocks, named for the two firms', () => {
    expect(textOf(html, 'pricing-hist-block-you')).toBe('CSC (you)')
    expect(textOf(html, 'pricing-hist-block-competitor')).toBe('WNS (your competitor)')
    expect(textOf(html, 'pricing-hist-block-totals')).toBe('Your profit so far')
  })

  it('renders one row per round played, and nothing else', () => {
    expect(html).toContain('data-testid="pricing-history-row-1"')
    expect(html).toContain('data-testid="pricing-history-row-2"')
    expect(html).not.toContain('data-testid="pricing-history-row-3"')
  })

  it('carries the running cumulative AND average per row (spec §4)', () => {
    expect(textOf(html, 'pricing-history-total-2')).toBe('$74.61M')
    expect(textOf(html, 'pricing-history-average-2')).toBe('$37.31M')
  })

  it('shows a loss as a loss', () => {
    expect(textOf(html, 'pricing-history-your-profit-2')).toBe('−$12.54M')
  })

  it('⚠ says nothing about rounds remaining or a total — there is no such number', () => {
    const text = visibleText(html).toLowerCase()
    for (const word of ['of 10', 'of 20', 'remaining', 'left', 'total rounds', 'last round']) {
      expect(text).not.toContain(word)
    }
  })

  it('⚠ never calls the competitor "the bot" (spec §1)', () => {
    expect(visibleText(html).toLowerCase()).not.toContain('the bot')
  })

  it('an empty history invites the first round rather than showing a bare grid', () => {
    const empty = renderToStaticMarkup(<HistoryTable history={[]} labels={LABELS} pmg={false} />)
    expect(empty).toContain('data-testid="pricing-history-empty"')
    expect(empty).not.toContain('data-testid="pricing-history"')
  })
})

describe('HistoryTable — the PMG column (spec §6.4)', () => {
  const pmgRow = row(1, { effectivePrice: 1600, yourPrice: 1600, competitorPrice: 2000 })

  it('adds the price-paid column in PMG mode', () => {
    const html = renderToStaticMarkup(<HistoryTable history={[pmgRow]} labels={LABELS} pmg />)
    expect(textOf(html, 'pricing-hist-block-paid')).toBe('Price paid')
    expect(textOf(html, 'pricing-history-paid-1')).toBe('$1,600')
  })

  it('and does NOT add it in Standard mode, where there is no single price paid', () => {
    const html = renderToStaticMarkup(<HistoryTable history={[row(1)]} labels={LABELS} pmg={false} />)
    expect(html).not.toContain('data-testid="pricing-hist-block-paid"')
    expect(html).not.toContain('data-testid="pricing-history-paid-1"')
  })
})

describe('MarketFacts — every number from config (spec §4)', () => {
  const html = renderToStaticMarkup(<MarketFacts market={MARKET} labels={LABELS} />)

  it('states the market size and the price bounds', () => {
    const t = textOf(html, 'pricing-market-size') ?? ''
    expect(t).toContain('190,000 containers')
    expect(t).toContain('$900')
    expect(t).toContain('$2,000')
  })

  it('gives BOTH firms’ base share and unit cost — the case gives students both', () => {
    expect(textOf(html, 'pricing-market-you')).toBe('CSC (you) 35.0% $966')
    expect(textOf(html, 'pricing-market-competitor')).toBe('WNS (your competitor) 65.0% $900')
  })

  it('follows an EDITED market rather than the shipped numbers', () => {
    const edited = renderToStaticMarkup(
      <MarketFacts market={{ ...MARKET, marketSize: 250_000, studentUnitCost: 1000 }} labels={LABELS} />)
    expect(textOf(edited, 'pricing-market-size')).toContain('250,000 containers')
    expect(textOf(edited, 'pricing-market-you')).toBe('CSC (you) 35.0% $1,000')
  })
})

describe('Formulas — the mode swaps them outright (spec §2 vs §6.1)', () => {
  it('Standard shows the share-responds-to-price formulas', () => {
    const html = renderToStaticMarkup(<Formulas market={MARKET} labels={LABELS} pmg={false} />)
    expect(html).toContain('data-testid="pricing-formulas-standard"')
    expect(html).not.toContain('data-testid="pricing-formulas-pmg"')
    const t = visibleText(html)
    expect(t).toContain('their price − your price')
    expect(t).toContain('$1,000')      // the slope, from config
    expect(t).toContain('$966')        // the student's unit cost, from config
  })

  it('PMG shows fixed shares and the lower-of-the-two price', () => {
    const html = renderToStaticMarkup(<Formulas market={MARKET} labels={LABELS} pmg />)
    expect(html).toContain('data-testid="pricing-formulas-pmg"')
    expect(html).not.toContain('data-testid="pricing-formulas-standard"')
    const t = visibleText(html)
    expect(t).toContain('LOWER of the two posted prices')
    expect(t).toContain('CSC share = 35.0% (fixed)')
    expect(t).toContain('WNS share = 65.0% (fixed)')
  })
})

describe('PmgRules — the §6.2 announcement, rendered from config', () => {
  const html = renderToStaticMarkup(<PmgRules market={MARKET} labels={LABELS} />)

  it('states the rule', () => {
    const t = visibleText(html)
    expect(t).toContain('Price Matching Guarantee')
    expect(t).toContain('always pay the lower')
  })

  it('states the frozen shares from config', () => {
    const t = visibleText(html)
    expect(t).toContain('35.0%')
    expect(t).toContain('65.0%')
  })

  it('⚠ its worked example uses IN-BOUNDS prices, so an edited band cannot strand it', () => {
    const narrow = { ...MARKET, minPrice: 1000, maxPrice: 1200 }
    const t = textOf(renderToStaticMarkup(<PmgRules market={narrow} labels={LABELS} />), 'pricing-pmg-example') ?? ''
    const prices = [...t.matchAll(/\$([\d,]+)/g)].map(m => Number(m[1].replace(/,/g, '')))
    expect(prices.length).toBeGreaterThan(0)
    for (const p of prices) {
      expect(p).toBeGreaterThanOrEqual(narrow.minPrice)
      expect(p).toBeLessThanOrEqual(narrow.maxPrice)
    }
  })
})

describe('Framing — the only thing the copy may say about length (spec §1, §3)', () => {
  const html = renderToStaticMarkup(<Framing labels={LABELS} minRounds={10} maxRounds={20} />)

  it('states the RANGE and that the last round is not announced', () => {
    const t = visibleText(html)
    expect(t).toContain('between 10 and 20 rounds')
    expect(t).toContain('not be told when the last one is')
  })

  it('calls the opponent "your competitor", never "the bot"', () => {
    const t = visibleText(html).toLowerCase()
    expect(t).toContain('your competitor')
    expect(t).not.toContain('the bot')
  })
})

describe('EndScreen — the reveal, and only after the game (spec §4)', () => {
  const history = [row(1), row(2, { yourTotal: 174_306_000, yourAverage: 87_153_000 })]
  const html = renderToStaticMarkup(
    <EndScreen history={history} labels={LABELS} pmg={false}
      totalProfit={174_306_000} averageProfit={87_153_000}
      competitorReveal="Your competitor was programmed to open at the highest allowed price." />)

  it('reveals how many rounds the game lasted — counted from the rows themselves', () => {
    expect(textOf(html, 'pricing-final-rounds')).toBe('2')
    expect(visibleText(html)).toContain('Your game lasted')
  })

  it('reports total and average profit in the same format the table used', () => {
    expect(textOf(html, 'pricing-final-total')).toBe('$174.31M')
    expect(textOf(html, 'pricing-final-average')).toBe('$87.15M')
  })

  it('repeats the competitor reveal, so a student who comes back does not lose it', () => {
    expect(html).toContain('data-testid="pricing-final-reveal"')
    expect(visibleText(html)).toContain('Your competitor was programmed to')
  })

  it('and omits that section entirely when the server sent no reveal', () => {
    const bare = renderToStaticMarkup(
      <EndScreen history={history} labels={LABELS} pmg={false}
        totalProfit={1} averageProfit={1} competitorReveal={null} />)
    expect(bare).not.toContain('data-testid="pricing-final-reveal"')
  })

  it('still shows the full history', () => {
    expect(html).toContain('data-testid="pricing-history-row-2"')
  })
})

describe('DebriefScreen — the reveal is the point of it (spec §9)', () => {
  const history = [row(1), row(2)]
  const QUESTION = {
    field: 'debrief_reflection',
    prompt: 'In a few sentences, explain your pricing strategy.',
    placeholder: 'A few sentences are plenty.',
  }
  const html = renderToStaticMarkup(
    <DebriefScreen
      question={QUESTION}
      competitorReveal="Your competitor was programmed to open at the highest allowed price, then best-reply."
      history={history} labels={LABELS} pmg={false}
      totalProfit={174_306_000} averageProfit={87_153_000}
      onDone={() => {}} />)

  it('shows the mode’s prompt and says it is ungraded', () => {
    expect(textOf(html, 'pricing-debrief-prompt')).toBe(QUESTION.prompt)
    expect(visibleText(html)).toContain('not graded')
  })

  it('⚠ shows the competitor reveal, ABOVE the question they are about to answer', () => {
    expect(html).toContain('data-testid="pricing-competitor-reveal"')
    expect(html.indexOf('pricing-competitor-reveal')).toBeLessThan(html.indexOf('pricing-debrief-prompt'))
  })

  it('states the round count and the totals — the game is over, so it may', () => {
    expect(textOf(html, 'pricing-debrief-rounds')).toBe('2')
    expect(textOf(html, 'pricing-debrief-total')).toBe('$174.31M')
  })

  it('keeps the history on screen while they write', () => {
    expect(html).toContain('data-testid="pricing-history-row-2"')
  })

  it('renders without a reveal rather than breaking, if the server sent none', () => {
    const bare = renderToStaticMarkup(
      <DebriefScreen question={QUESTION} competitorReveal={null} history={history}
        labels={LABELS} pmg={false} totalProfit={0} averageProfit={0} onDone={() => {}} />)
    expect(bare).not.toContain('data-testid="pricing-competitor-reveal"')
    expect(bare).toContain('data-testid="pricing-debrief-input"')
  })
})

describe('PmgRulesScreen — the standalone §6.2 announcement', () => {
  const html = renderToStaticMarkup(
    <PmgRulesScreen market={MARKET} labels={LABELS} minRounds={10} maxRounds={20} onDone={() => {}} />)

  it('leads with the rule change and nothing else to do', () => {
    expect(html).toContain('data-testid="pricing-pmg-screen"')
    expect(html).toContain('data-testid="pricing-pmg-rules"')
    expect(html).toContain('data-testid="pricing-pmg-continue"')
  })

  it('carries no knowledge check — that comes after', () => {
    expect(html).not.toContain('pricing-kc-')
  })

  it('states the round RANGE, the only schedule fact a student may be told', () => {
    expect(visibleText(html)).toContain('between 10 and 20 rounds')
  })
})

describe('pricingResumeIndex — where a returning student lands', () => {
  const base = { pmg: false, kcCount: 4, kcAnswered: 0, gameOver: false, debriefEnabled: true, debriefSubmitted: false }

  it('brand new (Standard): the first KC question', () => {
    expect(pricingResumeIndex(base)).toBe(0)
  })

  it('brand new (PMG): the rules screen, ahead of the KC', () => {
    expect(pricingResumeIndex({ ...base, pmg: true, kcCount: 3 })).toBe(0)
    expect(pricingScreenCount(true, 3, true)).toBe(6)   // rules + 3 KC + loop + debrief
  })

  it('part-way through the KC: the first unanswered question — past the rules screen', () => {
    expect(pricingResumeIndex({ ...base, kcAnswered: 2 })).toBe(2)
    expect(pricingResumeIndex({ ...base, pmg: true, kcCount: 3, kcAnswered: 2 })).toBe(3)
  })

  it('KC done, game running: the round loop', () => {
    expect(pricingResumeIndex({ ...base, kcAnswered: 4 })).toBe(4)
    expect(pricingResumeIndex({ ...base, pmg: true, kcCount: 3, kcAnswered: 3 })).toBe(4)
  })

  it('game over: the debrief', () => {
    expect(pricingResumeIndex({ ...base, kcAnswered: 4, gameOver: true })).toBe(5)
  })

  it('debrief submitted: past the end', () => {
    const done = { ...base, kcAnswered: 4, gameOver: true, debriefSubmitted: true }
    expect(pricingResumeIndex(done)).toBe(6)
    expect(pricingResumeIndex(done)).toBeGreaterThanOrEqual(pricingScreenCount(false, 4, true))
  })

  it('no debrief configured: game over IS the end', () => {
    const noDebrief = { ...base, kcAnswered: 4, gameOver: true, debriefEnabled: false }
    expect(pricingResumeIndex(noDebrief)).toBe(5)
    expect(pricingResumeIndex(noDebrief)).toBeGreaterThanOrEqual(pricingScreenCount(false, 4, false))
  })

  it('no KC configured: the loop is the first screen', () => {
    expect(pricingResumeIndex({ ...base, kcCount: 0, kcAnswered: 0 })).toBe(0)
  })

  it('⚠ gameOver comes from the SERVER, never from counting rounds', () => {
    // Nothing here takes a round count at all — the browser has no horizon to compare
    // against, which is exactly what spec §3 requires.
    expect(Object.keys(base).sort())
      .toEqual(['debriefEnabled', 'debriefSubmitted', 'gameOver', 'kcAnswered', 'kcCount', 'pmg'])
  })

  it('the round loop resumes at the next unplayed round', () => {
    expect(pricingStartIteration(6)).toBe(6)
    expect(pricingStartIteration(0)).toBe(0)
  })
})
