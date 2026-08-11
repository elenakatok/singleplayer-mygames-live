import {
  addedKcStage, setProcurementBuiltInIds,
  type KcOverrideMap, type ProcurementAddedKcQuestion, type ProcurementConfig,
  type ProcurementFormat, type ProcurementKcStage,
} from './config'
import { calcKCScore } from '@mygames/game-server'
import { applyKcOrder } from '../shared/kcSurface'
import { hash32 } from './auction/rng'

// ═══════════════════════════════════════════════════════════════════════════════
// Procurement Auction — THE QUESTION POOL. Source: `Procurement_Auction_KC_Questions
// _v3_FINAL.md`, transcribed verbatim.
//
// ⚠⚠ ONE MERGED POOL, ALL 17 QUESTIONS IN EVERY INSTANCE, VISIBILITY BY FORMAT
// (KC doc, Elena 08-02). A sealed instance defaults to S visible / O hidden; an open
// instance the reverse; and THE INSTRUCTOR MAY UNHIDE ANYTHING IN EITHER. That is why
// the open questions are here now rather than at CP4 — a sealed instance can be
// configured to ask them today.
//
// This is only safe because of the v3 rewrite: every question is a SELF-CONTAINED
// HYPOTHETICAL carrying its own numbers, so a sealed question shown in an open instance
// is still perfectly answerable. Under v2's phrasing it would have been incoherent — the
// merged pool and the rewrite depend on each other. ⚠ Author any new question the same
// way, or the pool stops being mergeable.
//
// ⚠⚠ THE GRADED DENOMINATOR IS THE COUNT OF VISIBLE GRADED QUESTIONS, COMPUTED AT
// SCORING TIME. Never a stored constant. Sealed default → 7. Open default → 8. Unhide
// three sealed questions in an open instance → 11. `gradedFor()` is the single
// derivation and both the render path and the grader call it.
//
// ⚠ OPTIONS SHUFFLE PER STUDENT, deterministically from (participantId, question id), so
// a reload is stable and two students see different orders. THE STORED ANSWER IS A
// STABLE OPTION ID, never a position — so shuffling cannot affect grading, and an
// explanation never says "option B".
//
// ⚠ NO GATE QUESTION and NO `role_target`. The single-player family has no roles — every
// student is a supplier — and does not use the shared `KnowledgeCheck` component. The
// numbering starts at the first graded question, unlike the negotiation games.
//
// ⚠ A NOTE ON A STALE LINE IN THE SOURCE. The KC doc's grading-rules section still says
// "Two separate question sets. The games deploy as two `game_id`s" — that is v2-era text,
// contradicted by the merged-pool section at the top of the same document (Elena, 08-02)
// and by spec §14.1. One game, one pool, one set of ids. Flagged, not silently resolved.
// ═══════════════════════════════════════════════════════════════════════════════

export type QuestionKind = 'mc' | 'text'

/** Where in the flow a question is asked. */
export type QuestionStage =
  /** The knowledge check, before play. */
  | 'kc'
  /** The prep paragraph, before play — ungraded, Tier-2 reported. */
  | 'prep'
  /** The closing paragraph, after the final results — ungraded, Tier-2 reported. */
  | 'debrief'

export interface KcOption {
  /** STABLE id. Grading compares against this, never against a position. */
  value: string
  label: string
}

export interface KcQuestion {
  id: string
  formats: readonly ProcurementFormat[]
  stage: QuestionStage
  kind: QuestionKind
  prompt: string
  options: KcOption[]
  /** null ⇒ ungraded: absent from both numerator and denominator. */
  correct_value: string | null
  /** ⚠ NEVER references an answer by letter or position — options shuffle. Names the
   *  concept or the value instead. */
  explanation: string
  /** Placeholder for a text question. */
  placeholder?: string
}

const BOTH: readonly ProcurementFormat[] = ['sealed_first_price', 'open_descending']
const SEALED: readonly ProcurementFormat[] = ['sealed_first_price']
const OPEN: readonly ProcurementFormat[] = ['open_descending']

/** Terse constructor — `a` is always the correct option AS AUTHORED. Display order is
 *  shuffled per student, so "a" is an identity, not a position. */
