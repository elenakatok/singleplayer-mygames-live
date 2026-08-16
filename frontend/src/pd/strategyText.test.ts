import { describe, it, expect } from 'vitest'
import { strategyDisplayName, strategyRuleSummary } from './strategyText'
import { PD_STRATEGIES } from './strategies'

// ⚠⚠ DRIFT PIN, HALF TWO OF TWO. The display names asserted here are asserted against
// the SERVER in functions/test/pdStrategyText.test.ts for the SAME fixture. Edit either
// side and its own suite fails.

const OPERA = 'Zarquon'
const BOXING = 'Blorptide'
const LABELS = { C: OPERA, D: BOXING }

describe('DRIFT PIN — display names match the server byte for byte', () => {
  it('all seven, in library order', () => {
    expect(PD_STRATEGIES.map(s => strategyDisplayName(s, LABELS))).toEqual([
      'Tit-for-tat',
      'Grim',
      'Random',
      `Always ${OPERA}`,
      `Always ${BOXING}`,
      'Alternating',
      'Match-and-stay',
    ])
  })

  it('the client library list matches the server\'s length and order', () => {
    expect(PD_STRATEGIES.length).toBe(7)
    expect([...PD_STRATEGIES]).toEqual([
      'tft', 'grim', 'random', 'always_first', 'always_second', 'alternate', 'match_stay',
    ])
  })
})

describe('⚠ the settings surface carries the INSTANCE wording and nothing else', () => {
  const surface = JSON.stringify([
    PD_STRATEGIES.map(s => strategyDisplayName(s, LABELS)),
    PD_STRATEGIES.map(s => strategyRuleSummary(s, LABELS)),
  ])

  it('the fixture actually reached the surface', () => {
    expect(surface).toContain(OPERA)
    expect(surface).toContain(BOXING)
  })

  it('⚠⚠ neither shipped default word appears ANYWHERE on it', () => {
    expect(surface).not.toContain('Cooperate')
    expect(surface).not.toContain('Defect')
  })

  it('a rename leaves no stale copy behind — the settings list relabels live', () => {
    const renamed = JSON.stringify([
      PD_STRATEGIES.map(s => strategyDisplayName(s, { C: 'Aaaa', D: 'Bbbb' })),
      PD_STRATEGIES.map(s => strategyRuleSummary(s, { C: 'Aaaa', D: 'Bbbb' })),
    ])
    expect(renamed).toContain('Aaaa')
    expect(renamed).toContain('Bbbb')
    expect(renamed).not.toContain(OPERA)
    expect(renamed).not.toContain(BOXING)
  })

  it('⚠ NOTHING IS CALLED PAVLOV', () => {
    expect(surface.toLowerCase()).not.toContain('pavlov')
  })

  it('every id has a distinct rule summary', () => {
    const s = PD_STRATEGIES.map(x => strategyRuleSummary(x, LABELS))
    expect(s.length).toBe(7)
    expect(new Set(s).size).toBe(7)
  })
})
