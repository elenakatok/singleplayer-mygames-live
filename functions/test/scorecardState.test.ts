import { describe, it, expect } from 'vitest'
import {
  parseStoredContracts, positionOf, phaseOf, upcomingContract, completedResults,
  totalEarnings, currentStanding, fullSchedule, toPeriodRecords,
  type StoredContract,
} from '../src/scorecard/state'
import { screenId, toClientContract, freshClientContract, clientParams } from '../src/scorecard/clientState'
import {
  DEFAULT_CONFIG, DEFAULT_TRUTH, type ScorecardConfig, type ScorecardTruth, type Condition,
} from '../src/scorecard/config'

// ═══════════════════════════════════════════════════════════════════════════════
// RESUME (spec §13) and the nested loop's state machine.
//
// ⚠ THESE TESTS RECONSTRUCT A DOC MID-FLOW RATHER THAN REPLAYING ONE. Replay would
// exercise the WRITER; resume is a property of the READER, and the failure being guarded
// against is a student coming back to a document some other process wrote.
// ═══════════════════════════════════════════════════════════════════════════════

const config: ScorecardConfig = DEFAULT_CONFIG
const truth: ScorecardTruth = DEFAULT_TRUTH

/** A contract with `n` periods played, all low effort, all misses. */
function contractWith(n: number, index: number, condition: Condition): StoredContract {
  const periods = Array.from({ length: n }, (_, i) => ({
    period: i + 1,
    action: 'low' as const,
    u: 0.99,
    acceptable: false,
    reliability_used: config.pAcceptableLow,
    score: 0,
    balance: config.endowmentPerContract,
  }))
  return {
    contract: index,
    condition,
    reliability: condition === 'high' ? truth.reliabilityHigh : truth.reliabilityLow,
    periods,
  }
}

describe('positionOf — the three resume boundaries (spec §13)', () => {
  it('a fresh session opens at contract 1, period 1', () => {
    const p = positionOf([], config, false)
    expect(p).toEqual({ kind: 'effort-choice', contract: 1, period: 1 })
    expect(phaseOf(p)).toBe('play')
  })

  it('⚠ BOUNDARY 1 — mid-contract resumes at the next unplayed period', () => {
    for (const played of [1, 4, 9]) {
      const p = positionOf([contractWith(played, 1, 'high')], config, false)
      expect(p).toEqual({ kind: 'effort-choice', contract: 1, period: played + 1 })
    }
  })

  it('⚠ BOUNDARY 2 — a completed contract resumes at contract-result, not the next contract', () => {
    const p = positionOf([contractWith(10, 1, 'high')], config, false)
    expect(p).toEqual({ kind: 'contract-result', contract: 1 })
    // ⚠ The whole point of the gated advance: the NEXT contract is not implied here, so
    // nothing downstream can render its reliability.
    expect(p.period).toBeUndefined()
  })

  it('⚠ BOUNDARY 3 — the last contract completed resumes at session-summary', () => {
    const all = Array.from({ length: config.contracts }, (_, i) =>
      contractWith(10, i + 1, i % 2 === 0 ? 'high' : 'low'))
    const p = positionOf(all, config, false)
    expect(p).toEqual({ kind: 'session-summary' })
    expect(phaseOf(p)).toBe('debrief')
  })

  it('the finish stamp wins even if the contracts array disagrees', () => {
    // S3: gates key on the stamp. A mid-assignment config change that raised `contracts`
    // must not reopen a session already stamped finished.
    expect(positionOf([contractWith(3, 1, 'high')], config, true)).toEqual({ kind: 'session-summary' })
  })

  it('and a session-summary is derived even WITHOUT the stamp', () => {
    // Belt and braces: a doc missing `finished_at` still reads correctly.
    const all = Array.from({ length: config.contracts }, (_, i) => contractWith(10, i + 1, 'high'))
    expect(positionOf(all, config, false).kind).toBe('session-summary')
  })

  it('mid-contract on a LATER contract resumes correctly', () => {
    const contracts = [
      contractWith(10, 1, 'high'), contractWith(10, 2, 'low'), contractWith(3, 3, 'high'),
    ]
    expect(positionOf(contracts, config, false))
      .toEqual({ kind: 'effort-choice', contract: 3, period: 4 })
  })
})

