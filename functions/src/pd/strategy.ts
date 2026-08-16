// ═══════════════════════════════════════════════════════════════════════════════
// Repeated Prisoner's Dilemma — the bot strategy library (PD spec §5).
//
// ⚠⚠ EVERY STRATEGY HERE IS A PURE FUNCTION OF MOVE HISTORY. NOT ONE READS A PAYOFF.
//
// That is load-bearing, not incidental. The game is DIRECTION-AGNOSTIC — the unit is
// the instructor's word and the software never states whether a bigger number is
// better — so a strategy that consulted a payoff would have to know a direction, and
// the whole configuration surface would acquire a meaning it deliberately does not
// have. It would also break the moment an instructor ran a non-dilemma matrix
// (Battle of the Sexes is a supported configuration, spec §2).
//
// ⚠ IF A FUTURE STRATEGY SEEMS TO NEED A PAYOFF VALUE OR A DIRECTION, THE DEFINITION
// HAS DRIFTED. Stop and re-derive it over the two abstract actions.
//
// C and D are POSITIONS — "the first move" and "the second move". They are NOT the
// words "Cooperate" and "Defect", which are instructor-set wording (config `labels`)
// and may be anything. Nothing in this file may be read as naming a real-world action.
//
// The compute step calls botMove() AFTER the student's round-t move is accepted and
// committed, passing history through t−1 — so the bot's move for round t can never
// depend on the student's round-t choice, and can never be reachable by the student
// before they commit (spec §1, architecture §5.3).
// ═══════════════════════════════════════════════════════════════════════════════

/** A move. C = the FIRST move, D = the SECOND move. Positions, not words. */
export type Move = 'C' | 'D'

/**
 * The strategy library. Ids are STABLE — they are written into rules-denied truth
 * documents and read back for the whole life of an instance, so an id may never be
 * renamed or reused for a different rule.
 */
export type Strategy =
  | 'tft'
  | 'grim'
  | 'random'
  | 'always_first'
  | 'always_second'
  | 'alternate'

/** Every strategy id, in a stable order. Settings lists them in this order, the
 *  reports group in this order, and the assignment draw indexes into a subset of it. */
export const STRATEGIES: readonly Strategy[] = [
  'tft', 'grim', 'random', 'always_first', 'always_second', 'alternate',
] as const

/**
 * The pool an instance gets when it has never been configured.
 *
 * ⚠ EXACTLY THE TWO THAT USED TO BE HARDCODED. An instance created before the pool was
 * configurable stores no `strategies` field, reads as this, and therefore draws from
 * the same two ids with the same uniform rule it always did — identical play, no
 * backfill, no write. `pdStrategyPool.test.ts` pins that identity.
 */
export const DEFAULT_STRATEGY_POOL: readonly Strategy[] = ['tft', 'grim'] as const

const STRATEGY_SET: ReadonlySet<string> = new Set(STRATEGIES)

/** Type guard for a stored/config-supplied strategy id. */
export function isStrategy(v: unknown): v is Strategy {
  return typeof v === 'string' && STRATEGY_SET.has(v)
}

/**
 * ⚠⚠ RETIRED IDS, MAPPED TO THEIR SURVIVING EQUIVALENT AT READ TIME.
 *
 * `match_stay` was removed because it was never a distinct rule. Its condition —
 * "repeat my own last move if the two of us matched, switch it if we differed" —
 * collapses in a two-action game: matched means my last move WAS the student's, so
 * repeating plays theirs; mismatched means flipping mine ALSO lands on theirs, because
 * there is nowhere else to land. Either way the output is the student's previous move,
 * which is tit-for-tat. Proven exhaustively over all 256 four-round histories before it
 * was removed.
 *
 * ⚠ THE MAPPING IS EXACT, NOT APPROXIMATE. A participant whose truth document holds
 * `match_stay` has been playing tit-for-tat all along by that equivalence, so reading it
 * as `tft` changes nothing they have experienced and nothing already stored in their
 * round records. Without this they would fail `isStrategy`, and `init.ts` would treat
 * them as never-assigned and REDRAW mid-game — the one thing the once-only contract
 * exists to prevent.
 *
 * ⚠ NO LIVE DOCUMENT HELD IT (checked in `singleplayer-mygames-live` before removal: 2
 * pd instances, 13 truth documents, all `tft` or `grim`, and neither instance had a
 * `config/main` at all). It is kept anyway because it costs two lines and removes the
 * failure mode entirely.
 */
const RETIRED_STRATEGIES: Readonly<Record<string, Strategy>> = {
  match_stay: 'tft',
}

/**
 * A STORED strategy id, normalized. Returns null for anything unrecognisable.
 *
 * ⚠ EVERY READ OF A STORED `strategy` FIELD GOES THROUGH THIS, not through `isStrategy`
 * directly — the play path (init.ts) and the reports (report.ts). `isStrategy` answers
 * "is this a strategy this build can run"; this answers "what should a document that
 * says this be played as", which is the question a reader actually has.
 */
export function parseStoredStrategy(v: unknown): Strategy | null {
  if (isStrategy(v)) return v
  if (typeof v === 'string' && v in RETIRED_STRATEGIES) return RETIRED_STRATEGIES[v]
  return null
}

