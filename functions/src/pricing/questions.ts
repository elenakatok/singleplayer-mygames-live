import type { PrepTextQuestion } from '@mygames/game-server'
import { computeRound, type PricingMarketConfig } from './market'
import {
  DEFAULT_LABELS, DEFAULT_DEBRIEF_PROMPT_STANDARD, addedKcStage,
  type PricingFirmLabels, type PricingConfig, type PricingAddedKcQuestion,
  type PricingKcStage, type KcOverrideMap,
} from './config'
import { applyKcOrder } from '../shared/kcSurface'

export { PRICING_KC_STAGES, DEFAULT_ADDED_KC_STAGE, addedKcStage } from './config'
export type { PricingKcStage } from './config'

// ═══════════════════════════════════════════════════════════════════════════════
// Pricing Game — the KNOWLEDGE CHECK (spec §8) and the DEBRIEF (spec §9), as DATA
// OBJECTS (standing platform constraint: never an inline array in student-flow code).
// Built on the shared PrepTextQuestion model and the shared `kc_` / `debrief_`
// field-prefix convention.
//
// ⚠ EVERY NUMBER IS DERIVED FROM THE INSTANCE'S MARKET, NOT FROZEN IN THE DATA
// OBJECT (spec §8, the never-stale principle). Each question below is a `build`
// function taking the market config; nothing about a question is stored, so an
// instructor who edits the market can never grade a student against a market that is
// no longer the one on their screen. The SAME function is called by the serve path
// (getQuestions) and the GRADE path (submitKcAnswer) — that is the whole reason it is
// one function, and it is the trap this file exists to close.
//
// ⚠ THE SET DEPENDS ON THE MODE (spec §8.1 vs §8.2). Standard asks the four
// share/contribution questions; PMG asks three about price matching and does NOT
// repeat the Standard four (students did those in their first instance). The mode
// also selects the debrief prompt (§9) — that lives in config.ts, which owns the
// mode-dependent default.
//
// NO GATE, as in PD: a wrong answer is recorded and scored, and the student
// continues into the game regardless.
// ═══════════════════════════════════════════════════════════════════════════════

// ── Local formatting (server-side; deliberately independent of the frontend's) ──

const money = (v: number) => `$${Math.round(v).toLocaleString('en-US')}`
/** A share as a percentage. Trailing '.0' is dropped so the common case reads "35%",
 *  not "35.0%" — these are prompts a student reads, not a data table. */
const pct = (v: number) => {
  const s = (v * 100).toFixed(1)
  return `${s.endsWith('.0') ? s.slice(0, -2) : s}%`
}
const containers = (v: number) => Math.round(v).toLocaleString('en-US')

/** Snap to the competitor's decision grid, staying inside the band. */
const snap = (v: number, m: PricingMarketConfig) => {
  const stepped = Math.round(v / m.gridStep) * m.gridStep
  return Math.min(m.maxPrice, Math.max(m.minPrice, stepped))
}

type Option = { value: string; label: string }

/**
 * Options in a stable order, DE-DUPLICATED by value.
 *
 * De-duplication is load-bearing, not tidiness: the distractors are derived, and an
 * edited market can make one of them collide with the right answer (base share 50%
 * would make the "50%" distractor in Q1 the correct answer). Offering the same value
 * twice would let a student pick a "wrong" option that is in fact right. Dropping the
 * duplicate leaves a shorter list, which is always answerable.
 */
function options(...opts: Option[]): Option[] {
  const seen = new Set<string>()
  return opts.filter(o => (seen.has(o.value) ? false : (seen.add(o.value), true)))
}

const shareOption = (v: number): Option => ({ value: v.toFixed(4), label: pct(v) })
const priceOption = (v: number): Option => ({ value: String(Math.round(v)), label: money(v) })

// ── The question specs ─────────────────────────────────────────────────────────

/** What a built question carries. `null` from `build` means the question does not
 *  apply to this market at all and is dropped from the set (see kc_loss below). */
