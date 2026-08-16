import type { PdStrategy } from './strategies'
import { httpsCallable } from 'firebase/functions'
import { FirebaseError } from 'firebase/app'
import { functions } from '../firebase'

// PD's callable client. `functions` is the shared Firebase instance (one project
// serves every single-player game); only the callable NAMES are pd-specific.
//
// SLICE 5 — launch, instructor session, the round loop, reports, and settings.
//
// ⚠ THE RESPONSE TYPES BELOW ARE THE WHOLE CLIENT-SIDE CONTRACT. There is no round
// count and no strategy in them because the server never sends either (spec §3, §5):
// the client cannot render, log, or infer from a field it never receives. Do not add
// a `rounds`, `roundsRemaining`, `total`, or `strategy` field here — if one ever
// appears in a response, that is a server bug, not a typing gap.

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

/**
 * Where a STUDENT goes when their session fails — the student login/portal, never the
 * instructor courses page. `/` is behind RequireAuth and redirects a student to a login
 * they cannot use; sending them there from a failsafe screen strands them. Doubly wrong
 * for a launcher-opened student window, which has its own session.
 *
 * Applies to EVERY student session failure, not just an expired token.
 */
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

export const pdBootstrap = (args: StudentBootstrapArgs) =>
  callFn<StudentBootstrapResult>('pdBootstrap', args)

// ── Student: the round loop ─────────────────────────────────────────────────────

/** A move. C = Cooperate (stay silent), D = Defect (confess). */
export type Move = 'C' | 'D'

/**
 * The EIGHT payoff values, counted in the instance's configured `unit`.
 *
 *   Y(a,b) = `you_ab`   your payoff when YOU play a and the OTHER player plays b
 *   O(a,b) = `other_ab` the other player's payoff in that SAME cell
 *
 * a, b ∈ { C = first move, D = second move } — abstract actions. "Cooperate" and
 * "Defect" are instructor-set WORDING (`PdMoveLabels`), never identifiers.
 *
 * ⚠ THE SERVER ALWAYS SENDS EIGHT. An instance created before this shape existed
 * stores four; `parsePayoffs` server-side normalizes it on every read (O = the
 * transpose of Y, which is what the old symmetric derive computed), so nothing on the
 * client ever sees the legacy shape and no client code may fall back to it.
 *
 * The game is DIRECTION-AGNOSTIC — nothing here says whether a bigger number is better.
 */
export type PdPayoffs = {
  you_cc: number
  you_cd: number
  you_dc: number
  you_dd: number
  other_cc: number
  other_cd: number
  other_dc: number
  other_dd: number
}

/** Display labels for the two moves (instructor-configurable, spec §2). */
export type PdMoveLabels = { C: string; D: string }

/** One PLAYED round, as the history table renders it. Cumulative totals are running
 *  sums over rounds played — never a fraction of a total the student cannot see. */
export type PdHistoryRow = {
  round: number
  studentMove: Move
  botMove: Move
  studentYears: number
  botYears: number
  studentTotal: number
  botTotal: number
}

export type PdStateResult = {
  ok: boolean
  labels: PdMoveLabels
  payoffs: PdPayoffs
  /** The word the payoff numbers are counted in. Carries NO direction — the game
   *  never states whether more is better. */
  unit: string
  /** The configured round-count RANGE — the only thing about the schedule a student
   *  may be told. NOT the drawn count, which never leaves the server. */
  minRounds: number
  maxRounds: number
  history: PdHistoryRow[]
  gameOver: boolean
}

export type PdRoundResult = {
  ok: boolean
  /** This round's outcome — exactly the four values the reveal shows. */
  round: { studentMove: Move; botMove: Move; studentYears: number; botYears: number }
  history: PdHistoryRow[]
  /** The ONLY thing the student learns about the schedule: it just ended, or it did
   *  not. Never how many rounds are left. */
  gameOver: boolean
}

/** Where am I? Also performs first-touch init server-side. */
export const pdGetState = () => callFn<PdStateResult>('pdGetState')

