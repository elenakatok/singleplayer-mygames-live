import { onCall } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import { extractInstructorGameId } from '@mygames/game-server'
import {
  FORECAST_CORS_ORIGINS, INSTANCES_COLLECTION, PARTICIPANTS_SUBCOLLECTION, BONUS_AT_PERFECT,
} from './config'
import { loadInstance } from './instance'
import { parseStoredRounds, toPoints } from './rounds'
import { runningMetrics, yearComparison } from './metrics'
import { clientParams, clientHistory } from './clientState'
import { periodLabelShort } from './history'
import { debriefQuestion } from './questions'
import {
  PUBLISHED_BENCHMARKS, publishedBenchmarksValid, revealProcess,
} from './benchmarks'
import {
  classSeries, classSummary, studentOutcome, mseHistogram, studentMonthRows,
  type ForecastGameRow,
} from './reportStats'
import { belowFloorFlag, type BelowFloorResult } from './belowFloor'

// ═══════════════════════════════════════════════════════════════════════════════
// forecastGetReport (instructor) — the single instructor-facing data source, feeding
// the dashboard roster (Tier 1), the debrief export (Tier 2) and both Tier-3 charts.
// One callable, one read of the instance, exactly as pennies', PD's, pricing's and
// newsvendor's do.
//
// ⚠ THIS RESPONSE CARRIES THE MODEL, and that is correct. The Tier-3 dashed reference
// IS the true systematic component, "auto-derived from config, never hand-entered"
// (spec §10), and the summary box exists to sit beside the §2.3 benchmarks. Spec §4
// withholds the model from the STUDENT, not from the instructor. This callable is
// behind an instructor session (extractInstructorGameId), and no student screen imports
// from here — the student-side whitelists are in clientState.ts and rounds.ts, and the
// one student path that legitimately carries the model is gated in reveal.ts.
//
// ⚠ CORRECT ON PARTIAL DATA. Elena opens this mid-week with the class spread across the
// assignment. Every aggregate is over who actually played (reportStats.ts), the chart's
// x-axis is what anyone has reached rather than the configured month count, and each
// point carries its own denominator.
// ═══════════════════════════════════════════════════════════════════════════════

/** One student, as the dashboard and Tier 1 render them (spec §10). */
export interface ForecastReportParticipant {
  participant_id: string
  name: string | null
  launched: boolean
  completed: boolean
  finalized: boolean
  months_played: number
  /** The outcome columns spec §10 lists. Null where they have played nothing. */
  mae: number | null
  mse: number | null
  standard_error: number | null
  mape: number | null
  accuracy: number | null
  bonus: number | null
  mean_error: number | null
  first_year_mse: number | null
  second_year_mse: number | null
  improved: boolean | null
  knowledge_check_score: number | null
  /** The participation score, once Score & Record has run. Null before that. */
  participation_score: number | null
  /** The Tier-2 paragraph, or null if not written. */
  debrief: string | null
  /** The per-student drill-down (spec §10): their full month-by-month table. */
  months: ReturnType<typeof studentMonthRows>
  /**
   * ⚠ THE BELOW-FLOOR FLAG (spec §5b) — INSTRUCTOR-ONLY, and informational only.
   *
   * Null when the test cannot be run (nothing played, or a degenerate σ). Non-null
   * otherwise, with `flagged` true only past the display minimum. It affects NO score
   * and gates nothing; it exists so Elena can see on the roster that a student's MSE is
   * below what the noise alone permits, which `demandDraw: 'common'` makes possible.
   *
   * It must never reach a student — not on the results screen, not on the final screen,
   * not in the reveal, not in either CSV. This field exists on the INSTRUCTOR payload
   * only, and the harness carries a negative control asserting its absence everywhere
   * else.
   */
  below_floor: BelowFloorResult | null
}

