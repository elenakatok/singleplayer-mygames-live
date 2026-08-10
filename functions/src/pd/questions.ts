import type { PrepTextQuestion } from '@mygames/game-server'
import { yearsFor, type PayoffConfig } from './payoff'
import {
  DEFAULT_MOVE_LABELS, DEFAULT_UNIT, addedKcStage,
  type PdMoveLabels, type PdConfig, type PdAddedKcQuestion, type KcOverrideMap,
  type PdKcStage,
} from './config'
import { applyKcOrder } from '../shared/kcSurface'
import type { Move } from './strategy'

// ═══════════════════════════════════════════════════════════════════════════════
// Repeated PD — the KNOWLEDGE CHECK (spec §7) and the DEBRIEF (spec §8), as DATA
// OBJECTS (standing platform constraint: never an inline array in student-flow
// code). Built on the shared PrepTextQuestion model and the shared `kc_` / `debrief_`
// field-prefix convention, so moving these into an admin-defaults config doc later is
// a read-and-merge, not a rewrite.
//
// FOUR QUESTIONS, ONE ANSWER EACH — "how many years do YOU serve?" for each of the
// four cells. Options are the four payoff values (0/1/10/15 on the shipped matrix).
//
// NO GATE (Elena's call, this game): the family has no roles, and this is a
// play-to-learn exercise. A wrong answer is RECORDED and SCORED, and the student
// proceeds anyway. Nothing here can block entry to the round loop.
//
// ⚠ CORRECTNESS IS DERIVED FROM CONFIG, NOT FROZEN IN THE DATA OBJECT. Each question
// carries the CELL it asks about ({ you, other }); resolveKcQuestions() then computes
// its options and its correct answer from the instance's own payoff matrix. The
// literals below are the shipped defaults and are asserted to agree with the default
// matrix in the unit tests. Why bother: the KC screen renders the matrix FROM CONFIG
// (spec §7 — the point is checking they can read it), so an instructor who edits the
// four values would otherwise be grading students against a matrix that is no longer
// the one on their screen.
// ═══════════════════════════════════════════════════════════════════════════════

