import { onCall } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import { extractInstructorGameId } from '@mygames/game-server'
import {
  PRICING_CORS_ORIGINS, INSTANCES_COLLECTION, PARTICIPANTS_SUBCOLLECTION, CONFIG_DOC, TRUTH_DOC,
  loadPricingConfig, loadPricingStrategies, activeStrategy,
} from './config'
import { STRATEGY_DESCRIPTIONS } from './strategy'
import { parseStoredRounds } from './rounds'
import { clientMarket } from './clientState'
import { debriefQuestion } from './questions'
import {
  pricesByRound, profitsByRound, averagePrice, averageProfitPerRound, totalProfit,
  classAveragePrice, classAverageEffectivePrice, classAverageProfit,
  equilibriumReference, equilibriumProfitReference,
  type PricingGameRow, type PricePoint, type ProfitPoint,
  type EquilibriumReference, type ProfitEquilibriumReference,
} from './reportStats'

// ═══════════════════════════════════════════════════════════════════════════════
// pricingGetReport (instructor) — the single instructor-facing data source, feeding
// BOTH the dashboard roster (Tier 1) and every report tile (Tiers 2 and 3). One
// callable, one read of the instance, exactly as pennies' and PD's do.
//
// ⚠ THIS RESPONSE CARRIES THE COMPETITOR'S RULE, and that is correct. It is
// instructor-only, behind an instructor session, and spec §10 requires the header to
// state which rule was in force — a class chart is unreadable without knowing what
// the class was playing against. The no-leak rule governs STUDENT play (spec §5); no
// student screen imports anything from here, and the student callables still return
// the reveal only after a student's own game is over.
//
// ⚠ CORRECT ON PARTIAL DATA. Elena opens this mid-week, with the class spread across
// the whole assignment: some finished, some three rounds in, some not started. Every
// aggregate is over who actually played (reportStats.ts), the chart's x-axis is the
// longest game ANYONE played rather than any horizon, and nothing divides by a
// denominator it has not checked.
// ═══════════════════════════════════════════════════════════════════════════════

/** One student, as the dashboard and Tier 1 render them (spec §10). */
export interface PricingReportParticipant {
  participant_id: string
  name: string | null
  launched: boolean
  completed: boolean
  finalized: boolean
  rounds_played: number
  /** Mean POSTED price. Null for a student who has posted none. */
  average_price: number | null
  /** Mean profit per round PLAYED. Null likewise. */
  average_profit: number | null
  total_profit: number
  knowledge_check_score: number | null
  /** The participation score, once Score & Record has run. Null before that. */
  participation_score: number | null
  /** The Tier-2 paragraph, or null if not written. */
  debrief: string | null
}

export const pricingGetReport = onCall({ cors: PRICING_CORS_ORIGINS }, async (request) => {
  const data = request.data as Record<string, unknown>
  const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true'
  const authHeader = request.rawRequest.headers.authorization as string | undefined

  const gameInstanceId = await extractInstructorGameId(data, isEmulator, authHeader)

  const db = admin.firestore()
  const instanceRef = db.collection(INSTANCES_COLLECTION).doc(gameInstanceId)

  const [participantsSnap, configSnap, truthSnap, instanceSnap] = await Promise.all([
    instanceRef.collection(PARTICIPANTS_SUBCOLLECTION).get(),
    instanceRef.collection('config').doc(CONFIG_DOC).get(),
    instanceRef.collection('truth').doc(TRUTH_DOC).get(),
    instanceRef.get(),
  ])

  const config = loadPricingConfig(configSnap.data())
  const strategy = activeStrategy(config, loadPricingStrategies(truthSnap.data()))
  const scored = instanceSnap.data()?.finalized === true

  const gameRows: PricingGameRow[] = []
  const participants: PricingReportParticipant[] = participantsSnap.docs.map(d => {
    const p = d.data()
    const rounds = parseStoredRounds(p.rounds)
    const row: PricingGameRow = {
      participant_id: d.id,
      prices: rounds.map(r => r.student_price),
      competitorPrices: rounds.map(r => r.competitor_price),
      effectivePrices: rounds.map(r => r.effective_price),
      profits: rounds.map(r => r.student_profit),
      competitorProfits: rounds.map(r => r.competitor_profit),
    }
    gameRows.push(row)

    const debriefRaw = (p.debrief_answers ?? {})[debriefQuestion.field]
    return {
      participant_id: d.id,
      name: (p.name as string | undefined) ?? null,
      launched: p.launched_at != null,
      completed: p.finished_at != null,
      finalized: p.finalized_at != null,
      rounds_played: rounds.length,
      average_price: averagePrice(row),
      average_profit: averageProfitPerRound(row),
      total_profit: totalProfit(row),
      knowledge_check_score: typeof p.knowledge_check_score === 'number' ? p.knowledge_check_score : null,
      participation_score: typeof p.normalized_score === 'number' ? p.normalized_score : null,
      debrief: typeof debriefRaw?.answer === 'string' ? debriefRaw.answer : null,
    }
  })

  /**
   * The chart's x-axis: the LONGEST game anyone actually played.
   *
   * ⚠ NOT a horizon. Horizons are per student (init.ts) and none of them is reported;
   * deriving the axis from the data is both the honest answer and the one that cannot
   * go stale, and it means the axis grows through the week as the class plays.
   */
  const maxRoundsPlayed = gameRows.reduce((max, r) => Math.max(max, r.prices.length), 0)

  const charts: { prices: PricePoint[]; profits: ProfitPoint[] } = {
    prices: pricesByRound(gameRows, maxRoundsPlayed),
    // The price chart's sibling: what those prices EARNED, round by round, with the
    // same denominators.
    profits: profitsByRound(gameRows, maxRoundsPlayed),
  }

  const equilibrium: EquilibriumReference = equilibriumReference(config.market, config.pmg)
  const profitEquilibrium: ProfitEquilibriumReference =
    equilibriumProfitReference(config.market, config.pmg)
  const avgProfit = classAverageProfit(gameRows)

  return {
    ok: true as const,
    scored,
    /** Which rules this instance ran (spec §10 header). */
    pmg: config.pmg,
    labels: config.labels,
    /** The market, so the chart can scale its axis to the instance's own price band. */
    market: clientMarket(config.market),
    /**
     * The competitor rule, in plain language — INSTRUCTOR ONLY (see the header).
     * The id rides along so a future cross-instance comparison can group by it
     * without re-deriving the sentence.
     */
    competitorRule: { id: strategy, description: STRATEGY_DESCRIPTIONS[strategy] },
    /** The longest game played — the chart's x-axis, NOT anyone's horizon. */
    maxRoundsPlayed,
    participants,
    charts,
    /** The summary-stat box beside the chart (spec §10). */
    summary: {
      averagePostedPrice: classAveragePrice(gameRows),
      /** PMG only — null under Standard, where there is no single price paid. */
      averageEffectivePrice: config.pmg ? classAverageEffectivePrice(gameRows) : null,
      equilibrium,
      /** The profit chart's summary: both firms' mean profit per round, and the
       *  profit each earns at the reference prices. */
      averageProfit: avgProfit.student,
      averageCompetitorProfit: avgProfit.competitor,
      profitEquilibrium,
    },
    /** The prompt the paragraphs answered — mode-dependent, so Tier 2 is labelled
     *  with the question that was actually asked. */
    debriefPrompt: config.debriefPrompt,
  }
})