type Built = {
  prompt: string
  options: Option[]
  correct_value: string
  explanation: string
  /**
   * ⚠ OPT OUT OF THE PER-STUDENT SHUFFLE — set ONLY on a numeric ladder.
   *
   * The five money/share questions `.sort()` their options ascending, so an option's
   * POSITION is a function of its VALUE and carries no information about which one is
   * right; scrambling a price ladder would only make four numbers harder to compare.
   * The CATEGORICAL questions have no such ordering, and there the author's order is
   * "correct answer first" — which is exactly the tell the shuffle exists to remove.
   *
   * ⚠ THE DEFAULT IS TO SHUFFLE, and that direction is deliberate: a categorical
   * question added later is protected by forgetting this flag, not by remembering it.
   */
  ordered?: true
}

type KcSpec = {
  field: string
  order: number
  build: (m: PricingMarketConfig, labels: PricingFirmLabels) => Built | null
}

/**
 * The two in-bounds prices the share/contribution questions are posed with.
 *
 * ⚠ DERIVED FROM THE BAND, NOT THE CASE'S LITERALS. Spec §8.1 illustrates Q2 with
 * $1,600 / $1,800; those are what the CASE's band happens to make sensible, and
 * hardcoding them would be a second source of truth that goes stale the moment an
 * instructor narrows the price range — the exact drift the derivation exists to
 * prevent. The rule instead is "a grid price just below the ceiling, and one two grid
 * steps below it", which at the shipped defaults gives $1,900 / $1,700 — a $200 gap,
 * so the correct answer and all four options are identical to the spec's table.
 */
function questionPrices(m: PricingMarketConfig): { yours: number; theirs: number } {
  const theirs = snap(m.maxPrice - m.gridStep, m)
  const yours = snap(theirs - 2 * m.gridStep, m)
  return { yours, theirs }
}

/** Q1 — base share: your share when both firms charge the same price (spec §8.1). */
const kcBaseShare: KcSpec = {
  field: 'kc_base_share',
  order: 1,
  build: (m, labels) => ({
    prompt: `You are ${labels.student}. What is your base market share — your share if both firms charge the same price?`,
    // Distractors: an even split, your competitor's base share, and the whole market.
    options: options(
      shareOption(m.studentBaseShare),
      shareOption(0.5),
      shareOption(m.competitorBaseShare),
      shareOption(1),
    ).sort((a, b) => Number(a.value) - Number(b.value)),
    ordered: true,   // numeric ladder — position tracks value, not correctness
    correct_value: m.studentBaseShare.toFixed(4),
    explanation:
      `Your base share is ${pct(m.studentBaseShare)}. Price differences move share away from ` +
      `that starting point — they do not create it.`,
  }),
}

/** Q2 — share at a price gap (spec §8.1): s_c + (their price − your price) / k. */
const kcShareGap: KcSpec = {
  field: 'kc_share_gap',
  order: 2,
  build: (m, labels) => {
    const { yours, theirs } = questionPrices(m)
    if (yours >= theirs) return null   // a band too narrow to pose a gap at all
    const out = computeRound(yours, theirs, m, false)
    return {
      prompt:
        `You price at ${money(yours)} and ${labels.competitor} prices at ${money(theirs)}. ` +
        `What is your market share?`,
      // Distractors: your base share, your COMPETITOR's share in this same scenario
      // (the sign-flipped answer), and their base share.
      options: options(
        shareOption(out.studentShare),
        shareOption(m.studentBaseShare),
        shareOption(out.competitorShare),
        shareOption(m.competitorBaseShare),
      ).sort((a, b) => Number(a.value) - Number(b.value)),
      ordered: true,   // numeric ladder — position tracks value, not correctness
      correct_value: out.studentShare.toFixed(4),
      explanation:
        `You undercut by ${money(theirs - yours)}, which moves ` +
        `${pct((theirs - yours) / m.slope)} of the market to you: ` +
        `${pct(m.studentBaseShare)} + ${pct((theirs - yours) / m.slope)} = ${pct(out.studentShare)}.`,
    }
  },
}