/** A PD knowledge-check question: the shared model plus the matrix cell it asks about. */
export type PdKcQuestion = PrepTextQuestion & {
  /** The cell: the student's own move, and the other player's. */
  cell: { you: Move; other: Move }
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

/** The shipped option set — the four values of the default matrix (spec §7). */
const DEFAULT_YEAR_OPTIONS = ['0', '1', '10', '15']

/**
 * "3 points" / "1 point" — best-effort singularization for an arbitrary configured
 * unit. Only the common English plural is handled (drop a trailing 's' at exactly 1);
 * any other word is used as given rather than mangled. The unit is the instructor's
 * word, so guessing harder than this would produce worse output, not better.
 */
export function unitLabel(value: string, unit: string): string {
  const one = value === '1'
  const word = one && unit.length > 1 && unit.endsWith('s') ? unit.slice(0, -1) : unit
  return `${value} ${word}`
}

/**
 * The prompt for one cell. Uses the instance's MOVE LABELS and UNIT, and states no
 * direction — it asks what you get, not whether that is good.
 */
export function kcPrompt(cell: { you: Move; other: Move }, labels: PdMoveLabels, unit: string): string {
  const mine = cell.you === 'C' ? labels.C : labels.D
  const theirs = cell.other === 'C' ? labels.C : labels.D
  const also = cell.you === cell.other ? 'also ' : ''
  return `You choose ${mine} and the other player ${also}chooses ${theirs}. How many ${unit} do YOU get?`
}

/**
 * The post-answer explanation for one cell, DERIVED from the instance's own numbers.
 * It states the two values and nothing else: no "best", no "worst", no "sucker's
 * payoff" — which of these outcomes is good is the instructor's framing, not the
 * software's, and a configured matrix may not be a dilemma at all.
 */
export function kcExplanation(
  cell: { you: Move; other: Move }, payoffs: PayoffConfig, labels: PdMoveLabels, unit: string,
): string {
  const mine = cell.you === 'C' ? labels.C : labels.D
  const theirs = cell.other === 'C' ? labels.C : labels.D
  const you = unitLabel(String(yearsFor(cell.you, cell.other, payoffs)), unit)
  const them = unitLabel(String(yearsFor(cell.other, cell.you, payoffs)), unit)
  return cell.you === cell.other
    ? `When you both choose ${mine}, you each get ${you}.`
    : `Choosing ${mine} while they choose ${theirs} gets you ${you}; they get ${them}.`
}

/**
 * The four questions, as DATA. `field`, `order` and `cell` are the real content here —
 * the prompt/options/correct_value/explanation literals below are what the SHIPPED
 * DEFAULT matrix derives, kept inline so the shape stays readable and so the shared
 * PrepTextQuestion contract is satisfied. resolveKcQuestions() regenerates all four of
 * those from the instance's own config, and a unit test asserts the literals match
 * what the defaults derive — so they cannot rot into a second source of truth.
 */
export const kcQuestions: PdKcQuestion[] = [
  {
    ...kcBase,
    field: 'kc_cc',
    order: 1,
    cell: { you: 'C', other: 'C' },
    prompt: 'You choose Cooperate and the other player also chooses Cooperate. How many years do YOU get?',
    options: DEFAULT_YEAR_OPTIONS.map(v => ({ value: v, label: unitLabel(v, DEFAULT_UNIT) })),
    correct_value: '1',
    explanation: 'When you both choose Cooperate, you each get 1 year.',
  },
  {
    ...kcBase,
    field: 'kc_cd',
    order: 2,
    cell: { you: 'C', other: 'D' },
    prompt: 'You choose Cooperate and the other player chooses Defect. How many years do YOU get?',
    options: DEFAULT_YEAR_OPTIONS.map(v => ({ value: v, label: unitLabel(v, DEFAULT_UNIT) })),
    correct_value: '15',
    explanation: 'Choosing Cooperate while they choose Defect gets you 15 years; they get 0 years.',
  },
  {
    ...kcBase,
    field: 'kc_dc',
    order: 3,
    cell: { you: 'D', other: 'C' },
    prompt: 'You choose Defect and the other player chooses Cooperate. How many years do YOU get?',
    options: DEFAULT_YEAR_OPTIONS.map(v => ({ value: v, label: unitLabel(v, DEFAULT_UNIT) })),
    correct_value: '0',
    explanation: 'Choosing Defect while they choose Cooperate gets you 0 years; they get 15 years.',
  },
  {
    ...kcBase,
    field: 'kc_dd',
    order: 4,
    cell: { you: 'D', other: 'D' },
    prompt: 'You choose Defect and the other player also chooses Defect. How many years do YOU get?',
    options: DEFAULT_YEAR_OPTIONS.map(v => ({ value: v, label: unitLabel(v, DEFAULT_UNIT) })),
    correct_value: '10',
    explanation: 'When you both choose Defect, you each get 10 years.',
  },
]

/** The debrief (spec §8): ONE open-ended paragraph, UNGRADED. Feeds the Tier-2 report. */
export const debriefQuestion: PrepTextQuestion = {
  field: 'debrief_reflection',
  order: 1,
  type: 'text',
  format: 'text',
  category: 'debrief',
  system: false,
  placeholder: 'A short paragraph is plenty.',
  hidden: false,
  deletable: false,
  role_target: 'all',
  prompt: 'In a short paragraph, explain what you did during the game and why.',
  // No `grading` and no `correct_value` — ungraded by construction, so it can never
  // reach calcKCScore's denominator (which counts grading:'static' questions only).
}

/**
 * The four questions resolved against ONE instance's config: prompt, options, correct
 * answer and explanation are ALL regenerated from that instance's payoff matrix, move
 * labels and unit. Nothing about them is stored, which is why they can never drift
 * from the matrix the student is shown — that no-drift property is the whole reason
 * these four are derived rather than editable (Slice 5 adds editable questions as a
 * separate list; see PdAddedKcQuestion).
 *
 * Pure — no Firestore. Both the serve path and the grade path call this, so the
 * options a student sees and the answer they are graded against cannot disagree.
 */
export function resolveKcQuestions(
  payoffs: PayoffConfig,
  unit: string = DEFAULT_UNIT,
  labels: PdMoveLabels = DEFAULT_MOVE_LABELS,
): PdKcQuestion[] {
  const distinct = [...new Set([
    payoffs.both_cooperate, payoffs.sucker, payoffs.temptation, payoffs.both_defect,
  ])].sort((a, b) => a - b)
  const options = distinct.map(v => ({ value: String(v), label: unitLabel(String(v), unit) }))

  return kcQuestions.map(q => ({
    ...q,
    prompt: kcPrompt(q.cell, labels, unit),
    options,
    correct_value: String(yearsFor(q.cell.you, q.cell.other, payoffs)),
    explanation: kcExplanation(q.cell, payoffs, labels, unit),
  }))
}

// ── Per-student option order (for INSTRUCTOR-ADDED questions only) ─────────────
//
// ⚠ THE FOUR DERIVED QUESTIONS ARE DELIBERATELY NOT SHUFFLED. All four offer the SAME
// list — the distinct payoff values, sorted ascending — and their answers are 1, 15, 0
// and 10, so an option's position tracks its VALUE and says nothing about correctness.
// Scrambling a sorted numeric ladder would only make four numbers harder to compare.
//
// An instructor-added question has neither property: arbitrary labels in whatever order
// they were typed, and most people type the right answer first.

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
 * Fisher–Yates over (participant, field, position), whitelisted to the two client
 * fields. DETERMINISTIC: a student who answers, reloads and comes back sees the list
 * they answered on. Grading is by option VALUE, so order never touches a score.
 * A fresh hash per position — one draw reused across all positions would make the
 * permutation a function of a single number, and students would visibly share layouts.
 */
export function shuffleClientOptions(
  opts: readonly { value: string; label: string }[],
  participantId: string,
  field: string,
): { value: string; label: string }[] {
  const out = opts.map(o => ({ value: o.value, label: o.label }))
  for (let i = out.length - 1; i > 0; i--) {
    const j = hash32(`${participantId}:${field}:${i}`) % (i + 1)
    const tmp = out[i]
    out[i] = out[j]
    out[j] = tmp
  }
  return out
}

/** The KC as sent to the STUDENT — the answer key removed.
 *  `correct_value` and `explanation` are stripped: the explanation is earned by
 *  answering (the submit callable returns it), and the key is never client-side. */
export function toClientKcQuestions(resolved: PdKcQuestion[]) {
  return resolved.map(q => ({
    field: q.field,
    prompt: q.prompt,
    options: (q.options ?? []).map(o => ({ value: o.value, label: o.label })),
  }))
}

// ═══════════════════════════════════════════════════════════════════════════════
// THE THREE CONVERGENCE FIELDS, APPLIED (spec §5).
//
// ⚠⚠ `pdResolveKc` AND `pdKcScoringSet` ARE THE ONE ANSWER TO "WHICH QUESTIONS DOES THIS
// INSTANCE ASK?", and the serve path and the grader BOTH call them. That is not tidiness:
// a question hidden from the display but left in the grader's scoring set is graded against
// an answer the student never saw and inflates every denominator. Spec §5 names it as the
// most plausible bug this change introduces. One function, two callers, no second list.
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * PD's stages. Declared in config.ts (so the parser can validate against them without an
 * import cycle) and re-exported here, which is where callers look for question concerns.
 *
 * ⚠⚠ `post` MEANS **AFTER PLAY**, NOT "AFTER THE REVEAL" — pd has NO reveal. The bot's
 * assigned strategy is never shown to the student; inferring it from play IS the exercise
 * (spec §5). Shipping scorecard's "After the reveal" wording would name a screen this game
 * does not have.
 *
 * ⚠ `post` NOW RECEIVES ADDED QUESTIONS. It used to hold only the debrief, and the settings
 * block was told the stage accepted no additions — because no post-play question LIST was
 * rendered. It is rendered now: the post-play screen walks this whole stage, the debrief
 * row included, exactly as the pre-play screens walk theirs. No new phase was needed; the
 * debrief was already occupying that position in the sequence.
 */