const mc = (
  id: string,
  formats: readonly ProcurementFormat[],
  prompt: string,
  labels: [string, string, string, string],
  explanation: string,
): KcQuestion => ({
  id, formats, stage: 'kc', kind: 'mc', prompt,
  options: labels.map((label, i) => ({ value: 'abcd'[i], label })),
  correct_value: 'a',
  explanation,
})

const text = (
  id: string,
  formats: readonly ProcurementFormat[],
  stage: QuestionStage,
  prompt: string,
): KcQuestion => ({
  id, formats, stage, kind: 'text', prompt, options: [], correct_value: null,
  explanation: '',
  placeholder: 'A few sentences is plenty.',
})

// ── GAME 1 — sealed-bid first-price ───────────────────────────────────────────

export const KC_POOL: readonly KcQuestion[] = [
  mc('S1', BOTH,
    'In a reverse (procurement) auction, a buyer awards one contract to one supplier. Which bid wins?',
    [
      'The lowest bid',
      'The highest bid',
      "The bid closest to the buyer's reserve price",
      'A bid chosen at random from all bids at or below the reserve',
    ],
    'This is a reverse auction — the buyer is purchasing, not selling, so the best bid from '
    + "the buyer's point of view is the cheapest one. The supplier who submits the lowest bid "
    + 'wins the contract.'),

  mc('S2', SEALED,
    'Suppose five suppliers submit sealed bids in a first-price reverse auction: 41, 47, 52, '
    + '66, and 71. What is the winning supplier paid?',
    [
      '41 — the amount of the winning bid',
      '47 — the amount of the next-lowest bid',
      '55.4 — the average of all five bids',
      "110 — the buyer's reserve price",
    ],
    'This is a first-price auction, so the winner is paid exactly what they bid. The supplier '
    + 'who bid 41 wins and is paid 41. The other bids affect only who wins, never the price.'),

  mc('S3', BOTH,
    'Suppose your cost is 35. You bid 58, and another supplier wins the contract. What is your profit?',
    [
      '0',
      '23 — the difference between your bid and your cost',
      '−35 — you incur your cost whether or not you win',
      '58 — the amount you bid',
    ],
    'A supplier who does not win the contract earns nothing and incurs nothing. Your cost is '
    + 'only incurred if you actually win and have to supply the widget, so a losing bid leaves '
    + 'you at zero — never negative.'),

  mc('S4', SEALED,
    'Suppose a buyer sets a reserve price of 110 ECU — the price it currently pays its '
    + 'incumbent supplier. What does a reserve price mean for your bid?',
    [
      'Any bid above 110 will not be accepted',
      'Any bid below 110 will not be accepted',
      'The winner is paid 110 regardless of what they bid',
      'The reserve is the minimum amount the winner can be paid',
    ],
    'A reserve price is the most the buyer is willing to pay. A buyer with the option of '
    + 'staying with an incumbent at 110 is worse off paying more than that, so bids above the '
    + 'reserve are not accepted. A supplier whose own cost exceeds the reserve has no bid worth '
    + 'making.'),

  mc('S5', BOTH,
    'Suppose your cost is 40 and you bid exactly 40. What happens?',
    [
      'You maximize your chance of winning, but earn zero profit if you win',
      'You maximize your chance of winning and earn the largest possible profit',
      'Your bid is rejected, because bids must include a markup',
      'You earn a profit equal to the difference between the reserve and your cost',
    ],
    'Bidding your cost gives you the best possible chance of being the lowest bidder, but it '
    + 'leaves you nothing: profit is your bid minus your cost, which is zero. Winning is only '
    + 'worth something if you bid above your cost, which is why every bid involves a trade-off '
    + 'between the chance of winning and the profit if you do.'),

  mc('S6', SEALED,
    'Suppose your cost is 30 in both of two sealed-bid auctions. In one you face 4 '
    + 'competitors; in the other you face 10, all drawing costs from the same range. Compared '
    + 'with the 4-competitor auction, your bid in the 10-competitor auction should be:',
    [
      'Lower — more competitors means a smaller markup',
      'Higher — more competitors means a larger markup',
      'The same — the number of competitors does not affect the optimal bid',
      'The same — only your own cost affects the optimal bid',
    ],
    'With more competitors, it is more likely that someone else has drawn a low cost, so a '
    + 'given markup is less likely to win. Bidding closer to your cost buys back some of that '
    + 'lost probability. As the number of competitors rises, the markup shrinks.'),

  mc('S7', SEALED,
    "Suppose suppliers' costs run from 10 to 110 ECU. Your cost advantage is how far your own "
    + 'cost sits below the top of that range. Compare an auction where your cost is 20 with one '
    + 'where it is 90, against the same number of competitors. In which should your markup be '
    + 'larger, and why?',
    [
      'The auction where your cost is 20 — a larger cost advantage supports a larger markup',
      'The auction where your cost is 90 — a high cost has to be recovered with a larger markup',
      'Neither — the markup depends only on the number of competitors',
      'Neither — the markup is the same fraction of your cost in both cases',
    ],
    'With a cost of 20 you are very likely to be the cheapest supplier in the room, so you can '
    + 'add a substantial markup and still expect to win. With a cost of 90 you are probably not '
    + 'the cheapest, and almost any markup prices you out — so the markup has to be thin. A '
    + 'bigger cost advantage earns a bigger markup.'),

  text('S8', SEALED, 'prep',
    'Suppose your cost in the first round is 30 and you face 4 competitors whose costs are '
    + 'somewhere between 10 and 110. What would you bid, and why? There is no right answer here '
    + '— write down your thinking before you play so you can compare it with what happens.'),

  text('S9', SEALED, 'debrief',
    'Looking back over the eight rounds, did your bids get closer to your cost, further from '
    + 'it, or stay about the same? What made you adjust?'),

  // ── GAME 2 — open-bid descending ────────────────────────────────────────────

  mc('O1', OPEN,
    'In an open-bid reverse auction, bidders can see the current auction price and the bidding '
    + 'history as the auction runs. Over the course of one such auction, the auction price:',
    [
      'Falls, as suppliers undercut one another to take the low bid',
      'Rises, as suppliers outbid one another for the contract',
      'Stays fixed at the reserve until the auction closes',
      'Moves up or down depending on how many suppliers are still active',
    ],
    'The buyer wants the cheapest contract, so to take the lead you have to bid below the '
    + 'current low bid, not above it. Every successful bid pushes the auction price down, and it '
    + 'never moves back up.'),

  mc('O2', OPEN,
    'Suppose bidding in an open reverse auction stops with the auction price at 44, and that '
    + 'low bid is yours. What are you paid?',
    [
      '44 — the amount of your own final bid',
      'The amount of the next-lowest bid still standing when bidding stopped',
      "110 — the buyer's reserve price",
      'Your cost, plus the minimum decrement',
    ],
    'The supplier holding the low bid when bidding stops wins and is paid the amount of that '
    + 'bid. Your last bid is the price — which is why there is no reason to undercut yourself, '
    + 'and no reason to keep bidding once the price is close to your cost.'),

  mc('O3', OPEN,
    'Suppose your cost is 35 and another supplier holds the low bid when the auction ends. '
    + 'What is your profit?',
    [
      '0',
      '23 — the difference between your last bid and your cost',
      '−35 — you incur your cost whether or not you win',
      'The difference between your last bid and the winning bid',
    ],
    'A supplier who does not win the contract earns nothing and incurs nothing. Your cost is '
    + 'only incurred if you actually win and have to supply the widget, so losing leaves you at '
    + 'zero — never negative.'),

  mc('O4', OPEN,
    'Suppose your cost is 46. The auction price has fallen to 47 and another supplier holds '
    + 'the low bid. What should you do?',
    [
      'Stop bidding — undercutting now would require bidding at or below your cost',
      'Bid 45, since winning at a small loss is better than not winning at all',
      'Bid 46, since matching your cost guarantees you the contract',
      'Bid 10, to end the auction immediately before anyone else can respond',
    ],
    'Anything you bid below 46 wins you a contract you lose money on, and 46 itself earns you '
    + 'nothing. The point where the auction price reaches your cost is exactly where you should '
    + 'stop — there is nothing left below it worth having.'),

  mc('O5', OPEN,
    'Suppose an open reverse auction has a minimum decrement that depends on the current price '
    + '— larger when the price is high, smaller as it falls. The auction price is 62 and the '
    + 'minimum decrement at that level is 5. Which of these bids is legal?',
    [
      '51 — you may undercut by more than the minimum, but never by less',
      '60 — any bid below the current price is legal',
      '62 — matching the current low bid ties for the lead',
      '63 — bids must be within one decrement of the current price in either direction',
    ],
    'The decrement is a floor on how much you must move, not a fixed step. At a price of 62 '
    + 'with a minimum of 5, any bid of 57 or lower is legal — so undercutting by 11 down to 51 '
    + 'is fine. Bidding 60 does not move the price far enough, and nothing at or above the '
    + 'current price is a bid at all.'),

  mc('O6', OPEN,
    'While an open reverse auction is running, which of the following is shown to you?',
    [
      'Whether you currently hold the low bid, and the history of bids placed',
      'The costs of the other suppliers',
      'The lowest bid each supplier is willing to make before they stop',
      'Nothing until the auction closes',
    ],
    'Bids are public as they are placed, and your own status — whether or not you are currently '
    + "winning — is shown throughout. What stays private is every supplier's cost, and therefore "
    + 'how much room each of them still has. That is what you are inferring from their behavior '
    + 'as the price falls.'),

  mc('O7', OPEN,
    'Suppose you press the Drop Out button during an open reverse auction. What happens?',
    [
      'You are out for the rest of that auction and cannot bid again in it, and the remaining '
      + 'suppliers finish without you',
      'You are out for the rest of the game and score zero in every remaining auction',
      'You can re-enter later in the same auction if the price is still above your cost',
      'The auction ends immediately and no contract is awarded',
    ],
    'Dropping out is a deliberate decision that applies to the auction you are in, and it is '
    + 'final for that auction — there is no re-entry, and the price only falls, so there would be '
    + 'nothing to re-enter for. The other suppliers carry on and one of them wins the contract. '
    + 'Each new auction starts fresh, with new costs drawn for everyone.'),

  mc('O8', OPEN,
    'Suppose two open reverse auctions run with the same reserve and the same cost range, one '
    + 'with 4 competing suppliers and one with 10. In which would you expect the final price to '
    + 'be lower, on average?',
    [
      'The auction with 10 competitors — more suppliers makes a very low cost more likely',
      'The auction with 4 competitors — fewer suppliers means each must bid more aggressively',
      'The two are the same, because the reserve price is the same',
      'The two are the same, because each supplier stops at their own cost either way',
    ],
    'Every supplier stops at their own cost regardless of how many rivals there are, so no '
    + 'individual changes their behavior. But with more suppliers drawing costs, the chance that '
    + 'someone has drawn a very low one goes up — and the price is driven down by whoever can '
    + 'still afford to keep bidding. More competition means a lower price for the buyer.'),

  text('O9', OPEN, 'prep',
    'Before you start: how will you decide when to stop bidding in an auction? Write down the '
    + 'rule you plan to follow, so you can compare it against what you actually do.'),

  text('O10', OPEN, 'debrief',
    'You have now played both a sealed-bid auction and an open-bid auction under the same '
    + 'conditions. Which one felt easier to bid well in, and why? Did the two formats produce '
    + 'noticeably different prices?'),
]

