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
