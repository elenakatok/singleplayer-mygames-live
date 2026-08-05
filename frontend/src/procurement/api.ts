import { httpsCallable } from 'firebase/functions'
import { functions } from '../firebase'
import { isAuthError, instructorErrorMessage, CLASSROOM_URL, STUDENT_CLASSROOM_URL } from '../forecast/api'

// ═══════════════════════════════════════════════════════════════════════════════
// Procurement Auction — the callable client. `functions` is the shared Firebase
// instance (one project serves every single-player game); only the callable NAMES are
// procurement-specific.
//
// ⚠⚠ THE RESPONSE TYPES BELOW ARE THE CLIENT-SIDE CONTRACT, AND WHAT IS ABSENT FROM
// THEM IS THE POINT (Part 1 §4). There is no `seed` and no rival-cost array in any
// STUDENT type, because the server never sends them: rival costs are drawn at
// resolution time inside the submit transaction, and a student who could see them
// before bidding would have no decision left. Do not add such a field here; if one ever
// appears in a student response, that is a server bug, not a typing gap.
//
// ⚠ NOTE WHAT IS *NOT* IMPORTED: `db`. Every read goes through a callable. Firestore
// rules deny the client both truth/ and participants/, so the SDK could not reach this
// data even if something reached for it — and nothing does.
//
// ⚠ THE THREE ERROR HELPERS ARE RE-EXPORTED FROM forecast/api, NOT RE-IMPLEMENTED.
// They are family-level behaviour, not game behaviour: `isAuthError` carries the
// "Missing token" case that bit forecast in production on 08-02, and a fourth private
// copy of that regex is a fourth place for it to go stale. Whether they should be
// promoted into `@mygames/game-ui` alongside `useStudentSession` is a real question and
// it is Elena's — flagged, not decided.
// ═══════════════════════════════════════════════════════════════════════════════

export { isAuthError, instructorErrorMessage, CLASSROOM_URL, STUDENT_CLASSROOM_URL }