export { PD_KC_STAGES, DEFAULT_ADDED_KC_STAGE, addedKcStage } from './config'
export type { PdKcStage } from './config'

/** The derived four's ids — pd's built-in set. */
export const PD_BUILT_IN_KC_IDS: ReadonlySet<string> = new Set(kcQuestions.map(q => q.field))

/**
 * Apply an instructor's wording to one derived question.
 *
 * ⚠⚠ TEXT ONLY, BY CONSTRUCTION. `options` is a map from an EXISTING option value to a
 * replacement LABEL, so this cannot add an option, drop one, reorder them, change a value,
 * or touch `correct_value`. Grading compares option VALUES, so an override provably cannot
 * move a score. An unknown option value in the map is ignored here and REFUSED at the
 * callable, so the instructor is told rather than silently having no effect.
 *
 * ⚠ The EXPLANATION is deliberately NOT overridable. It is generated prose citing the
 * question's own payoff numbers, and only non-interpolating questions can be overridden at
 * all — so nothing reachable here has an explanation worth rewriting.
 */
export function applyKcOverride(q: PdKcQuestion, overrides: KcOverrideMap): PdKcQuestion {
  const o = overrides[q.field]
  if (!o) return q
  return {
    ...q,
    prompt: o.prompt ?? q.prompt,
    options: o.options
      ? (q.options ?? []).map(opt => ({ value: opt.value, label: o.options![opt.value] ?? opt.label }))
      : q.options,
  }
}

