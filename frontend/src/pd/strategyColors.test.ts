import { describe, it, expect } from 'vitest'
import { STRATEGY_COLOR, strategyColor } from './strategyColors'
import { PD_STRATEGIES } from './strategies'

// ═══════════════════════════════════════════════════════════════════════════════
// The shared strategy palette. The design target is a classroom PROJECTOR.
// ═══════════════════════════════════════════════════════════════════════════════

describe('the palette is COMPLETE, checked against the id list itself', () => {
  it('⚠⚠ one entry per strategy, no more and no fewer', () => {
    // ⚠ COMPARED AGAINST `PD_STRATEGIES`, NOT AGAINST A RESTATED LIST. A strategy added
    // without a colour must fail HERE rather than render in the fallback grey, which
    // nobody would notice on a projector.
    expect(PD_STRATEGIES.length).toBe(6)
    expect(Object.keys(STRATEGY_COLOR).sort()).toEqual([...PD_STRATEGIES].sort())
  })

  it('every id resolves to a real hex colour, not the unknown fallback', () => {
    expect(PD_STRATEGIES.length).toBe(6)
    for (const id of PD_STRATEGIES) {
      expect(strategyColor(id)).toMatch(/^#[0-9a-f]{6}$/i)
      expect(strategyColor(id)).not.toBe('#6b7280')
    }
  })

  it('⚠ NEGATIVE CONTROL — an id with no entry DOES fall back', () => {
    // Without this, "never the fallback" above could pass because the fallback is
    // unreachable rather than because every id has a colour.
    expect(strategyColor('nonexistent' as never)).toBe('#6b7280')
  })
})

describe('the six colours are pairwise distinct', () => {
  it('⚠⚠ no two strategies share a colour', () => {
    const values = PD_STRATEGIES.map(id => STRATEGY_COLOR[id])
    expect(values.length).toBe(6)
    expect(new Set(values).size).toBe(6)
  })

  it('the two that Elena already projects are UNCHANGED', () => {
    expect(STRATEGY_COLOR.tft).toBe('#2563eb')    // blue
    expect(STRATEGY_COLOR.grim).toBe('#dc2626')   // red
  })

  it('⚠⚠ NO TEAL, AND NOTHING ELSE IN THE BLUE-GREEN FAMILY BUT BLUE ITSELF', () => {
    // THE DEFECT THIS PALETTE FIXES: `alternate` was teal (#0891b2), sitting beside
    // tit-for-tat's blue in the legend and merging with it under projection.
    expect(STRATEGY_COLOR.alternate).not.toBe('#0891b2')
    // Hue, computed here from the hex rather than asserted as a literal. Cyan/teal is
    // roughly 165°–200°; only blue may sit above 200°.
    const hue = (hex: string) => {
      const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
      const max = Math.max(r, g, b)
      const min = Math.min(r, g, b)
      const d = max - min
      if (d === 0) return null   // achromatic — black, white, grey
      const hv = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4
      return ((hv * 60) + 360) % 360
    }
    const hues = PD_STRATEGIES.map(id => ({ id, hue: hue(STRATEGY_COLOR[id]) }))
    expect(hues.length).toBe(6)
    const tealish = hues.filter(x => x.hue !== null && x.hue >= 160 && x.hue <= 200)
    expect(tealish).toEqual([])
    // …and exactly ONE colour sits in the blue band at all.
    const blues = hues.filter(x => x.hue !== null && x.hue > 200 && x.hue < 260)
    expect(blues.map(x => x.id)).toEqual(['tft'])
  })

  it('always_second is a REAL black, and not merely a dark grey', () => {
    expect(STRATEGY_COLOR.always_second).toBe('#000000')
  })

  it('black does not collide with any chart chrome', () => {
    // Both charts draw gridlines at #eee and axes at #ccc; the darkest chrome anywhere
    // is #333 (legend text, bar value labels). Asserted as a fact about the palette:
    // the black series is darker than every chrome value, so it can never be mistaken
    // for a gridline or an axis.
    const CHROME = ['#eee', '#ccc', '#888', '#999', '#bbb', '#555', '#333']
    expect(CHROME).not.toContain(STRATEGY_COLOR.always_second)
    const lum = (hex: string) => {
      const n = hex.length === 4
        ? hex.slice(1).split('').map(c => parseInt(c + c, 16))
        : [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16))
      return (n[0] + n[1] + n[2]) / 3
    }
    expect(CHROME.length).toBe(7)
    for (const c of CHROME) expect(lum(STRATEGY_COLOR.always_second)).toBeLessThan(lum(c))
  })
})