/**
 * What a strategy needs beyond the two move histories.
 *
 * Only `random` reads it. It is the SAME seedable path `init.ts` uses for the round
 * count and the assignment: seeded ⇒ a pure function of (seed, participant, round);
 * unseeded ⇒ real randomness.
 */
export interface BotContext {
  /** The instance seed. null ⇒ real randomness. */
  seed: string | null
  participantId: string
}

/** FNV-1a + murmur3 fmix32. Same construction as init.ts's — the avalanche matters
 *  because the draw consumes the LOW BIT, and raw FNV-1a low bits are poorly mixed
 *  for short, similar inputs (round numbers are exactly that). */
function hash32(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  h ^= h >>> 16
  h = Math.imul(h, 0x85ebca6b)
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35)
  h ^= h >>> 16
  return h >>> 0
}

/**
 * The bot's move for the round that follows the two histories.
 *
 * @param strategy       which bot this student faces (fixed for all their rounds)
 * @param studentHistory the STUDENT's own prior moves, in round order, through t−1.
 *                       Empty ⇒ this is round 1.
 * @param botHistory     the BOT's own prior moves, in round order, through t−1.
 *                       ⚠⚠ READ FROM THE STORED ROUND RECORDS — see below.
 * @param ctx            seed + participant, for `random` only.
 *
 * ⚠⚠ THE SIGNATURE IS WIDE, AND `botHistory` MUST COME FROM STORAGE. It used to take
 * the student's history alone, because every strategy was a function of it. `random`
 * is not: its past moves are DRAWS, and replaying the strategy to reconstruct them
 * would silently rewrite history on every unseeded instance. `submitRound` therefore
 * passes `botMoves(storedRounds)`, straight off the stored `bot_move` fields, and
 * `pdStrategyLibrary.test.ts` asserts a stored move is read back rather than
 * re-derived.
 *
 * ⚠ `botHistory` IS KEPT THOUGH NO SURVIVING STRATEGY READS IT. The parameter is the
 * seam a self-referential rule needs, and removing it would have to be undone by the
 * next one; it is also what makes the read-from-storage discipline expressible at all.
 * It is threaded from the real records at the one call site, so it cannot rot.
 *
 * ⚠ `botHistory` AND `ctx` ARE OPTIONAL, AND A STRATEGY THAT NEEDS ONE AND IS GIVEN
 * NOTHING THROWS. Optional keeps every history-only call site compiling unchanged;
 * throwing is what stops the optionality from becoming a silent wrong answer.
 *
 * Pure with respect to everything except `random`'s unseeded draw. Never mutates
 * either history.
 */
export function botMove(
  strategy: Strategy,
  studentHistory: readonly Move[],
  botHistory?: readonly Move[],
  ctx?: BotContext,
): Move {
  /** 1-based index of the round being computed. */
  const round = studentHistory.length + 1

  switch (strategy) {
    // TIT-FOR-TAT — first move on round 1, then mirror the student's most recent move.
    // Teaches: reciprocity rewards cooperation, and punishment is proportionate and
    // forgiving (one cooperative move buys the bot back).
    case 'tft':
      if (studentHistory.length === 0) return 'C'
      return studentHistory[studentHistory.length - 1]

    // GRIM (classic / unforgiving) — first move until the student's FIRST second-move,
    // then second move forever. Teaches: betrayal can be permanent. Deliberately NOT
    // forgiving: returning never brings the bot back (spec §5, §11).
    case 'grim':
      return studentHistory.includes('D') ? 'D' : 'C'

    // ALWAYS FIRST — the first move every round, whatever the student does.
    case 'always_first':
      return 'C'

    // ALWAYS SECOND — the second move every round, whatever the student does.
    case 'always_second':
      return 'D'

    // ALTERNATING — first move on round 1, then switch every round.
    // ⚠ A FUNCTION OF THE ROUND INDEX ALONE. It never reads either history's CONTENTS,
    // only the student history's LENGTH, which is the round counter. A student cannot
    // influence it by any sequence of moves; `pdStrategy.test.ts` proves that by
    // running it against two different histories of equal length.
    case 'alternate':
      return round % 2 === 1 ? 'C' : 'D'

    // RANDOM — the first or the second move with equal probability, independently each
    // round. Nothing the student does changes it.
    //
    // ⚠⚠ THE DRAW IS WRITTEN WHEN DRAWN AND NEVER RECOMPUTED. This function produces a
    // move for the round being played; `submitRound` stores it in the round record and
    // every later reader — the history table, the reports — takes the STORED value. Unseeded, a recompute would return a different
    // move and silently rewrite a student's history; the seeded path would agree by
    // luck of construction, which is exactly how such a bug survives a test suite.
    case 'random': {
      if (ctx === undefined) {
        throw new Error('botMove(random) needs a BotContext — pass { seed, participantId }.')
      }
      // ⚠ THE ROUND IS IN THE HASH INPUT. Without it every round of one student's game
      // draws the same move, which is a constant strategy wearing a coin's name.
      const bit = ctx.seed === null
        ? (Math.random() < 0.5 ? 0 : 1)
        : hash32(`${ctx.seed}:bot:${ctx.participantId}:${round}`) % 2
      return bit === 0 ? 'C' : 'D'
    }
  }
}