/** Q3 — contribution per container (spec §8.1): price − your unit cost. */
const kcContribution: KcSpec = {
  field: 'kc_contribution',
  order: 3,
  build: (m) => {
    const { yours } = questionPrices(m)
    return {
      prompt:
        `Your unit cost is ${money(m.studentUnitCost)}. If you price at ${money(yours)}, ` +
        `what is your contribution per container?`,
      // Distractors: the unit cost itself, the price itself, and the contribution a
      // student would get by subtracting the COMPETITOR's cost instead of their own.
      options: options(
        priceOption(yours - m.studentUnitCost),
        priceOption(m.studentUnitCost),
        priceOption(yours),
        priceOption(yours - m.competitorUnitCost),
      ).sort((a, b) => Number(a.value) - Number(b.value)),
      ordered: true,   // numeric ladder — position tracks value, not correctness
      correct_value: String(Math.round(yours - m.studentUnitCost)),
      explanation:
        `Contribution is price minus YOUR unit cost: ${money(yours)} − ` +
        `${money(m.studentUnitCost)} = ${money(yours - m.studentUnitCost)} per container.`,
    }
  },
}

/**
 * Q4 — pricing below cost (spec §8.1). Fixed-FORM, config numbers: it plants the
 * maximize-contribution-not-share lesson the whole game turns on.
 *
 * DROPPED when no legal price is below your unit cost — an instructor whose band
 * starts above cost has a market where the question is unanswerable, and a question
 * nobody can answer would sit in every student's denominator. The set is served and
 * graded from the same resolve call, so dropping it here drops it from both.
 */
const kcBelowCost: KcSpec = {
  field: 'kc_below_cost',
  order: 4,
  build: (m) => {
    if (m.minPrice >= m.studentUnitCost) return null
    const out = computeRound(m.minPrice, m.maxPrice, m, false)
    return {
      prompt:
        `You price at ${money(m.minPrice)} — below your unit cost of ${money(m.studentUnitCost)} — ` +
        `and win a large market share. What happens to your total profit?`,
      options: [
        { value: 'negative', label: 'It is negative — you lose money on every container you sell' },
        { value: 'high', label: 'It is high, because you serve most of the customers' },
        { value: 'zero', label: 'It is exactly zero' },
        { value: 'depends', label: 'It depends on your competitor’s unit cost' },
      ],
      correct_value: 'negative',
      explanation:
        `Every container sells for ${money(m.minPrice - m.studentUnitCost)} less than it costs ` +
        `you, so winning ${containers(out.studentDemand)} containers loses money ` +
        `${containers(out.studentDemand)} times over. Share is worth nothing without contribution.`,
    }
  },
}

/** PMG Q1 — what your customers actually pay (spec §8.2): the lower posted price. */
const kcPmgEffective: KcSpec = {
  field: 'kc_pmg_effective',
  order: 1,
  build: (m, labels) => {
    const { yours: lower, theirs: higher } = questionPrices(m)
    // You post the HIGHER price here, so the right answer is your competitor's.
    return {
      prompt:
        `You post ${money(higher)} and ${labels.competitor} posts ${money(lower)}. ` +
        `What price do YOUR customers actually pay?`,
      options: options(
        priceOption(lower),
        priceOption(higher),
        priceOption((lower + higher) / 2),
        priceOption(m.studentUnitCost),
      ).sort((a, b) => Number(a.value) - Number(b.value)),
      ordered: true,   // numeric ladder — position tracks value, not correctness
      correct_value: String(Math.round(lower)),
      explanation:
        `Under the price-matching guarantee everyone pays the LOWER posted price, ` +
        `whoever posted it — so your customers pay ${money(lower)}, not ${money(higher)}.`,
    }
  },
}

/**
 * PMG Q2 — share under PMG (spec §8.2): frozen at base, whatever the gap.
 *
 * The gap is chosen so the STANDARD formula's answer exceeds 100% — that impossible
 * number is the diagnostic distractor (spec §8.2: "105% is the diagnostic distractor
 * — the Standard formula's answer"), and a student who picks it has carried the wrong
 * model across from their first instance.
 */
