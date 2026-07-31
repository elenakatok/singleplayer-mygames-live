import { httpsCallable } from 'firebase/functions'
import { FirebaseError } from 'firebase/app'
import { functions } from '../firebase'

// The Newsvendor game's callable client. `functions` is the shared Firebase instance
// (one project serves every single-player game); only the callable NAMES are
// newsvendor-specific.
//
// PART 1 — the REGULAR (single-source) game. Dual sourcing is Part 2: it is a config
// flag on this same game, so nothing here will need a second set of names.
//
// ⚠⚠ THE RESPONSE TYPES BELOW ARE THE WHOLE CLIENT-SIDE CONTRACT, AND WHAT IS ABSENT
// FROM THEM IS THE POINT. There is no `qOpt`, no `criticalRatio`, no `profitOpt` and
// no `gap` in any STUDENT type, because the server never sends them (spec §9.2: the
// benchmark is computed and stored for reports only, and the student never sees it —
// not during play, not on the final screen). Do not add such a field here; if one ever
// appears in a student response, that is a server bug, not a typing gap.
//
// The INSTRUCTOR types further down DO carry the benchmark, and that is correct: the
// reports exist to show the optimality gap, and they are behind an instructor session.
// No student screen imports from that section.

async function callFn<T>(name: string, data: object = {}): Promise<T> {
  const fn = httpsCallable<object, T>(functions, name)
  const result = await fn(data)
  return result.data
}

/** The classroom root — the INSTRUCTOR view (behind RequireAuth). Use this only on
 *  instructor screens. */
export const CLASSROOM_URL = import.meta.env.DEV
  ? 'http://localhost:5173'
  : 'https://classroom.mygames.live'

/** Where a STUDENT goes when their session fails — the student login/portal, never
 *  the instructor courses page (which is behind RequireAuth and would strand them). */
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

export const newsvendorBootstrap = (args: StudentBootstrapArgs) =>
  callFn<StudentBootstrapResult>('newsvendorBootstrap', args)

// ── Student: the period loop ────────────────────────────────────────────────────

/** The instance's parameters, as the student receives them (spec §7a). Every field
 *  is printed on the place-order screen. */
export type NewsvendorParams = {
  P: number
  c: number
  v: number
  g: number
  h: number
  /** Dual-sourcing mode — the screens branch their labels on it (spec §7a, §7b). */
  dual: boolean
  /** DUAL only: the full per-unit cost of the expensive second source. 0 in regular. */
  cL: number
  /** true = Normal demand, false = Uniform. */
  isNormal: boolean
  mean: number
  sd: number
  minD: number
  maxD: number
  /** The total number of periods. Public in this game — the screen says "Period k of
   *  N" (spec §7a). */
  periods: number
  /** The order box's bounds (spec §3), the same ones the server enforces. */
  orderMin: number
  orderMax: number
  showCalculator: boolean
  showServiceLevel: boolean
}

/** One PLAYED period, as the history table renders it (spec §7c). */
export type NewsvendorHistoryRow = {
  round: number
  yourOrder: number
  demand: number
  sales: number
  unitsOver: number
  /** REGULAR: demand you could not meet. 0 in dual — nothing is ever short. */
  unitsShort: number
  /** DUAL: units bought in from the expensive source. 0 in regular. */
  unitsFromSecondSource: number
  profit: number
  /** Demand proportion met, 0–1. Rendered only when showServiceLevel. */
  serviceLevel: number
  yourTotal: number
  yourAverage: number
}

/** This period's outcome — what the round-results screen shows (spec §7b). */
export type NewsvendorRoundOutcome = {
  round: number
  yourOrder: number
  demand: number
  sales: number
  unitsOver: number
  unitsShort: number
  unitsFromSecondSource: number
  profit: number
  serviceLevel: number
}

/** 'play' — the loop is open. 'debrief' — every period is played (spec §7d). */
export type NewsvendorPhase = 'play' | 'debrief'

export type NewsvendorStateResult = {
  ok: boolean
  params: NewsvendorParams
  history: NewsvendorHistoryRow[]
  totalProfit: number
  averageProfit: number
  averageOrder: number
  averageServiceLevel: number
  periodsPlayed: number
  phase: NewsvendorPhase
  gameOver: boolean
}

