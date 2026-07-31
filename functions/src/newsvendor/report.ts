import { onCall } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import { extractInstructorGameId } from '@mygames/game-server'
import {
  NEWSVENDOR_CORS_ORIGINS, INSTANCES_COLLECTION, PARTICIPANTS_SUBCOLLECTION, CONFIG_DOC,
  loadNewsvendorConfig,
} from './config'
import { criticalRatio, optimalOrder, economicsError } from './economics'
import { parseStoredRounds } from './rounds'
import { clientParams } from './clientState'
import { prepQuestion, debriefQuestion } from './questions'
import {
  ordersByPeriod, profitsByPeriod,
  averageOrder, averageDemand, averageServiceLevel, averageProfit, inStockRate,
  totalProfit, totalBenchmarkProfit, optimalityGap,
  averageBenchmarkProfit, averageOptimalityGap,
  classAverageOrder, classAverageDemand, classAverageServiceLevel,
  classAverageProfit, classAverageBenchmarkProfit,
  type NewsvendorGameRow, type SeriesPoint,
} from './reportStats'

// ═══════════════════════════════════════════════════════════════════════════════
// newsvendorGetReport (instructor) — the single instructor-facing data source,
// feeding BOTH the dashboard roster (Tier 1) and every report tile (Tiers 2 and 3).
// One callable, one read of the instance, exactly as pennies', PD's and pricing's do.
//
// ⚠ THIS RESPONSE CARRIES THE BENCHMARK, and that is correct. Q_opt, the critical
// ratio, the benchmark profit and the optimality gap exist so Elena can teach the
// gap; spec §9.2 withholds them from the STUDENT, not from the instructor. This
// callable is behind an instructor session, and no student screen imports from here —
// the student-side whitelists are in clientState.ts and rounds.ts.
//
// ⚠ CORRECT ON PARTIAL DATA. Elena opens this mid-week with the class spread across
// the assignment. Every aggregate is over who actually played (reportStats.ts), the
// charts' x-axis is the longest game ANYONE played rather than the configured period
// count, and nothing divides by a denominator it has not checked.
// ═══════════════════════════════════════════════════════════════════════════════

/** One student, as the dashboard and Tier 1 render them. */
export interface NewsvendorReportParticipant {
  participant_id: string
  name: string | null
  launched: boolean
  completed: boolean
  finalized: boolean
  rounds_played: number
  /** Mean order quantity. Null for a student who has ordered none. */
  average_order: number | null
  /** Mean realized demand they faced. Null likewise. */
  average_demand: number | null
  /** Mean demand proportion met (0–1). Null likewise. Still reported; no longer a
   *  roster column — see `in_stock_rate`, which replaced it. */
  average_service_level: number | null
  /** Fraction of periods FULLY stocked (Q ≥ D). Comparable to the critical ratio. */
  in_stock_rate: number | null
  /** Mean profit per period PLAYED. Null likewise. */
  average_profit: number | null
  /** Running totals. Still reported; the roster shows the per-period averages below. */
  total_profit: number
  /** ⚠ INSTRUCTOR-ONLY (spec §9.2). */
  benchmark_profit: number
  /** Benchmark minus realized, over periods played. SIGNED — see reportStats.ts. */
  optimality_gap: number | null
  /**
   * The three figures the roster actually renders — all PER PERIOD, so they share one
   * scale with each other and with the expected-profit chart. `average_profit` is
   * above; these two complete the set.
   */
  average_benchmark_profit: number | null
  average_optimality_gap: number | null
  knowledge_check_score: number | null
  /** The participation score, once Score & Record has run. Null before that. */
  participation_score: number | null
  /** The two Tier-2 paragraphs, or null if not written. */
  prep: string | null
  debrief: string | null
}

