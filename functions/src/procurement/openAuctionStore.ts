import {
  Timestamp, type DocumentReference, type Firestore, type Transaction,
} from 'firebase-admin/firestore'
import { makeRng } from './auction/rng'
import { drawCosts } from './auction/costs'
import {
  openAuction, type OpenBot, type OpenSettings, type OpenState, type OpenEvent,
} from './auction/openAuction'
import { PLAYER_ID, rivalId, drawPlayerCost } from './round'
import { openCostFor } from './openRound'
import { toClientAuction, type ClientAuction } from './openView'
import type { ProcurementConfig } from './config'
import type { OpenEventRecord } from './rounds'

// ═══════════════════════════════════════════════════════════════════════════════
// OPEN FORMAT — how the auction is STORED, and how the pure machine is re-entered from
// storage. The bridge between `auction/openAuction.ts` (pure) and Firestore.
//
// ⚠⚠ TWO DOCUMENTS, TWO AUDIENCES, AND THE SPLIT IS THE LEAK DEFENCE:
//
//   participants/{pid}.open_auction   the STATE — standing, holder, stopped ids,
//                                     history, sequence, decisions, nextBotAtMs
//   truth/bots_{pid}.r{n}             the BOT COSTS for round n
//
// **Bot costs must exist from round open, which the sealed format never required.** In
// the sealed format rival costs are drawn at RESOLUTION, inside the transaction that
// accepts the bid, and so simply do not exist before it (Part 1 §4). The open format
// cannot do that: every bot decision, from the very first, is a function of its cost. §4
// anticipates exactly this — "if drawn earlier for any reason, they live in the
// rules-denied `truth` subcollection" — and that is where they go.
//
// `match /truth/{doc}` denies read AND write to every client unconditionally, with no
// exception for the instructor (firestore.rules). The doc id is `bots_{pid}` rather than
// the bare participant id so it cannot collide with `truth/main`, which holds the seed.
//
// ⚠ THE PARTICIPANT DOC IS ALSO RULES-DENIED, so `stopped` — which is derived from costs
// and therefore leaks something about them — is not client-reachable either. The payload
// a student receives is built by `openView.ts`, field by field, and carries neither.
//
// ⚠ THE STATE MACHINE IS RE-ENTERED FROM STORAGE ON EVERY CALL. That is the whole point
// of commit-per-step (§4.6) and it is why `decisions` is durable: the ordering RNG is
// keyed by it, so a stream that lived only in memory would restart every time and every
// decision in a round would draw the same value. See `OpenSettings.rngAt`.
// ═══════════════════════════════════════════════════════════════════════════════

/** The rules-denied doc holding one student's bot costs. ⚠ Never `main` — that is the
 *  seed's doc, and a participant id of "main" would otherwise overwrite it. */
export const botCostsDocId = (participantId: string) => `bots_${participantId}`

/** One round's field within that doc. Per-round, so round t+1's costs can be drawn by
 *  the transaction that resolves round t without disturbing anything already written. */
const botCostsField = (round: number) => `r${round}`

// ── the stored state ───────────────────────────────────────────────────────────

/** `open_auction`, as stored. snake_case, matching the rest of the participant doc. */
interface StoredAuction {
  round: number
  status: OpenState['status']
  standing: number
  holder: string | null
  stopped: string[]
  player_out: boolean
  history: OpenEventRecord[]
  sequence: number
  decisions: number
  next_bot_at_ms: number | null
  winner_id: string | null
  price: number | null
}

const toRecord = (e: OpenEvent): OpenEventRecord =>
  e.kind === 'dropOut'
    ? { kind: 'dropOut', bidder_id: e.bidderId, is_player: true }
    : { kind: 'bid', bidder_id: e.bidderId, amount: e.amount, is_player: e.isPlayer }

const fromRecord = (e: OpenEventRecord): OpenEvent =>
  e.kind === 'dropOut'
    ? { kind: 'dropOut', bidderId: e.bidder_id }
    : { kind: 'bid', bidderId: e.bidder_id, amount: e.amount ?? 0, isPlayer: e.is_player }

/** The state, written for `round`. ⚠ The round number travels WITH it — a state without
 *  one is a state that could be applied to the wrong round. */
