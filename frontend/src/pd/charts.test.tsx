import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { CooperationChartSVG, runsOf } from './CooperationChartSVG'
import { FirstMoveChartSVG } from './FirstMoveChartSVG'
import type { PdCooperationPoint, PdFirstMoveOutcome, PdMoveLabels } from './api'

// Static-markup tests for the two Tier-3 charts. Both are pure presentation (types-only
// imports from api.ts), so renderToStaticMarkup reaches them without jsdom. The MATHS
// they draw is tested server-side in pdReportStats.test.ts; what is asserted here is
// that the components render the series they were given, label them with the
// instance's unit, claim no direction, and degrade sensibly when a group is empty.

const LABELS: PdMoveLabels = { C: 'Cooperate', D: 'Defect' }
const visible = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()

const pt = (round: number, tft: number | null, grim: number | null, tftN = 2, grimN = 2): PdCooperationPoint =>
  ({ round, tft, grim, tftN, grimN })

describe('runsOf — gaps break the line rather than faking 0%', () => {
  it('returns one run when every point has data', () => {
    const runs = runsOf([pt(1, 1, 0), pt(2, 0.5, 0)], 'tft')
    expect(runs).toHaveLength(1)
    expect(runs[0].map(p => p.round)).toEqual([1, 2])
  })

  it('splits into separate runs around a null', () => {
    const runs = runsOf([pt(1, 1, 0), pt(2, null, 0), pt(3, 0.5, 0)], 'tft')
    expect(runs.map(r => r.map(p => p.round))).toEqual([[1], [3]])
  })

  it('is empty when the series has no data at all', () => {
    expect(runsOf([pt(1, null, 0), pt(2, null, 0)], 'tft')).toEqual([])
  })

  it('reads the requested series only', () => {
    const runs = runsOf([pt(1, null, 0.5)], 'grim')
    expect(runs).toEqual([[{ round: 1, value: 0.5 }]])
  })
})

describe('CooperationChartSVG — Tier 3a', () => {
  const points = [pt(1, 1, 1), pt(2, 1, 0.5), pt(3, 0.5, 0)]
  const html = renderToStaticMarkup(<CooperationChartSVG points={points} />)

  it('renders the chart with both labelled series', () => {
    expect(html).toContain('data-testid="pd-cooperation-chart"')
    expect(html).toContain('data-testid="pd-coop-line-tft"')
    expect(html).toContain('data-testid="pd-coop-line-grim"')
    const text = visible(html)
    expect(text).toContain('Tit-for-tat')
    expect(text).toContain('GRIM')
  })

  it('labels the x axis as rounds and the y axis as percentages', () => {
    const text = visible(html)
    expect(text).toContain('Round')
    expect(text).toContain('100%')
    expect(text).toContain('0%')
  })

  it('explains that the denominator is students who played that round', () => {
    expect(visible(html)).toContain('played')
  })

  it('says so plainly when there is nothing to draw', () => {
    const empty = renderToStaticMarkup(<CooperationChartSVG points={[]} />)
    expect(visible(empty)).toContain('No rounds played yet')
    expect(empty).not.toContain('<svg')
  })

  it('draws a one-round instance without dividing by zero', () => {
    const one = renderToStaticMarkup(<CooperationChartSVG points={[pt(1, 1, 0)]} />)
    expect(one).toContain('<svg')
    expect(one).not.toContain('NaN')
  })
})

describe('FirstMoveChartSVG — Tier 3b', () => {
  const outcomes: PdFirstMoveOutcome[] = [
    { firstMove: 'C', strategy: 'tft', avgYearsPerRound: 1, n: 3 },
    { firstMove: 'C', strategy: 'grim', avgYearsPerRound: 1.2, n: 2 },
    { firstMove: 'D', strategy: 'tft', avgYearsPerRound: 5.3, n: 2 },
    { firstMove: 'D', strategy: 'grim', avgYearsPerRound: 9.8, n: 4 },
  ]
  const html = renderToStaticMarkup(<FirstMoveChartSVG outcomes={outcomes} labels={LABELS} />)

  it('draws one bar per (first move × strategy)', () => {
    for (const id of ['C-tft', 'C-grim', 'D-tft', 'D-grim']) {
      expect(html).toContain(`data-testid="pd-firstmove-bar-${id}"`)
    }
  })

  it('labels the groups with the instance’s move labels', () => {
    const text = visible(html)
    expect(text).toContain('Opened with Cooperate')
    expect(text).toContain('Opened with Defect')
    const custom = visible(renderToStaticMarkup(
      <FirstMoveChartSVG outcomes={outcomes} labels={{ C: 'Stay silent', D: 'Confess' }} />))
    expect(custom).toContain('Opened with Stay silent')
  })

  it('prints each value to one decimal place and its group size', () => {
    const text = visible(html)
    expect(text).toContain('9.8')
    expect(text).toContain('n=4')
  })

  it('⚠ states NO direction — the unit is configurable, so the chart cannot know', () => {
    const text = visible(html).toLowerCase()
    for (const phrase of ['lower is better', 'higher is better', 'worse outcome', 'losses']) {
      expect(text).not.toContain(phrase)
    }
    // It still says what the bars MEASURE.
    expect(text).toContain('per round')
  })

  it('labels the axis with the configured unit', () => {
    const custom = visible(renderToStaticMarkup(
      <FirstMoveChartSVG outcomes={outcomes} labels={LABELS} unit="points" />))
    expect(custom).toContain('Avg points / round')
    expect(custom).not.toContain('years')
  })

  it('shows the GRIM-punishes-defectors contrast when the data has it', () => {
    // Not an assertion about the chart's maths (that is server-side) — an assertion
    // that both values reach the DOM so the contrast is visible at all.
    const text = visible(html)
    expect(text).toContain('5.3')
    expect(text).toContain('9.8')
  })

  it('marks an empty cell as "no data" rather than a zero-height bar', () => {
    const sparse: PdFirstMoveOutcome[] = [
      { firstMove: 'C', strategy: 'tft', avgYearsPerRound: 1, n: 1 },
      { firstMove: 'C', strategy: 'grim', avgYearsPerRound: null, n: 0 },
      { firstMove: 'D', strategy: 'tft', avgYearsPerRound: null, n: 0 },
      { firstMove: 'D', strategy: 'grim', avgYearsPerRound: null, n: 0 },
    ]
    const out = renderToStaticMarkup(<FirstMoveChartSVG outcomes={sparse} labels={LABELS} />)
    expect(visible(out)).toContain('no data')
    expect(out).not.toContain('data-testid="pd-firstmove-bar-D-grim"')
  })

  it('says so plainly when nothing has been played', () => {
    const none: PdFirstMoveOutcome[] = [
      { firstMove: 'C', strategy: 'tft', avgYearsPerRound: null, n: 0 },
      { firstMove: 'C', strategy: 'grim', avgYearsPerRound: null, n: 0 },
      { firstMove: 'D', strategy: 'tft', avgYearsPerRound: null, n: 0 },
      { firstMove: 'D', strategy: 'grim', avgYearsPerRound: null, n: 0 },
    ]
    const out = renderToStaticMarkup(<FirstMoveChartSVG outcomes={none} labels={LABELS} />)
    expect(visible(out)).toContain('No completed games yet')
    expect(out).not.toContain('<svg')
  })
})