const kcPmgShare: KcSpec = {
  field: 'kc_pmg_share',
  order: 2,
  build: (m, labels) => {
    // The smallest grid gap that pushes the Standard answer over 100%.
    const needed = Math.ceil(((1 - m.studentBaseShare) * m.slope) / m.gridStep) * m.gridStep
    const band = m.maxPrice - m.minPrice
    const gap = Math.min(needed, Math.floor(band / m.gridStep) * m.gridStep)
    if (gap <= 0) return null
    const slack = band - gap
    const yours = snap(m.minPrice + slack / 2, m)
    const theirs = Math.min(m.maxPrice, yours + gap)
    const flipped = m.studentBaseShare + (theirs - yours) / m.slope

    return {
      prompt:
        `You post ${money(yours)} and ${labels.competitor} posts ${money(theirs)}. ` +
        `What is your market share?`,
      // The diagnostic distractor is the Standard formula's answer — which is the
      // whole point, so it is offered EVEN THOUGH it may exceed 100%.
      options: options(
        shareOption(m.studentBaseShare),
        shareOption(m.competitorBaseShare),
        shareOption(1),
        shareOption(flipped),
      ).sort((a, b) => Number(a.value) - Number(b.value)),
      ordered: true,   // numeric ladder — position tracks value, not correctness
      correct_value: m.studentBaseShare.toFixed(4),
      explanation:
        `Under the price-matching guarantee shares do not respond to price at all — ` +
        `yours is always ${pct(m.studentBaseShare)}. ${pct(flipped)} is what the ordinary ` +
        `share formula would have said, and it is exactly the reasoning PMG removes.`,
    }
  },
}

/** PMG Q3 — undercutting wins nothing (spec §8.2). Fixed-FORM, config numbers. */
const kcPmgUndercut: KcSpec = {
  field: 'kc_pmg_undercut',
  order: 3,
  build: (m, labels) => ({
    prompt:
      `Under the price-matching guarantee, you undercut ${labels.competitor} by ` +
      `${money(m.gridStep)}. How many additional customers do you win?`,
    options: [
      { value: 'none', label: `None — your share stays ${pct(m.studentBaseShare)}` },
      { value: 'containers', label: `${containers(m.marketSize * (m.gridStep / m.slope))} containers` },
      { value: 'share_move', label: `${pct(m.gridStep / m.slope)} of the market` },
      { value: 'all', label: 'All of them' },
    ],
    correct_value: 'none',
    explanation:
      `None. Because your competitor's customers pay the lower price too, undercutting ` +
      `moves no share at all — it only lowers the price everyone pays, including yours. ` +
      `${containers(m.marketSize * (m.gridStep / m.slope))} containers is what the same ` +
      `undercut would have won in the standard game.`,
  }),
}

const STANDARD_KC: KcSpec[] = [kcBaseShare, kcShareGap, kcContribution, kcBelowCost]
const PMG_KC: KcSpec[] = [kcPmgEffective, kcPmgShare, kcPmgUndercut]

// ── Resolution ─────────────────────────────────────────────────────────────────

/** A resolved knowledge-check question: the shared model, fully built. */
export type PricingKcQuestion = PrepTextQuestion & {
  field: string
  prompt: string
  options: Option[]
  correct_value: string
  explanation: string
  /** See `Built.ordered`. Absent ⇒ the options are shuffled per student. */
  ordered?: true
}

const kcBase = {
  type: 'mc' as const,
  format: 'multiple_choice' as const,
  category: 'knowledge_check' as const,
  grading: 'static' as const,
  system: false,
  placeholder: '',
  hidden: false,
  deletable: false,
  role_target: 'all',
}

/**
 * This instance's knowledge check: the MODE picks the set, and every prompt, option,
 * correct answer and explanation is regenerated from the instance's own market.
 *
 * Pure — no Firestore. Both the serve path and the grade path call this, so the
 * options a student sees and the answer they are graded against cannot disagree.
 */
export function resolvePricingKcQuestions(
  market: PricingMarketConfig,
  pmg: boolean,
  labels: PricingFirmLabels = DEFAULT_LABELS,
): PricingKcQuestion[] {
  const specs = pmg ? PMG_KC : STANDARD_KC
  const out: PricingKcQuestion[] = []
  for (const spec of specs) {
    const built = spec.build(market, labels)
    if (built === null) continue        // does not apply to this market — see kcBelowCost
    out.push({ ...kcBase, field: spec.field, order: out.length + 1, ...built })
  }
  return out
}