/** Play one round. `round` is the 1-based round the client believes it is on; the
 *  server verifies it and treats a resubmit for an already-played round as a no-op
 *  (submit-and-lock), so a double-click or a retry cannot burn a round. */
export const pdSubmitRound = (round: number, move: Move) =>
  callFn<PdRoundResult>('pdSubmitRound', { round, move })

// ── Student: knowledge check + debrief ──────────────────────────────────────────

/** One KC question as the client receives it — NO answer key. `correct_value` and
 *  `explanation` are stripped server-side; the explanation arrives only in the
 *  response to an answer, which is what makes it impossible to read ahead. */
export type PdKcQuestionClient = {
  field: string
  prompt: string
  options: { value: string; label: string }[]
  /** Present on instructor-added questions; the derived four are always 'mc'. */
  type?: 'mc' | 'text'
}

export type PdDebriefQuestionClient = {
  field: string
  prompt: string
  placeholder: string
}

export type PdQuestionsResult = {
  ok: boolean
  kcEnabled: boolean
  /**
   * TWO SOURCES, KEPT APART. `derived` is the four matrix-comprehension questions,
   * recomputed server-side from the live matrix every call; `added` is the
   * instructor's own questions with their own stored keys. The client renders
   * derived-then-added but never merges the lists — see getQuestions.ts.
   */
  kc: { derived: PdKcQuestionClient[]; added: PdKcQuestionClient[] }
  debriefEnabled: boolean
  debrief: PdDebriefQuestionClient | null
  /** Fields already answered — drives KC resume (poll's findIndex pattern). */
  kcAnswered: string[]
  debriefSubmitted: boolean
  /**
   * ⚠⚠ THE WHOLE `post` STAGE, IN SERVED ORDER — the debrief row plus any added question
   * the instructor put AFTER PLAY. The post-play position in the sequence walks this list
   * exactly as the pre-play position walks the KC list.
   *
   * ⚠ `kind` ROUTES THE SUBMIT and `type` does not: an added free-text question is also
   * `type: 'text'` but goes to pdSubmitKcAnswer, while the debrief goes to
   * pdSubmitDebrief. Never infer one from the other.
   */
  postStage: PdPostStageQuestionClient[]
}

export type PdPostStageQuestionClient = {
  /** `debrief` → pdSubmitDebrief · `added` → pdSubmitKcAnswer. See the note above. */
  kind: 'debrief' | 'added'
  field: string
  type: 'mc' | 'text'
  prompt: string
  placeholder?: string
  /** Empty for free text. Shuffled per student for an added mc question. */
  options: { value: string; label: string }[]
  /** Presence of the stored answer. Drives resume — the first false is where they land. */
  answered: boolean
}

/** The KC + debrief question set, plus what this student has already answered. */
export const pdGetQuestions = () => callFn<PdQuestionsResult>('pdGetQuestions')

/** Answer ONE KC question. Graded, but NOT a gate: a wrong answer is recorded and
 *  the student proceeds. The verdict and explanation come back post-answer. */
export const pdSubmitKcAnswer = (field: string, answer: string) =>
  callFn<{ ok: boolean; correct: boolean; graded: boolean; explanation: string }>(
    'pdSubmitKcAnswer', { field, answer })

/** Submit the debrief paragraph. Ungraded. */
export const pdSubmitDebrief = (answer: string) =>
  callFn<{ ok: boolean; stored: boolean; answer: string }>('pdSubmitDebrief', { answer })

// ── Instructor: roster, scoring, reports ────────────────────────────────────────
//
// ⚠ EVERYTHING BELOW IS INSTRUCTOR-ONLY and DOES carry the strategy and the round
// count. That is not a hole in the no-leak rule: these callables are
// instructor-authenticated server-side, no student screen imports them, and the
// student-facing types above still cannot express either value. Keep it that way —
// if a student component ever needs data from here, that is the bug.

