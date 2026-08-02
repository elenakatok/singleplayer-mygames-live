import { httpsCallable } from 'firebase/functions'
import { FirebaseError } from 'firebase/app'
import { functions } from '../firebase'

// The Forecasting Game's callable client. `functions` is the shared Firebase instance
// (one project serves every single-player game); only the callable NAMES are
// forecast-specific.
//
// ⚠⚠ THE RESPONSE TYPES BELOW ARE THE WHOLE CLIENT-SIDE CONTRACT, AND WHAT IS ABSENT
// FROM THEM IS THE POINT (spec §4, §12). There is no `a`, no `b`, no `H`, no `sigma`,
// no `highSeasonMonths`, no `seed` and no `systematic` in any STUDENT type, because the
// server never sends them: the model is the answer, and explaining the systematic
// component IS the exercise (spec §7). Do not add such a field here; if one ever
// appears in a student response, that is a server bug, not a typing gap.
//
// ⚠ THERE IS ALSO NO ARRAY OF FUTURE DEMAND, anywhere. `history` is the COMMON five
// years every student is shown; `played` is only the months this student has already
// forecast. A month that has not been played has no representation on the client at
// all — not a null, not a placeholder. That absence is structural (functions
// forecast/rounds.ts), and it is what makes the leak surface small.
//
// ⚠ NOTE WHAT IS *NOT* IMPORTED: `db`. Every read goes through a callable. Firestore
// rules deny the client both truth/ and participants/, so the SDK could not reach this
// data even if something reached for it — but nothing does, and the CP4 harness
// asserts that no forecast module imports the Firestore handle.

async function callFn<T>(name: string, data: object = {}): Promise<T> {
  const fn = httpsCallable<object, T>(functions, name)
  const result = await fn(data)
  return result.data
}

/** The classroom root — the INSTRUCTOR view (behind RequireAuth). */
export const CLASSROOM_URL = import.meta.env.DEV
  ? 'http://localhost:5173'
  : 'https://classroom.mygames.live'

/** Where a STUDENT goes when their session fails — the student portal, never the
 *  instructor courses page (which is behind RequireAuth and would strand them). */
export const STUDENT_CLASSROOM_URL = `${CLASSROOM_URL}/student`

export function isAuthError(err: unknown): boolean {
  if (!(err instanceof FirebaseError)) return false
  return err.code === 'functions/permission-denied' || err.code === 'functions/unauthenticated'
}

// ── Student: launch ─────────────────────────────────────────────────────────────

export type StudentBootstrapArgs =
  | { token: string }
  | { _test: { participant_id: string; game_instance_id: string } }

export type StudentBootstrapResult = {
  ok: boolean
  participant_id: string
  game_instance_id: string
  customToken: string
}

export const forecastBootstrap = (args: StudentBootstrapArgs) =>
  callFn<StudentBootstrapResult>('forecastBootstrap', args)

// ── Student: the month loop ─────────────────────────────────────────────────────

/**
 * The instance's parameters, as the student receives them (spec §4).
 *
 * ⚠ THIS IS THE WHITELIST. Every field is either cosmetic or something the screen
 * prints anyway. The month count is PUBLIC in this game — spec §14 records that
 * showing the horizon was a deliberate departure from PD and pricing.
 */
export type ForecastParams = {
  numHistory: number
  rounds: number
  forecastMin: number
  forecastMax: number
  productName: string
  unitLabel: string
  periodLabel: string
  /** numHistory + 1 — the first month of play, supplied so the client never adds. */
  firstPlayPeriod: number
  /** The notional bonus at 100% accuracy (spec §5a). */
  bonusAtPerfect: number
}

/** One month of the COMMON history — the chart and the grid render from these.
 *  ⚠ No high-season flag: spotting the season is the exercise (spec §4). */
export type ForecastHistoryPoint = {
  period: number
  year: number
  month: number
  /** "Y1 Jan" */
  label: string
  demand: number
}

