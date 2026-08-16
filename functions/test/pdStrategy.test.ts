import { describe, it, expect } from 'vitest'
import {
  botMove, isStrategy, STRATEGIES, DEFAULT_STRATEGY_POOL, type Move, type Strategy,
} from '../src/pd/strategy'

// Pure strategy tests (no emulator). Runs under `npm test`.

/** Build a history from a compact string, e.g. h('CCD') → ['C','C','D']. */
const h = (s: string): Move[] => [...s] as Move[]

describe('botMove — TIT-FOR-TAT', () => {
  it('opens with C on round 1 (empty history)', () => {
    expect(botMove('tft', [])).toBe('C')
  })

  it('mirrors the student’s most recent move', () => {
    expect(botMove('tft', h('C'))).toBe('C')
    expect(botMove('tft', h('D'))).toBe('D')
  })

  it('mirrors across a sequence, one round at a time', () => {
    // Student plays C C D D C; the bot's move for each round is the student's
    // previous move, so the bot's sequence lags by exactly one round.
    const student = h('CCDDC')
    const bot = student.map((_, t) => botMove('tft', student.slice(0, t)))
    expect(bot).toEqual(h('CCCDD'))
  })

  it('forgives — one cooperative move brings the bot straight back', () => {
    expect(botMove('tft', h('CCDDD'))).toBe('D')
    expect(botMove('tft', h('CCDDDC'))).toBe('C') // back to C the very next round
  })
})

describe('botMove — GRIM (classic, unforgiving)', () => {
  it('opens with C on round 1 (empty history)', () => {
    expect(botMove('grim', [])).toBe('C')
  })

  it('stays C through an all-C history', () => {
    expect(botMove('grim', h('C'))).toBe('C')
    expect(botMove('grim', h('CCCCCCCCCC'))).toBe('C')
  })

  it('flips to D on the round AFTER the student’s first D', () => {
    const student = h('CCDCC')
    const bot = student.map((_, t) => botMove('grim', student.slice(0, t)))
    //          round:              1    2    3    4    5
    // student played:              C    C    D    C    C
    // bot cooperates through round 3 (the defection is not yet in history when
    // round 3's move is computed), then defects from round 4 on.
    expect(bot).toEqual(h('CCCDD'))
  })

  it('stays D FOREVER even after the student returns to cooperating', () => {
    expect(botMove('grim', h('CCD'))).toBe('D')
    expect(botMove('grim', h('CCDC'))).toBe('D')
    expect(botMove('grim', h('CCDCCCCCCCCCCCCCCCCC'))).toBe('D')
  })

  it('is unforgiving where TFT is forgiving — the pedagogical contrast', () => {
    const after = h('CCDCC') // defected once, then cooperated twice
    expect(botMove('tft', after)).toBe('C')
    expect(botMove('grim', after)).toBe('D')
  })
})

describe('purity + shared invariants', () => {
  /** Every strategy whose output is fixed by its inputs. `random` is not one. */
  const DETERMINISTIC: Strategy[] =
    STRATEGIES.filter(s => s !== 'random')
  /** Every strategy that opens with the FIRST move. `always_second` does not, by
   *  definition, and `random` opens on a coin. */
  const OPENS_FIRST: Strategy[] =
    STRATEGIES.filter(s => s !== 'random' && s !== 'always_second')

  it('does not mutate either history it is given', () => {
    const studentHistory = h('CCD')
    const botHistory = h('CCC')
    const sCopy = [...studentHistory]
    const bCopy = [...botHistory]
    for (const s of DETERMINISTIC) botMove(s, studentHistory, botHistory)
    expect(studentHistory).toEqual(sCopy)
    expect(botHistory).toEqual(bCopy)
  })

  it('every DETERMINISTIC strategy is deterministic — same inputs, same output', () => {
    // ⚠ `random` IS EXCLUDED, and that is the point of the split rather than a gap:
    // it is the one strategy whose move is a DRAW, which is exactly why its drawn
    // move is written to the round record and never recomputed (spec §5).
    const studentHistory = h('CDCDD')
    const botHistory = h('CCDDC')
    expect(DETERMINISTIC.length).toBe(6)
    for (const s of DETERMINISTIC) {
      const first = botMove(s, studentHistory, botHistory)
      for (let i = 0; i < 50; i++) expect(botMove(s, studentHistory, botHistory)).toBe(first)
    }
  })

  it('every strategy but always_second and random opens with the FIRST move', () => {
    expect(OPENS_FIRST.length).toBe(5)
    for (const s of OPENS_FIRST) expect(botMove(s, [], [])).toBe('C')
    // ⚠ NAMED EXCEPTIONS, asserted rather than skipped: `always_second` opens with the
    // second move BY DEFINITION, and a test that quietly excluded it would not notice
    // if it started opening with the first.
    expect(botMove('always_second', [], [])).toBe('D')
    expect(['C', 'D']).toContain(botMove('random', [], [], { seed: 's', participantId: 'p' }))
  })

  it('isStrategy accepts the library and rejects anything else', () => {
    expect(STRATEGIES).toEqual([
      'tft', 'grim', 'random', 'always_first', 'always_second', 'alternate', 'match_stay',
    ])
    expect(STRATEGIES.length).toBe(7)
    for (const s of STRATEGIES) expect(isStrategy(s)).toBe(true)
    for (const bad of ['TFT', 'grim ', '', 'pavlov', 'always', null, undefined, 7, {}]) {
      expect(isStrategy(bad)).toBe(false)
    }
  })

  it('⚠ the DEFAULT POOL is exactly the two ids that used to be hardcoded', () => {
    // The whole migration rests on this line: an unconfigured instance draws from
    // these two, in this order, as it always did.
    expect(DEFAULT_STRATEGY_POOL).toEqual(['tft', 'grim'])
  })

  it('⚠ NO STRATEGY READS A PAYOFF — the signature cannot express one', () => {
    // Stated as a test so the property is defended rather than merely intended: the
    // game is direction-agnostic (spec §2), so a strategy consulting a payoff would
    // need a direction the software does not have. botMove takes two move histories
    // and a seed context, and nothing else. A payoff argument would be a compile
    // error at every call site — which is the enforcement.
    expect(botMove.length).toBeLessThanOrEqual(4)
  })
})