/** Every id in the pool — the allow-list `loadProcurementConfig` filters `kcVisible`
 *  against, so a removed question cannot keep a stale entry alive in a stored config. */
export const KC_POOL_IDS: readonly string[] = KC_POOL.map(q => q.id)

// ⚠⚠ THE COLLISION GUARD'S AUTHORITY, HANDED TO config.ts AT MODULE LOAD. procurement's
// built-in ids are UNPREFIXED (`S1`…`S9`, `O1`…`O10`), so the `kc_` prefix rule the other
// four prefixed games use would protect nothing here — an added question could take `S3`
// and shadow a built-in in the grader's lookup. It needs the explicit id SET, as scorecard
// does. Injected rather than imported so config.ts stays free of the pool and the import
// cycle never forms, exactly as `knownKcIds` already is.
setProcurementBuiltInIds(KC_POOL_IDS)

/** The same set, for callers that want it without reaching through config.ts. */
export function procurementBuiltInIdsForFormat(): ReadonlySet<string> {
  return new Set(KC_POOL_IDS)
}

/**
 * The DEFAULT visible set for a format: its own questions, hidden the other's.
 *
 * ⚠ Used only when an instance has never been configured. Once the instructor saves a
 * `kcVisible` list, that list is authoritative — including an empty one, which is a
 * legitimate "ask nothing" choice and must not be re-defaulted.
 */
