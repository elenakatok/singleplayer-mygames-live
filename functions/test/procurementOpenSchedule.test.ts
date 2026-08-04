import { describe, it, expect } from 'vitest'
import {
  bandAt, stepAt, delayAt, maxLegalBid, isLegalBid,
  type DecrementBand, type DelayBand,
} from '../src/procurement/auction/schedule'
import {
  DEFAULT_DECREMENT_SCHEDULE, DEFAULT_DELAY_SCHEDULE,
  parseDecrementSchedule, parseDelaySchedule, loadProcurementConfig,
} from '../src/procurement/config'

// ═══════════════════════════════════════════════════════════════════════════════
// §9 STEP 1 — `step(currentPrice)` and `delay(currentPrice)`, ONE shared band lookup,
// unit-tested against §8's STEP COLUMN before anything consumes them.
//
// ⚠ THE STEP COLUMN IS THE SPEC'S OWN, transcribed from §8.1 rather than recomputed:
// the whole ten-step trace is wrong if this table is wrong, and a test that derived the
// expectation from the same schedule the code reads would agree with any bug in the
// lookup. (Derive expected from a different source than actual — here, from the
// document.)
// ═══════════════════════════════════════════════════════════════════════════════

const SCHEDULE: DecrementBand[] = [
  { above: 80, step: 10 },
  { above: 50, step: 5 },
  { above: 30, step: 2 },
  { above: 0, step: 1 },
]

const DELAYS: DelayBand[] = [
  { above: 80, delayMs: 800 },
  { above: 50, delayMs: 1200 },
  { above: 30, delayMs: 2500 },
  { above: 0, delayMs: 3000 },
]

/** §8.1's table, transcribed: the standing price each step was made AGAINST, and the
 *  "step size in force" the document prints beside it. */
const SPEC_STEP_COLUMN: [standing: number, step: number][] = [
  [110, 10],  // step 1  → 100
  [100, 10],  // step 2  →  90
  [90, 10],   // step 3  →  80
  [80, 5],    // step 4  →  75   ⚠ the strict-`>` row
  [75, 5],    // step 5  →  70
  [70, 5],    // step 6  →  65
  [65, 5],    // step 7  →  60
  [60, 5],    // step 8  →  55
  [55, 5],    // step 9  →  50
  [50, 2],    // step 10 →  48   ⚠ the other strict-`>` row
]

describe('§8.1 the step column — the schedule reproduces the document', () => {
  it('every row of §8.1 has the step size the document prints', () => {
    expect(SPEC_STEP_COLUMN.length).toBe(10)
    for (const [standing, step] of SPEC_STEP_COLUMN) {
      expect(stepAt(standing, SCHEDULE), `standing ${standing}`).toBe(step)
    }
  })

  it('and the trace those steps produce is §8.1\'s bid column exactly', () => {
    // Derived from the document's OWN standing prices, one step at a time — so this
    // asserts the arithmetic that §2's whole pacing argument rests on.
    const bids = SPEC_STEP_COLUMN.map(([standing]) => maxLegalBid(standing, SCHEDULE))
    expect(bids).toEqual([100, 90, 80, 75, 70, 65, 60, 55, 50, 48])
  })

  it('⚠ the band test is STRICT — at a standing bid of 80 the step is 5, not 10', () => {
    // ⚠ THE SINGLE MOST LOAD-BEARING COMPARISON IN THE FORMAT. §8.1 step 4 pins it: the
    // cascade goes 90 → 80 → 75, not 90 → 80 → 70. An inclusive test makes every row
    // after step 3 wrong.
    expect(stepAt(81, SCHEDULE)).toBe(10)
    expect(stepAt(80, SCHEDULE)).toBe(5)
    expect(stepAt(51, SCHEDULE)).toBe(5)
    expect(stepAt(50, SCHEDULE)).toBe(2)
    expect(stepAt(31, SCHEDULE)).toBe(2)
    expect(stepAt(30, SCHEDULE)).toBe(1)
  })

  it('a bid must clear the step — the ceiling is standing − step', () => {
    expect(maxLegalBid(110, SCHEDULE)).toBe(100)
    expect(maxLegalBid(48, SCHEDULE)).toBe(46)
    expect(isLegalBid(46, 48, SCHEDULE)).toBe(true)
    expect(isLegalBid(47, 48, SCHEDULE)).toBe(false)
    expect(isLegalBid(36, 48, SCHEDULE)).toBe(true)    // jump bidding is legal (§4.2)
    expect(isLegalBid(46.5, 48, SCHEDULE)).toBe(false) // whole ECU only
  })
})

// ── the delay schedule, and that it is the SAME lookup ────────────────────────