/** Has an instructor rewritten this question? Drives the "edited" badge, nothing else. */
export function isKcOverridden(id: string, overrides: KcOverrideMap): boolean {
  return overrides[id] !== undefined
}

/**
 * This instance's DERIVED four: overridden, hidden ones removed, in the instance's order.
 *
 * ⚠ `kcEnabled: false` empties this entirely — the derived four are all graded, and D12
 * says the toggle gates graded questions.
 */
export function pdResolveKc(config: PdConfig): PdKcQuestion[] {
  if (!config.kcEnabled) return []
  const all = resolveKcQuestions(config.payoffs, config.unit, config.labels)
    .filter(q => config.kcHidden[q.field] !== true)
    .map(q => applyKcOverride(q, config.kcOverrides))
  return applyKcOrder(all, q => q.field, config.kcOrder)
}

/** An added question that carries a usable key, and therefore a mark. */
export function isGradedAdded(q: PdAddedKcQuestion): boolean {
  return q.type === 'mc' && typeof q.correct_value === 'string'
}

/**
 * This instance's ADDED questions: hidden ones removed, in order.
 *
 * ⚠⚠ D12 — `kcEnabled` GATES GRADED QUESTIONS ONLY. A graded addition disappears with the
 * toggle, exactly as the derived four do. An UNGRADED free-text addition does NOT: it is
 * governed by its own visibility checkbox, the same rule the debrief paragraph follows.
 * That is a deliberate behaviour change from the pre-convergence build, where the toggle
 * removed every addition regardless — recorded in the handoff.
 */
export function resolveAddedKcQuestions(
  config: PdConfig,
  /** ⚠ Omitted ⇒ EVERY stage. The grader calls it that way on purpose: gradedness is
   *  stage-independent (D3), so a post-stage MC question is graded and counts in the
   *  denominator exactly like a pre-play one. */
  stage?: PdKcStage,
): PdAddedKcQuestion[] {
  return applyKcOrder(resolveAddedKcQuestionsUnordered(config, stage), q => q.id, config.kcOrder)
}

/**
 * The same set WITHOUT the ordering pass.
 *
 * ⚠⚠ THE STAGE BUILDER USES THIS, AND THE REASON IS A LIVE DEFECT THIS FIXES (spec §6).
 * `order` must be applied EXACTLY ONCE, over the whole stage list. Applying it here AND
 * again over the stage means the second pass sorts against positions the first produced —
 * and because `applyKcOrder` falls back to an item's CURRENT index for an id the map does
 * not mention, a PARTIAL map then lands in an order neither pass intended. It is invisible
 * with a complete map, because complete maps are idempotent, which is how it shipped and
 * survived two passes.
 */
export function resolveAddedKcQuestionsUnordered(
  config: PdConfig,
  stage?: PdKcStage,
): PdAddedKcQuestion[] {
  const visible = config.addedKcQuestions.filter(q => config.kcHidden[q.id] !== true)
  const gated = config.kcEnabled ? visible : visible.filter(q => !isGradedAdded(q))
  return stage === undefined ? gated : gated.filter(q => addedKcStage(q) === stage)
}

/**
 * ⚠⚠ THE WHOLE `post` STAGE, IN ORDER — the debrief row plus any added questions assigned
 * there. This is what the post-play screen walks.
 *
 * The debrief is a ROW here, not a special case (spec D9): it takes part in `order` under
 * its own id, and its visibility is `debriefEnabled` rather than the `hidden` map, because
 * it is stored under `debrief_prompt` / `debrief_enabled` and NOT in the three convergence
 * maps. That boundary is what makes folding it into the list a change with no storage
 * migration.
 *
 * ⚠ `kind` is what routes a submit: `debrief` → pdSubmitDebrief, `added` → pdSubmitKcAnswer.
 * The client must not infer it from `type`, because an added free-text question is also
 * `type: 'text'` and goes to a different callable.
 */
export interface PdPostStageQuestion {
  kind: 'debrief' | 'added'
  field: string
  type: 'mc' | 'text'
  prompt: string
  placeholder?: string
  options: { value: string; label: string }[]
}