describe('⚠ the schedule survives resume — derived from the STORED startsWith', () => {
  it("contract 3 is LOW for a startsWith='low' participant (the spec's own calibration)", () => {
    const up = upcomingContract(3, 'low', config, truth)
    expect(up.condition).toBe('low')
    expect(up.reliability).toBe(truth.reliabilityLow)
    expect(up.label).toBe('Low Reliability (40%)')
  })

  it("contract 3 is HIGH for a startsWith='high' participant", () => {
    expect(upcomingContract(3, 'high', config, truth).condition).toBe('high')
  })

  it('⚠ depends on NOTHING that could have changed since the student joined', () => {
    // The only inputs are the stored arm and the contract index. There is no clock, no
    // RNG and no participant document in scope — which is what makes resume total.
    for (let k = 1; k <= config.contracts; k++) {
      expect(upcomingContract(k, 'low', config, truth).condition)
        .toBe(upcomingContract(k, 'low', config, truth).condition)
    }
  })

  it('the two arms mirror each other at every contract', () => {
    const hi = fullSchedule('high', config, truth)
    const lo = fullSchedule('low', config, truth)
    expect(hi).toHaveLength(config.contracts)
    hi.forEach((c, i) => expect(lo[i]).not.toBe(c))
  })
})

describe('⚠ T10 — screenId isolates periods AND contracts', () => {
  it('changes on every period within a contract', () => {
    const ids = Array.from({ length: 10 }, (_, i) =>
      screenId({ kind: 'effort-choice', contract: 1, period: i + 1 }))
    expect(new Set(ids).size).toBe(10)
  })

  it('⚠ does NOT collide across contracts at the same period number', () => {
    // The contract boundary is the second instance of the PD bug class: balance resets to
    // the endowment, score resets to zero and the reliability may change. A period-only
    // id would hand contract 2 period 1 the same key as contract 1 period 1 and React
    // would keep the mounted subtree — with a stale radio selection and stale numbers.
    const a = screenId({ kind: 'effort-choice', contract: 1, period: 1 })
    const b = screenId({ kind: 'effort-choice', contract: 2, period: 1 })
    expect(a).not.toBe(b)
    expect(a).toBe('effort-c1-p1')
    expect(b).toBe('effort-c2-p1')
  })

  it('every position in a whole session gets a distinct id', () => {
    const ids: string[] = []
    for (let c = 1; c <= config.contracts; c++) {
      for (let p = 1; p <= config.periodsPerContract; p++) {
        ids.push(screenId({ kind: 'effort-choice', contract: c, period: p }))
      }
      ids.push(screenId({ kind: 'contract-result', contract: c }))
    }
    ids.push(screenId({ kind: 'session-summary' }))
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toHaveLength(config.contracts * config.periodsPerContract + config.contracts + 1)
  })
})

describe('the client whitelist (spec §8)', () => {
  it('⚠ clientParams carries NEITHER reliability, the schedule, nor the seed', () => {
    const params = clientParams(config) as Record<string, unknown>
    for (const forbidden of [
      'reliabilityHigh', 'reliabilityLow', 'reliabilitySchedule', 'labelHigh', 'labelLow',
      'seed', 'startsWith',
    ]) {
      expect(params[forbidden], `clientParams must not carry ${forbidden}`).toBeUndefined()
    }
  })

  it('carries exactly the printed parameter block, and nothing more', () => {
    expect(Object.keys(clientParams(config)).sort()).toEqual([
      'bonus', 'buyerName', 'contractNoun', 'contracts', 'currency', 'deliveryNoun',
      'endowmentPerContract', 'highEffortCost', 'lowEffortCost', 'pAcceptableLow',
      'periodNoun', 'periodsPerContract', 'productName', 'scorecardNoun',
      'showPriorContractsPanel', 'showReliabilityLabel', 'showRunningBalance',
      'showTargetReachedBanner', 'targetScore',
    ])
  })

  it('⚠ §4.1 — a DEAD contract\'s payload has the same shape as a live one', () => {
    // Ten low-effort misses: dead from period 5 (0 + 6 < 7). The key sets must match,
    // and no value may encode the conclusion.
    const dead = toClientContract(contractWith(6, 1, 'high'), config, 'High Reliability (70%)')
    const live = toClientContract(contractWith(2, 1, 'high'), config, 'High Reliability (70%)')
    expect(dead.score + dead.periodsRemaining).toBeLessThan(config.targetScore)   // dead
    expect(live.score + live.periodsRemaining).toBeGreaterThanOrEqual(config.targetScore) // live
    expect(Object.keys(dead).sort()).toEqual(Object.keys(live).sort())
    expect(dead.targetReached).toBe(false)
    expect(live.targetReached).toBe(false)
  })

  it('⚠ the REACHED-target flag does ship — the asymmetry is deliberate', () => {
    const c = contractWith(8, 1, 'high')
    c.periods.forEach((p, i) => { p.acceptable = i < 7; p.score = Math.min(i + 1, 7) })
    const client = toClientContract(c, config, null)
    expect(client.targetReached).toBe(true)
  })

  it('a fresh contract opens at the endowment with nothing played', () => {
    const c = freshClientContract(4, 0.4, 'Low Reliability (40%)', config)
    expect(c).toMatchObject({
      contract: 4, period: 1, score: 0, balance: config.endowmentPerContract,
      highEffortPeriods: 0, targetReached: false, isContractStart: true, periods: [],
      periodsRemaining: config.periodsPerContract,
    })
  })
})

