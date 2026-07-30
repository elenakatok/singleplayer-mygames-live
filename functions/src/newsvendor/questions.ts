import type { PrepTextQuestion } from '@mygames/game-server'
import { hash32 } from './demand'
import type { NewsvendorConfig } from './config'
import { DEFAULT_NEWSVENDOR_CONFIG } from './config'

// ═══════════════════════════════════════════════════════════════════════════════
// Newsvendor — the KNOWLEDGE CHECK (spec §8, Newsvendor_KC_Questions_v1.md) and the
// two free-text questions, as DATA OBJECTS (standing platform constraint: never an
// inline array in student-flow code).
//
// ⚠⚠ THESE STEMS ARE STATIC CONTENT, NOT DERIVED FROM THE INSTANCE — and that is the
// OPPOSITE of pricing's rule, on purpose. Pricing derives every KC number from the
// live market so a student is never graded against a market they were not shown.
// Here the KC deliberately uses a DIFFERENT market from the one the student plays:
//
//     P = 120, c = 50, v = 50, g = 20, h = 10, Normal demand mean 500, sd 100
//
// so that students must REDO the calculation rather than recall a number off the
// place-order screen (KC doc, "⚠ These questions use a DIFFERENT market than the game
// plays"). Deriving them from config would destroy exactly the property they are
// built for. Every stem therefore carries its own numbers in its text.
//
// The safety this trades away is bought back in the harness instead: TEACHING_MARKET
// below is a real NewsvendorConfig, and the harness re-computes Q2–Q4 and Q7–Q8
// through the SHARED economics.ts and asserts the authored answer keys agree. So the
// authored numbers cannot silently drift from the engine that scores the game.
//
// ⚠ OPTIONS ARE SHUFFLED PER STUDENT (KC doc: "Randomize option order per render").
// The doc writes every correct answer as "A" for readability; a delivered KC that
// preserved that would be answerable without reading. The shuffle is DETERMINISTIC in
// (participant_id, field), so a student who reloads sees the same order rather than
// having the options move under them — and grading compares VALUES, never positions,
// so the order cannot affect a score either way.
//
// DENOMINATOR = 10, all graded (KC doc). It is computed from the served set, never
// hardcoded, so an instructor who adds questions or turns the KC off still gets a
// correct fraction.
//
// NO GATE, as in PD and pricing: a wrong answer is recorded and scored, and the
// student continues regardless.
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * The KC's teaching market — the numbers written into the stems above.
 *
 * Exported as a full config so the harness can drive the SHARED economics.ts with it
 * and check the authored keys. It is NEVER used to play a game and never reaches an
 * instance; `periods` and the display toggles are inherited from the defaults purely
 * to satisfy the type.
 *
 * Its implied solution, which the stems state: CU = 120 − 50 + 20 = 90;
 * CO = 50 − (50 − 10) = 10; CR = 0.90; z(0.90) = 1.28; Q* = 500 + 1.28·100 = 628.
 */
export const TEACHING_MARKET: NewsvendorConfig = {
  ...DEFAULT_NEWSVENDOR_CONFIG,
  P: 120, c: 50, v: 50, g: 20, h: 10,
  isNormal: true, mean: 500, sd: 100,
}

type Option = { value: string; label: string }

interface KcSpec {
  field: string
  prompt: string
  options: Option[]
  correct_value: string
  explanation: string
}

// ── The ten authored questions (KC doc Q1–Q10) ─────────────────────────────────