/**
 * A Fisher–Yates shuffle driven by a hash of (participant, field, position), so it is
 * stable for one student and different across students.
 *
 * Stability matters more than it looks: a student who answers, reloads and returns to a
 * re-ordered list would be reading a different screen from the one they answered on.
 * Grading is by option VALUE (`submitKcAnswer` compares against `correct_value`), so
 * order never touches a score.
 *
 * A fresh hash per position — reusing one 32-bit draw across all positions would make
 * the permutation a function of a single number, so only 2^32 of the possible orders
 * could appear and students would visibly share layouts.
 */
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

function shuffleFor(participantId: string, field: string, opts: readonly Option[]): Option[] {
  const out = [...opts]
  for (let i = out.length - 1; i > 0; i--) {
    const j = hash32(`${participantId}:${field}:${i}`) % (i + 1)
    const tmp = out[i]
    out[i] = out[j]
    out[j] = tmp
  }
  return out
}

/**
 * The same shuffle for an INSTRUCTOR-ADDED question's options, whitelisted to the two
 * client fields. Separate entry point because added questions are stored config, not a
 * `PricingKcQuestion` — but they must not be the one door the tell walks back in through.
 * A single option (or none) is returned untouched.
 */
export function shuffleClientOptions(
  opts: readonly Option[],
  participantId: string,
  field: string,
): Option[] {
  const src = opts.length > 1 ? shuffleFor(participantId, field, opts) : [...opts]
  return src.map(o => ({ value: o.value, label: o.label }))
}

/** The KC as sent to the STUDENT — the answer key removed. `correct_value` and
 *  `explanation` are stripped: the explanation is earned by answering (the submit
 *  callable returns it), and the key is never client-side.
 *
 *  ⚠ AND THE POSITION OF THE ANSWER IS REMOVED TOO. The categorical questions are
 *  authored correct-answer-first; without this, `kc_below_cost` and `kc_pmg_undercut`
 *  were answerable by picking the top radio button. `ordered` questions are numeric
 *  ladders and keep their sort — see the flag's note on `Built`. */
export function toClientKcQuestions(resolved: PricingKcQuestion[], participantId: string) {
  return resolved.map(q => ({
    field: q.field,
    prompt: q.prompt,
    options: (q.ordered ? q.options : shuffleFor(participantId, q.field, q.options))
      .map(o => ({ value: o.value, label: o.label })),
  }))
}

// ═══════════════════════════════════════════════════════════════════════════════
// THE THREE CONVERGENCE FIELDS, APPLIED (spec §5).
//
// ⚠⚠ `pricingResolveKc` AND `pricingKcScoringSet` ARE THE ONE ANSWER TO "WHICH QUESTIONS
// DOES THIS INSTANCE ASK?", and the serve path and the grader BOTH call them. A question
// hidden from the display but left in the grader's scoring set is graded against an answer
// the student never saw and inflates every denominator — spec §5's named worst case.
//
// ⚠⚠ THREE THINGS ARE TRUE HERE AND OF NO OTHER GAME:
//   1. `ordered` — five of the seven built-ins must NOT shuffle. It stays PER QUESTION with
//      shuffle as the default, so a categorical question added later is protected by
//      forgetting the flag rather than by remembering it.
//   2. THE MODE SWAP — two mutually exclusive sets on one boolean. The maps below are flat
//      and that is safe ONLY because the two sets share no ids (see config.ts).
//   3. THE SET IS CONFIG-DEPENDENT IN COUNT — `kc_share_gap` and `kc_below_cost` return
//      null for some markets and vanish from both the served set and the denominator, so
//      every map here must tolerate an id that is not currently served.
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Every id EITHER mode can serve — the union of both sets.
 *
 * ⚠ THE UNION, NOT THE CURRENT MODE'S. A stored override for the other mode's question must
 * survive a save made in this mode, and a question that `build()` returned null for is
 * still a built-in. Validating against the current mode alone would reject an instructor's
 * own stored edit the moment they flipped the toggle or narrowed the price band.
 */
export const PRICING_BUILT_IN_KC_IDS: ReadonlySet<string> = new Set(
  [...STANDARD_KC, ...PMG_KC].map(s => s.field),
)

