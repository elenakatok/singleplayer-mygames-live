import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { CooperationChartSVG, runsOf } from './CooperationChartSVG'
import { FirstMoveChartSVG } from './FirstMoveChartSVG'
import type { PdCooperationPoint, PdFirstMoveOutcome, PdMoveLabels } from './api'
import { STRATEGY_COLOR } from './strategyColors'

// Static-markup tests for the two Tier-3 charts. Both are pure presentation (types-only
// imports from api.ts), so renderToStaticMarkup reaches them without jsdom. The MATHS
// they draw is tested server-side in pdReportStats.test.ts; what is asserted here is
// that the components render the series they were given, label them with the
// instance's unit, claim no direction, and degrade sensibly when a group is empty.

const LABELS: PdMoveLabels = { C: 'Cooperate', D: 'Defect' }
const visible = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()

/**
 * One chart point in the CURRENT shape — a list of series, not four named fields.
 *
 * ⚠ THE SHAPE CHANGED with the seven-strategy library: `{tft, grim, tftN, grimN}`
 * hardcoded a two-strategy game into the wire format. The helper keeps the old
 * two-argument ergonomics so the existing assertions below read unchanged.
 */
const pt = (round: number, tft: number | null, grim: number | null, tftN = 2, grimN = 2): PdCooperationPoint =>
  ({
    round,
    series: [
      { strategy: 'tft', rate: tft, n: tftN },
      { strategy: 'grim', rate: grim, n: grimN },
    ],
  })

/** A point carrying an arbitrary set of series, for the seven-strategy assertions. */
const ptOf = (round: number, series: PdCooperationPoint['series']): PdCooperationPoint =>
  ({ round, series })

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
    // ⚠ NAMES COME FROM THE SERVER MAP NOW. With no map passed the raw id shows —
    // deliberately, rather than a client-side English table that could not render
    // "Always <first move>" and went stale the moment a strategy was added. The
    // seven-strategy block below asserts the labelled path.
    expect(text).toContain('tft (n=')
    expect(text).toContain('grim (n=')
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

// ═══════════════════════════════════════════════════════════════════════════════
// ⚠ NEGATIVE BARS — payoffs may be negative (spec §2), so a mean payoff per round can
// be below zero. The old scale was anchored at the frame's bottom edge, which made a
// negative bar's `height` NEGATIVE — an invalid <rect> that browsers silently drop, so
// the bar vanished with no error and its value label floated under the axis.
// ═══════════════════════════════════════════════════════════════════════════════