/** One PLAYED month, as the history table renders it (spec §4). */
export type ForecastPlayedRow = {
  round: number
  period: number
  /** "Y6 Jan" */
  label: string
  forecast: number
  actual: number
  /** SIGNED — positive means demand came in above the forecast. */
  error: number
  absoluteError: number
  squaredError: number
  /** Null on a zero-demand month. */
  absolutePercentageError: number | null
  maeToDate: number
  mseToDate: number
  mapeToDate: number | null
}

/** The running scorecard (spec §4, §5, §5a). */
export type ForecastRunning = {
  n: number
  mae: number
  /** THE OBJECTIVE (spec §5a). */
  mse: number
  /** √MSE, under the lecture's label — never "RMSE" (spec §0, §5). */
  standardError: number
  /** Fraction; null when no month had a defined APE. */
  mape: number | null
  mapeN: number
  /** 1 − MAPE. */
  accuracy: number | null
  /** $10,000 × (1 − MAPE), floored at zero (spec §5a). */
  bonus: number | null
  /** Mean SIGNED error — the bias figure (spec §4, §5). */
  meanError: number
}

/** Y6 vs Y7 (spec §5). `improved` is null until both years have a month. */
export type ForecastYears = {
  first: { year: number; n: number; mse: number } | null
  second: { year: number; n: number; mse: number } | null
  improved: boolean | null
}

/** This month's card (spec §4's round-results screen). */
export type ForecastRoundOutcome = {
  round: number
  period: number
  /** "Year 6, January" */
  label: string
  month: number
  year: number
  forecast: number
  actual: number
  error: number
  absoluteError: number
  squaredError: number
  absolutePercentageError: number | null
  running: ForecastRunning
}

/** 'play' — the loop is open. 'debrief' — every month is played (spec §5, §9). */
export type ForecastPhase = 'play' | 'debrief'

export type ForecastStateResult = {
  ok: boolean
  params: ForecastParams
  /** The COMMON five years — identical for every student (spec §2.2). */
  history: ForecastHistoryPoint[]
  /** Months this student has PLAYED. Never a future month. */
  played: ForecastPlayedRow[]
  running: ForecastRunning
  years: ForecastYears
  roundsPlayed: number
  phase: ForecastPhase
  gameOver: boolean
}

export type ForecastRoundResult = {
  ok: boolean
  round: ForecastRoundOutcome
  history: ForecastPlayedRow[]
  running: ForecastRunning
  years: ForecastYears
  roundsPlayed: number
  phase: ForecastPhase
  gameOver: boolean
}

export const forecastGetState = () => callFn<ForecastStateResult>('forecastGetState')

/** Submit one month's forecast. `forecast` is a whole number inside the instance's
 *  bounds; the server validates it again and rejects anything else, THEN draws demand
 *  and resolves — in that order, in one transaction (spec §2.2). */
export const forecastSubmitRound = (round: number, forecast: number) =>
  callFn<ForecastRoundResult>('forecastSubmitRound', { round, forecast })

// ── Student: the two CSV exports (spec §4, §5) ──────────────────────────────────

/**
 * ⚠ THE FILES ARE BUILT SERVER-SIDE (spec §12). This callable returns finished CSV
 * TEXT; the browser only writes it to a Blob. The client is never handed a series to
 * assemble a file from, because holding one would mean holding data it was not shown.
 *
 * 'history' — the IN-PLAY file, FROZEN at the five-year history (spec §4). Does not
 *             grow as play proceeds.
 * 'full'    — the FINAL-SCREEN file: history plus every month actually played (spec §5).
 */
export type ForecastExportResult = {
  ok: boolean
  kind: 'history' | 'full'
  filename: string
  /** Human label, e.g. "Demand history, Years 1–5" (spec §4 requires it be labelled). */
  title: string
  csv: string
}

export const forecastGetExport = (kind: 'history' | 'full') =>
  callFn<ForecastExportResult>('forecastGetExport', { kind })

// ── Student: the knowledge check and the debrief (spec §8, §9) ──────────────────

/** One KC question as the student receives it — NO answer key, NO explanation. Both
 *  are earned by answering (forecastSubmitKcAnswer returns the explanation).
 *  `options` arrive already shuffled for THIS student (spec §8). */
export type ForecastKcQuestionClient = {
  field: string
  prompt: string
  options: { value: string; label: string }[]
  /** Added questions may be free text; the authored nine are always 'mc'. */
  type?: 'mc' | 'text'
}