/**
 * Apply an instructor's wording to one built-in.
 *
 * ⚠⚠ TEXT ONLY, BY CONSTRUCTION. `options` maps an EXISTING option value to a replacement
 * LABEL, so this cannot add an option, drop one, reorder them, change a value, or touch
 * `correct_value`. Grading compares option VALUES, so an override provably cannot move a
 * score.
 *
 * ⚠ THE `ordered` FLAG AND THE SORT SURVIVE UNTOUCHED. The five ladder questions sort their
 * options ascending by value; relabelling cannot reorder them, because the labels are
 * replaced in place rather than rebuilt from the map.
 */
export function applyKcOverride(q: PricingKcQuestion, overrides: KcOverrideMap): PricingKcQuestion {
  const o = overrides[q.field]
  if (!o) return q
  return {
    ...q,
    prompt: o.prompt ?? q.prompt,
    options: o.options
      ? q.options.map(opt => ({ value: opt.value, label: o.options![opt.value] ?? opt.label }))
      : q.options,
  }
}

/** Has an instructor rewritten this question? Drives the "edited" badge, nothing else. */
export function isKcOverridden(id: string, overrides: KcOverrideMap): boolean {
  return overrides[id] !== undefined
}

/**
 * This instance's DERIVED set: the mode's questions, overridden, hidden ones removed, in
 * the instance's order.
 *
 * ⚠ `kcEnabled: false` empties it entirely — every derived question is graded, and D12 says
 * the toggle gates graded questions.
 */
export function pricingResolveKc(config: PricingConfig): PricingKcQuestion[] {
  if (!config.kcEnabled) return []
  const all = resolvePricingKcQuestions(config.market, config.pmg, config.labels)
    .filter(q => config.kcHidden[q.field] !== true)
    .map(q => applyKcOverride(q, config.kcOverrides))
  return applyKcOrder(all, q => q.field, config.kcOrder)
}

/** An added question that carries a usable key, and therefore a mark. */
export function isGradedAdded(q: PricingAddedKcQuestion): boolean {
  return q.type === 'mc' && typeof q.correct_value === 'string'
}

/**
 * This instance's ADDED questions: hidden ones removed, in order.
 *
 * ⚠⚠ D12 — `kcEnabled` GATES GRADED QUESTIONS ONLY. A graded addition disappears with the
 * toggle; an UNGRADED free-text one does not, and is governed by its own visibility, the
 * same rule the debrief paragraph follows.
 *
 * ⚠ Omitted `stage` ⇒ EVERY stage. The grader calls it that way deliberately: gradedness is
 * stage-independent (D3).
 */
export function resolveAddedKcQuestions(
  config: PricingConfig,
  stage?: PricingKcStage,
): PricingAddedKcQuestion[] {
  const visible = config.addedKcQuestions.filter(q => config.kcHidden[q.id] !== true)
  const gated = config.kcEnabled ? visible : visible.filter(q => !isGradedAdded(q))
  const scoped = stage === undefined ? gated : gated.filter(q => addedKcStage(q) === stage)
  return applyKcOrder(scoped, q => q.id, config.kcOrder)
}

/**
 * ⚠⚠ THE GRADER'S SCORING SET — the whole of it, in one place.
 *
 * `pricingSubmitKcAnswer` calls exactly this and builds no list of its own. Visible AND
 * graded: a hidden question is absent (never asked), and an ungraded one — free text, or an
 * mc whose key named no offered option — is absent from numerator AND denominator.
 *
 * ⚠ A question `build()` returned null for is absent too, automatically: it never enters
 * `resolvePricingKcQuestions`, so the denominator follows the market without a special case.
 */
export function pricingKcScoringSet(
  config: PricingConfig,
): { field: string; correct_value: string }[] {
  return [
    ...pricingResolveKc(config).map(q => ({ field: q.field, correct_value: q.correct_value })),
    ...resolveAddedKcQuestions(config)
      .filter(isGradedAdded)
      .map(q => ({ field: q.id, correct_value: q.correct_value! })),
  ]
}