export function serializeAuction(round: number, state: OpenState): { open_auction: StoredAuction } {
  return {
    open_auction: {
      round,
      status: state.status,
      standing: state.standing,
      holder: state.holder,
      stopped: state.stopped,
      player_out: state.playerOut,
      history: state.history.map(toRecord),
      sequence: state.sequence,
      decisions: state.decisions,
      next_bot_at_ms: state.nextBotAtMs,
      winner_id: state.winnerId,
      price: state.price,
    },
  }
}

/**
 * Defensive read. Anything malformed — or belonging to a DIFFERENT round — reads as
 * absent, and the caller opens the round afresh rather than acting on half a record.
 *
 * ⚠ THE ROUND CHECK IS NOT PARANOIA. `open_auction` is a single map, overwritten each
 * round; a stale one from round 3 applied in round 4 would resolve round 4 against round
 * 3's standing price. Same discipline as `parseOpenRound`.
 */
export function parseAuction(raw: unknown, round: number): OpenState | null {
  if (typeof raw !== 'object' || raw === null) return null
  const a = raw as Record<string, unknown>
  if (a.round !== round) return null

  const int = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
  if (!int(a.standing) || !int(a.sequence) || !int(a.decisions)) return null
  if (a.status !== 'bot_turn' && a.status !== 'waiting' && a.status !== 'resolved') return null

  const history: OpenEvent[] = []
  if (!Array.isArray(a.history)) return null
  for (const el of a.history) {
    if (typeof el !== 'object' || el === null) return null
    const e = el as Record<string, unknown>
    if (e.kind !== 'bid' && e.kind !== 'dropOut') return null
    if (typeof e.bidder_id !== 'string') return null
    if (e.kind === 'bid' && !int(e.amount)) return null
    history.push(fromRecord({
      kind: e.kind,
      bidder_id: e.bidder_id,
      amount: int(e.amount) ? e.amount : undefined,
      is_player: e.is_player === true,
    }))
  }

  return {
    status: a.status,
    standing: a.standing,
    holder: typeof a.holder === 'string' ? a.holder : null,
    stopped: Array.isArray(a.stopped) ? a.stopped.filter((v): v is string => typeof v === 'string') : [],
    playerOut: a.player_out === true,
    history,
    sequence: a.sequence,
    decisions: a.decisions,
    nextBotAtMs: int(a.next_bot_at_ms) ? a.next_bot_at_ms : null,
    winnerId: typeof a.winner_id === 'string' ? a.winner_id : null,
    price: int(a.price) ? a.price : null,
  }
}

// ── the bot costs ──────────────────────────────────────────────────────────────

/** Defensive read of one round's stored bot costs. ⚠ ALL-OR-NOTHING, and the LENGTH must
 *  match `rivalCount`: a short vector would silently run the auction with fewer bidders
 *  than the instance says it has, and the "N of M" counter would be a lie. */
export function parseBotCosts(raw: unknown, rivalCount: number): number[] | null {
  if (!Array.isArray(raw) || raw.length !== rivalCount) return null
  if (!raw.every(v => typeof v === 'number' && Number.isFinite(v))) return null
  return raw as number[]
}

/**
 * Draw one round's bot costs.
 *
 * ⚠ THE SAME STREAM KEY AS THE SEALED FORMAT'S RIVAL DRAW (`round.ts`), deliberately: a
 * seeded instance then produces the SAME rival costs under either format, which is what
 * makes a seeded side-by-side comparison of the two mechanisms honest.
 */
export function drawBotCosts(
  seed: string | null,
  participantId: string,
  round: number,
  config: ProcurementConfig,
): number[] {
  return drawCosts(
    makeRng(seed, `${participantId}:rivals:${round}`),
    config.rivalCostDist,
    config.rivalCount,
  )
}

/** The patch that records a round's bot costs on the rules-denied truth doc. */
export const botCostsPatch = (round: number, costs: number[]) => ({
  [botCostsField(round)]: costs,
})

/** Read a round's costs out of a truth doc's data, or null if it has none yet. */
export const storedBotCosts = (
  truthData: Record<string, unknown> | undefined,
  round: number,
  rivalCount: number,
): number[] | null => parseBotCosts(truthData?.[botCostsField(round)], rivalCount)