export type ForecastDebriefQuestionClient = {
  field: string
  prompt: string
  placeholder: string
}

export type ForecastQuestionsResult = {
  ok: boolean
  kcEnabled: boolean
  /** ⚠ TWO SOURCES, KEPT APART: `authored` is this game's fixed nine (which carry their
   *  own teaching numbers, deliberately NOT the instance's model — the KC runs before
   *  play); `added` is the instructor's own list with its own keys. */
  kc: { authored: ForecastKcQuestionClient[]; added: ForecastKcQuestionClient[] }
  kcAnswered: string[]
  debriefEnabled: boolean
  debrief: ForecastDebriefQuestionClient | null
  debriefSubmitted: boolean
}

export const forecastGetQuestions = () => callFn<ForecastQuestionsResult>('forecastGetQuestions')

export type ForecastKcAnswerResult = {
  ok: boolean
  correct: boolean
  graded: boolean
  /** Earned by answering — this is the ONLY path that returns it. */
  explanation: string
}

export const forecastSubmitKcAnswer = (field: string, answer: string) =>
  callFn<ForecastKcAnswerResult>('forecastSubmitKcAnswer', { field, answer })

// ── Student: THE REVEAL (spec §9) ───────────────────────────────────────────────
//
// ⚠⚠ THIS IS THE ONE STUDENT PAYLOAD IN THE WHOLE GAME THAT CARRIES THE MODEL, and it
// is GATED server-side: the game must be over AND the debrief behind them (functions
// forecast/reveal.ts). Everything else in this client is built to keep a, b, H and σ
// out of the browser; here they arrive on purpose, because the exercise is finished and
// the reveal is the highest-value screen in the game.
//
// Note the consequence for review: a `RevealPayload` appearing in any type OTHER than
// these two results would be a leak. It appears in exactly two.

/** The true process, revealed (spec §9). */
export type ForecastProcess = {
  intercept: number
  trend: number
  highSeasonLift: number
  highSeasonMonths: number[]
  sigma: number
  /** σ² — the floor no forecast can beat (spec §2.3). */
  floorMse: number
  seasonality: 'additive' | 'multiplicative'
}

export type ForecastBenchmarkRow = {
  id: string
  label: string
  /** Null when the rule could not be formed for this student's months. */
  mse: number | null
  /** Present on the published table; absent on realized rows. */
  note?: string
}

export type ForecastReveal = {
  process: ForecastProcess
  /** This student's own final scorecard, so the comparison is against their number. */
  yours: ForecastRunning
  years: ForecastYears
  benchmarks: ForecastBenchmarkRow[]
  /** True when the rows are this student's REALIZED figures rather than spec §2.3's
   *  published expectations (an instance whose model was edited). The screen says so. */
  benchmarksAreRealized: boolean
  /** Which row is "where the lecture's own method would have landed" (spec §9). */
  lectureModelId: string
}

export type ForecastDebriefResult = {
  ok: boolean
  field: string
  stored: boolean
  answer: string
  reveal: ForecastReveal
}

/** Submit the debrief paragraph. The paragraph is stored BEFORE the reveal is built,
 *  server-side, so a student cannot read the process and then describe a method they
 *  did not use (spec §9). */
export const forecastSubmitDebrief = (answer: string) =>
  callFn<ForecastDebriefResult>('forecastSubmitDebrief', { answer })

/** Re-read the reveal for a student who has already earned it — the resume path
 *  (spec §4: closeable and resumable; §9: the highest-value screen). Same gate. */
export const forecastGetReveal = () =>
  callFn<{ ok: boolean; reveal: ForecastReveal }>('forecastGetReveal')

// ── Instructor: session, roster, scoring, reports, settings ─────────────────────
//
// ⚠ EVERYTHING BELOW IS INSTRUCTOR-ONLY, and it DOES carry the demand model. That is
// correct and required (spec §10): the Tier-3 dashed reference IS the true systematic
// component, "auto-derived from config, never hand-entered". These callables are behind
// an instructor session, and no student screen imports from this section.