describe('FirstMoveChartSVG — a negative mean draws a real bar', () => {
  const LABELS2 = { C: 'Zarquon', D: 'Blorptide' }

  /** Every <rect> height in the markup, as numbers. */
  const rectHeights = (html: string) =>
    [...html.matchAll(/height="(-?[\d.]+)"/g)].map(m => Number(m[1]))

  const MIXED: PdFirstMoveOutcome[] = [
    { firstMove: 'C', strategy: 'tft', avgYearsPerRound: 2.5, n: 3 },
    { firstMove: 'C', strategy: 'grim', avgYearsPerRound: -1.5, n: 2 },
    { firstMove: 'D', strategy: 'tft', avgYearsPerRound: -3, n: 2 },
    { firstMove: 'D', strategy: 'grim', avgYearsPerRound: 1, n: 4 },
  ]

  const html = renderToStaticMarkup(
    <FirstMoveChartSVG outcomes={MIXED} labels={LABELS2} unit="points" />)

  it('renders all four bars', () => {
    for (const id of ['C-tft', 'C-grim', 'D-tft', 'D-grim']) {
      expect(html).toContain(`data-testid="pd-firstmove-bar-${id}"`)
    }
  })

  it('⚠⚠ NO RECT HAS A NEGATIVE HEIGHT — the failure mode was an invisible bar', () => {
    const hs = rectHeights(html)
    expect(hs.length).toBeGreaterThan(0)
    expect(hs.every(h => h >= 0)).toBe(true)
  })

  it('a zero line is drawn, because the axis now spans zero', () => {
    expect(html).toContain('data-testid="pd-firstmove-zeroline"')
  })

  it('negative and positive bars sit on OPPOSITE sides of the zero line', () => {
    const yOfBar = (id: string) => {
      const m = html.match(new RegExp(`data-testid="pd-firstmove-bar-${id}"[^>]*?y="([\\d.]+)"[^>]*?height="([\\d.]+)"`))
      expect(m).not.toBeNull()
      return { top: Number(m![1]), bottom: Number(m![1]) + Number(m![2]) }
    }
    const zero = Number(html.match(/pd-firstmove-zeroline"[^>]*?y1="([\d.]+)"/)![1])
    const pos = yOfBar('C-tft')     // +2.5
    const neg = yOfBar('D-tft')     // −3
    // A positive bar's bottom rests on the zero line; a negative bar's top does.
    expect(Math.abs(pos.bottom - zero)).toBeLessThan(0.001)
    expect(Math.abs(neg.top - zero)).toBeLessThan(0.001)
    expect(pos.top).toBeLessThan(zero)      // grows upward (SVG y increases downward)
    expect(neg.bottom).toBeGreaterThan(zero) // grows downward
  })

  it('⚠ NEGATIVE CONTROL — an all-positive chart draws NO zero line and is unchanged', () => {
    // The old code was correct for non-negative data, so a positive-only fixture cannot
    // distinguish the fix. Asserting the zero line is ABSENT here proves the new branch
    // is data-driven rather than always-on.
    const positive = renderToStaticMarkup(
      <FirstMoveChartSVG
        outcomes={[
          { firstMove: 'C', strategy: 'tft', avgYearsPerRound: 1, n: 3 },
          { firstMove: 'C', strategy: 'grim', avgYearsPerRound: 2, n: 2 },
          { firstMove: 'D', strategy: 'tft', avgYearsPerRound: 3, n: 2 },
          { firstMove: 'D', strategy: 'grim', avgYearsPerRound: 4, n: 4 },
        ]}
        labels={LABELS2} unit="points"
      />)
    expect(positive).toContain('data-testid="pd-firstmove-bar-C-tft"')
    expect(positive).not.toContain('pd-firstmove-zeroline')
    expect(rectHeights(positive).every(h => h >= 0)).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// ⚠ SEVEN STRATEGIES — one series per ASSIGNED strategy, named and counted.
// ═══════════════════════════════════════════════════════════════════════════════

describe('CooperationChartSVG — one series per assigned strategy', () => {
  const LABELS3: Record<string, string> = {
    tft: 'Tit-for-tat', grim: 'Grim', random: 'Random',
    always_first: 'Always Zarquon', always_second: 'Always Blorptide',
    alternate: 'Alternating',
  }
  const ALL: PdCooperationPoint['series'] = [
    { strategy: 'tft', rate: 1, n: 5 },
    { strategy: 'grim', rate: 0.5, n: 4 },
    { strategy: 'random', rate: 0.25, n: 3 },
    { strategy: 'always_first', rate: 0.8, n: 2 },
    { strategy: 'always_second', rate: 0.1, n: 6 },
    { strategy: 'alternate', rate: 0.6, n: 7 },
  ]

  it('draws all six lines and six legend entries', () => {
    const html = renderToStaticMarkup(
      <CooperationChartSVG points={[ptOf(1, ALL), ptOf(2, ALL)]} strategyLabels={LABELS3} />)
    expect(ALL.length).toBe(6)
    for (const s of ALL) {
      expect(html).toContain(`data-testid="pd-coop-line-${s.strategy}"`)
      expect(html).toContain(`data-testid="pd-coop-legend-${s.strategy}"`)
    }
  })

  it('⚠ EVERY LEGEND ENTRY STATES ITS OWN n= — a thin series must read as thin', () => {
    const text = renderToStaticMarkup(
      <CooperationChartSVG points={[ptOf(1, ALL)]} strategyLabels={LABELS3} />)
      .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
    // n taken from the fixture, not read back off the render.
    expect(text).toContain('Alternating (n=7)')
    expect(text).toContain('Always Blorptide (n=6)')
    expect(text).toContain('Tit-for-tat (n=5)')
  })

  it('⚠⚠ A STRATEGY WITH NO SERIES GETS NO LINE AND NO LEGEND ENTRY', () => {
    // The server sends only ASSIGNED strategies. Both halves asserted: the assigned one
    // appears, the checked-but-unassigned one does not.
    const twoOnly = ALL.filter(s => s.strategy === 'tft' || s.strategy === 'random')
    expect(twoOnly.length).toBe(2)
    const html = renderToStaticMarkup(
      <CooperationChartSVG points={[ptOf(1, twoOnly), ptOf(2, twoOnly)]} strategyLabels={LABELS3} />)
    expect(html).toContain('data-testid="pd-coop-line-tft"')
    expect(html).toContain('data-testid="pd-coop-line-random"')
    for (const absent of ['grim', 'always_first', 'always_second', 'alternate']) {
      expect(html).not.toContain(`data-testid="pd-coop-line-${absent}"`)
      expect(html).not.toContain(`data-testid="pd-coop-legend-${absent}"`)
    }
  })

  it('names come from the SERVER map, never from a hardcoded English table', () => {
    const renamed = renderToStaticMarkup(
      <CooperationChartSVG
        points={[ptOf(1, [{ strategy: 'always_second', rate: 0.5, n: 3 }])]}
        strategyLabels={{ always_second: 'Always Blorptide' }}
      />).replace(/<[^>]+>/g, ' ')
    expect(renamed).toContain('Always Blorptide')
    expect(renamed).not.toContain('Defect')
    expect(renamed).not.toContain('Cooperate')
  })

  it('⚠ NEGATIVE CONTROL — an unknown id falls back to the raw id, not to a wrong name', () => {
    const html = renderToStaticMarkup(
      <CooperationChartSVG points={[ptOf(1, [{ strategy: 'alternate', rate: 1, n: 2 }])]} />)
      .replace(/<[^>]+>/g, ' ')
    // No label map passed at all: the id shows, rather than a name invented client-side.
    expect(html).toContain('alternate (n=2)')
  })
})

describe('FirstMoveChartSVG — one bar per assigned strategy', () => {
  it('⚠ a THIRD strategy gets bars; the two-id list used to drop it silently', () => {
    const html = renderToStaticMarkup(
      <FirstMoveChartSVG
        outcomes={[
          { firstMove: 'C', strategy: 'tft', avgYearsPerRound: 1, n: 2 },
          { firstMove: 'C', strategy: 'random', avgYearsPerRound: 2, n: 3 },
          { firstMove: 'D', strategy: 'tft', avgYearsPerRound: 3, n: 1 },
          { firstMove: 'D', strategy: 'random', avgYearsPerRound: 4, n: 1 },
        ]}
        labels={{ C: 'Zarquon', D: 'Blorptide' }}
        unit="points"
        strategyLabels={{ tft: 'Tit-for-tat', random: 'Random' }}
      />)
    for (const id of ['C-tft', 'C-random', 'D-tft', 'D-random']) {
      expect(html).toContain(`data-testid="pd-firstmove-bar-${id}"`)
    }
    expect(html).toContain('data-testid="pd-firstmove-legend-random"')
    // …and a strategy nobody was assigned has no bar at all.
    expect(html).not.toContain('data-testid="pd-firstmove-bar-C-grim"')
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// ⚠⚠ BOTH CHARTS READ FROM THE ONE SHARED PALETTE — ASSERTED BY RENDERING.
//
// Reading the import would only prove the module resolves. These assert the hex
// actually reaches the SVG, so a chart that quietly reintroduced a per-file colour
// constant fails here.
// ═══════════════════════════════════════════════════════════════════════════════

describe('the shared palette reaches both charts', () => {
  const LABELS4 = { C: 'Zarquon', D: 'Blorptide' }

  it('CooperationChartSVG strokes each series in its shared colour', () => {
    const series: PdCooperationPoint['series'] = [
      { strategy: 'tft', rate: 1, n: 2 },
      { strategy: 'alternate', rate: 0.5, n: 2 },
      { strategy: 'always_second', rate: 0.25, n: 2 },
    ]
    const html = renderToStaticMarkup(
      <CooperationChartSVG points={[{ round: 1, series }, { round: 2, series }]} />)
    expect(series.length).toBe(3)
    for (const s of series) {
      expect(html).toContain(STRATEGY_COLOR[s.strategy])
    }
    // ⚠ THE TEAL THAT WAS THE DEFECT must not appear anywhere in the markup.
    expect(html).not.toContain('#0891b2')
    // …and black really is drawn as a series stroke.
    expect(html).toContain(`stroke="${STRATEGY_COLOR.always_second}"`)
  })

  it('FirstMoveChartSVG fills each bar in its shared colour', () => {
    const html = renderToStaticMarkup(
      <FirstMoveChartSVG
        outcomes={[
          { firstMove: 'C', strategy: 'tft', avgYearsPerRound: 1, n: 2 },
          { firstMove: 'C', strategy: 'alternate', avgYearsPerRound: 2, n: 2 },
          { firstMove: 'D', strategy: 'tft', avgYearsPerRound: 3, n: 1 },
          { firstMove: 'D', strategy: 'alternate', avgYearsPerRound: 4, n: 1 },
        ]}
        labels={LABELS4} unit="points"
      />)
    expect(html).toContain(`fill="${STRATEGY_COLOR.tft}"`)
    expect(html).toContain(`fill="${STRATEGY_COLOR.alternate}"`)
    expect(html).not.toContain('#0891b2')
  })

  it('⚠ NEGATIVE CONTROL — a colour NOT in the palette is absent from the markup', () => {
    // Without this, "contains the palette hex" could pass on a chart that emitted every
    // colour it had ever known.
    const html = renderToStaticMarkup(
      <CooperationChartSVG points={[{ round: 1, series: [{ strategy: 'tft', rate: 1, n: 1 }] }]} />)
    expect(html).toContain(STRATEGY_COLOR.tft)
    expect(html).not.toContain(STRATEGY_COLOR.grim)
    expect(html).not.toContain(STRATEGY_COLOR.alternate)
  })
})