export type NewsvendorRoundResult = {
  ok: boolean
  round: NewsvendorRoundOutcome
  history: NewsvendorHistoryRow[]
  totalProfit: number
  averageProfit: number
  averageOrder: number
  averageServiceLevel: number
  periodsPlayed: number
  phase: NewsvendorPhase
  gameOver: boolean
}

export const newsvendorGetState = () => callFn<NewsvendorStateResult>('newsvendorGetState')

/** Submit one period's order quantity. `order` is a whole number inside the
 *  instance's bounds; the server validates it again and rejects anything else, then
 *  draws demand and resolves — in that order, in one transaction. */
export const newsvendorSubmitRound = (round: number, order: number) =>
  callFn<NewsvendorRoundResult>('newsvendorSubmitRound', { round, order })

// ── Student: the knowledge check and the two free-text questions ────────────────

/** One KC question as the student receives it — NO answer key, NO explanation. Both
 *  are earned by answering (newsvendorSubmitKcAnswer returns the explanation).
 *  `options` arrive already shuffled for THIS student (spec/KC doc). */
export type NewsvendorKcQuestionClient = {
  field: string
  prompt: string
  options: { value: string; label: string }[]
  /** Added questions may be free text; the authored ten are always 'mc'. */
  type?: 'mc' | 'text'
}

export type NewsvendorFreeTextQuestionClient = {
  field: string
  prompt: string
  placeholder: string
}

export type NewsvendorQuestionsResult = {
  ok: boolean
  kcEnabled: boolean
  /** Which mode this instance runs. The dual set REPLACES the regular one entirely. */
  dual: boolean
  /** ⚠ TWO SOURCES, KEPT APART: `authored` is this game's fixed ten (fixed teaching
   *  numbers, deliberately NOT the instance's own); `added` is the instructor's own
   *  list with its own keys. The client renders authored-then-added and the server
   *  grades each on its own path. */
  kc: { authored: NewsvendorKcQuestionClient[]; added: NewsvendorKcQuestionClient[] }
  kcAnswered: string[]
  prepEnabled: boolean
  prep: NewsvendorFreeTextQuestionClient | null
  prepSubmitted: boolean
  debriefEnabled: boolean
  debrief: NewsvendorFreeTextQuestionClient | null
  debriefSubmitted: boolean
}

export const newsvendorGetQuestions = () => callFn<NewsvendorQuestionsResult>('newsvendorGetQuestions')

export type NewsvendorKcAnswerResult = {
  ok: boolean
  correct: boolean
  graded: boolean
  /** Earned by answering — this is the ONLY path that returns it. */
  explanation: string
}

export const newsvendorSubmitKcAnswer = (field: string, answer: string) =>
  callFn<NewsvendorKcAnswerResult>('newsvendorSubmitKcAnswer', { field, answer })

/** The prep and the debrief share one callable; the field says which (see
 *  submitFreeText.ts for why one rather than two). */
export const newsvendorSubmitFreeText = (field: string, answer: string) =>
  callFn<{ ok: boolean; field: string; stored: boolean; answer: string }>(
    'newsvendorSubmitFreeText', { field, answer })

// ── Instructor: session ─────────────────────────────────────────────────────────

export type InstructorSessionArgs =
  | { token: string }
  | { _dev: { game_instance_id: string } }

export const newsvendorInstructorSession = (args: InstructorSessionArgs) =>
  callFn<{ ok: boolean; customToken: string }>('newsvendorInstructorSession', args)

// ── Instructor: roster, scoring, reports ────────────────────────────────────────
//
// ⚠ EVERYTHING BELOW IS INSTRUCTOR-ONLY, and it DOES carry the benchmark (Q*, the
// critical ratio, profitOpt, the optimality gap). That is correct and required
// (spec §9.2): the reports exist to show the gap. These callables are behind an
// instructor session, and no student screen imports from this section.

export const newsvendorSyncRoster = () => callFn<{ ok: boolean; synced: number }>('newsvendorSyncRoster')

export type NewsvendorPushSummary = { total: number; succeeded: number; failed: unknown[] }

export const newsvendorScoreAndRecord = () =>
  callFn<{ ok: boolean; scored: number; finishers: number; push: NewsvendorPushSummary | null }>(
    'newsvendorScoreAndRecord')