/** ⚠ Declared in `strategies.ts`, which imports nothing — see the note there. Re-exported
 *  here so call sites that already talk to api.ts keep one import. */
export type { PdStrategy } from './strategies'
export { PD_STRATEGIES } from './strategies'

/** One roster row (Tier 1, Reports Contract). */
export type PdReportParticipant = {
  participant_id: string
  name: string | null
  launched: boolean
  completed: boolean
  rounds_played: number
  cooperation_rate: number | null
  avg_years: number | null
  student_years_total: number
  bot_years_total: number
  strategy: PdStrategy | null
  first_move: Move | null
  knowledge_check_score: number | null
  participation_score: number | null
  debrief: string | null
}

/** One series' value at one round. */
export type PdCooperationSeriesPoint = {
  strategy: PdStrategy
  /** Fraction who played the FIRST move this round. null ⇒ none had played it. */
  rate: number | null
  /** The denominator, and the legend's n=. */
  n: number
}

/**
 * Tier 3a — one point per round, one entry per ASSIGNED strategy.
 *
 * ⚠ A LIST, NOT NAMED FIELDS. It was `{tft, grim, tftN, grimN}`, which hardcoded a
 * two-strategy library into the wire format. The series present are the strategies
 * actually assigned in the instance — a strategy in the pool that nobody drew gets no
 * series at all.
 */
export type PdCooperationPoint = {
  round: number
  series: PdCooperationSeriesPoint[]
}

/** Tier 3b — one bar per (first move × strategy). `avgYearsPerRound` is the mean
 *  payoff per round in the instance's unit; the name is historical. */
export type PdFirstMoveOutcome = {
  firstMove: Move
  strategy: PdStrategy
  avgYearsPerRound: number | null
  n: number
}

export type PdReportData = {
  ok: boolean
  scored: boolean
  /** The longest game played in this instance — the cooperation chart's x-axis.
   *  NOT a horizon: each student draws their own and none of them is reported. */
  maxRoundsPlayed: number
  payoffs: PdPayoffs
  labels: PdMoveLabels
  /** The instance's unit word, so the roster and charts label their numbers the same
   *  way the students' screens did. */
  unit: string
  participants: PdReportParticipant[]
  charts: { cooperation: PdCooperationPoint[]; firstMove: PdFirstMoveOutcome[] }
  /** ⚠ Every strategy's display name and debrief reveal line, resolved SERVER-SIDE
   *  against this instance's wording. The reports render these as given and hold no
   *  label map of their own. */
  strategyText: Record<PdStrategy, { label: string; reveal: string }>
  debriefPrompt: string
}

/** The roster + every report dataset, in one call. */
export const pdGetReport = () => callFn<PdReportData>('pdGetReport')

/** Participation scoring + the gradebook push. Re-runnable. */
export const pdScoreAndRecord = () =>
  callFn<{ ok: boolean; scored: number; finishers: number; names: Record<string, string | null>; push: { total: number; succeeded: number; failed: { participant_id: string; reason: string }[] } | null }>(
    'pdScoreAndRecord')

/** Pull the course roster so never-launched students appear (and can be graded −2). */
export const pdSyncRoster = () =>
  callFn<{ ok: boolean; synced: number; note?: string }>('pdSyncRoster')

// ── Instructor: session ─────────────────────────────────────────────────────────

export type InstructorSessionArgs =
  | { token: string }
  | { _dev: { game_instance_id: string } }

export const pdInstructorSession = (args: InstructorSessionArgs) =>
  callFn<{ ok: boolean; customToken: string }>('pdInstructorSession', args)

// ── Instructor: settings ────────────────────────────────────────────────────────

/** One instructor-added KC question, as stored. Structurally separate from the four
 *  DERIVED matrix questions, which are never stored and never editable. */
export type PdAddedKcQuestion = {
  id: string
  type: 'mc' | 'text'
  prompt: string
  options?: { value: string; label: string }[]
  correct_value?: string
  explanation?: string
}