export const forecastGetReport = onCall({ cors: FORECAST_CORS_ORIGINS }, async (request) => {
  const data = request.data as Record<string, unknown>
  const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true'
  const authHeader = request.rawRequest.headers.authorization as string | undefined

  const gameInstanceId = await extractInstructorGameId(data, isEmulator, authHeader)

  const db = admin.firestore()
  const instanceRef = db.collection(INSTANCES_COLLECTION).doc(gameInstanceId)

  const [participantsSnap, instanceSnap, instance] = await Promise.all([
    instanceRef.collection(PARTICIPANTS_SUBCOLLECTION).get(),
    instanceRef.get(),
    loadInstance(db, gameInstanceId),
  ])

  const { config, model, history } = instance
  const scored = instanceSnap.data()?.finalized === true

  const gameRows: ForecastGameRow[] = []
  const participants: ForecastReportParticipant[] = participantsSnap.docs.map(d => {
    const p = d.data()
    const rounds = parseStoredRounds(p.rounds)
    const points = toPoints(rounds)
    gameRows.push({ participant_id: d.id, points })

    const out = studentOutcome(points, runningMetrics, yearComparison)
    // ⚠ σ FROM THE INSTANCE, never a constant — an instructor can edit it in Settings
    // and every threshold moves with it (belowFloor.ts).
    const belowFloor = belowFloorFlag(out.mse, out.monthsPlayed, model.sigma)
    const freeText = (p.free_text_answers ?? {}) as Record<string, { answer?: unknown }>
    const debriefRaw = freeText[debriefQuestion.field]?.answer

    return {
      participant_id: d.id,
      name: (p.name as string | undefined) ?? null,
      launched: p.launched_at != null,
      completed: p.finished_at != null,
      finalized: p.finalized_at != null,
      months_played: out.monthsPlayed,
      mae: out.mae,
      mse: out.mse,
      standard_error: out.standardError,
      mape: out.mape,
      accuracy: out.accuracy,
      bonus: out.bonus,
      mean_error: out.meanError,
      first_year_mse: out.firstYearMse,
      second_year_mse: out.secondYearMse,
      improved: out.improved,
      knowledge_check_score: typeof p.knowledge_check_score === 'number' ? p.knowledge_check_score : null,
      participation_score: typeof p.normalized_score === 'number' ? p.normalized_score : null,
      debrief: typeof debriefRaw === 'string' ? debriefRaw : null,
      months: studentMonthRows(points),
      below_floor: belowFloor,
    }
  })

  /**
   * ⚠ FLAGGED STUDENTS ARE EXCLUDED FROM TIER 3 (spec §5b), and the charts SAY SO.
   *
   * One student who had the answers can drag the class-average forecast line onto the
   * true process and put a spike at the bottom of the histogram — turning the lecture
   * asset into a picture of the leak rather than of the class. So they come out.
   *
   * The count travels with the payload precisely so the caption can state it: Elena
   * must never be looking at a filtered chart without knowing it is filtered. Tier 1
   * still lists them — the roster is the report where they should be visible.
   */
  const flaggedIds = new Set(
    participants.filter(p => p.below_floor?.flagged).map(p => p.participant_id),
  )
  const chartRows = gameRows.filter(row => !flaggedIds.has(row.participant_id))

  const usePublished = publishedBenchmarksValid(model, config.numHistory)

  return {
    ok: true as const,
    scored,
    /** The student-safe params, so the dashboard banner reads the same numbers the
     *  students saw. */
    params: clientParams(config, BONUS_AT_PERFECT),
    /**
     * ⚠ INSTRUCTOR-ONLY: the true process. The Tier-3 reference line and the debrief
     * slide are both built from it (spec §10), and it is what makes the reference
     * "auto-derived, never hand-entered".
     */
    process: revealProcess(model),
    participants,
    /** Tier 3, chart 1: class average actual vs class average forecast vs the true
     *  systematic component, with per-month denominators (spec §10). */
    classChart: classSeries(chartRows, model, periodLabelShort),
    /** Tier 3, the summary box — "this box IS the debrief slide" (spec §10). */
    summary: classSummary(chartRows, runningMetrics),
    /**
     * The §2.3 benchmark table for the summary box.
     *
     * ⚠ NULL when this instance's model has been edited away from the published one —
     * the table would then describe a game nobody played. The reports page says so
     * rather than printing confident wrong numbers beside the class's real ones.
     */
    benchmarks: usePublished
      ? PUBLISHED_BENCHMARKS.map(b => ({ id: b.id, label: b.label, mse: b.mse, standardError: b.standardError, note: b.note }))
      : null,
    /** Tier 3, chart 2: the MSE histogram (spec §10, "BUILD IN v1"). Log-binned — see
     *  reportStats.ts for why linear bins would hide the whole lesson. */
    histogram: mseHistogram(
      participants
        .filter(p => !flaggedIds.has(p.participant_id))
        .map(p => p.mse).filter((m): m is number => m !== null),
    ),
    /**
     * How many students Tier 3 dropped, and why — so the caption can say it out loud
     * (spec §5b). Zero on a healthy instance, which is the common case.
     */
    excludedFromCharts: flaggedIds.size,
    /** The prompt the paragraphs answered, so the Tier-2 tile is labelled with the
     *  question that was actually asked. */
    debriefPrompt: config.debriefPrompt,
    /** How many months of history the class was shown — the chart's left edge. */
    numHistory: config.numHistory,
    historyLength: history.length,
    /**
     * The five-year history itself, so the reports page can chart it (Elena, 08-02).
     *
     * ⚠ NOT SECRET, and worth saying why it is safe to add here: this is the same
     * array every student is shown on their opening screen, identical for all of them.
     * The instructor had no view of it at all before — the class chart starts at the
     * first PLAYED month — so the data students were given was the one thing the
     * reports could not show.
     */
    history: clientHistory(history),
  }
})