describe('parseStoredContracts — defensive reads', () => {
  it('reads a well-formed array', () => {
    const raw = [contractWith(10, 1, 'high'), contractWith(4, 2, 'low')]
    const parsed = parseStoredContracts(raw, config)
    expect(parsed).toHaveLength(2)
    expect(parsed[1].periods).toHaveLength(4)
  })

  it('returns [] for anything that is not an array', () => {
    for (const junk of [undefined, null, 42, 'x', {}]) {
      expect(parseStoredContracts(junk, config)).toEqual([])
    }
  })

  it('stops at the first out-of-order contract, keeping a contiguous prefix', () => {
    const raw = [contractWith(10, 1, 'high'), { ...contractWith(10, 2, 'low'), contract: 5 }]
    expect(parseStoredContracts(raw, config)).toHaveLength(1)
  })

  it('stops at a malformed period, keeping the contiguous prefix', () => {
    const c = contractWith(5, 1, 'high')
    ;(c.periods[2] as unknown as Record<string, unknown>).u = 'not a number'
    expect(parseStoredContracts([c], config)[0].periods).toHaveLength(2)
  })

  it('an incomplete contract must be the LAST one', () => {
    const raw = [contractWith(4, 1, 'high'), contractWith(10, 2, 'low')]
    // Contract 1 is short, so nothing after it is trusted.
    expect(parseStoredContracts(raw, config)).toHaveLength(1)
  })

  it('⚠ RECOMPUTES settlement rather than trusting the stored summary', () => {
    const c = contractWith(10, 1, 'high')
    c.periods.forEach((p, i) => { p.acceptable = i < 8; p.score = Math.min(i + 1, 8) })
    // A stored summary that disagrees with the periods must lose — the periods are the
    // audit record and the summary is a cache.
    c.earnings = 99999
    c.score = 0
    const parsed = parseStoredContracts([c], config)[0]
    expect(parsed.score).toBe(8)
    expect(parsed.met_target).toBe(true)
    expect(parsed.earnings).toBe(config.endowmentPerContract + config.bonus) // all low effort
  })

  it('refuses more contracts than the config allows', () => {
    const raw = Array.from({ length: config.contracts + 5 }, (_, i) => contractWith(10, i + 1, 'high'))
    expect(parseStoredContracts(raw, config)).toHaveLength(config.contracts)
  })
})

describe('derived figures', () => {
  it('totals only COMPLETED contracts — an open one contributes nothing', () => {
    const done = contractWith(10, 1, 'high')
    done.periods.forEach((p, i) => { p.acceptable = i < 7; p.score = Math.min(i + 1, 7) })
    const open = contractWith(3, 2, 'low')
    const parsed = parseStoredContracts([done, open], config)
    expect(completedResults(parsed, config)).toHaveLength(1)
    // The bonus is not known until a contract settles (spec §1).
    expect(totalEarnings(parsed, config)).toBe(config.endowmentPerContract + config.bonus)
  })

  it('currentStanding reads the open contract, and resets between contracts', () => {
    const open = contractWith(3, 1, 'high')
    open.periods[2].score = 2
    open.periods[2].balance = 38
    expect(currentStanding([open], config)).toEqual({ score: 2, balance: 38, highEffortPeriods: 0 })
    // With no open contract, standing is a fresh contract's.
    expect(currentStanding([contractWith(10, 1, 'high')], config))
      .toEqual({ score: 0, balance: config.endowmentPerContract, highEffortPeriods: 0 })
  })

  it('toPeriodRecords tags every period with its contract condition', () => {
    const c = contractWith(4, 1, 'low')
    expect(toPeriodRecords(c).every(r => r.condition === 'low')).toBe(true)
    expect(toPeriodRecords(c)).toHaveLength(4)
  })
})