export function defaultVisibleFor(format: ProcurementFormat): string[] {
  return KC_POOL.filter(q => q.formats.includes(format)).map(q => q.id)
}

/** Every question this format COULD ask, visible or not — what Settings lists. */
export function poolForFormat(format: ProcurementFormat): KcQuestion[] {
  return KC_POOL.filter(q => q.formats.includes(format))
}

/**
 * The questions this instance actually asks at a given stage.
 *
 * ⚠ THE FORMAT FILTER COMES FIRST AND IS NOT OVERRIDABLE. A stored `kcVisible` carrying
 * an id tagged for the other format cannot resurrect it — an instructor who flips
 * `format` before any submission keeps their choices for the questions that still apply
 * and loses the ones that do not, which is correct and is why this is not a plain
 * `filter(includes)`.
 */
export function resolveQuestions(
  format: ProcurementFormat,
  kcVisible: readonly string[],
  stage: QuestionStage,
): KcQuestion[] {
  const on = new Set(kcVisible)
  return KC_POOL.filter(q => q.stage === stage && q.formats.includes(format) && on.has(q.id))
}

/** The graded, visible KC questions — kept for callers that only want the count. */
export function resolveKcQuestions(
  format: ProcurementFormat,
  kcVisible: readonly string[],
): KcQuestion[] {
  return resolveQuestions(format, kcVisible, 'kc')
}