const KC_SPECS: readonly KcSpec[] = [
  {
    field: 'kc_cr_concept',
    prompt:
      'In the newsvendor problem, the critical ratio (the target in-stock probability) '
      + 'is chosen to balance two costs. Which two?',
    options: [
      { value: 'over_under', label: 'The cost of ordering too much (overage) against the cost of ordering too little (underage)' },
      { value: 'price_cost', label: 'The retail price against the production cost' },
      { value: 'salvage_holding', label: 'The salvage value against the holding cost' },
      { value: 'mean_sd', label: 'The mean of demand against its standard deviation' },
    ],
    correct_value: 'over_under',
    explanation:
      'The method trades off overage against underage. The other pairs are inputs to those '
      + 'two costs, not the trade-off itself.',
  },
  {
    field: 'kc_underage',
    prompt:
      'A product sells for P = 120, costs c = 50 to make, has salvage value v = 50, holding '
      + 'cost h = 10, and goodwill (shortage) cost g = 20 per unit short. What is the underage '
      + 'cost — the cost of being one unit short of demand?',
    options: [
      { value: 'cu_90', label: '$90' },
      { value: 'cu_70', label: '$70' },
      { value: 'cu_120', label: '$120' },
      { value: 'cu_30', label: '$30' },
    ],
    correct_value: 'cu_90',
    explanation:
      'Being short loses the margin (P − c = 70) plus the goodwill cost g = 20, so the underage '
      + 'cost is 90. $70 forgets goodwill; $120 is the price itself; $30 is g + h.',
  },
  {
    field: 'kc_overage',
    prompt:
      'For the same product (c = 50, v = 50, h = 10), what is the overage cost — the net cost '
      + 'of one leftover unit at the end of the period?',
    options: [
      { value: 'co_10', label: '$10' },
      { value: 'co_0', label: '$0' },
      { value: 'co_50', label: '$50' },
      { value: 'co_40', label: '$40' },
    ],
    correct_value: 'co_10',
    explanation:
      'A leftover unit cost 50 to make; you recover salvage 50 but pay holding 10, so net '
      + 'recovery is 40 and the overage cost is 50 − 40 = 10. $0 forgets holding, $50 forgets '
      + 'salvage entirely, and $40 is the net salvage itself rather than the cost.',
  },
  {
    field: 'kc_critical_ratio',
    prompt:
      'Given CU = 90 and CO = 10, what is the critical ratio (the optimal probability that '
      + 'demand is met)?',
    options: [
      { value: 'cr_090', label: '0.90' },
      { value: 'cr_010', label: '0.10' },
      { value: 'cr_9', label: '9.0' },
      { value: 'cr_045', label: '0.45' },
    ],
    correct_value: 'cr_090',
    explanation:
      'CR = CU / (CU + CO) = 90 / 100 = 0.90. 0.10 is the complement (the over-ordering ratio); '
      + '9.0 is the odds CU / CO, which is not a probability.',
  },
  {
    field: 'kc_direction',
    prompt: 'At a critical ratio of 0.90, the optimal order quantity Q* is:',
    options: [
      { value: 'above', label: 'Above mean demand, because the critical ratio is above 0.50' },
      { value: 'at', label: "Exactly at mean demand, because that's the expected demand" },
      { value: 'below', label: 'Below mean demand, to avoid costly leftovers' },
      { value: 'unknown', label: 'It cannot be determined without knowing demand each period' },
    ],
    correct_value: 'above',
    explanation:
      'A critical ratio above 0.50 puts the optimal quantity above the median — which for a '
      + 'Normal is the mean. Ordering the mean would leave you short more often than the '
      + 'economics justify.',
  },
  {
    field: 'kc_qstar',
    prompt:
      'Demand is Normal with mean 500 and standard deviation 100. The critical ratio is 0.90, '
      + 'which corresponds to z = 1.28. Using Q* = mean + z·sd, the optimal order quantity is:',
    options: [
      { value: 'q_628', label: '628' },
      { value: 'q_500', label: '500' },
      { value: 'q_372', label: '372' },
      { value: 'q_590', label: '590' },
    ],
    correct_value: 'q_628',
    explanation:
      'Q* = 500 + 1.28·100 = 628. 500 forgets safety stock; 372 subtracts the safety stock '
      + "instead of adding it; 590 confuses the critical-ratio value 0.90 with the z it maps to.",
  },
  {
    field: 'kc_profit_leftover',
    prompt:
      'For the same product (P = 120, c = 50, v = 50, h = 10, g = 20), suppose you order Q = 600 '
      + 'and demand turns out to be D = 400. Profit = P·(sold) − c·Q + (leftover)·(v − h) − '
      + '(shortage)·g. What is your profit?',
    options: [
      { value: 'p_26000', label: '$26,000' },
      { value: 'p_18000', label: '$18,000' },
      { value: 'p_48000', label: '$48,000' },
      { value: 'p_42000', label: '$42,000' },
    ],
    correct_value: 'p_26000',
    explanation:
      'Sold = min(600, 400) = 400, so revenue is 48,000; production costs 50·600 = 30,000; the '
      + '200 leftover units salvage at the net rate 40 for +8,000; there is no shortage. '
      + '48,000 − 30,000 + 8,000 = 26,000.',
  },
  {
    field: 'kc_profit_shortage',
    prompt:
      'Now suppose you order Q = 400 and demand is D = 700. What is your profit?',
    options: [
      { value: 's_22000', label: '$22,000' },
      { value: 's_28000', label: '$28,000' },
      { value: 's_48000', label: '$48,000' },
      { value: 's_14000', label: '$14,000' },
    ],
    correct_value: 's_22000',
    explanation:
      'Sold = min(400, 700) = 400, so revenue is 48,000; production costs 50·400 = 20,000; there '
      + 'is no leftover; the 300 units short cost goodwill 20 each, −6,000. '
      + '48,000 − 20,000 − 6,000 = 22,000. $28,000 forgets the goodwill penalty entirely.',
  },
  {
    field: 'kc_salvage_rises',
    prompt:
      'If the salvage value v increases (you recover more for leftover units), holding '
      + 'everything else fixed, the optimal order quantity Q* should:',
    options: [
      { value: 'up', label: 'Increase — leftovers are less costly, so ordering more is safer' },
      { value: 'down', label: 'Decrease — higher salvage means you need fewer units' },
      { value: 'same', label: "Stay the same — salvage doesn't enter the order decision" },
      { value: 'up_if_above_p', label: 'Increase only if v exceeds the retail price P' },
    ],
    correct_value: 'up',
    explanation:
      'A higher salvage value lowers the overage cost CO, which raises the critical ratio and '
      + 'therefore Q*. Cheaper mistakes on the leftover side justify ordering more.',
  },
  {
    field: 'kc_variability',
    prompt:
      'Two markets have the same mean demand and the same critical ratio (0.90), but Market B '
      + 'has a larger standard deviation of demand than Market A. The optimal order quantity in '
      + 'Market B is:',
    options: [
      { value: 'higher', label: 'Higher than in Market A — more variability means more safety stock above the mean' },
      { value: 'lower', label: 'Lower than in Market A — more risk means order less' },
      { value: 'same', label: 'The same — Q* depends only on the mean' },
      { value: 'higher_if_price', label: 'Higher only if the retail price also rises' },
    ],
    correct_value: 'higher',
    explanation:
      'Q* = mean + z·sd with z = 1.28 > 0, so a larger sd scales up the safety-stock term and '
      + 'pushes Q* further above the mean. (If the critical ratio were below 0.50, z would be '
      + 'negative and the effect would reverse.)',
  },
]

