import { marginalThreshold, type ScorecardRules } from './config'

// ═══════════════════════════════════════════════════════════════════════════════
// THE SOLVER (spec §6). ⚠⚠ ONE SOLVER, FOUR CONSUMERS — spec §16, and the single most
// important structural rule in this build.
//
// The settings panel (§3.1), the reports (§11), the optimizer robot (build prompt CP3)
// and the debrief reveal (§10) ALL call `solve()`. Nothing anywhere else may implement
// a policy, not even an "obviously equivalent" one.
//
// ⚠ WHY THE OBVIOUS SHORTCUT IS WRONG. "Work until you hit the target" looks right and
// is nearly right — it earns 91.16 against the optimum's 94.12 under high reliability.
// It is WRONG at (period 7, score 6), where Δ = 8.80 against a threshold of 10: one point
// from target with four periods left, the DP takes the FREE DRAWS FIRST. The loss from
// getting that one cell wrong is 0.17 ECU per contract — far too small for anyone to
// notice on a screen, and large enough to make the reports and the debrief argue for a
// policy the lecture does not teach. `highUntilTarget` below exists ONLY as a §6.3
// benchmark row, and is never a policy any consumer may play.
//
// ── THE RULE (spec §6.1) ──────────────────────────────────────────────────────
//
//   high beats low  ⟺  (reliability − p_low) · Δ  >  (c_high − c_low)
//                      where Δ = V(r−1, s+1) − V(r−1, s)
//
// Δ is the OPTION VALUE of one scorecard point, and under a threshold payoff it is
// violently non-constant: `bonus` when the point is pivotal, 0 the moment the target is
// met or lost. Coasting, writing off and the squeeze are one rule applied to a payoff
// with a cliff in it — the treatment does not change the rule, it multiplies the
// left-hand side by a quarter.
//
// ── STATE ─────────────────────────────────────────────────────────────────────
//
// Indexed `[periodsRemaining][score]`, NOT `[period][score]`. Periods-remaining is the
// natural recursion (V[0] is terminal) and it is what makes the solver independent of
// where in a contract it is asked. The §6.2 grids are printed by PERIOD, so
// `policyGrid()` converts: at period p of T, periodsRemaining = T − p + 1.
//
// ⚠ NO EPSILON ON THE COMPARISON. The (period 7, score 6) cell sits 0.48 from flipping
// and spec §6.2 records that it "flips under small parameter edits" — that is a
// DESIGN FACT about the parameters, not float noise, and a tolerance would paper over
// exactly the sensitivity the settings panel exists to display. Strict `>` throughout,
// which also gives ties to LOW effort — correct, since spec §6.1 requires a point be
// worth strictly MORE than the threshold.
// ═══════════════════════════════════════════════════════════════════════════════

/** What optimal play is worth, and what it does, under ONE condition. */
export interface Solution {
  /** The reliability this was solved at — carried so a consumer cannot mix conditions. */
  reliability: number
  /**
   * `policy[r][s]` — true when high effort is optimal with r periods remaining and
   * score s. r ranges 1…T; index 0 is unused (terminal, no action).
   */
  policy: boolean[][]
  /**
   * `V[r][s]` — expected FUTURE earnings (effort costs and the terminal bonus) from
   * r periods remaining at score s. ⚠ EXCLUDES the endowment, which is not a decision
   * variable; `benchmarks.optimal` adds it back.
   */
  V: number[][]
  benchmarks: Benchmarks
}

/** Spec §6.3's column for one condition. All analytic — nothing here is simulated. */
export interface Benchmarks {
  /** One scorecard point must be worth more than this (spec §6.1). 10 / 40. */
  marginalThreshold: number
  /** E[earnings] per contract under the DP. 94.12 / 51.56. */
  optimal: number
  /** ⚠ A BENCHMARK ROW, NEVER A POLICY. 91.16 / 16.71. See the header. */
  highUntilTarget: number
  /** 87.95 / 16.57. */
  alwaysHigh: number
  /** ⚠ IDENTICAL IN BOTH CONDITIONS — reliability never touches low effort. 51.27. */
  alwaysLow: number
  /** P(bonus) under the DP. 0.6427 / 0.0173. */
  pBonusOptimal: number
  /** E[high-effort periods] under the DP. 8.25 / 0.13. */
  expectedHighEffortPeriods: number
  /** E[final score] under the DP. 6.30 / 3.01. */
  expectedScoreOptimal: number
}

/**
 * Solve one condition.
 *
 * ⚠ Takes ONE reliability, never a config holding both — see `ScorecardRules`. A caller
 * that wants both conditions calls this twice, which is what every consumer does.
 */