describe('§3 delay(currentPrice) — the same shape, the same lookup', () => {
  it('reads the shipped delay bands the document states', () => {
    expect(delayAt(110, DELAYS)).toBe(800)
    expect(delayAt(81, DELAYS)).toBe(800)
    expect(delayAt(80, DELAYS)).toBe(1200)   // ⚠ strict, exactly like the step
    expect(delayAt(51, DELAYS)).toBe(1200)
    expect(delayAt(50, DELAYS)).toBe(2500)
    expect(delayAt(31, DELAYS)).toBe(2500)
    expect(delayAt(30, DELAYS)).toBe(3000)
  })

  it('⚠ ONE band lookup serves both — the two schedules change band at the same price', () => {
    // This is the property open §3 asks for ("should share the band-lookup helper rather
    // than reimplementing it") and the reason §2's phase arithmetic comes out: Phase 1
    // lives in the coarse bands and Phase 2 in the fine ones BECAUSE the boundaries agree.
    // Asserted as a property over the whole price range, not at a few sampled points.
    for (let price = 0; price <= 130; price++) {
      const stepBand = bandAt(price, SCHEDULE)
      const delayBand = bandAt(price, DELAYS)
      expect(stepBand.above, `price ${price}`).toBe(delayBand.above)
    }
  })

  it('§2\'s pacing table — 3 steps at 0.8s, 6 at 1.2s, 1 at 2.5s ≈ 12s of Phase 1', () => {
    // The document's own arithmetic, recomputed from the standing prices in §8.1. If the
    // bands or the defaults move, this is the line that says the published pacing claim
    // no longer holds.
    const delays = SPEC_STEP_COLUMN.map(([standing]) => delayAt(standing, DELAYS))
    expect(delays.filter(d => d === 800).length).toBe(3)
    expect(delays.filter(d => d === 1200).length).toBe(6)
    expect(delays.filter(d => d === 2500).length).toBe(1)
    const total = delays.reduce((a, b) => a + b, 0)
    expect(total).toBe(12_100)
  })

  it('an empty schedule throws rather than silently picking a step', () => {
    expect(() => bandAt(50, [])).toThrow(/empty band schedule/)
  })

  it('a price below every band falls through to the last band', () => {
    expect(stepAt(0, SCHEDULE)).toBe(1)
    expect(stepAt(-5, SCHEDULE)).toBe(1)
  })
})

// ── config: both schedules are instance config, never constants ───────────────

describe('§3 both schedules are read from the instance record', () => {
  it('the shipped defaults are the document\'s', () => {
    expect(DEFAULT_DECREMENT_SCHEDULE).toEqual(SCHEDULE)
    expect(DEFAULT_DELAY_SCHEDULE).toEqual(DELAYS)
  })

  it('a stored schedule overrides the default, and is sorted descending by band', () => {
    // Written bottom-up, as an instructor plausibly would. Order IS the semantics, so the
    // parser normalizes rather than trusting the doc.
    const parsed = parseDelaySchedule([
      { above: 0, delayMs: 400 },
      { above: 60, delayMs: 100 },
    ])
    expect(parsed).toEqual([{ above: 60, delayMs: 100 }, { above: 0, delayMs: 400 }])
    expect(delayAt(70, parsed)).toBe(100)
    expect(delayAt(10, parsed)).toBe(400)
  })

  it('a malformed schedule falls back to the shipped default IN FULL, never to empty', () => {
    // `bandAt` throws on an empty schedule, so a half-written config doc must never be
    // able to produce one — the same defensive posture as loadProcurementConfig.
    expect(parseDelaySchedule('nonsense')).toEqual(DEFAULT_DELAY_SCHEDULE)
    expect(parseDelaySchedule([{ above: 50 }])).toEqual(DEFAULT_DELAY_SCHEDULE)
    expect(parseDecrementSchedule([{ above: 50, step: 0 }])).toEqual(DEFAULT_DECREMENT_SCHEDULE)
    expect(parseDecrementSchedule([])).toEqual(DEFAULT_DECREMENT_SCHEDULE)
  })

  it('a zero STEP is refused but a zero DELAY is allowed', () => {
    // A zero step makes `maxLegalBid` return the standing price — a bot would "undercut"
    // without moving and the cascade would never terminate. A zero delay just runs fast.
    expect(parseDecrementSchedule([{ above: 0, step: 0 }])).toEqual(DEFAULT_DECREMENT_SCHEDULE)
    expect(parseDelaySchedule([{ above: 0, delayMs: 0 }])).toEqual([{ above: 0, delayMs: 0 }])
  })

  it('the instance config carries both schedules and the jitter', () => {
    const config = loadProcurementConfig({
      delaySchedule: [{ above: 0, delayMs: 50 }],
      delayJitterMs: 40,
    })
    expect(config.delaySchedule).toEqual([{ above: 0, delayMs: 50 }])
    expect(config.delayJitterMs).toBe(40)
    // ⚠ Defaults when absent — an instance created before these keys existed is playable.
    expect(loadProcurementConfig({}).delaySchedule).toEqual(DEFAULT_DELAY_SCHEDULE)
    expect(loadProcurementConfig({}).delayJitterMs).toBe(250)
  })

  it('⚠ `botDelayMs` is gone — a stored one is ignored, not carried', () => {
    // open §3 (2026-08-04) replaced the scalar pair with the band schedule. A stale key in
    // an old config doc must not resurrect it as a second source of pacing truth.
    const config = loadProcurementConfig({ botDelayMs: [1000, 2000] }) as Record<string, unknown>
    expect('botDelayMs' in config).toBe(false)
    expect(config.delaySchedule).toEqual(DEFAULT_DELAY_SCHEDULE)
  })
})
