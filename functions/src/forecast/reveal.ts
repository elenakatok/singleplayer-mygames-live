import type { ForecastConfig } from './config'
import type { ForecastModel } from './demand'
import {
  PUBLISHED_BENCHMARKS, LECTURE_MODEL_BENCHMARK_ID, publishedBenchmarksValid,
  realizedBenchmarks, revealProcess,
} from './benchmarks'
import { runningMetrics, yearComparison } from './metrics'
import { toPoints, type StoredRound } from './rounds'
import { forecastPostStage, type ForecastStageRow } from './questions'

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
// THE GATE, stated once: the game must be OVER, and THE WHOLE AFTER-PLAY STAGE must be
// BEHIND them — every VISIBLE row answered, or switched off for this instance so there was
// never one to answer. A student mid-play fails it; a student who has finished but not yet
// written their paragraph fails it, which is what keeps the paragraph a description of what
// they ACTUALLY did rather than of what they now know they should have done.
//
// ⚠⚠ THE RULE IS "EVERY VISIBLE POST-STAGE ROW", NOT "THE DEBRIEF ROW" — a decision, and
// the reasoning is the paragraph above rather than a preference. The gate exists because an
// answer written after the reveal describes the right answer instead of the student's own
// method. That argument is about WHERE THE QUESTION SITS, not about which question it is: an
// instructor who adds "what do you think drove the variation you saw?" to the after-play
// stage has put it there for exactly the reason the debrief is there, and gating only the
// debrief would let it be answered off the reveal screen. Gating the debrief alone would
// also make the stage's whole placement decorative — everything in it would be answerable
// after the answer key. So: the reveal is refused until every visible after-play row is
// answered.
//
// ⚠⚠ AND THEREFORE: A HIDDEN ROW CANNOT BLOCK THE REVEAL, BY CONSTRUCTION. The gate reads
// `forecastPostStage(config)`, the SAME list the student is served, which has already
// dropped hidden rows, graded additions switched off by `kcEnabled`, and the debrief
// paragraph when `debrief_enabled` is false. There is no second list that could contain a
// row the student is never shown, which is the only way "answer a question you cannot see"
// could arise. An empty stage passes the gate outright.
//
// ⚠ TWO ANSWER MAPS, deliberately not unified (spec §6): the debrief row is stored in
// `free_text_answers` by forecastSubmitDebrief, and added rows in `kc_static_answers` by
// forecastSubmitKcAnswer. The gate asks the map the row's OWN kind names, so a row cannot
// be satisfied by an answer filed under the other one.
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
  for (const row of forecastPostStage(config)) {
    if (!isPostRowAnswered(row, pData)) {
      return {
        allowed: false,
        // Worded for a student who somehow reaches it early, not as an internal error.
        // Singular/plural is not attempted: the client shows the unanswered rows themselves.
        reason: 'Please answer the last question first — then we will show you how demand was actually generated.',
      }
    }
  }
  return { allowed: true }
}

/**
 * Is ONE after-play row answered, according to the stored doc?
 *
 * ⚠ The map is chosen by the row's `kind`, never by its `type`: an ADDED free-text question
 * is also `type: 'text'` but is submitted through forecastSubmitKcAnswer and stored in
 * `kc_static_answers`. Reading `type` here would let an added paragraph be permanently
 * unsatisfiable, because nothing ever writes it to `free_text_answers`.
 */
export function isPostRowAnswered(
  row: ForecastStageRow,
  pData: Record<string, unknown>,
): boolean {
  const map = (row.kind === 'free-text' ? pData.free_text_answers : pData.kc_static_answers) ?? {}
  return (map as Record<string, unknown>)[row.field] != null
}

/**
 * The after-play rows this student has NOT answered — what the client renders, and what
 * `revealGate` is refusing on. Derived from the same list, so the screen and the gate
 * cannot disagree about which questions are outstanding.
 */
export function unansweredPostRows(
  config: ForecastConfig,
  pData: Record<string, unknown>,
): ForecastStageRow[] {
  return forecastPostStage(config).filter(row => !isPostRowAnswered(row, pData))
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
