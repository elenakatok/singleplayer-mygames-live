import type { ForecastConfig } from './config'
import type { ForecastModel } from './demand'
import {
  PUBLISHED_BENCHMARKS, LECTURE_MODEL_BENCHMARK_ID, publishedBenchmarksValid,
  realizedBenchmarks, revealProcess,
} from './benchmarks'
import { runningMetrics, yearComparison } from './metrics'
import { toPoints, type StoredRound } from './rounds'
import { debriefQuestion } from './questions'

// ═══════════════════════════════════════════════════════════════════════════════
// Forecasting — THE DEBRIEF REVEAL (spec §9): "On submit, the debrief screen reveals
// the process — the trend, the high-season lift, σ, and the student's own MSE beside
// the benchmarks from §2.3."
//
// ⚠⚠ THIS IS THE ONLY PLACE THE MODEL LEGITIMATELY REACHES A STUDENT, AND IT IS
// GATED. Everything else in this build exists to keep a, b, H and σ away from the
// browser; this module hands them over on purpose, because the exercise is finished and
// the reveal is (spec §9) "the highest-value screen in the game".
//
// That inversion is exactly why the gate lives HERE, in one function, rather than being
// re-checked at each call site. Two callables can return the reveal — forecastSubmit
// Debrief (on the transition) and forecastGetReveal (on a reload) — and if they could
// drift on when it is allowed, one of them would become a way to read the answer key
// early. They call `revealGate` instead.
//
// THE GATE, stated once: the game must be OVER, and the debrief must be BEHIND them —
// either answered, or switched off for this instance so there was never one to answer.
// A student mid-play fails it; a student who has finished but not yet written their
// paragraph fails it, which is what keeps the paragraph a description of what they
// ACTUALLY did rather than of what they now know they should have done.
// ═══════════════════════════════════════════════════════════════════════════════

export type RevealGate =
  | { allowed: true }
  | { allowed: false; reason: string }

/**
 * May this student see the process?
 *
 * ⚠ TAKES THE STORED PARTICIPANT DOC, not a claim from the client. `finished_at` is
 * stamped by forecastSubmitRound when the last month is played, and the debrief answer
 * is written by forecastSubmitDebrief — both server-side facts, neither forgeable.
 */
export function revealGate(
  pData: Record<string, unknown>,
  config: ForecastConfig,
): RevealGate {
  if (pData.finished_at == null) {
    return { allowed: false, reason: 'The process is revealed once you have forecast every month.' }
  }
  if (config.debriefEnabled) {
    const freeText = (pData.free_text_answers ?? {}) as Record<string, unknown>
    if (freeText[debriefQuestion.field] == null) {
      return {
        allowed: false,
        // Worded for a student who somehow reaches it early, not as an internal error.
        reason: 'Please answer the last question first — then we will show you how demand was actually generated.',
      }
    }
  }
  return { allowed: true }
}

/** The reveal payload (spec §9). Built field by field, so what it carries is a list
 *  somebody chose rather than whatever happened to be in scope. */
export interface RevealPayload {
  /** The true process: intercept, trend, lift, high season, σ, and σ² as the floor. */
  process: ReturnType<typeof revealProcess>
  /** This student's own final scorecard, so the comparison is against their number. */
  yours: ReturnType<typeof runningMetrics>
  /** Y6 vs Y7 (spec §5), repeated here because the debrief is where "did you improve?"
   *  is actually discussed. */
  years: ReturnType<typeof yearComparison>
  /**
   * The §2.3 comparison table.
   *
   * ⚠ TWO POSSIBLE SOURCES, and the flag says which. `published` is spec §2.3's
   * simulated expectations, valid only at the shipped model on the published history.
   * On an instance whose model an instructor has edited those numbers describe a game
   * nobody played, so the realized table — what each rule would ACTUALLY have scored
   * against this student's own months — is sent instead.
   */
  benchmarks: { id: string; label: string; mse: number | null; note?: string }[]
  /** True when the rows are this student's realized figures rather than spec §2.3's
   *  published expectations. The client says so on screen; a table of numbers whose
   *  provenance is ambiguous is worse than no table. */
  benchmarksAreRealized: boolean
  /** Which row is "where the lecture's own method would have landed" (spec §9). */
  lectureModelId: string
}

/**
 * Builds the reveal. Pure — the gate is checked by the caller, because a function that
 * both decides and produces would make it possible to get the payload by ignoring a
 * return value.
 */
export function buildReveal(
  model: ForecastModel,
  config: ForecastConfig,
  history: readonly number[],
  rounds: readonly StoredRound[],
): RevealPayload {
  const points = toPoints(rounds)
  const usePublished = publishedBenchmarksValid(model, config.numHistory)

  return {
    process: revealProcess(model),
    yours: runningMetrics(points),
    years: yearComparison(points),
    benchmarks: usePublished
      ? PUBLISHED_BENCHMARKS.map(b => ({ id: b.id, label: b.label, mse: b.mse, note: b.note }))
      : realizedBenchmarks(history, points, model).map(b => ({ id: b.id, label: b.label, mse: b.mse })),
    benchmarksAreRealized: !usePublished,
    lectureModelId: LECTURE_MODEL_BENCHMARK_ID,
  }
}