/** How many authored questions this build ships. The denominator is derived from the
 *  served set, never from this constant — it exists so the harness can assert the set
 *  is the full ten rather than a truncated copy. */
export const AUTHORED_KC_COUNT = KC_SPECS.length

// ── Per-student option order ───────────────────────────────────────────────────

/**
 * A Fisher–Yates shuffle driven by a hash of (participant, field), so it is stable for
 * one student and different across students.
 *
 * Stability matters more than it looks: a student who answers, reloads, and returns to
 * a re-ordered list would be reading a different screen from the one they answered on.
 * Grading is by option VALUE, so order never touches a score.
 */
function shuffleFor(participantId: string, field: string, options: readonly Option[]): Option[] {
  const out = [...options]
  for (let i = out.length - 1; i > 0; i--) {
    // A fresh hash per position — reusing one 32-bit draw across all positions would
    // make the permutation a function of a single number, so only 2^32 of the possible
    // orders could ever appear and students would visibly share layouts.
    const j = hash32(`${participantId}:${field}:${i}`) % (i + 1)
    const tmp = out[i]
    out[i] = out[j]
    out[j] = tmp
  }
  return out
}

// ── Resolution ─────────────────────────────────────────────────────────────────

/** A resolved knowledge-check question: the shared model, fully built. */
export type NewsvendorKcQuestion = PrepTextQuestion & {
  field: string
  prompt: string
  options: Option[]
  correct_value: string
  explanation: string
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
 * This instance's knowledge check, with THIS student's option order.
 *
 * Pure — no Firestore. Both the serve path (newsvendorGetQuestions) and the grade path
 * (newsvendorSubmitKcAnswer) call this with the same participant id, so the options a
 * student sees and the answer they are graded against cannot disagree.
 */
export function resolveNewsvendorKcQuestions(participantId: string): NewsvendorKcQuestion[] {
  return KC_SPECS.map((spec, i) => ({
    ...kcBase,
    field: spec.field,
    order: i + 1,
    prompt: spec.prompt,
    options: shuffleFor(participantId, spec.field, spec.options),
    correct_value: spec.correct_value,
    explanation: spec.explanation,
  }))
}

/** The KC as sent to the STUDENT — the answer key removed. `correct_value` and
 *  `explanation` are stripped: the explanation is earned by answering (the submit
 *  callable returns it), and the key is never client-side. */
export function toClientKcQuestions(resolved: NewsvendorKcQuestion[]) {
  return resolved.map(q => ({
    field: q.field,
    prompt: q.prompt,
    options: q.options.map(o => ({ value: o.value, label: o.label })),
  }))
}

// ── The two free-text questions (spec §8) ──────────────────────────────────────
//
// ⚠ TWO of them, and EACH GETS ITS OWN TIER-2 REPORT (spec §8, last line). They are
// not a before/after pair of the same question: the prep asks how a student INTENDS
// to decide before they have seen any demand, and the debrief asks what they actually
// did over twenty periods. Elena reads them side by side.
//
// Ungraded BY CONSTRUCTION: neither carries `grading` or `correct_value`, so neither
// can reach calcKCScore's denominator.

/** Asked BEFORE play (spec §8). The prompt lives in config so an instructor can edit
 *  it; the literal here is only the shape's required field. */
export const prepQuestion: PrepTextQuestion = {
  field: 'prep_strategy',
  order: 1,
  type: 'text',
  format: 'text',
  // The shared model's name for this category is 'preparation' (game-server's
  // PrepTextQuestion), not 'prep' — the field id below is what this game calls it.
  category: 'preparation',
  system: false,
  placeholder: 'A sentence or two is plenty.',
  hidden: false,
  deletable: false,
  role_target: 'all',
  prompt: '',
}

/** Asked AFTER play (spec §8, REGULAR mode). Part 2 swaps the PROMPT for the dual
 *  wording on a dual instance — the field, the storage and the report stay as they
 *  are, exactly as pricing's debrief switches on `pmg`. */
export const debriefQuestion: PrepTextQuestion = {
  field: 'debrief_regular',
  order: 1,
  type: 'text',
  format: 'text',
  category: 'debrief',
  system: false,
  placeholder: 'A few sentences are plenty.',
  hidden: false,
  deletable: false,
  role_target: 'all',
  prompt: '',
}

/** The two free-text fields, in flow order. One list, so the submit callable's
 *  whitelist and the report's tiles can never disagree about what exists. */
export const FREE_TEXT_FIELDS = [prepQuestion.field, debriefQuestion.field] as const