export function pdPostStageQuestions(config: PdConfig): PdPostStageQuestion[] {
  const rows: PdPostStageQuestion[] = []

  if (config.debriefEnabled) {
    rows.push({
      kind: 'debrief',
      field: debriefQuestion.field,
      type: 'text',
      // ⚠ The instructor's prompt from `debrief_prompt`, never the literal in the data
      // object — that literal is only the shape's required field.
      prompt: config.debriefPrompt,
      placeholder: debriefQuestion.placeholder,
      options: [],
    })
  }

  for (const q of resolveAddedKcQuestionsUnordered(config, 'post')) {
    rows.push({
      kind: 'added',
      field: q.id,
      type: q.type,
      prompt: q.prompt,
      options: q.options ?? [],
    })
  }

  // ⚠ Ordered ACROSS both kinds, so an instructor can put an added question before the
  // debrief paragraph. `applyKcOrder` is total on a partial map, so a row with no entry
  // keeps its authored position — the debrief first, additions after it.
  return applyKcOrder(rows, r => r.field, config.kcOrder)
}

/**
 * This instance's added questions IN THE CLIENT SHAPE — whitelisted field by field, and
 * SHUFFLED.
 *
 * ⚠⚠ THIS EXISTS SO THE SHUFFLE IS TESTABLE WHERE IT IS ACTUALLY WIRED. A mutation that
 * deleted the `shuffleClientOptions` call from `pdGetQuestions` survived a suite that
 * tested the shuffle helper directly — the helper was perfect and nothing called it. The
 * serve path now composes this, so a test of this function tests the real path.
 *
 * ⚠ NEVER SPREAD — every field is named, so a stored `correct_value` cannot ride out to a
 * student. A free-text question keeps `options: []`, which is the signal the client renders
 * a textarea on.
 */
/**
 * ⚠ `stage` IS REQUIRED, DELIBERATELY. It was optional-meaning-all-stages for about an
 * hour, and dropping the argument at the call site silently served every after-play
 * question BEFORE play — a mutation no unit test caught, because the tests passed the stage
 * explicitly. Requiring it makes that mutation a compile error; the harness covers the
 * runtime half. The grader's "every stage" case has its own call,
 * `resolveAddedKcQuestions(config)`, where the absence of a stage is the point.
 */
export function addedToClientKcQuestions(
  config: PdConfig,
  participantId: string,
  stage: PdKcStage,
): { field: string; type: 'mc' | 'text'; prompt: string; options: { value: string; label: string }[] }[] {
  return resolveAddedKcQuestions(config, stage).map(q => ({
    field: q.id,
    type: q.type,
    prompt: q.prompt,
    options: shuffleClientOptions(q.options ?? [], participantId, q.id),
  }))
}

/**
 * The `post` stage as the STUDENT receives it — the same list, with every added question's
 * options SHUFFLED.
 *
 * ⚠⚠ THE SHUFFLE APPLIES HERE TOO. A post-play added question is exactly as leakable as a
 * pre-play one — an instructor still types the right answer first — and routing the post
 * list around `shuffleClientOptions` would reintroduce the `cef36fe` tell in the one place
 * nobody thought to look. The serve path composes THIS, so a test of this function tests
 * the wiring rather than the primitive.
 */
export function postStageToClient(
  config: PdConfig,
  participantId: string,
): PdPostStageQuestion[] {
  return pdPostStageQuestions(config).map(r => (
    r.kind === 'added'
      ? { ...r, options: shuffleClientOptions(r.options, participantId, r.field) }
      : r
  ))
}

/**
 * ⚠⚠ THE GRADER'S SCORING SET — the whole of it, in one place.
 *
 * `pdSubmitKcAnswer` calls exactly this and builds no list of its own. Visible AND graded:
 * a hidden question is absent (it was never asked), and an ungraded one — free text, or an
 * mc whose key named no offered option and was dropped at parse time — is absent from the
 * numerator AND the denominator, so adding one cannot lower anybody's score.
 */
export function pdKcScoringSet(config: PdConfig): { field: string; correct_value: string }[] {
  return [
    ...pdResolveKc(config).map(q => ({ field: q.field, correct_value: q.correct_value! })),
    ...resolveAddedKcQuestions(config)
      .filter(isGradedAdded)
      .map(q => ({ field: q.id, correct_value: q.correct_value! })),
  ]
}
