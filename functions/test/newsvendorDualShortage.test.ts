import { describe, it, expect } from 'vitest'
import { loadNewsvendorConfig } from '../src/newsvendor/config'
import { criticalRatio } from '../src/newsvendor/economics'

// ═══════════════════════════════════════════════════════════════════════════════
// ⚠⚠ THE SHORTAGE COST SURVIVES DUAL MODE — it is HIDDEN, never cleared.
//
// The instructor dashboard used to print "shortage $150" in a dual instance, where a
// shortage cannot occur: demand beyond the reserved quantity is BOUGHT from the second
// supplier. The banner now drops the field (frontend Dashboard.tsx), and the settings
// page and the student's params panel had already dropped it, each saying why.
//
// ⚠ THE POINT OF THIS FILE IS THE OTHER HALF OF THAT FIX: "hidden" must not quietly
// become "zeroed". An instructor who runs the dual variant and then switches back to
// single source must find the same number they typed. Nothing in the read or write path
// couples `g` to `dual` today, and these tests are what keep it that way — the coupling
// would be trivial to add later while "tidying", and no display test would notice.
// ═══════════════════════════════════════════════════════════════════════════════

/** A stored config document, in the wire shape `loadNewsvendorConfig` parses. */
const doc = (over: Record<string, unknown> = {}) => ({
  price: 3000, cost: 1000, salvage: 800, goodwill: 150, holding: 300,
  second_source_cost: 2000, periods: 20,
  is_normal: true, mean: 1000, sd: 300,
  ...over,
})

describe('the shortage cost across a mode switch', () => {
  it('⚠⚠ IS PRESERVED THROUGH single → dual → single', () => {
    // MUTANT: clear `g` on the dual branch of loadNewsvendorConfig (`g: d.dual ? 0 : …`),
    // or zero it in the update path when `dual` is set. → fails at the second and third
    // assertions. The instructor typed 150; switching the variant must not spend it.
    const single = loadNewsvendorConfig(doc({ dual: false }))
    expect(single.g).toBe(150)

    // The SAME stored document, read as dual — the switch changes no stored field.
    const asDual = loadNewsvendorConfig(doc({ dual: true }))
    expect(asDual.g, 'hidden in dual, not cleared').toBe(150)

    // …and back.
    const backAgain = loadNewsvendorConfig(doc({ dual: false }))
    expect(backAgain.g, 'returns with the number it had').toBe(150)
    expect(backAgain.g).toBe(single.g)
  })

  it('⚠ and `g` NEVER reaches the dual benchmark, whatever its value', () => {
    // The arithmetic reason the banner should never have shown it. Under dual sourcing
    // CU is the PREMIUM (c_l − c), not the retail margin, so neither the price nor the
    // shortage cost enters the critical ratio or Q*.
    // MUTANT: use `P - c + g` for CU in dual mode. → fails.
    const at150 = criticalRatio(loadNewsvendorConfig(doc({ dual: true, goodwill: 150 })))
    const at9999 = criticalRatio(loadNewsvendorConfig(doc({ dual: true, goodwill: 9999 })))
    expect(at150).toEqual(at9999)
    // The figures the dashboard banner reports, verified rather than assumed:
    expect(at150.CU, 'CU = c_l − c = 2000 − 1000').toBe(1000)
    expect(at150.CO, 'CO = c − (v − h) = 1000 − (800 − 300)').toBe(500)
    expect(at150.CR, 'CR = 1000 / 1500').toBeCloseTo(0.667, 3)
  })

  it('⚠ in SINGLE source it does the opposite — it moves the benchmark', () => {
    // The control. If this ever stopped being true, the two modes would have collapsed
    // into one and the whole distinction the banner draws would be meaningless.
    const a = criticalRatio(loadNewsvendorConfig(doc({ dual: false, goodwill: 150 })))
    const b = criticalRatio(loadNewsvendorConfig(doc({ dual: false, goodwill: 9999 })))
    expect(a).not.toEqual(b)
    expect(a.CU, 'CU = P − c + g = 3000 − 1000 + 150').toBe(2150)
  })
})