/**
 * ⚠ THE DENOMINATOR. Visible AND graded. The single derivation — Settings' live count,
 * the student's progress display, the report header and the grader all call this, so the
 * number on the instructor's screen is by construction the number the score is out of.
 */
export function gradedFor(
  format: ProcurementFormat,
  kcVisible: readonly string[],
): KcQuestion[] {
  return resolveKcQuestions(format, kcVisible).filter(q => q.correct_value !== null)
}

/** The shape the grader consumes — id + key only, never the prompt or the explanation. */
export function scoringSet(
  format: ProcurementFormat,
  kcVisible: readonly string[],
): { field: string; correct_value: string }[] {
  return gradedFor(format, kcVisible).map(q => ({ field: q.id, correct_value: q.correct_value! }))
}

// ══════════════════════════════════════════════════════════════════════════════
// THE CONVERGENCE SURFACE (spec §5) — hide, order, overrides, added questions.
//
// ⚠⚠ THE FUNCTIONS ABOVE TAKE `(format, kcVisible)` AND THESE TAKE THE WHOLE CONFIG.
// That is the migration boundary (D18): `kcVisible` is read only by `migrateKcHidden`, and
// everything from here down works from `config.kcHidden`. The old signatures survive
// because the report and the open-format views still call them with a DERIVED visible list;
// they are not a second source of truth.
// ══════════════════════════════════════════════════════════════════════════════

/**
 * An instructor's rewrite of a built-in question, applied.
 *
 * ⚠⚠ TEXT ONLY — the prompt, and option LABELS looked up BY VALUE. There is no path from
 * this function to `correct_value`, so an override provably cannot move a score; the grader
 * compares values, which an override never touches.
 *
 * ⚠ The EXPLANATION is deliberately NOT overridable: it is the teaching text that justifies
 * the authored answer, and a rewritten stem with an unrewritten explanation is at least
 * visibly inconsistent rather than silently wrong.
 */
export function applyKcOverride(q: KcQuestion, overrides: KcOverrideMap): KcQuestion {
  const o = overrides[q.id]
  if (!o) return q
  return {
    ...q,
    prompt: o.prompt ?? q.prompt,
    options: o.options
      ? q.options.map(opt => ({ ...opt, label: o.options![opt.value] ?? opt.label }))
      : q.options,
  }
}

/** Has an instructor rewritten this question? Drives the "edited" badge, nothing else. */
export function isKcOverridden(id: string, overrides: KcOverrideMap): boolean {
  return overrides[id] !== undefined
}

/**
 * This instance's BUILT-IN questions at one pool stage: format-filtered, hidden ones
 * removed, overridden, in the instructor's order.
 *
 * ⚠⚠ THE `kcEnabled` GATE LIVES HERE, NOT ONLY IN THE CALLERS. Before this pass the ternary
 * sat in `getQuestions`, `report` and `submitKcAnswer` separately — three copies of one
 * rule, and the resolver itself ignored it. That is the shape scorecard and forecast both
 * shipped a real bug in. It gates the GRADED `kc` stage only (D12): `prep` and `debrief` are
 * ungraded free text and resolve unconditionally, which §9 records as intended behaviour.
 *
 * ⚠ THE FORMAT FILTER IS NOT OVERRIDABLE and comes first, as it always has.
 */