export function solve(rules: ScorecardRules, reliability: number): Solution {
  const { periodsPerContract: T, targetScore: S, bonus: B, pAcceptableLow: pLow } = rules

  const V: number[][] = []
  const policy: boolean[][] = []

  // Terminal: nothing left to play, so the contract is worth its bonus or nothing.
  V[0] = []
  for (let s = 0; s <= T; s++) V[0][s] = s >= S ? B : 0
  policy[0] = []

  for (let r = 1; r <= T; r++) {
    V[r] = []
    policy[r] = []
    for (let s = 0; s <= T; s++) {
      const up = V[r - 1][Math.min(s + 1, T)]
      const stay = V[r - 1][s]
      // The DIFFERENCE is what the rule turns on; the levels are carried so V is a
      // genuine expected-earnings figure the reports can display.
      const low = -rules.lowEffortCost + pLow * up + (1 - pLow) * stay
      const high = -rules.highEffortCost + reliability * up + (1 - reliability) * stay
      const takeHigh = high > low
      policy[r][s] = takeHigh
      V[r][s] = takeHigh ? high : low
    }
  }

  return {
    reliability,
    policy,
    V,
    benchmarks: computeBenchmarks(rules, reliability, policy, V),
  }
}

/** True when high effort is optimal in this state. The accessor every consumer uses. */
export function highEffortOptimal(sol: Solution, periodsRemaining: number, score: number): boolean {
  return sol.policy[periodsRemaining]?.[score] ?? false
}

// ── The forward distribution ──────────────────────────────────────────────────

/**
 * Roll a policy forward exactly, period by period, over the distribution of scores.
 *
 * ⚠ EXACT, NOT SIMULATED (spec §6.3: "Benchmarks (exact, not simulated)"). The state
 * space is ~110 cells and the horizon is 10, so the whole distribution is cheap to carry
 * — there is no reason to accept Monte Carlo error in a number that goes on a slide.
 * The harness DOES cross-check these against 200k simulated runs (spec §13), which is a
 * different job: catching a wrong closed form, not estimating one.
 */
function rollForward(
  rules: ScorecardRules,
  reliability: number,
  playsHigh: (periodsRemaining: number, score: number) => boolean,
): { dist: Map<number, number>; expectedHigh: number; perPeriod: PeriodMass[] } {
  const { periodsPerContract: T, pAcceptableLow: pLow } = rules
  let dist = new Map<number, number>([[0, 1]])
  let expectedHigh = 0
  const perPeriod: PeriodMass[] = []

  for (let p = 1; p <= T; p++) {
    const r = T - p + 1
    let pHigh = 0
    let pCoast = 0
    for (const [s, pr] of dist) {
      if (playsHigh(r, s)) pHigh += pr
      else if (s >= rules.targetScore) pCoast += pr
    }
    // ⚠ "WRITTEN OFF" IS THE REMAINDER, and the definition matters — see BUILD_NOTES.
    // It is NOT "mathematically unreachable": spec §6.2 calls (period 4, score 0) a
    // write-off at Δ = 2.72 even though score 0 with 7 periods left can still reach 7.
    // The category is "the DP has stopped paying for this contract and is not coasting",
    // which is what the §6.3 profile table's three rows partition into.
    perPeriod.push({ period: p, pHigh, pCoasting: pCoast, pWrittenOff: 1 - pHigh - pCoast })
    expectedHigh += pHigh

    const next = new Map<number, number>()
    for (const [s, pr] of dist) {
      const q = playsHigh(r, s) ? reliability : pLow
      next.set(s + 1, (next.get(s + 1) ?? 0) + pr * q)
      next.set(s, (next.get(s) ?? 0) + pr * (1 - q))
    }
    dist = next
  }
  return { dist, expectedHigh, perPeriod }
}

/** One period's mass split three ways under a policy (spec §6.3's profile table). */
export interface PeriodMass {
  /** 1-based (R10). */
  period: number
  pHigh: number
  pCoasting: number
  pWrittenOff: number
}

function summarise(dist: Map<number, number>, targetScore: number) {
  let pBonus = 0
  let expectedScore = 0
  for (const [s, pr] of dist) {
    if (s >= targetScore) pBonus += pr
    expectedScore += s * pr
  }
  return { pBonus, expectedScore }
}

/** Earnings of a policy from its expected high-effort count and bonus probability. */
function earnings(rules: ScorecardRules, expectedHigh: number, pBonus: number): number {
  const lowPeriods = rules.periodsPerContract - expectedHigh
  return (
    rules.endowmentPerContract -
    rules.highEffortCost * expectedHigh -
    rules.lowEffortCost * lowPeriods +
    rules.bonus * pBonus
  )
}

function computeBenchmarks(
  rules: ScorecardRules,
  reliability: number,
  policy: boolean[][],
  V: number[][],
): Benchmarks {
  const opt = rollForward(rules, reliability, (r, s) => policy[r][s])
  const optStats = summarise(opt.dist, rules.targetScore)

  const hut = rollForward(rules, reliability, (_r, s) => s < rules.targetScore)
  const hutStats = summarise(hut.dist, rules.targetScore)

  const hi = rollForward(rules, reliability, () => true)
  const hiStats = summarise(hi.dist, rules.targetScore)

  // ⚠ Always-low is solved at pAcceptableLow, NOT at `reliability` — which is exactly
  // why the two conditions' always-low figures are identical (51.27 both). A bug that
  // routed reliability into this call would make the columns differ and would look
  // entirely plausible on screen. The fixture test pins them equal.
  const lo = rollForward(rules, reliability, () => false)
  const loStats = summarise(lo.dist, rules.targetScore)

  return {
    marginalThreshold: marginalThreshold(rules, reliability),
    optimal: rules.endowmentPerContract + V[rules.periodsPerContract][0],
    highUntilTarget: earnings(rules, hut.expectedHigh, hutStats.pBonus),
    alwaysHigh: earnings(rules, hi.expectedHigh, hiStats.pBonus),
    alwaysLow: earnings(rules, lo.expectedHigh, loStats.pBonus),
    pBonusOptimal: optStats.pBonus,
    expectedHighEffortPeriods: opt.expectedHigh,
    expectedScoreOptimal: optStats.expectedScore,
  }
}

