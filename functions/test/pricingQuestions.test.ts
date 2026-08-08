import { describe, it, expect } from 'vitest'
import { resolvePricingKcQuestions, toClientKcQuestions, debriefQuestion } from '../src/pricing/questions'
import { DEFAULT_MARKET, computeRound, type PricingMarketConfig } from '../src/pricing/market'
import {
  DEFAULT_LABELS, loadPricingConfig,
  DEFAULT_DEBRIEF_PROMPT_STANDARD, DEFAULT_DEBRIEF_PROMPT_PMG,
} from '../src/pricing/config'

// ═══════════════════════════════════════════════════════════════════════════════
// The knowledge check (spec §8) and the debrief (spec §9).
//
// The theme throughout is NEVER-STALE: every number in every question is derived
// from the instance's market, so editing the market moves the questions AND their
// answers together. The tests that matter most are the ones that edit the market and
// check the answer followed.
// ═══════════════════════════════════════════════════════════════════════════════

const M = DEFAULT_MARKET
const std = () => resolvePricingKcQuestions(M, false, DEFAULT_LABELS)
const pmg = () => resolvePricingKcQuestions(M, true, DEFAULT_LABELS)

/** The two prices the share/contribution questions are posed with, per questions.ts:
 *  a grid price just below the ceiling, and one two grid steps below that. */
const THEIRS = M.maxPrice - M.gridStep      // 1900
const YOURS = THEIRS - 2 * M.gridStep       // 1700

describe('the MODE picks the set (spec §8.1 vs §8.2)', () => {
  it('Standard asks the four share/contribution questions', () => {
    expect(std().map(q => q.field)).toEqual([
      'kc_base_share', 'kc_share_gap', 'kc_contribution', 'kc_below_cost',
    ])
  })

  it('PMG asks three price-matching questions', () => {
    expect(pmg().map(q => q.field)).toEqual([
      'kc_pmg_effective', 'kc_pmg_share', 'kc_pmg_undercut',
    ])
  })

  it('⚠ and PMG repeats NONE of the Standard four — students did those in instance 1', () => {
    const stdFields = new Set(std().map(q => q.field))
    expect(pmg().every(q => !stdFields.has(q.field))).toBe(true)
  })

  it('every question is graded, multiple choice, and carries an explanation', () => {
    for (const q of [...std(), ...pmg()]) {
      expect(q.type).toBe('mc')
      expect(q.grading).toBe('static')
      expect(q.options.length).toBeGreaterThanOrEqual(3)
      expect(q.correct_value).toBeTruthy()
      expect(q.explanation.length).toBeGreaterThan(20)
      // The correct answer must be ON the list — otherwise everyone is marked wrong.
      expect(q.options.some(o => o.value === q.correct_value)).toBe(true)
    }
  })
})

describe('Standard mode answers, against the spec’s derivations (§8.1)', () => {
  it('Q1 base share = s_c', () => {
    const q = std()[0]
    expect(q.correct_value).toBe('0.3500')
    expect(q.options.map(o => o.label)).toEqual(['35%', '50%', '65%', '100%'])
  })

  it('Q2 share at a gap = s_c + (their price − your price) / k', () => {
    const q = std()[1]
    // $1,700 vs $1,900 ⇒ 0.35 + 200/1000 = 0.55, exactly as the spec's table.
    expect(q.correct_value).toBe('0.5500')
    expect(q.prompt).toContain('$1,700')
    expect(q.prompt).toContain('$1,900')
    // Distractors: base, the sign-flipped (competitor's) share, competitor base.
    expect(q.options.map(o => o.label)).toEqual(['35%', '45%', '55%', '65%'])
  })

  it('Q3 contribution = price − YOUR unit cost', () => {
    const q = std()[2]
    expect(q.correct_value).toBe(String(YOURS - M.studentUnitCost))   // 734
    // Distractors: the unit cost, the price, and the competitor's-cost mistake.
    expect(q.options.map(o => o.value).sort((a, b) => Number(a) - Number(b)))
      .toEqual(['734', '800', '966', '1700'])
  })

  it('Q4 pricing below cost is NEGATIVE, whatever the share', () => {
    const q = std()[3]
    expect(q.correct_value).toBe('negative')
    expect(q.prompt).toContain('$900')     // the floor, from config
    expect(q.prompt).toContain('$966')     // the unit cost, from config
    expect(q.options.map(o => o.value)).toEqual(['negative', 'high', 'zero', 'depends'])
  })
})

