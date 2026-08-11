import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

// ⚠ Dashboard.tsx reaches ../firebase through api.ts, which initializes Firebase on import
// and throws in Node. The same one-line stub pricing's and procurement's render tests use.
vi.mock('../firebase', () => ({ auth: {}, db: {}, functions: {} }))

import { InstanceHeader } from './Dashboard'
import type { NewsvendorParams, NewsvendorBenchmark } from './api'

// ═══════════════════════════════════════════════════════════════════════════════
// Newsvendor — static-markup render tests for the INSTRUCTOR dashboard banner.
//
// Same approach as pricing's and procurement's: the repo has no jsdom, but
// `InstanceHeader` is pure presentation (it imports only TYPES from api.ts, so nothing
// touches Firebase), which makes `renderToStaticMarkup` enough to assert what matters.
//
// ⚠⚠ WHY THIS FILE EXISTS AT ALL: the dual-mode banner shipped showing a SHORTAGE COST,
// and nothing asserted on the banner in any suite — this was newsvendor's first frontend
// render test. The bug survived because the dual dashboard was never read next to the
// dual settings page, which had got it right and said so in prose.
// ═══════════════════════════════════════════════════════════════════════════════

/** The market from the reported bug, to the ECU. */
const BASE: NewsvendorParams = {
  P: 3000, c: 1000, v: 800, g: 150, h: 300,
  dual: false, cL: 0,
  isNormal: true, mean: 1000, sd: 300, minD: 0, maxD: 0,
  periods: 20, orderMin: 0, orderMax: 10_000, showCalculator: true,
}

/** ⚠ DUAL zeroes nothing — `g` keeps its stored value and `cL` becomes real. That is the
 *  whole point of the third test below. */
const dual = (over: Partial<NewsvendorParams> = {}): NewsvendorParams =>
  ({ ...BASE, dual: true, cL: 2000, ...over })

const BENCH: NewsvendorBenchmark = { CU: 1000, CO: 500, CR: 1000 / 1500, Qopt: 1129 }

const render = (params: NewsvendorParams, benchmark: NewsvendorBenchmark | null = BENCH) =>
  renderToStaticMarkup(<InstanceHeader params={params} benchmark={benchmark} configError={null} />)

describe('the instructor market banner', () => {
  it('⚠⚠ DUAL MODE SHOWS NO SHORTAGE FIELD AT ALL — not "$0"', () => {
    // MUTANT: render it as $0 in dual mode (drop the `!params.dual` guard, or replace it
    // with `params.dual ? 0 : params.g`). → fails.
    // WHY: demand beyond the reserved quantity is BOUGHT from the second supplier, so a
    // shortage never occurs and `g` enters nothing — not profit, not the critical ratio
    // (CU is the premium `cL − c`), not Q*. "$0" would claim a shortage costs nothing;
    // the point is that there is not one.
    const html = render(dual())
    expect(html).not.toContain('shortage')
    expect(html).not.toContain('$150')
    // ⚠ AND NOT AS A ZERO EITHER — the mutant this test exists for.
    expect(html).not.toMatch(/shortage\s*\$?0/i)
  })

  it('⚠ …even though the stored value is non-zero and still in the params', () => {
    // Guards against a "fix" that removed the field by zeroing the config instead.
    const p = dual({ g: 150 })
    expect(p.g).toBe(150)              // the datum is present…
    expect(render(p)).not.toContain('shortage')   // …and simply not displayed
  })

  it('SINGLE SOURCE STILL SHOWS IT — the fix must not remove it from both branches', () => {
    // MUTANT: drop the line entirely rather than guarding it on `dual`. → fails.
    const html = render(BASE)
    expect(html).toContain('shortage')
    expect(html).toContain('$150')
  })

  it('⚠ every other field stays in BOTH modes — only shortage is mode-dependent', () => {
    // MUTANT: remove price on the grounds that it drops out of the critical ratio. → fails.
    // Price determines profit and students see it on their costs panel; salvage and holding
    // bear on leftover reserved units; the second source is dual's whole mechanism.
    for (const [label, p] of [['single', BASE], ['dual', dual()]] as const) {
      const html = render(p)
      expect(html, `${label}: price`).toContain('$3,000')
      expect(html, `${label}: cost`).toContain('$1,000')
      expect(html, `${label}: salvage`).toContain('$800')
      expect(html, `${label}: holding`).toContain('$300')
      expect(html, `${label}: periods`).toContain('20 periods')
    }
    // The second source is dual-only, and is NOT affected by this change.
    expect(render(dual())).toContain('second source')
    expect(render(BASE)).not.toContain('second source')
  })

  it('⚠ a zero shortage is hidden in single source too — the pre-existing rule', () => {
    // Unchanged behaviour, pinned so the new `!params.dual` guard cannot be mistaken for
    // the only reason the line ever disappears.
    expect(render({ ...BASE, g: 0 })).not.toContain('shortage')
  })

  it('the benchmark line still reports the dual figures', () => {
    // ⚠ CU is the PREMIUM (cL − c = 1000), NOT the retail margin, and `g` is absent from
    // it — which is the arithmetic reason the banner should never have shown a shortage.
    const html = render(dual())
    expect(html).toContain('0.667')
    expect(html).toContain('1,129')
  })
})