/** One student, as the dashboard and the Tier-1 roster render them. */
export type NewsvendorReportParticipant = {
  participant_id: string
  name: string | null
  launched: boolean
  completed: boolean
  finalized: boolean
  rounds_played: number
  average_order: number | null
  average_demand: number | null
  average_service_level: number | null
  average_profit: number | null
  total_profit: number
  /** ⚠ Instructor-only. */
  benchmark_profit: number
  /** Benchmark minus realized. SIGNED — a lucky student really can beat it. */
  optimality_gap: number | null
  knowledge_check_score: number | null
  participation_score: number | null
  prep: string | null
  debrief: string | null
}

/** One period of a Tier-3 chart. `n` is the number of students the two averages are
 *  over — it thins as the class spreads out, and the chart says so. */
export type NewsvendorSeriesPoint = {
  round: number
  student: number
  competitor: number
  n: number
}

/** The benchmark this instance's parameters imply (spec §4). Instructor-only. */
export type NewsvendorBenchmark = {
  Qopt: number
  CU: number
  CO: number
  CR: number
}

export type NewsvendorReportData = {
  ok: boolean
  /** Has Score & Record been run for this instance? */
  scored: boolean
  params: NewsvendorParams
  /** Null when the config cannot produce a benchmark at all; `configError` says why. */
  benchmark: NewsvendorBenchmark | null
  configError: string | null
  /** The longest game anyone played — the charts' x-axis, not the configured count. */
  maxPeriodsPlayed: number
  participants: NewsvendorReportParticipant[]
  charts: { orders: NewsvendorSeriesPoint[]; profits: NewsvendorSeriesPoint[] }
  summary: {
    averageOrder: number | null
    averageDemand: number | null
    averageServiceLevel: number | null
    averageProfit: number | null
    averageBenchmarkProfit: number | null
  }
  prepPrompt: string
  debriefPrompt: string
}

export const newsvendorGetReport = () => callFn<NewsvendorReportData>('newsvendorGetReport')

// ── Instructor: settings (spec §2) ──────────────────────────────────────────────

export type NewsvendorAddedKcQuestion = {
  id: string
  type: 'mc' | 'text'
  prompt: string
  options?: { value: string; label: string }[]
  correct_value?: string
  explanation?: string
}

/** The editable config, exactly the scalars of spec §2 plus the flow switches. */
export type NewsvendorEditableConfig = {
  P: number
  c: number
  /** Dual-sourcing mode. One toggle; everything else follows it. */
  dual: boolean
  /** Full per-unit cost of the expensive second source. Only meaningful when dual. */
  cL: number
  v: number
  g: number
  h: number
  isNormal: boolean
  mean: number
  sd: number
  minD: number
  maxD: number
  periods: number
  showCalculator: boolean
  showServiceLevel: boolean
  prepEnabled: boolean
  prepPrompt: string
  kcEnabled: boolean
  addedKcQuestions: NewsvendorAddedKcQuestion[]
  debriefEnabled: boolean
  debriefPrompt: string
}

export type NewsvendorConfigResult = {
  ok: boolean
  config: NewsvendorEditableConfig
  /** Instructor-only — it derives every demand draw, so it lives in the rules-denied
   *  truth doc and reaches no student response. */
  seed: string | null
  orderBounds: { min: number; max: number }
  benchmark: NewsvendorBenchmark | null
  /** DUAL only: the DERIVED premium (c_l − c). Null in regular mode. */
  premium: number | null
  configError: string | null
  /** Read-only preview of the AUTHORED ten, with the key. Not editable: they use
   *  fixed teaching numbers on purpose, so students must recompute. */
  authoredKcPreview: {
    field: string
    prompt: string
    options: { value: string; label: string }[]
    correct_value: string
  }[]
  authoredKcCount: number
  /** Has any student actually played a period? Drives the edit warning. */
  anyRoundsPlayed: boolean
}

export const newsvendorGetConfig = () => callFn<NewsvendorConfigResult>('newsvendorGetConfig')

/** Save settings. Every field is optional — only what is sent is written (merge), so
 *  a partial save can never clobber a sibling setting. A blank `seed` clears it. */
export const newsvendorUpdateConfig = (patch: Partial<NewsvendorEditableConfig & { seed: string | null }>) =>
  callFn<NewsvendorConfigResult>('newsvendorUpdateConfig', patch)