describe('PMG mode answers, against the spec’s derivations (§8.2)', () => {
  it('Q1 your customers pay the LOWER posted price', () => {
    const q = pmg()[0]
    expect(q.correct_value).toBe(String(YOURS))
    expect(q.prompt).toContain('actually pay')
  })

  it('Q2 your share is frozen at base', () => {
    const q = pmg()[1]
    expect(q.correct_value).toBe('0.3500')
  })

  it('⚠ …and the diagnostic distractor is the STANDARD formula’s impossible answer', () => {
    const q = pmg()[1]
    const over100 = q.options.filter(o => Number(o.value) > 1)
    expect(over100.length).toBe(1)
    // At the defaults the gap is $700, so the Standard formula would say 105%.
    expect(over100[0].label).toBe('105%')
  })

  it('Q3 undercutting wins NOTHING under PMG', () => {
    const q = pmg()[2]
    expect(q.correct_value).toBe('none')
    // The "19,000 containers" distractor is what the same undercut wins in Standard.
    expect(q.options.map(o => o.label)).toContain('19,000 containers')
  })
})

describe('⚠ NEVER STALE — edit the market and every answer follows', () => {
  const edited: PricingMarketConfig = {
    ...M, studentBaseShare: 0.4, competitorBaseShare: 0.6, studentUnitCost: 1000,
  }

  it('the base-share answer moves with the base share', () => {
    expect(resolvePricingKcQuestions(edited, false)[0].correct_value).toBe('0.4000')
  })

  it('the gap answer moves too, and still agrees with the MARKET MODEL itself', () => {
    const q = resolvePricingKcQuestions(edited, false)[1]
    // Not recomputed by hand: asked of the same function the game scores rounds with.
    const truth = computeRound(YOURS, THEIRS, edited, false).studentShare
    expect(q.correct_value).toBe(truth.toFixed(4))
  })

  it('the contribution answer uses the NEW unit cost', () => {
    expect(resolvePricingKcQuestions(edited, false)[2].correct_value)
      .toBe(String(YOURS - 1000))
  })

  it('a narrowed price band moves the prices the questions are posed with', () => {
    const narrow: PricingMarketConfig = { ...M, minPrice: 1000, maxPrice: 1400 }
    const q = resolvePricingKcQuestions(narrow, false)[1]
    // Every price named must be one the game would actually accept.
    for (const m of q.prompt.matchAll(/\$([\d,]+)/g)) {
      const p = Number(m[1].replace(/,/g, ''))
      expect(p).toBeGreaterThanOrEqual(narrow.minPrice)
      expect(p).toBeLessThanOrEqual(narrow.maxPrice)
    }
  })
})

describe('a market that makes a question meaningless drops it', () => {
  it('no in-bounds price below unit cost ⇒ no below-cost question', () => {
    const aboveCost: PricingMarketConfig = { ...M, minPrice: 1200 }
    const qs = resolvePricingKcQuestions(aboveCost, false)
    expect(qs.map(q => q.field)).toEqual(['kc_base_share', 'kc_share_gap', 'kc_contribution'])
  })

  it('…and the set renumbers, so the client’s "question N of M" stays honest', () => {
    const qs = resolvePricingKcQuestions({ ...M, minPrice: 1200 }, false)
    expect(qs.map(q => q.order)).toEqual([1, 2, 3])
  })
})