async function callFn<T>(name: string, data: object = {}): Promise<T> {
  const fn = httpsCallable<object, T>(functions, name)
  const result = await fn(data)
  return result.data
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

export const procurementBootstrap = (args: StudentBootstrapArgs) =>
  callFn<StudentBootstrapResult>('procurementBootstrap', args)

// ── Student: state ──────────────────────────────────────────────────────────────

export type ProcurementFormat = 'sealed_first_price' | 'open_descending'

export type DecrementBand = { above: number; step: number }
/** ⚠ REPLACES the `botDelayMs` scalar pair (open §3, 2026-08-04): a single uniform delay
 *  cannot serve both the ten-step bot cascade and the endgame duel. Same band shape and
 *  same boundaries as the decrement schedule, so pacing follows tension automatically. */
export type DelayBand = { above: number; delayMs: number }

/**
 * The instance's parameters, as the student receives them.
 *
 * ⚠ THIS IS THE WHITELIST. Every field is printed on the bidding screen anyway. The
 * ROUND COUNT IS PUBLIC in this game — eight rounds are independent, so unlike PD and
 * pricing there is no endgame effect that knowing the horizon would let a student
 * exploit, and the screen says "Round k of N" freely.
 *
 * ⚠ THE RIVAL COST RANGE IS PUBLIC, and deliberately: the equilibrium markup the debrief
 * discusses is only computable by a student who knows the top of it. Hiding it would hide
 * the lesson. THE PLAYER'S OWN RANGE IS THE OPPOSITE CASE and is absent — see below.
 */
export type ProcurementParams = {
  format: ProcurementFormat
  rounds: number
  rivalCount: number
  totalBidders: number
  reserve: number
  rivalCostMin: number
  rivalCostMax: number
  /** ⚠ THE PLAYER'S OWN COST RANGE IS DELIBERATELY ABSENT (§4): a student is told the
   *  RIVAL distribution only. Their own range does not enter their optimization (§5.2) —
   *  their cost is realized before they bid, so only the realized number matters. The
   *  server does not send it; do not add it here, and do not derive it from the data. */
  bidIncrementUnit: number
  currencyLabel: string
  /** Open format only. The client uses these to know how far a bid must fall and how long
   *  to wait before asking whether a bot is due. ⚠ THE CLIENT'S TIMING IS ADVISORY — the
   *  server re-checks `nextBotAtMs` on every advance (open §4.6). */
  decrementSchedule: DecrementBand[]
  delaySchedule: DelayBand[]
  delayJitterMs: number
}

export type ProcurementPlayedRow = {
  round: number
  yourCost: number
  yourBid: number | null
  won: boolean
  price: number | null
  profit: number
  profitTotal: number
  /** What β would have bid at this student's own cost (§8). Null when their cost was
   *  above the reserve. The SERVER's number — never re-derived on the client.
   *  ⚠ NULL ON EVERY OPEN ROUND — there is no single benchmark bid in a descending
   *  auction, and the open surfaces show exit price instead. */
  yourEquilibriumBid: number | null
  /**
   * OPEN FORMAT ONLY (§7) — where this student stopped, and whether that is OBSERVED or
   * only BOUNDED. Null on every sealed round: a sealed bid is not a stopping point.
   *
   * ⚠⚠ `exitCensored` IS TRUE IFF THEY WON, and it comes from the server's record — it is
   * never re-derived from `won` on the client. A winner was never pushed to their limit,
   * so their exit price is an upper bound, and they sit ABOVE the 45° line even playing
   * perfectly. Every surface that shows the number must carry the flag with it.
   */
  exitPrice: number | null
  exitCensored: boolean
}

/** One rival's (cost, bid) pair, for the §9 scatter's bot series.
 *
 *  ⚠⚠ THE ONLY RIVAL COST THAT EVER REACHES A CLIENT, and the server sends it only once
 *  `finished_at` is stamped — `revealRivalPoints` is null for the entire live game. It
 *  exists because the scatter's argument is that the bots sit ON the optimal line, which
 *  needs their costs on the x-axis. Do not read it anywhere but the results scatter, and
 *  do not add a call that fetches it earlier. */
export type ProcurementRivalPoint = {
  round: number
  cost: number
  bid: number
}

export type ProcurementPhase = 'kc' | 'play' | 'debrief' | 'done'

export type ProcurementState = {
  ok: boolean
  params: ProcurementParams
  played: ProcurementPlayedRow[]
  totalProfit: number
  /** What the §8 benchmark bid would have earned against the SAME realized rivals. */
  totalEquilibriumProfit: number
  roundsWon: number
  roundsPlayed: number
  /**
   * The round to play next (1-based) and the student's own drawn cost for it — the one
   * drawn number a student receives before acting, and the whole premise of the bidding
   * screen (§4, §6.1). Both null once every round is played.
   *
   * ⚠ THE COST IS THE PLAYER'S OWN, off its own stream. There is no rival cost here and
   * there never will be: rival costs are drawn at resolution, inside the submit
   * transaction. If one ever appears in this type, that is a server bug.
   */
  currentRound: number | null
  currentCost: number | null
  /** ⚠ null until the server stamps `finished_at`. The gate lives on the server. */
  revealRivalPoints: ProcurementRivalPoint[] | null
  /** ⚠ OPEN FORMAT ONLY, null otherwise — the LIVE AUCTION exactly as committed. */
  auction: ProcurementAuction | null
  phase: ProcurementPhase
  gameOver: boolean
}

export const procurementGetState = () => callFn<ProcurementState>('procurementGetState')

// ── Student: one sealed round ───────────────────────────────────────────────────

/** One bidder's line on the round-result table. ⚠ NOTE WHAT IS ABSENT: `cost`. The bids
 *  are revealed once the round resolves; the costs behind them never are. */
export type ProcurementBidLine = {
  label: string
  /** null = this rival was priced out by the reserve and made no bid (§3.1). */
  amount: number | null
  isYou: boolean
  won: boolean
}

export type ProcurementRoundResult = {
  round: number
  yourCost: number
  yourBid: number | null
  /** Every bidder, LOWEST FIRST, the player's and the winner's marked. */
  bids: ProcurementBidLine[]
  won: boolean
  price: number | null
  profit: number
  profitTotal: number
  /** No admissible bid at all — nobody won. Only reachable at a lowered reserve. */
  noAward: boolean
  /** The player's own cost was above the reserve: there was no bid worth making. */
  costAboveReserve: boolean
  tie: boolean
  /** Fires the "two bids tied at the lowest price" line — without it a student sees two
   *  identical lowest bids with the other marked winner and reads it as a bug. */
  tiedAndLost: boolean
  equilibriumBid: number | null
  equilibriumWouldHaveWon: boolean
  equilibriumProfit: number
}

export type ProcurementSubmitBidResult = {
  ok: boolean
  /** The next round and the student's own cost for it, so the loop starts without a
   *  second round trip. Both null once the game is over. */
  nextRound: number | null
  nextCost: number | null
  round: ProcurementRoundResult
  history: ProcurementPlayedRow[]
  totalProfit: number
  totalEquilibriumProfit: number
  roundsWon: number
  roundsPlayed: number
  phase: ProcurementPhase
  gameOver: boolean
}

/** ⚠ SUBMIT AND LOCK. A resubmit for a round already stored returns that round and
 *  writes nothing — the retry is safe, and it cannot trigger a second cost draw.
 *  ⚠ SEALED FORMAT. The open format posts to the SAME callable with a different shape —
 *  see `procurementOpenBid`. */
export const procurementSubmitBid = (round: number, bid: number) =>
  callFn<ProcurementSubmitBidResult>('procurementSubmitBid', { round, bid })

// ── Student: the OPEN-DESCENDING auction (open §4.6) ────────────────────────────

/**
 * The live auction, exactly as the server holds it.
 *
 * ⚠⚠ THE STANDING BID HERE IS THE COMMITTED ONE. Nothing advances without a server
 * commit, so there is no window in which the server knows a price this object does not —
 * which is the whole reason the cascade is not precomputed and animated (open §4.6). Do
 * NOT add client-side interpolation, optimistic bids, or a locally-advanced price: every
 * one of those recreates the gap this design exists to close.
 *
 * ⚠ NOTE WHAT IS ABSENT: any bot cost, the `stopped` list — derived from bot costs, and it
 * would give each rival's away to within one step of the schedule — AND ANY COUNT OF IT.
 * See `totalBidders` below (functions procurement/openView.ts).
 */
export type ProcurementAuctionEvent = {
  kind: 'bid' | 'dropOut'
  /** "You" or "Bot 3" (open §5.1). ⚠ There is no cost on this row, ever. */
  label: string
  amount: number | null
  isYou: boolean
}

export type ProcurementAuction = {
  round: number
  /** `bot_turn` — wait until `nextBotAtMs`, then call advance.
   *  `waiting`  — the cascade has halted; Bid and Drop Out are live, with NO timeout.
   *  `resolved` — over. */
  status: 'bot_turn' | 'waiting' | 'resolved'
  standing: number
  holderLabel: string | null
  youHold: boolean
  yourLastBid: number | null
  youAreOut: boolean
  /** Declared back on a bid so a collision can be described. ⚠ A stale one NEVER rejects
   *  on its own — the server re-checks against the new standing (open §4.6). */
  sequence: number
  nextBotAtMs: number | null
  step: number
  /** §5.1's "Minimum next bid", and the bid box's pre-fill. ⚠ A DEFAULT, NOT A LIMIT —
   *  jump bidding is legal and useful (§4.2). */
  minNextBid: number | null
  history: ProcurementAuctionEvent[]
  /**
   * ⚠⚠ THE OPENING PARAMETER, AND IT NEVER MOVES. There is deliberately NO `activeBidders`
   * — a competitor's departure is not announced in a live auction, the player infers it
   * from silence, and silence is ambiguous between "priced out" and "still thinking". The
   * server does not compute it; if you are about to add "how many are left", you are
   * re-adding the last client-side field derived from bot cost state.
   */
  totalBidders: number
  winnerLabel: string | null
  youWon: boolean
  price: number | null
}

export type ProcurementOpenTurn = {
  ok: boolean
  auction: ProcurementAuction
  yourCost: number
  /** A refused bid. ⚠ NOT AN ERROR RESPONSE: `auction` above is still the current truth,
   *  so the screen shows the refusal AND the price that moved under it. */
  rejected: string | null
  /** Set by the action that ENDED the round. */
  roundOutcome: {
    round: number
    yourCost: number
    yourLastBid: number | null
    won: boolean
    price: number | null
    profit: number
    profitTotal: number
    droppedOut: boolean
    /** ⚠ §7's pair, read back off the stored record rather than recomputed. */
    exitPrice: number | null
    exitCensored: boolean
    /** What perfect play — stopping exactly at cost — would have earned from these same
     *  draws. Drives §5.2's "there was nothing more to win here". */
    perfectProfit: number
    perfectWon: boolean
  } | null
  history: ProcurementPlayedRow[]
  totalProfit: number
  /** "A perfect player would have earned X from your draws" (§5.3), summed over the
   *  per-round perfect-play replays. Same field name as the sealed format's. */
  totalEquilibriumProfit: number
  roundsWon: number
  roundsPlayed: number
  nextRound: number | null
  phase: ProcurementPhase
  gameOver: boolean
}

/** The client's tick. ⚠ Commits AT MOST ONE bot bid, and only if the server agrees it is
 *  due — calling early is harmless and writes nothing (open §8.3 case 11). */
export const procurementAdvance = () =>
  callFn<ProcurementOpenTurn>('procurementAdvance')

/** The player's bid in the open format. `sequence` is what they were LOOKING AT. */
export const procurementOpenBid = (bid: number, sequence: number) =>
  callFn<ProcurementOpenTurn>('procurementSubmitBid', { bid, sequence })

/** ⚠ FINAL, and recorded as PLAY (open §4.5). This format only. */
export const procurementDropOut = () =>
  callFn<ProcurementOpenTurn>('procurementDropOut')

// ── Student: questions ──────────────────────────────────────────────────────────

export type ProcurementKcQuestionClient = {
  field: string
  kind: 'mc' | 'text'
  prompt: string
  options: { value: string; label: string }[]
  placeholder: string | null
}

export type ProcurementQuestions = {
  ok: boolean
  kcEnabled: boolean
  kc: ProcurementKcQuestionClient[]
  kcAnswered: string[]
  /** ⚠ COMPUTED SERVER-SIDE from the VISIBLE GRADED questions, never stored. The
   *  student's score is out of exactly this. There is no `/17` on the client either. */
  gradedTotal: number
  prep: ProcurementKcQuestionClient[]
  prepAnswered: string[]
  debrief: ProcurementKcQuestionClient[]
  debriefAnswered: string[]
}

export const procurementGetQuestions = () =>
  callFn<ProcurementQuestions>('procurementGetQuestions')

export const procurementSubmitKcAnswer = (field: string, answer: string) =>
  callFn<{ ok: boolean; correct: boolean; graded: boolean; explanation: string }>(
    'procurementSubmitKcAnswer', { field, answer })

/** ⚠ ONE callable for the prep AND the debrief paragraph — routed server-side by the
 *  question's stage tag. */
export const procurementSubmitFreeText = (field: string, answer: string) =>
  callFn<{ ok: boolean; field: string; stage: QuestionStage; stored: boolean; answer: string }>(
    'procurementSubmitFreeText', { field, answer })

// ── Instructor ──────────────────────────────────────────────────────────────────

// ⚠ ONLY the session exchange takes arguments. Every other instructor callable
// authenticates on the auto-attached Bearer id-token that `useInstructorSession`
// established — matching forecast, newsvendor, pricing and PD. An `args` parameter here
// would invite a caller to re-send the classroom JWT on every navigation, which is the
// 15-minute `jwt expired` bug the shared hook's resume guard exists to prevent.
import type { InstructorSessionArgs } from '../shared/useInstructorSession'

export type ProcurementConfig = {
  format: ProcurementFormat
  direction: 'reverse'
  rounds: number
  rivalCount: number
  reserve: number
  rivalCostDist: { distribution: 'uniform'; min: number; max: number; integer: boolean }
  playerCostDist: { distribution: 'uniform'; min: number; max: number; integer: boolean }
  bidIncrementUnit: number
  /** Is the reserve still FOLLOWING the top of the rival cost range? ⚠ RECORDED by the
   *  server, never inferred from `reserve === rivalCostDist.max` — an instructor who
   *  deliberately sets the reserve TO the rival max must not have it silently start
   *  moving again. True until they edit the reserve; resetting it turns it back on. */
  reserveAuto: boolean
  /** ⚠ OPEN-FORMAT PACING, EDITABLE IN SETTINGS ON PURPOSE. Open §2/§10 name three levers
   *  for tuning the first live run — shorter delays, a coarser top band, a lower reserve —
   *  and require all three to be reachable between rounds. A deploy is not a lever. */
  decrementSchedule: DecrementBand[]
  delaySchedule: DelayBand[]
  delayJitterMs: number
  currencyLabel: string
  kcEnabled: boolean
  /** ⚠ Includes the PREP and DEBRIEF questions (S8/S9, O9/O10) — they are pool entries
   *  with a `stage` tag, toggled here like every graded question. There is deliberately
   *  no separate debriefEnabled/debriefPrompt pair. */
  kcVisible: string[]
}

export type QuestionStage = 'kc' | 'prep' | 'debrief'

export type ProcurementKcPoolRow = {
  id: string
  stage: QuestionStage
  prompt: string
  graded: boolean
  visible: boolean
}

export type ProcurementConfigResult = {
  ok: boolean
  config: ProcurementConfig
  /** ⚠ MASKED — whether a seed is set, never the seed itself. */
  seedSet: boolean
  formatLocked: boolean
  kcPool: ProcurementKcPoolRow[]
  kcPoolTotal: number
  kcVisibleCount: number
  kcGradedCount: number
}

export const procurementGetConfig = () =>
  callFn<ProcurementConfigResult>('procurementGetConfig')

export const procurementUpdateConfig = (
  config: Partial<ProcurementConfig> & { seed?: string | null },
) =>
  callFn<{ ok: boolean; config: ProcurementConfig; updated: string[]; seedWritten: boolean; rejected: string[] }>(
    'procurementUpdateConfig', { config })

export const procurementSyncRoster = () =>
  callFn<{ ok: boolean; synced: number; note?: string }>('procurementSyncRoster')

export type ProcurementPushSummary = { total: number; succeeded: number; failed: unknown[] }

export const procurementScoreAndRecord = () =>
  callFn<{ ok: boolean; scored: number; finishers: number; push: ProcurementPushSummary | null }>(
    'procurementScoreAndRecord')

/** One simulated rival's (cost, bid, won) triple for the Tier-3 class chart.
 *  ⚠ INSTRUCTOR-ONLY — this comes from `procurementGetReport`, which no student can call.
 *  The student-facing rival reveal is a different payload, gated on `finished_at`. */
export type ProcurementReportRivalPoint = {
  round: number
  cost: number
  bid: number
  won: boolean
}

export type ProcurementReportRow = {
  participantId: string
  name: string | null
  externalId: string | null
  finished: boolean
  roundsPlayed: number
  roundsWon: number
  profitTotal: number
  knowledgeCheckScore: number | null
  rawScore: number | null
  normalizedScore: number | null
  rounds: ProcurementPlayedRow[]
  /** The simulated rivals this student faced — the class chart's rival series. */
  rivalPoints: ProcurementReportRivalPoint[]
  /** Every free-text answer, keyed by question id. */
  freeText: Record<string, string>
}

export type ProcurementReport = {
  ok: boolean
  format: ProcurementFormat
  rounds: number
  reserve: number
  /** ⚠ THE TIER-3 LINE IS DERIVED FROM THESE, per instance. β needs θmax and n, not just
   *  the reserve — two instances with different rival ranges must not share one line. */
  rivalCostMin: number
  rivalCostMax: number
  playerCostMin: number
  playerCostMax: number
  rivalCount: number
  totalBidders: number
  currencyLabel: string
  gradedTotal: number
  finalized: boolean
  /** ⚠ ONE ENTRY PER TIER-2 TILE — the spawn gate. Four across the two formats. */
  textQuestions: { field: string; stage: QuestionStage; prompt: string }[]
  rows: ProcurementReportRow[]
}

export const procurementGetReport = () => callFn<ProcurementReport>('procurementGetReport')

export const procurementInstructorSession = (args: InstructorSessionArgs) =>
  callFn<{ ok: boolean; customToken: string }>('procurementInstructorSession', args)

// ── Display helpers ─────────────────────────────────────────────────────────────

export const FORMAT_LABEL: Record<ProcurementFormat, string> = {
  sealed_first_price: 'Sealed-bid, first price',
  open_descending: 'Open-bid, descending',
}