export type InstructorSessionArgs =
  | { token: string }
  | { _dev: { game_instance_id: string } }

export const forecastInstructorSession = (args: InstructorSessionArgs) =>
  callFn<{ ok: boolean; customToken: string }>('forecastInstructorSession', args)

export const forecastSyncRoster = () => callFn<{ ok: boolean; synced: number }>('forecastSyncRoster')

export type ForecastPushSummary = { total: number; succeeded: number; failed: unknown[] }

export const forecastScoreAndRecord = () =>
  callFn<{ ok: boolean; scored: number; finishers: number; push: ForecastPushSummary | null }>(
    'forecastScoreAndRecord')

/** One month of a student's drill-down table (spec §10, Tier 1). */
export type ForecastStudentMonth = {
  period: number
  forecast: number
  actual: number
  error: number
  absoluteError: number
  squaredError: number
  absolutePercentageError: number | null
}

/** One student, as the dashboard and the Tier-1 roster render them (spec §10). */
export type ForecastReportParticipant = {
  participant_id: string
  name: string | null
  launched: boolean
  completed: boolean
  finalized: boolean
  months_played: number
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
  participation_score: number | null
  debrief: string | null
  months: ForecastStudentMonth[]
}

/** One month of the Tier-3 class chart. `n` thins as the class spreads out, and the
 *  chart says so — composition, not behaviour (spec §10). */
export type ForecastClassPoint = {
  period: number
  label: string
  actual: number
  forecast: number
  /** The TRUE systematic component — spec §10's dashed reference. */
  systematic: number
  n: number
}

export type ForecastReportData = {
  ok: boolean
  scored: boolean
  params: ForecastParams
  /** ⚠ Instructor-only: the true process, for the Tier-3 reference and the summary. */
  process: ForecastProcess
  participants: ForecastReportParticipant[]
  classChart: ForecastClassPoint[]
  summary: {
    students: number
    meanMae: number | null
    meanMse: number | null
    /** √(mean MSE) — comparable with the §2.3 benchmark column (see reportStats.ts). */
    standardError: number | null
    meanBias: number | null
    meanMape: number | null
  }
  /** Null when this instance's model was edited away from the published one — the
   *  §2.3 table would then describe a game nobody played. */
  benchmarks: (ForecastBenchmarkRow & { standardError: number })[] | null
  histogram: { bins: { lo: number; hi: number; count: number }[]; min: number; max: number } | null
  debriefPrompt: string
  numHistory: number
  historyLength: number
}

export const forecastGetReport = () => callFn<ForecastReportData>('forecastGetReport')

/** The editable instance settings (spec §3). Split by destination on the server:
 *  student-safe fields to config/main, the model and seed to the rules-denied
 *  truth/main. */
export type ForecastEditableConfig = {
  numHistory: number
  rounds: number
  forecastMin: number
  forecastMax: number
  productName: string
  unitLabel: string
  periodLabel: string
  kcEnabled: boolean
  addedKcQuestions: unknown[]
  debriefEnabled: boolean
  debriefPrompt: string
}

export type ForecastEditableModel = {
  a: number
  b: number
  H: number
  highSeasonMonths: number[]
  sigma: number
  seasonality: 'additive' | 'multiplicative'
  seasonStructure: 'twoSeason' | 'perMonth'
  monthOffsets: number[]
  demandDraw: 'perStudent' | 'common'
}

export type ForecastConfigResult = {
  ok: boolean
  config: ForecastEditableConfig
  /** ⚠ Instructor-only — the answer key. */
  model: ForecastEditableModel
  seed: string | null
  usesPublishedHistory: boolean
  /** Advisory only (spec §3, §3a, §5a): warn, never block. */
  warnings: string[]
  authoredKcPreview: { field: string; prompt: string; options: { value: string; label: string }[]; correct_value: string }[]
  authoredKcCount: number
  anyRoundsPlayed: boolean
}

export const forecastGetConfig = () => callFn<ForecastConfigResult>('forecastGetConfig')

export const forecastUpdateConfig = (
  patch: Partial<ForecastEditableConfig & ForecastEditableModel & { seed: string | null }>,
) => callFn<ForecastConfigResult>('forecastUpdateConfig', patch)