describe('options are de-duplicated — an edited market cannot offer the same value twice', () => {
  it('a 50% base share collapses the "50%" distractor into the right answer', () => {
    const half: PricingMarketConfig = { ...M, studentBaseShare: 0.5, competitorBaseShare: 0.5 }
    const q = resolvePricingKcQuestions(half, false)[0]
    const values = q.options.map(o => o.value)
    expect(new Set(values).size).toBe(values.length)
    expect(values).toContain('0.5000')
    // Still answerable: the right answer is offered exactly once.
    expect(values.filter(v => v === q.correct_value)).toHaveLength(1)
  })
})

describe('toClientKcQuestions — the answer key never ships', () => {
  it('strips correct_value and explanation from every question, in both modes', () => {
    for (const set of [std(), pmg()]) {
      const client = toClientKcQuestions(set, 'stu-1')
      const json = JSON.stringify(client)
      expect(json).not.toContain('correct_value')
      expect(json).not.toContain('explanation')
      for (const q of client) {
        expect(Object.keys(q).sort()).toEqual(['field', 'options', 'prompt'])
      }
    }
  })

  it('⚠ nor does the POSITION of the answer — `ordered` marks the flag, not the field', () => {
    // Every question that is NOT a numeric ladder must be shuffled. Asserted against
    // `ordered` itself so a question added later is covered without editing this test.
    for (const set of [std(), pmg()]) {
      const categorical = set.filter(q => !q.ordered)
      expect(categorical.length, 'each mode has at least one categorical question')
        .toBeGreaterThan(0)
      for (const q of categorical) {
        // Across many students the answer must not land first every time.
        const firsts = new Set(
          Array.from({ length: 40 }, (_, i) =>
            toClientKcQuestions([q], `stu-${i}`)[0].options[0].value),
        )
        expect(firsts.size, `${q.field}: the first option must vary across students`)
          .toBeGreaterThan(1)
      }
    }
  })

  it('⚠ …and the same student always sees the same order — a reload is not a new screen', () => {
    const a = toClientKcQuestions(std(), 'stu-7')
    const b = toClientKcQuestions(std(), 'stu-7')
    expect(a).toEqual(b)
  })

  it('numeric ladders keep their sort — position tracks value, not correctness', () => {
    for (const set of [std(), pmg()]) {
      for (const q of set.filter(x => x.ordered)) {
        const served = toClientKcQuestions([q], 'stu-3')[0].options.map(o => Number(o.value))
        expect(served, `${q.field} stays ascending`)
          .toEqual([...served].sort((x, y) => x - y))
      }
    }
  })

  it('⚠ shuffling never drops, duplicates or rewrites an option', () => {
    for (const set of [std(), pmg()]) {
      for (const q of set) {
        const served = toClientKcQuestions([q], 'stu-9')[0].options
        expect([...served].sort((a, b) => a.value.localeCompare(b.value)))
          .toEqual([...q.options].map(o => ({ value: o.value, label: o.label }))
            .sort((a, b) => a.value.localeCompare(b.value)))
      }
    }
  })
})

describe('the debrief (spec §9)', () => {
  it('is ungraded BY CONSTRUCTION — no grading, no key', () => {
    expect(debriefQuestion.correct_value).toBeUndefined()
    expect((debriefQuestion as { grading?: string }).grading).toBeUndefined()
    expect(debriefQuestion.field).toBe('debrief_reflection')
  })

  it('and its PROMPT comes from the mode (config), verbatim from the spec', () => {
    expect(loadPricingConfig({ pmg: false }).debriefPrompt).toBe(DEFAULT_DEBRIEF_PROMPT_STANDARD)
    expect(loadPricingConfig({ pmg: true }).debriefPrompt).toBe(DEFAULT_DEBRIEF_PROMPT_PMG)
    expect(DEFAULT_DEBRIEF_PROMPT_STANDARD).toContain('How did you choose your initial price')
    expect(DEFAULT_DEBRIEF_PROMPT_PMG).toContain('Price Matching Guarantee')
  })
})