export function resolveBuiltIns(config: ProcurementConfig, stage: QuestionStage): KcQuestion[] {
  return applyKcOrder(resolveBuiltInsUnordered(config, stage), q => q.id, config.kcOrder)
}

/** The same set WITHOUT the ordering pass — see `procurementPreStage` for why. */
export function resolveBuiltInsUnordered(
  config: ProcurementConfig,
  stage: QuestionStage,
): KcQuestion[] {
  if (stage === 'kc' && !config.kcEnabled) return []
  return KC_POOL
    .filter(q => q.stage === stage
      && q.formats.includes(config.format)
      && config.kcHidden[q.id] !== true)
    .map(q => applyKcOverride(q, config.kcOverrides))
}

/** An added question that carries a usable key, and therefore a mark. */
export function isGradedAdded(q: ProcurementAddedKcQuestion): boolean {
  return q.type === 'mc' && typeof q.correct_value === 'string'
}

/**
 * This instance's ADDED questions: hidden ones removed, in order.
 *
 * ⚠⚠ D12 — `kcEnabled` GATES GRADED QUESTIONS ONLY. A graded addition disappears with the
 * toggle; an UNGRADED one does not, and is governed by its own visibility — the same rule
 * procurement's two free-text built-ins already followed.
 *
 * ⚠ Omitted `stage` ⇒ EVERY stage. The grader calls it that way deliberately: gradedness is
 * stage-independent (D3).
 */
export function resolveAddedKcQuestions(
  config: ProcurementConfig,
  stage?: ProcurementKcStage,
): ProcurementAddedKcQuestion[] {
  return applyKcOrder(resolveAddedKcQuestionsUnordered(config, stage), q => q.id, config.kcOrder)
}

/** The same, unordered — see `procurementPreStage` for why the stages need it. */
export function resolveAddedKcQuestionsUnordered(
  config: ProcurementConfig,
  stage?: ProcurementKcStage,
): ProcurementAddedKcQuestion[] {
  const visible = config.addedKcQuestions.filter(q => config.kcHidden[q.id] !== true)
  const gated = config.kcEnabled ? visible : visible.filter(q => !isGradedAdded(q))
  return stage === undefined ? gated : gated.filter(q => addedKcStage(q) === stage)
}

/**
 * ⚠⚠ THE GRADER'S SCORING SET — the whole of it, in one place.
 *
 * `procurementSubmitKcAnswer` calls exactly this and builds no list of its own. Visible AND
 * graded: a hidden question is absent (never asked), and an ungraded one is absent from
 * numerator AND denominator.
 *
 * ⚠ THE BUILT-IN HALF IS THE `kc` STAGE ONLY, because `prep` and `debrief` built-ins carry
 * no `correct_value` — the `.filter` is what makes that true rather than the stage tag, per
 * D3, and an added mc placed in `debrief` IS graded from there.
 */
export function procurementScoringSet(
  config: ProcurementConfig,
): { field: string; correct_value: string }[] {
  return [
    ...resolveBuiltIns(config, 'kc')
      .filter(q => q.correct_value !== null)
      .map(q => ({ field: q.id, correct_value: q.correct_value! })),
    ...resolveAddedKcQuestions(config)
      .filter(isGradedAdded)
      .map(q => ({ field: q.id, correct_value: q.correct_value! })),
  ]
}

/**
 * ⚠⚠ THE SCORE THIS ANSWER SET EARNS, or null if it does not earn one — the whole grading
 * DECISION, in a pure function the suite can reach.
 *
 * ⚠⚠ PROCUREMENT IS THE ONE GAME NOT ON `kcScoreOrNull`, AND THAT IS CORRECT (spec §9). Its
 * rule is stricter: with an EMPTY graded set it writes NEITHER a score NOR a completion
 * stamp, and consumers read the absent field as null. `kcScoreOrNull` writes null AND lets
 * the caller stamp `knowledge_check_completed_at`, handing a student a completed knowledge
 * check the first time they open the screen — which is the thing this guard exists to
 * prevent. Do not "align" it.
 *
 * ⚠ THE GUARD USED TO BE UNREACHABLE and a test pinned the invariant that made it so: every
 * `kc`-stage question carried a key. ADDED QUESTIONS END THAT — an instructor may now put an
 * ungraded free-text question in the `kc` stage, or hide every graded one. The guard is LIVE
 * now, and has its own coverage instead of an unreachability proof.
 */