// ── settings ───────────────────────────────────────────────────────────────────

/**
 * The pure machine's settings for one student's round.
 *
 * ⚠⚠ `rngAt` IS KEYED BY THE DECISION INDEX. The machine is re-entered from storage on
 * every callable invocation, so a stateful stream would restart at position 0 each time
 * and every decision in a round would draw the same value — under a seed the same bot
 * would win every ordering race. `state.decisions` is durable precisely so this key can
 * be. Pinned by a negative control in procurementOpenAuction.test.ts.
 *
 * ⚠ `jitterAt` DRAWS FROM `Math.random`, OUTSIDE THE SEEDED STREAM, AND THAT IS
 * DELIBERATE. It is UX only, never strategic (open §3): it moves a wall-clock timestamp
 * and nothing else. Putting it on the seeded stream would consume positions that a bot
 * decision then would not get, coupling the pacing to the mechanism — the exact thing
 * §3 says must not happen. Timestamps are already not reproducible under a seed
 * (`Timestamp.now`), so nothing is lost.
 */
export function openSettingsFor(
  config: ProcurementConfig,
  botCosts: readonly number[],
  seed: string | null,
  participantId: string,
  round: number,
): OpenSettings {
  const bots: OpenBot[] = botCosts.map((cost, i) => ({ bidderId: rivalId(i), cost }))
  return {
    reserve: config.reserve,
    schedule: config.decrementSchedule,
    delaySchedule: config.delaySchedule,
    playerId: PLAYER_ID,
    bots,
    rngAt: (decision: number) =>
      makeRng(seed, `${participantId}:openOrder:${round}:${decision}`),
    jitterAt: () => {
      const j = config.delayJitterMs
      return j <= 0 ? 0 : Math.round((Math.random() * 2 - 1) * j)
    },
  }
}

// ── opening a round's auction ──────────────────────────────────────────────────

/**
 * ⚠ EVERYTHING A ROUND NEEDS IS RECORDED, NOT DERIVED — the whole of BUILD_NOTES §6e in
 * one sentence, applied to a second kind of draw. CP3a computed the player's cost on
 * demand and called it "once-only by construction"; that is true only when a seed is set,
 * and `makeRng(null, key)` returns `Math.random` and IGNORES the key, so unseeded — the
 * normal classroom case — every read redrew it. The open format would have had the same
 * disease in a worse place: an auction whose BOT costs were re-derived per call would
 * change its mind about who is willing between one commit and the next, mid-cascade.
 *
 * Hence: the player's cost in `open_round`, the bot costs in `truth/bots_{pid}`, and the
 * auction state in `open_auction` — three recorded facts, no recipes.
 */

/**
 * Read-or-draw one round's bot costs inside a transaction.
 *
 * ⚠ TRANSACTIONAL FOR THE SAME REASON `ensureOpenRound` IS: two tabs, a double click or a
 * retry would otherwise each draw and each write, and the auction would be running
 * against whichever landed last while the other was briefly authoritative.
 */
export function resolveBotCosts(
  tx: Transaction,
  truthRef: DocumentReference,
  truthData: Record<string, unknown> | undefined,
  round: number,
  seed: string | null,
  participantId: string,
  config: ProcurementConfig,
): number[] {
  const stored = storedBotCosts(truthData, round, config.rivalCount)
  if (stored !== null) return stored
  const drawn = drawBotCosts(seed, participantId, round, config)
  tx.set(truthRef, botCostsPatch(round, drawn), { merge: true })
  return drawn
}

/** A concrete Timestamp for the round record. Kept here so the open path and the sealed
 *  path stamp rounds the same way — a sentinel is illegal inside an array element. */
export const playedAtNow = () => Timestamp.now()

/**
 * Settings for the PERFECT-PLAY BENCHMARK replay (§7, CP4b Item 1) — the same bots at the
 * same costs, on a SEPARATELY KEYED ordering stream.
 *
 * ⚠ THE SEPARATE KEY IS THE POINT, and it is the sealed format's `counterfactual`
 * convention applied here (round.ts). If the replay drew from the play stream, the real
 * auction's bot ordering would depend on whether a benchmark had been computed — the exact
 * data-dependent coupling the positional-draw convention exists to prevent (rng.ts).
 *
 * ⚠ THE JITTER IS ZERO. It is a wall-clock nicety for a live screen; a replay has no
 * screen, and a `Math.random` call here would make the benchmark itself non-reproducible
 * for no reason at all.
 */
