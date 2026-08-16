import { describe, it, expect } from 'vitest'
import { loadPdConfig, parseStrategyPool, DEFAULT_PD_CONFIG } from '../src/pd/config'
import { drawStrategy, hash32 } from '../src/pd/init'
import { STRATEGIES, DEFAULT_STRATEGY_POOL, type Strategy } from '../src/pd/strategy'

// ═══════════════════════════════════════════════════════════════════════════════
// THE POOL, ITS MIGRATION, AND THE ASSIGNMENT DRAW (spec §5).
//
// ⚠ THE MIGRATION CLAIM IS EXACT: an instance created before the pool was configurable
// stores no `strategies` field and must assign EXACTLY the strategy it would have
// assigned before this pass — same student, same seed, same answer. The oracle below
// is a verbatim transcription of the pre-change `drawStrategy`.
// ═══════════════════════════════════════════════════════════════════════════════

/** VERBATIM the old drawStrategy: uniform over the hardcoded ['tft','grim']. */
function legacyDrawStrategy(seed: string, participantId: string): Strategy {
  const legacyStrategies: Strategy[] = ['tft', 'grim']
  const k = hash32(`${seed}:strategy:${participantId}`) % legacyStrategies.length
  return legacyStrategies[k]
}

describe('parseStrategyPool — the lazy migration', () => {
  it('⚠⚠ an instance with NO `strategies` field reads as exactly tft + grim', () => {
    expect(parseStrategyPool(undefined)).toEqual(['tft', 'grim'])
    expect(loadPdConfig({}).strategies).toEqual(['tft', 'grim'])
    expect(loadPdConfig(undefined).strategies).toEqual([...DEFAULT_STRATEGY_POOL])
  })

  it('a stored pool is honoured', () => {
    expect(loadPdConfig({ strategies: ['random', 'alternate'] }).strategies)
      .toEqual(['random', 'alternate'])
  })

  it('is returned deduped and in library order, whatever order it was stored in', () => {
    expect(parseStrategyPool(['match_stay', 'tft', 'tft', 'random']))
      .toEqual(['tft', 'random', 'match_stay'])
  })

  it('drops unknown ids rather than throwing', () => {
    expect(parseStrategyPool(['tft', 'pavlov', 'nonsense', 7, null]))
      .toEqual(['tft'])
  })

  it('⚠ a pool that drops to EMPTY falls back — never an unplayable instance', () => {
    expect(parseStrategyPool([])).toEqual(['tft', 'grim'])
    expect(parseStrategyPool(['pavlov'])).toEqual(['tft', 'grim'])
    expect(parseStrategyPool('nonsense')).toEqual(['tft', 'grim'])
  })

  it('the shipped default config carries the two-strategy pool', () => {
    expect(DEFAULT_PD_CONFIG.strategies).toEqual(['tft', 'grim'])
  })
})

describe('⚠⚠ MIGRATION IDENTITY — an unconfigured instance assigns exactly what it did', () => {
  const pids = Array.from({ length: 200 }, (_, i) => `stu-${i}`)

  it('every participant draws the SAME strategy as the pre-change implementation', () => {
    const pool = loadPdConfig({}).strategies            // the migrated pool
    expect(pool).toEqual(['tft', 'grim'])
    let checked = 0
    for (const pid of pids) {
      expect(drawStrategy('seed-A', pid, pool)).toBe(legacyDrawStrategy('seed-A', pid))
      checked++
    }
    expect(checked).toBe(200)
    // …and the fixture is not degenerate: both strategies actually occur.
    const drawn = new Set(pids.map(p => drawStrategy('seed-A', p, pool)))
    expect(drawn.size).toBe(2)
  })

  it('NEGATIVE CONTROL — a DIFFERENT pool gives a different answer for someone', () => {
    // If the assertion above could pass for any pool it would prove nothing.
    const other: Strategy[] = ['random', 'alternate']
    const differs = pids.filter(p => drawStrategy('seed-A', p, other) !== legacyDrawStrategy('seed-A', p))
    expect(differs.length).toBe(200)
  })

  it('NEGATIVE CONTROL — a different SEED gives a different answer for someone', () => {
    const pool = loadPdConfig({}).strategies
    const differs = pids.filter(p => drawStrategy('seed-B', p, pool) !== legacyDrawStrategy('seed-A', p))
    expect(differs.length).toBeGreaterThan(50)   // ~half, by construction
  })
})

describe('drawStrategy — uniform over the CHECKED set', () => {
  const pids = Array.from({ length: 3000 }, (_, i) => `p-${i}`)

  it('never draws a strategy outside the pool', () => {
    const pool: Strategy[] = ['random', 'always_second', 'match_stay']
    const drawn = pids.map(p => drawStrategy('seed-U', p, pool))
    // ⚠ COUNT ASSERTED FIRST, so an empty loop cannot pass this test.
    expect(drawn.length).toBe(3000)
    const outside = drawn.filter(s => !pool.includes(s))
    expect(outside).toEqual([])
    // And every pool member really does come up — "never outside" is satisfiable by a
    // constant, which this rules out.
    expect(new Set(drawn).size).toBe(3)
  })

  it('is roughly uniform across the pool', () => {
    const pool: Strategy[] = ['tft', 'grim', 'random', 'alternate']
    const counts = new Map<Strategy, number>(pool.map(s => [s, 0]))
    for (const p of pids) {
      const s = drawStrategy('seed-U', p, pool)
      counts.set(s, (counts.get(s) ?? 0) + 1)
    }
    expect([...counts.values()].reduce((a, b) => a + b, 0)).toBe(3000)
    const expectedEach = 3000 / 4
    // Multinomial 4σ band, computed independently of the code under test.
    const sigma = Math.sqrt(3000 * 0.25 * 0.75)
    for (const [, n] of counts) expect(Math.abs(n - expectedEach)).toBeLessThan(4 * sigma)
  })

  it('a ONE-strategy pool is legal and always draws it', () => {
    const drawn = pids.slice(0, 50).map(p => drawStrategy('seed-U', p, ['alternate']))
    expect(drawn.length).toBe(50)
    expect(new Set(drawn)).toEqual(new Set(['alternate']))
  })

  it('the SAME participant + seed always draws the same strategy', () => {
    const pool: Strategy[] = ['tft', 'grim', 'random']
    const first = drawStrategy('s', 'alice', pool)
    for (let i = 0; i < 50; i++) expect(drawStrategy('s', 'alice', pool)).toBe(first)
  })

  it('every library id is reachable when the whole library is checked', () => {
    const drawn = new Set(pids.map(p => drawStrategy('seed-U', p, STRATEGIES)))
    expect(drawn.size).toBe(7)
  })
})