export function procurementKcScoreFor(
  allAnswers: Record<string, string>,
  config: ProcurementConfig,
): number | null {
  const forScoring = procurementScoringSet(config)
  // ⚠ THE EMPTY-SET GUARD, and the ONLY difference from the rest of the family.
  if (forScoring.length === 0) return null
  if (!forScoring.every(q => allAnswers[q.field] != null)) return null
  // ⚠ THE ARITHMETIC IS THE SHARED `calcKCScore` AND IS NOT REIMPLEMENTED HERE. What is
  // local is the DECISION of when to write at all; the scoring rule must never fork.
  return calcKCScore(allAnswers, forScoring).score
}

/**
 * A deterministic per-student option order.
 *
 * ⚠ STABLE ON RELOAD and DIFFERENT BETWEEN STUDENTS, both required by the KC doc. Keyed
 * on (participantId, question id) so it survives any number of re-renders and any device.
 *
 * ⚠ AND IT CANNOT AFFECT GRADING, by construction: the stored answer is the option's
 * STABLE `value`, never its position, and the grader compares values. Shuffling the
 * display is therefore invisible to the score — which is also why no explanation may ever
 * say "option B".
 *
 * Fisher–Yates driven by successive hashes rather than one, so the order is not a
 * rotation of the authored one.
 */
