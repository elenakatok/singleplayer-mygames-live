import { describe, it, expect } from 'vitest'
import { botMove, isStrategy, STRATEGIES, type Move } from '../src/pd/strategy'

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
  it('does not mutate the history it is given', () => {
    const history = h('CCD')
    const copy = [...history]
    botMove('tft', history)
    botMove('grim', history)
    expect(history).toEqual(copy)
  })

  it('is deterministic — same inputs, same output, every time', () => {
    const history = h('CDCDD')
    for (const s of STRATEGIES) {
      const first = botMove(s, history)
      for (let i = 0; i < 50; i++) expect(botMove(s, history)).toBe(first)
    }
  })

  it('every strategy opens with C (nobody defects first)', () => {
    for (const s of STRATEGIES) expect(botMove(s, [])).toBe('C')
  })

  it('isStrategy accepts the library and rejects anything else', () => {
    expect(STRATEGIES).toEqual(['tft', 'grim'])
    for (const s of STRATEGIES) expect(isStrategy(s)).toBe(true)
    for (const bad of ['TFT', 'grim ', '', null, undefined, 7, {}]) {
      expect(isStrategy(bad)).toBe(false)
    }
  })
})