// ── Consumers' views of the solution ─────────────────────────────────────────

/**
 * The per-period effort profile under optimal play (spec §6.3) — the DASHED REFERENCE
 * on Tier-3 chart 2 and on the final student screen (§5).
 *
 * ⚠ This is what makes chart 2 argue something (spec §11): under low reliability the
 * optimal line is flat near zero, and the class line floating far above it is the whole
 * lecture. A chart without it is two curves nobody can score.
 */
export function optimalProfile(rules: ScorecardRules, reliability: number): PeriodMass[] {
  const sol = solve(rules, reliability)
  return rollForward(rules, reliability, (r, s) => sol.policy[r][s]).perPeriod
}

/**
 * P(a contract reaches a mathematically dead state with at least `minPeriodsLeft` still
 * to play) under optimal play — 27.8% at defaults under high reliability (spec §6.3).
 *
 * "Mathematically dead" here IS the strict sense — `score + periodsRemaining < S*`, the
 * bonus is impossible — which is a different and narrower thing than `pWrittenOff` above.
 * It is what spec §4.1's silence is about, and the number is why that silence applies to
 * most students rather than to an edge case.
 *
 * ⚠ DEAD MASS IS REMOVED FROM THE LIVE DISTRIBUTION as it is counted, so each contract
 * is counted at most once. Counting "is dead now and was alive one period ago" instead
 * DOUBLE-COUNTS — a contract that scores a point while already dead re-satisfies the
 * naive test — and inflates 27.8% to 35.6%. Death is absorbing: once s + r < S*, scoring
 * keeps s + r constant, so it can never recover.
 */
export function deadStateShare(
  rules: ScorecardRules,
  reliability: number,
  minPeriodsLeft = 1,
): number {
  const { periodsPerContract: T, targetScore: S, pAcceptableLow: pLow } = rules
  const sol = solve(rules, reliability)
  let live = new Map<number, number>([[0, 1]])
  let dead = 0

  for (let p = 1; p <= T; p++) {
    const r = T - p + 1
    const next = new Map<number, number>()
    for (const [s, pr] of live) {
      const q = sol.policy[r][s] ? reliability : pLow
      next.set(s + 1, (next.get(s + 1) ?? 0) + pr * q)
      next.set(s, (next.get(s) ?? 0) + pr * (1 - q))
    }
    const left = T - p
    const survivors = new Map<number, number>()
    for (const [s, pr] of next) {
      if (s + left < S) {
        if (left >= minPeriodsLeft) dead += pr
      } else {
        survivors.set(s, pr)
      }
    }
    live = survivors
  }
  return dead
}

// ── The §6.2 grid ─────────────────────────────────────────────────────────────

/** A grid cell: high effort, low effort, or a state that cannot be reached. */
export type GridCell = '#' | 'o' | '.'

/**
 * Render the optimal policy as spec §6.2 prints it — the LECTURE SLIDE 6 layout.
 *
 * Rows are scores, HIGH FIRST, with the top row meaning "targetScore or better".
 * Columns are PERIODS 1…T (R10 — periods, not periods-remaining, and 1-based).
 *
 * Reachability: at period p, exactly p − 1 periods have been played, so a score above
 * p − 1 is unreachable and prints `.`.
 */
export function policyGrid(rules: ScorecardRules, reliability: number): { score: number; cells: GridCell[] }[] {
  const sol = solve(rules, reliability)
  const { periodsPerContract: T, targetScore: S } = rules
  const rows: { score: number; cells: GridCell[] }[] = []
  for (let s = S; s >= 0; s--) {
    const cells: GridCell[] = []
    for (let p = 1; p <= T; p++) {
      if (s > p - 1) cells.push('.')
      else cells.push(sol.policy[T - p + 1][s] ? '#' : 'o')
    }
    rows.push({ score: s, cells })
  }
  return rows
}

/** The grid as a printable block, in exactly the shape spec §6.2 uses. */
export function formatGrid(rules: ScorecardRules, reliability: number): string {
  const rows = policyGrid(rules, reliability)
  const header =
    'score  period→ ' +
    Array.from({ length: rules.periodsPerContract }, (_, i) => String(i + 1).padStart(2)).join(' ')
  const body = rows.map(({ score, cells }) => {
    const label = score === rules.targetScore ? `${score}+` : `${score} `
    return `    ${label.padEnd(4)}        ` + cells.map(c => c.padStart(2)).join(' ')
  })
  return [header, ...body].join('\n')
}
