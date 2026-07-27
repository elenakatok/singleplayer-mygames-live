import { describe, it, expect } from 'vitest'
import {
  loadPricingConfig, loadPricingStrategies, activeStrategy, parseRoundRange,
  truthParticipantDoc, DEFAULT_PRICING_CONFIG, DEFAULT_STRATEGIES,
  DEFAULT_DEBRIEF_PROMPT_STANDARD, DEFAULT_DEBRIEF_PROMPT_PMG,
  DEFAULT_MIN_ROUNDS, DEFAULT_MAX_ROUNDS, HARD_MAX_ROUNDS,
} from '../src/pricing/config'
import { DEFAULT_MARKET } from '../src/pricing/market'

// ═══════════════════════════════════════════════════════════════════════════════
// The instance config (spec §3) and the per-mode competitor rule (spec §5).
//
// The theme throughout: a half-written or hand-edited document must degrade to the
// shipped defaults, never throw and never leave the game unplayable — the same
// posture as parseMarket. Plus the one thing that is specific to THIS game: the
// `pmg` flag is a switch, and everything downstream of it (the debrief prompt, the
// competitor rule) has to move when it moves.
// ═══════════════════════════════════════════════════════════════════════════════

describe('loadPricingConfig — defaults (spec §3)', () => {
  it('an absent config doc is the shipped case defaults, in Standard mode', () => {
    const cfg = loadPricingConfig(undefined)
    expect(cfg).toEqual(DEFAULT_PRICING_CONFIG)
    expect(cfg.pmg).toBe(false)
    expect(cfg.market).toEqual(DEFAULT_MARKET)
    expect(cfg.labels).toEqual({ student: 'CSC', competitor: 'WNS' })
    expect(cfg.minRounds).toBe(10)
    expect(cfg.maxRounds).toBe(20)
  })

  it('the market defaults are the case numbers', () => {
    const m = loadPricingConfig({}).market
    expect(m.marketSize).toBe(190_000)
    expect(m.studentBaseShare).toBe(0.35)
    expect(m.competitorBaseShare).toBe(0.65)
    expect(m.studentUnitCost).toBe(966)
    expect(m.competitorUnitCost).toBe(900)
    expect(m.slope).toBe(1000)
    expect(m.minPrice).toBe(900)
    expect(m.maxPrice).toBe(2000)
  })

  it('reads the stored values it is given', () => {
    const cfg = loadPricingConfig({
      pmg: true,
      labels: { student: 'Cheyenne', competitor: 'Western' },
      market: { market_size: 250_000 },
      min_rounds: 6, max_rounds: 9,
      kc_enabled: false, debrief_enabled: false,
      debrief_prompt: '  What did you learn?  ',
      seed: ' s1 ',
    })
    expect(cfg.pmg).toBe(true)
    expect(cfg.labels).toEqual({ student: 'Cheyenne', competitor: 'Western' })
    expect(cfg.market.marketSize).toBe(250_000)
    expect(cfg.minRounds).toBe(6)
    expect(cfg.maxRounds).toBe(9)
    expect(cfg.kcEnabled).toBe(false)
    expect(cfg.debriefEnabled).toBe(false)
    expect(cfg.debriefPrompt).toBe('What did you learn?')
    expect(cfg.seed).toBe('s1')
  })

  it('an absent kc/debrief toggle reads as ON — an old instance keeps its flow', () => {
    const cfg = loadPricingConfig({})
    expect(cfg.kcEnabled).toBe(true)
    expect(cfg.debriefEnabled).toBe(true)
  })

  it('a blank label falls back rather than rendering an empty firm name', () => {
    const cfg = loadPricingConfig({ labels: { student: '   ', competitor: 7 } })
    expect(cfg.labels).toEqual({ student: 'CSC', competitor: 'WNS' })
  })

  it('normalises a numeric seed, so seed 7 and seed "7" draw identically', () => {
    expect(loadPricingConfig({ seed: 7 }).seed).toBe('7')
    expect(loadPricingConfig({ seed: '7' }).seed).toBe('7')
    expect(loadPricingConfig({ seed: '' }).seed).toBeNull()
    expect(loadPricingConfig({ seed: {} }).seed).toBeNull()
  })
})