/**
 * This instance's added questions IN THE CLIENT SHAPE — whitelisted field by field, and
 * SHUFFLED.
 *
 * ⚠⚠ `stage` IS REQUIRED. In pd this argument was optional for an hour and dropping it at
 * the call site served every after-results question BEFORE play — a mutation no unit test
 * caught, because the tests passed the stage explicitly. Requiring it makes that a compile
 * error. The grader's "every stage" case has its own call, `resolveAddedKcQuestions(config)`.
 *
 * ⚠ ADDED QUESTIONS ARE NEVER `ordered`. The flag exists for the five derived numeric
 * ladders; an instructor typing a question has arbitrary labels in the order they typed
 * them, and most people type the right answer first.
 */
export function addedToClientKcQuestions(
  config: PricingConfig,
  participantId: string,
  stage: PricingKcStage,
): { field: string; type: 'mc' | 'text'; prompt: string; options: { value: string; label: string }[] }[] {
  return resolveAddedKcQuestions(config, stage).map(q => ({
    field: q.id,
    type: q.type,
    prompt: q.prompt,
    options: shuffleClientOptions(q.options ?? [], participantId, q.id),
  }))
}

/**
 * ⚠⚠ THE WHOLE `post` STAGE, IN ORDER — the debrief row plus any added question assigned
 * there. pricing's debrief screen walks this list.
 *
 * The debrief is a ROW (spec D9): it takes part in `order` under its own id, and its
 * visibility is `debriefEnabled` rather than the `hidden` map, because it is stored under
 * `debrief_prompt` / `debrief_enabled` and NOT in the three convergence maps. That boundary
 * is what makes folding it into the list a change with no storage migration.
 *
 * ⚠ `kind` routes the submit: `debrief` → pricingSubmitDebrief, `added` →
 * pricingSubmitKcAnswer. The client must not infer it from `type`, because an added
 * free-text question is also `type: 'text'` and goes to a different callable.
 */
export interface PricingPostStageQuestion {
  kind: 'debrief' | 'added'
  field: string
  type: 'mc' | 'text'
  prompt: string
  placeholder?: string
  options: { value: string; label: string }[]
}

export function pricingPostStageQuestions(config: PricingConfig): PricingPostStageQuestion[] {
  const rows: PricingPostStageQuestion[] = []

  if (config.debriefEnabled) {
    rows.push({
      kind: 'debrief',
      field: debriefQuestion.field,
      type: 'text',
      // ⚠ The instructor's prompt from `debrief_prompt` — which itself defaults PER MODE
      // (config.ts) — never the literal on the data object.
      prompt: config.debriefPrompt,
      placeholder: debriefQuestion.placeholder,
      options: [],
    })
  }

  for (const q of resolveAddedKcQuestions(config, 'post')) {
    rows.push({ kind: 'added', field: q.id, type: q.type, prompt: q.prompt, options: q.options ?? [] })
  }

  // Ordered ACROSS both kinds, so an instructor can put an added question before the
  // debrief paragraph. `applyKcOrder` is total on a partial map.
  return applyKcOrder(rows, r => r.field, config.kcOrder)
}

/**
 * The `post` stage as the STUDENT receives it — added options SHUFFLED.
 *
 * ⚠ The serve path composes THIS, so a test of this function tests the wiring rather than
 * the primitive. Both previous passes lost a mutant to that distinction.
 */
export function postStageToClient(
  config: PricingConfig,
  participantId: string,
): PricingPostStageQuestion[] {
  return pricingPostStageQuestions(config).map(r => (
    r.kind === 'added'
      ? { ...r, options: shuffleClientOptions(r.options, participantId, r.field) }
      : r
  ))
}

// ── The debrief (spec §9) ──────────────────────────────────────────────────────

/** ONE open-ended paragraph, UNGRADED. Feeds the Tier-2 report.
 *
 *  The PROMPT is mode-dependent and lives in config (loadPricingConfig picks the
 *  Standard or PMG default and honours an instructor edit); the literal here is only
 *  the shape's required field. No `grading` and no `correct_value` — ungraded by
 *  construction, so it can never reach calcKCScore's denominator. */
export const debriefQuestion: PrepTextQuestion = {
  field: 'debrief_reflection',
  order: 1,
  type: 'text',
  format: 'text',
  category: 'debrief',
  system: false,
  placeholder: 'A few sentences are plenty.',
  hidden: false,
  deletable: false,
  role_target: 'all',
  prompt: DEFAULT_DEBRIEF_PROMPT_STANDARD,
}