export function benchmarkSettingsFor(
  config: ProcurementConfig,
  botCosts: readonly number[],
  seed: string | null,
  participantId: string,
  round: number,
): OpenSettings {
  return {
    ...openSettingsFor(config, botCosts, seed, participantId, round),
    rngAt: (decision: number) =>
      makeRng(seed, `${participantId}:benchmark:${round}:${decision}`),
    jitterAt: () => 0,
  }
}

// ── opening a round, in one transaction ────────────────────────────────────────

export interface OpenedRound {
  cost: number
  botCosts: number[]
  state: OpenState
  settings: OpenSettings
  /** Did this call write anything? The caller uses it to decide whether the state it is
   *  about to persist is new. */
  wrote: boolean
}

/**
 * Read-or-open everything round `round` needs, inside the caller's transaction.
 *
 * ⚠⚠ THE AUCTION STATE IS OPENED LAZILY, WHEN THE STUDENT ARRIVES — NOT by the transaction
 * that resolved the previous round. The COSTS are drawn there (they are facts, and drawing
 * them a commit early is what makes the round advance atomic), but the auction's
 * `nextBotAtMs` is a WALL-CLOCK fact that means nothing until somebody is looking at it.
 * Opened a round early, the first bot bid would be overdue by however long the student
 * spent on the previous screen and would fire the instant they arrived — the opposite of
 * §3's pacing, and it would read as a bug.
 *
 * ⚠ ALL THREE OPENINGS SHARE ONE TRANSACTION. A reload between them would otherwise leave
 * a round with a cost and no auction, or an auction whose bots had not been drawn.
 */
export function ensureRoundOpen(
  tx: Transaction,
  participantRef: DocumentReference,
  truthRef: DocumentReference,
  pData: Record<string, unknown>,
  truthData: Record<string, unknown> | undefined,
  round: number,
  seed: string | null,
  participantId: string,
  config: ProcurementConfig,
  nowMs: number,
): OpenedRound {
  let wrote = false

  let cost = openCostFor(pData, round)
  if (cost === null) {
    cost = drawPlayerCost(seed, participantId, round, config)
    tx.set(participantRef, { open_round: { round, cost, opened_at: playedAtNow() } }, { merge: true })
    wrote = true
  }

  const botCosts = resolveBotCosts(tx, truthRef, truthData, round, seed, participantId, config)
  const settings = openSettingsFor(config, botCosts, seed, participantId, round)

  let state = parseAuction(pData.open_auction, round)
  if (state === null) {
    state = openAuction(settings, nowMs)
    tx.set(participantRef, serializeAuction(round, state), { merge: true })
    wrote = true
  }

  return { cost, botCosts, state, settings, wrote }
}

/**
 * `getState`'s entry point: open the round if it is not open, and return the student's own
 * cost plus the live auction as they may see it.
 *
 * ⚠ A READ PATH THAT WRITES, like `ensureOpenRound` before it and for the same reason:
 * the round has to be opened before the student can be shown anything about it, and there
 * is no other moment at which that can happen.
 */
export async function ensureOpenAuction(
  db: Firestore,
  participantRef: DocumentReference,
  instanceRef: DocumentReference,
  round: number,
  seed: string | null,
  participantId: string,
  config: ProcurementConfig,
): Promise<{ cost: number; auction: ClientAuction }> {
  const truthRef = instanceRef.collection('truth').doc(botCostsDocId(participantId))
  const nowMs = Date.now()
  return db.runTransaction(async (tx) => {
    const [pSnap, tSnap] = await Promise.all([tx.get(participantRef), tx.get(truthRef)])
    const opened = ensureRoundOpen(
      tx, participantRef, truthRef, pSnap.data() ?? {}, tSnap.data(),
      round, seed, participantId, config, nowMs)
    return {
      cost: opened.cost,
      auction: toClientAuction(round, opened.state, opened.settings),
    }
  })
}
