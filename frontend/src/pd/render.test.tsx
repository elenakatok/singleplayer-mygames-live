// eslint-disable-next-line @typescript-eslint/no-unused-vars -- classic JSX transform
import React from 'react'
import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { PayoffMatrix } from './PayoffMatrix'
import { HistoryTable } from './HistoryTable'
import type { PdHistoryRow, PdMoveLabels, PdPayoffs } from './api'

// Static-markup render tests. The repo has no jsdom/testing-library, but these two
// components are pure presentation (they import only TYPES from api.ts, so nothing
// touches Firebase), which makes renderToStaticMarkup enough to assert the thing that
// actually matters: the numbers land in the right cells, and nothing the student must
// not see is in the output.

const PAYOFFS: PdPayoffs = { both_cooperate: 1, sucker: 15, temptation: 0, both_defect: 10 }
const LABELS: PdMoveLabels = { C: 'Cooperate', D: 'Defect' }

/** The VISIBLE text of a testid'd element (tags stripped, whitespace collapsed).
 *  Asserting on text rather than raw markup keeps inline styles — `text-align:left`
 *  and friends — from colliding with the words being looked for. */
const textOf = (html: string, testid: string) => {
  const m = html.match(new RegExp(`<(t[dhr])\\s+data-testid="${testid}"[^>]*>([\\s\\S]*?)</\\1>`))
  return m ? m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : null
}

/** All visible text in the markup. */
const visibleText = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()

describe('PayoffMatrix — renders from config, in the split-cell layout', () => {
  const html = renderToStaticMarkup(<PayoffMatrix payoffs={PAYOFFS} labels={LABELS} />)

  it('puts each pair of moves in its own cell, their years first then yours', () => {
    // Cell markup order is [above the diagonal = theirs] then [below = yours].
    expect(textOf(html, 'pd-matrix-CC')).toBe('1 1')
    expect(textOf(html, 'pd-matrix-CD')).toBe('0 15')   // they 0, you 15 (the sucker)
    expect(textOf(html, 'pd-matrix-DC')).toBe('15 0')   // they 15, you 0 (the temptation)
    expect(textOf(html, 'pd-matrix-DD')).toBe('10 10')
  })

  it('uses the instance’s move labels, not hardcoded words', () => {
    const custom = visibleText(renderToStaticMarkup(
      <PayoffMatrix payoffs={PAYOFFS} labels={{ C: 'Stay silent', D: 'Confess' }} />,
    ))
    expect(custom).toContain('Stay silent')
    expect(custom).toContain('Confess')
    expect(custom).not.toContain('Cooperate')
  })

  it('uses the instance’s numbers, not the shipped defaults', () => {
    const custom = renderToStaticMarkup(
      <PayoffMatrix payoffs={{ both_cooperate: 2, sucker: 9, temptation: 1, both_defect: 6 }} labels={LABELS} />,
    )
    expect(textOf(custom, 'pd-matrix-CD')).toBe('1 9')
    expect(visibleText(custom)).not.toContain('15')
  })

  it('frames the numbers as losses — years in prison, lower is better', () => {
    const text = visibleText(html)
    expect(text).toContain('Years in prison')
    expect(text.toLowerCase()).toContain('lower is better')
  })
})

describe('HistoryTable — rounds PLAYED, grouped You | Opponent header', () => {
  const history: PdHistoryRow[] = [
    { round: 1, studentMove: 'C', botMove: 'C', studentYears: 1, botYears: 1, studentTotal: 1, botTotal: 1 },
    { round: 2, studentMove: 'D', botMove: 'C', studentYears: 0, botYears: 15, studentTotal: 1, botTotal: 16 },
    { round: 3, studentMove: 'D', botMove: 'D', studentYears: 10, botYears: 10, studentTotal: 11, botTotal: 26 },
  ]
  const html = renderToStaticMarkup(<HistoryTable history={history} labels={LABELS} />)

  it('renders the grouped block header', () => {
    expect(html).toContain('data-testid="pd-hist-block-you"')
    expect(html).toContain('data-testid="pd-hist-block-opponent"')
  })

  it('renders one row per round played, and no more', () => {
    for (const r of [1, 2, 3]) expect(html).toContain(`data-testid="pd-history-row-${r}"`)
    expect(html).not.toContain('data-testid="pd-history-row-4"')
  })

  it('shows each round’s moves, years, and running totals', () => {
    // round │ your move, years, running total │ their move, years, running total
    expect(textOf(html, 'pd-history-row-2')).toBe('2 Defect 0 1 Cooperate 15 16')
    expect(textOf(html, 'pd-history-row-3')).toBe('3 Defect 10 11 Defect 10 26')
  })

  it('says nothing about rounds remaining — the whole point of the table', () => {
    const text = visibleText(html).toLowerCase()
    expect(text).not.toContain('remaining')
    expect(text).not.toContain('rounds left')
    expect(text).not.toContain(' of 1')   // catches "round 3 of 1x" in any form
  })

  it('invites the first round rather than showing an empty grid', () => {
    const empty = renderToStaticMarkup(<HistoryTable history={[]} labels={LABELS} />)
    expect(empty).toContain('No rounds played yet')
    expect(empty).not.toContain('<table')
  })
})