describe('the pmg flag is a SWITCH — everything downstream moves with it', () => {
  it('is false unless stored as exactly true (a truthy string is not a mode)', () => {
    expect(loadPricingConfig({}).pmg).toBe(false)
    expect(loadPricingConfig({ pmg: 'true' }).pmg).toBe(false)
    expect(loadPricingConfig({ pmg: 1 }).pmg).toBe(false)
    expect(loadPricingConfig({ pmg: true }).pmg).toBe(true)
  })

  it('picks the DEBRIEF PROMPT for the mode (spec §9)', () => {
    expect(loadPricingConfig({ pmg: false }).debriefPrompt).toBe(DEFAULT_DEBRIEF_PROMPT_STANDARD)
    expect(loadPricingConfig({ pmg: true }).debriefPrompt).toBe(DEFAULT_DEBRIEF_PROMPT_PMG)
    // The two really are different questions, not one with the mode's name in it.
    expect(DEFAULT_DEBRIEF_PROMPT_PMG).toContain('Price Matching Guarantee')
    expect(DEFAULT_DEBRIEF_PROMPT_STANDARD).not.toContain('Price Matching')
  })

  it('but an instructor-edited prompt survives the mode default', () => {
    expect(loadPricingConfig({ pmg: true, debrief_prompt: 'Mine' }).debriefPrompt).toBe('Mine')
  })

  it('picks the COMPETITOR RULE for the mode (spec §5)', () => {
    const strategies = loadPricingStrategies(undefined)
    expect(activeStrategy(loadPricingConfig({ pmg: false }), strategies))
      .toBe('standard-highstart-bestreply')
    expect(activeStrategy(loadPricingConfig({ pmg: true }), strategies))
      .toBe('pmg-ceiling')
  })
})

describe('loadPricingStrategies — the rule is config, not a rebuild (spec §5)', () => {
  it('an absent truth doc gives the shipped rule for each mode', () => {
    expect(loadPricingStrategies(undefined)).toEqual(DEFAULT_STRATEGIES)
    expect(loadPricingStrategies({})).toEqual(DEFAULT_STRATEGIES)
  })

  it('an instructor may swap a mode’s rule for another library rule', () => {
    const s = loadPricingStrategies({ standard_strategy: 'pmg-ceiling' })
    expect(s.standard).toBe('pmg-ceiling')
    expect(s.pmg).toBe('pmg-ceiling')
    expect(activeStrategy(loadPricingConfig({ pmg: false }), s)).toBe('pmg-ceiling')
  })

  it('an UNKNOWN rule id falls back rather than reaching the compute step', () => {
    const s = loadPricingStrategies({ standard_strategy: 'undercut-always', pmg_strategy: 42 })
    expect(s).toEqual(DEFAULT_STRATEGIES)
  })
})

describe('parseRoundRange (spec §3)', () => {
  it('defaults to [10, 20]', () => {
    expect(parseRoundRange(undefined, undefined)).toEqual({ minRounds: 10, maxRounds: 20 })
    expect(DEFAULT_MIN_ROUNDS).toBe(10)
    expect(DEFAULT_MAX_ROUNDS).toBe(20)
  })
  it('accepts a configured range', () => {
    expect(parseRoundRange(3, 5)).toEqual({ minRounds: 3, maxRounds: 5 })
  })
  it('clamps to the hard bounds — no zero-round and no unfinishable game', () => {
    expect(parseRoundRange(0, 5000)).toEqual({ minRounds: 1, maxRounds: HARD_MAX_ROUNDS })
  })
  it('restores the defaults when min > max or either is not an integer', () => {
    expect(parseRoundRange(20, 10)).toEqual({ minRounds: 10, maxRounds: 20 })
    expect(parseRoundRange(10.5, 20)).toEqual({ minRounds: 10, maxRounds: 20 })
    expect(parseRoundRange('10', 20)).toEqual({ minRounds: 10, maxRounds: 20 })
  })
})

describe('truthParticipantDoc', () => {
  it('prefixes the id so it can never collide with truth/main', () => {
    expect(truthParticipantDoc('stu-1')).toBe('participant_stu-1')
    expect(truthParticipantDoc('main')).toBe('participant_main')
    expect(truthParticipantDoc('main')).not.toBe('main')
  })
})