export type PdConfigResult = {
  ok: boolean
  /** The instance's pool — which strategies may be assigned. Never empty. */
  strategies: PdStrategy[]
  /** Every id with its display name and reveal line, resolved against the STORED
   *  wording. The settings page relabels live from `strategyText.ts` as the
   *  instructor types; this is the load-time value and the drift reference. */
  strategyOptions: { id: PdStrategy; label: string; reveal: string }[]
  payoffs: PdPayoffs
  labels: PdMoveLabels
  unit: string
  minRounds: number
  maxRounds: number
  kcEnabled: boolean
  addedKcQuestions: PdAddedKcQuestion[]
  debriefEnabled: boolean
  debriefPrompt: string
  /** Read-only preview of what the CURRENT matrix derives — instructor-side, so it
   *  may include the answer key. Not editable: change the matrix instead. */
  derivedKcPreview: { field: string; prompt: string; options: { value: string; label: string }[]; correct_value?: string }[]
  /** Whether ANY student has drawn their hidden round count yet — i.e. whether
   *  anyone has launched. A BOOLEAN — never a number, even here. Drives the "range
   *  edits will not reach students already playing" notice. */
  anyRoundsDrawn: boolean
  /** ⚠ The three convergence fields (spec §5). */
  kcHidden: Record<string, boolean>
  kcOrder: Record<string, number>
  kcOverrides: Record<string, PdKcOverride>
  /** Everything the shared knowledge-check block renders. */
  kc: PdKcInventory
}

/** One question's instructor wording. ⚠ `options` maps an EXISTING option value to a
 *  replacement LABEL — it cannot add, drop, reorder or re-key an option, and therefore
 *  cannot move a score. */
export type PdKcOverride = {
  prompt?: string
  options?: Record<string, string>
}

/** ⚠ `post` means AFTER PLAY. pd has NO reveal — the bot's strategy is never shown. */
export type PdKcStage = 'pre' | 'post'

export type PdKcInventoryQuestion = {
  id: string
  kind: 'builtin' | 'added'
  stage: PdKcStage
  prompt: string
  options: { value: string; label: string }[]
  correctValue: string | null
  graded: boolean
  visible: boolean
  locked: boolean
  /** ⚠ Populated whenever `locked` — a disabled control with no reason reads as a bug. */
  lockReason: string | null
  overridden: boolean
  originalPrompt?: string
  originalOptions?: { value: string; label: string }[]
  type?: 'mc' | 'text'
  order: number | null
}

export type PdKcInventory = {
  stages: readonly PdKcStage[]
  builtIn: PdKcInventoryQuestion[]
  added: PdKcInventoryQuestion[]
  /** ⚠ The debrief paragraph, AS A ROW (spec D9) — an ungraded question in a later stage,
   *  not a separate surface. Backed by `debriefPrompt` / `debriefEnabled`, NOT by the
   *  three convergence maps, so no stored answer moves. */
  debrief: PdKcInventoryQuestion
  poolTotal: number
  visibleCount: number
  gradedCount: number
}

/** Every editable setting for the instance. */
export const pdGetConfig = () => callFn<PdConfigResult>('pdGetConfig')

/** Save settings. Every field is optional — only what is sent is written (merge), so
 *  a partial save can never clobber a sibling setting. */
export const pdUpdateConfig = (patch: Partial<{
  /** The opponent pool. ⚠ The callable REFUSES an empty array — see spec §5.3. */
  strategies: PdStrategy[]
  payoffs: PdPayoffs
  labels: PdMoveLabels
  unit: string
  minRounds: number
  maxRounds: number
  kcEnabled: boolean
  addedKcQuestions: PdAddedKcQuestion[]
  debriefEnabled: boolean
  debriefPrompt: string
  kcHidden: Record<string, boolean>
  kcOrder: Record<string, number>
  kcOverrides: Record<string, PdKcOverride>
}>) => callFn<PdConfigResult>('pdUpdateConfig', patch)