export function shuffleOptions(options: readonly KcOption[], participantId: string, id: string): KcOption[] {
  const out = [...options]
  for (let i = out.length - 1; i > 0; i--) {
    const j = hash32(`${participantId}:${id}:${i}`) % (i + 1)
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

/**
 * The student-facing shape. ⚠ Built field by field — `correct_value` and `explanation`
 * are dropped, never spread, so the answer key cannot ride out with the question.
 */
export function toClientQuestions(questions: readonly KcQuestion[], participantId: string) {
  return questions.map(q => ({
    field: q.id,
    kind: q.kind,
    prompt: q.prompt,
    options: q.kind === 'mc'
      ? shuffleOptions(q.options, participantId, q.id).map(o => ({ value: o.value, label: o.label }))
      : [],
    placeholder: q.placeholder ?? null,
  }))
}

/** Look one question up by id, whatever its stage. */
export function questionById(id: string): KcQuestion | undefined {
  return KC_POOL.find(q => q.id === id)
}

// ── The two stage lists (spec D9) ─────────────────────────────────────────────
//
// ⚠⚠ THE POOL HAS THREE STAGE TAGS AND THE INSTRUCTOR SEES TWO. `kc` and `prep` are both
// asked before the first round — the graded questions, then the written plan — so they are
// ONE configurable stage and two serve-time tags. `debrief` is asked after the final
// results screen. A built-in's own tag is NEVER rewritten.
//
// ⚠ PROCUREMENT NEEDED NO FOLDING, unlike the other five. Its prep and debrief paragraphs
// were ALREADY pool entries with `(ungraded)` tags and their own visibility — that is the
// design the rest of the family converged ONTO. What they gain here is edit, reorder, and a
// stage that accepts added questions.
//
// ⚠⚠ AND THEREFORE THERE IS NO BOUNDARY TRANSLATION IN THIS GAME. The other five keep their
// paragraph prompts in config keys (`debriefPrompt`, `prepPrompt`) and translate to and from
// `kc_overrides` in the settings page. Procurement has NO such key — config.ts says so in as
// many words — so its free-text prompts are edited through `kc_overrides` like any other
// built-in, and nothing needs translating. Do not invent a config key for them.
//
// ⚠ `kind` ROUTES THE SUBMIT and must not be inferred from `type`:
//     'authored'  built-in mc          → procurementSubmitKcAnswer  (kc_static_answers)
//     'free-text' built-in prep/debrief → procurementSubmitFreeText  (free_text_answers)
//     'added'     any addition          → procurementSubmitKcAnswer  (kc_static_answers)
// An ADDED free-text question is `type: 'text'` and still goes to the KC callable.

export interface ProcurementStageRow {
  kind: 'authored' | 'added' | 'free-text'
  field: string
  type: 'mc' | 'text'
  prompt: string
  placeholder?: string
  options: { value: string; label: string }[]
}

const rowOf = (q: KcQuestion): ProcurementStageRow => ({
  kind: q.kind === 'mc' ? 'authored' : 'free-text',
  field: q.id,
  type: q.kind === 'mc' ? 'mc' : 'text',
  prompt: q.prompt,
  placeholder: q.placeholder ?? undefined,
  options: q.options.map(o => ({ value: o.value, label: o.label })),
})

const addedRow = (q: ProcurementAddedKcQuestion): ProcurementStageRow => ({
  kind: 'added',
  field: q.id,
  type: q.type,
  prompt: q.prompt,
  options: (q.options ?? []).map(o => ({ value: o.value, label: o.label })),
})

/**
 * The PRE-PLAY stage: the graded built-ins, the prep paragraph, and any `kc`-stage addition.
 *
 * ⚠⚠ EVERY SOURCE IS RESOLVED *UNORDERED* AND `applyKcOrder` RUNS ONCE, AT THE BOTTOM, over
 * the whole list. Applying it inside the resolvers as well makes the second pass sort against
 * positions the first produced — invisible under a COMPLETE map, wrong under a partial one,
 * because `applyKcOrder` falls back to an item's CURRENT index for an unmentioned id. That
 * bug shipped in newsvendor and was fixed in pd and pricing (spec §6).
 */
export function procurementPreStage(config: ProcurementConfig): ProcurementStageRow[] {
  const rows = [
    ...resolveBuiltInsUnordered(config, 'kc').map(rowOf),
    ...resolveBuiltInsUnordered(config, 'prep').map(rowOf),
    ...resolveAddedKcQuestionsUnordered(config, 'kc').map(addedRow),
  ]
  return applyKcOrder(rows, r => r.field, config.kcOrder)
}

/**
 * The DEBRIEF stage: the debrief paragraph and any `debrief`-stage addition.
 *
 * ⚠ PROCUREMENT HAS NO SERVER-ENFORCED REVEAL GATE, unlike forecast, and must not gain one.
 * Its final results screen simply PRECEDES this stage; nothing is withheld until it is
 * answered, because there is no answer key to contaminate — the results are the student's
 * own outcome, which they are entitled to see.
 */
export function procurementDebriefStage(config: ProcurementConfig): ProcurementStageRow[] {
  const rows = [
    ...resolveBuiltInsUnordered(config, 'debrief').map(rowOf),
    ...resolveAddedKcQuestionsUnordered(config, 'debrief').map(addedRow),
  ]
  return applyKcOrder(rows, r => r.field, config.kcOrder)
}

/**
 * A stage as the STUDENT receives it — every mc row's options SHUFFLED per student, answer
 * keys absent.
 *
 * ⚠⚠ THE SHUFFLE LIVES AT THE SERVE BOUNDARY THE CALLABLE COMPOSES, so a test of this
 * function tests the WIRING rather than the shuffle primitive. Every pass in this programme
 * lost a mutant to that distinction (spec §7).
 */
export function stageToClient(
  rows: ProcurementStageRow[],
  participantId: string,
): ProcurementStageRow[] {
  return rows.map(r => (
    r.options.length > 1
      ? { ...r, options: shuffleOptions(r.options, participantId, r.field).map(o => ({ value: o.value, label: o.label })) }
      : r
  ))
}

/**
 * This instance's added questions IN THE CLIENT SHAPE — whitelisted field by field, shuffled.
 *
 * ⚠⚠ `stage` IS REQUIRED. In pd this argument was optional for an hour and dropping it at the
 * call site served every after-results question before play — a mutation no unit test caught,
 * because every test passed the stage explicitly. Requiring it makes that a compile error.
 */
export function addedToClientKcQuestions(
  config: ProcurementConfig,
  participantId: string,
  stage: ProcurementKcStage,
) {
  return resolveAddedKcQuestions(config, stage).map(q => ({
    field: q.id,
    kind: q.type,
    prompt: q.prompt,
    options: q.type === 'mc'
      ? shuffleOptions(q.options ?? [], participantId, q.id).map(o => ({ value: o.value, label: o.label }))
      : [],
    placeholder: null,
  }))
}