export const newsvendorGetReport = onCall({ cors: NEWSVENDOR_CORS_ORIGINS }, async (request) => {
  const data = request.data as Record<string, unknown>
  const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true'
  const authHeader = request.rawRequest.headers.authorization as string | undefined

  const gameInstanceId = await extractInstructorGameId(data, isEmulator, authHeader)

  const db = admin.firestore()
  const instanceRef = db.collection(INSTANCES_COLLECTION).doc(gameInstanceId)

  const [participantsSnap, configSnap, instanceSnap] = await Promise.all([
    instanceRef.collection(PARTICIPANTS_SUBCOLLECTION).get(),
    instanceRef.collection('config').doc(CONFIG_DOC).get(),
    instanceRef.get(),
  ])

  const config = loadNewsvendorConfig(configSnap.data())
  const scored = instanceSnap.data()?.finalized === true

  const gameRows: NewsvendorGameRow[] = []
  const participants: NewsvendorReportParticipant[] = participantsSnap.docs.map(d => {
    const p = d.data()
    const rounds = parseStoredRounds(p.rounds)
    const row: NewsvendorGameRow = {
      participant_id: d.id,
      orders: rounds.map(r => r.q),
      demands: rounds.map(r => r.d),
      profits: rounds.map(r => r.profit),
      benchmarkProfits: rounds.map(r => r.profit_opt),
      serviceLevels: rounds.map(r => r.service_level),
    }
    gameRows.push(row)

    const freeText = (p.free_text_answers ?? {}) as Record<string, { answer?: unknown }>
    const text = (field: string) =>
      typeof freeText[field]?.answer === 'string' ? (freeText[field].answer as string) : null

    return {
      participant_id: d.id,
      name: (p.name as string | undefined) ?? null,
      launched: p.launched_at != null,
      completed: p.finished_at != null,
      finalized: p.finalized_at != null,
      rounds_played: rounds.length,
      average_order: averageOrder(row),
      average_demand: averageDemand(row),
      average_service_level: averageServiceLevel(row),
      in_stock_rate: inStockRate(row),
      average_profit: averageProfit(row),
      total_profit: totalProfit(row),
      benchmark_profit: totalBenchmarkProfit(row),
      optimality_gap: optimalityGap(row),
      average_benchmark_profit: averageBenchmarkProfit(row),
      average_optimality_gap: averageOptimalityGap(row),
      knowledge_check_score: typeof p.knowledge_check_score === 'number' ? p.knowledge_check_score : null,
      participation_score: typeof p.normalized_score === 'number' ? p.normalized_score : null,
      prep: text(prepQuestion.field),
      debrief: text(debriefQuestion.field),
    }
  })

  /**
   * The charts' x-axis: the LONGEST game anyone actually played.
   *
   * ⚠ NOT the configured period count. Deriving it from the data means the axis grows
   * through the week as the class plays, and a chart opened on Tuesday does not carry
   * twelve empty columns.
   */
  const maxPeriodsPlayed = gameRows.reduce((max, r) => Math.max(max, r.orders.length), 0)

  const charts: { orders: SeriesPoint[]; profits: SeriesPoint[] } = {
    orders: ordersByPeriod(gameRows, maxPeriodsPlayed),
    profits: profitsByPeriod(gameRows, maxPeriodsPlayed),
  }

  // The benchmark this instance implies. Guarded: a degenerate config (net salvage at
  // or above cost) has no finite Q*, and the report must still open — it reports the
  // problem rather than dividing by zero on the way to a chart.
  const configError = economicsError(config)
  const benchmark = configError === null
    ? { Qopt: optimalOrder(config), ...criticalRatio(config) }
    : null

  return {
    ok: true as const,
    scored,
    /** Everything the instance is configured with — the dashboard banner reads it. */
    params: clientParams(config),
    /**
     * The full second-supplier cost, INSTRUCTOR-ONLY and sent regardless of mode.
     *
     * ⚠ WHY IT IS NOT JUST READ OFF `params`: clientParams deliberately zeroes c_l on a
     * regular instance, because a student there has no second source and should not be
     * shown a price for one. The expected-profit chart needs a real c_l either way — it
     * draws the dual curve even for a regular instance so the two can be compared — so
     * it comes from config directly, on this instructor-only payload.
     */
    secondSourceCost: config.cL,
    /**
     * ⚠ INSTRUCTOR-ONLY. The critical ratio and the benchmark order this instance's
     * own parameters imply (spec §4), so the Tier-3 chart can draw the reference line
     * and the summary box can name the number the class was aiming at without
     * re-deriving it in the browser.
     */
    benchmark,
    /** Non-null when the config cannot produce a benchmark at all — shown as a warning
     *  on the reports page rather than silently omitting the reference line. */
    configError,
    /** The longest game played — the charts' x-axis. */
    maxPeriodsPlayed,
    participants,
    charts,
    /** The summary-stat box beside the charts. */
    summary: {
      averageOrder: classAverageOrder(gameRows),
      averageDemand: classAverageDemand(gameRows),
      averageServiceLevel: classAverageServiceLevel(gameRows),
      averageProfit: classAverageProfit(gameRows),
      averageBenchmarkProfit: classAverageBenchmarkProfit(gameRows),
    },
    /** The prompts the paragraphs answered, so each Tier-2 tile is labelled with the
     *  question that was actually asked. */
    prepPrompt: config.prepPrompt,
    debriefPrompt: config.debriefPrompt,
  }
})
