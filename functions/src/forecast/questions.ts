import type { PrepTextQuestion } from '@mygames/game-server'
import { hash32 } from './demand'

// ═══════════════════════════════════════════════════════════════════════════════
// Forecasting — the KNOWLEDGE CHECK (spec §8) and the single debrief question
// (spec §9), as DATA OBJECTS (standing platform constraint: never an inline array in
// student-flow code).
//
// ⚠⚠ THE STEMS CARRY THEIR OWN NUMBERS AND ARE NOT DERIVED FROM THE INSTANCE — the
// newsvendor precedent, and here it is a LEAK CONTROL rather than a pedagogy
// preference. Spec §8's header says "all numbers auto-derive from config (never-stale
// principle)", but the KC runs BEFORE play (spec §4), and this game's config is the
// answer: deriving a stem from a, b, H or σ would print a model parameter on a screen
// the student sees before they have forecast anything, which spec §4's whitelist rule
// ("no a/b/S/σ, ever") forbids outright.
//
// In practice nothing in Q1–Q9 needs the instance at all — every question is about a
// lecture concept with self-contained numbers — with ONE exception, noted at Q6 below.
//
// ⚠ OPTIONS ARE SHUFFLED PER STUDENT. Spec §8 writes the correct answer first for
// readability; a delivered KC that preserved that order would be answerable without
// reading. The shuffle is DETERMINISTIC in (participant_id, field), so a student who
// reloads sees the same order rather than having the options move under them — and
// grading compares VALUES, never positions, so order cannot affect a score either way.
//
// DENOMINATOR = 9, all graded (spec §8). It is computed from the SERVED set, never
// hardcoded, so an instructor who adds questions or turns the KC off still gets a
// correct fraction. There is no `/9` anywhere in the grading path.
//
// NO GATE, as in PD, pricing and newsvendor: a wrong answer is recorded and scored, and
// the student continues regardless.
// ═══════════════════════════════════════════════════════════════════════════════

type Option = { value: string; label: string }

interface KcSpec {
  field: string
  prompt: string
  options: Option[]
  correct_value: string
  explanation: string
}

/**
 * The trend figure used in Q6's hypothetical.
 *
 * ⚠ DELIBERATELY NOT THE INSTANCE'S OWN TREND, and this is a considered deviation from
 * spec §8's literal wording, which writes Q6 as "risen about 4 units a month" — the
 * shipped model's actual b.
 *
 * WHY: the KC runs before play. A stem stating the game's own trend would hand the
 * student b for free on the screen before the one where they are asked to infer it,
 * which spec §4 forbids in as many words ("no a/b/S/σ, ever"). The question tests a
 * CONCEPT — a naive "repeat last month" forecast on a rising series is biased low — and
 * the concept transfers at any trend, so nothing pedagogical is lost by using a
 * different number. Flagged to Elena at Checkpoint 3.
 */
const Q6_TREND_UNITS = 12

// ── The nine authored questions (spec §8, Q1–Q9) ───────────────────────────────

const KC_SPECS: readonly KcSpec[] = [
  {
    field: 'kc_systematic',
    prompt:
      'Sales rise every December and fall every February, year after year. This is an '
      + 'example of:',
    options: [
      { value: 'systematic', label: 'Systematic variability' },
      { value: 'unsystematic', label: 'Unsystematic variability' },
      { value: 'forecast_error', label: 'Forecast error' },
      { value: 'random_noise', label: 'Random noise' },
    ],
    correct_value: 'systematic',
    explanation:
      'A pattern that repeats year after year is systematic — it can be explained and '
      + 'therefore forecast. Unsystematic variability is what is left over once you have '
      + 'explained everything explicable.',
  },
  {
    field: 'kc_goal',
    prompt: 'The goal of demand forecasting is best described as:',
    options: [
      { value: 'eliminate', label: 'Eliminate all forecast error' },
      { value: 'explain_describe', label: "Explain systematic variability and describe what's left" },
      { value: 'exact', label: 'Predict every period exactly' },
      { value: 'inventory', label: 'Minimize inventory' },
    ],
    correct_value: 'explain_describe',
    explanation:
      'Some variability cannot be predicted, so eliminating all error and predicting every '
      + 'period exactly are both impossible. The job is to explain the part that IS '
      + 'systematic and to describe the size of what remains.',
  },
  {
    field: 'kc_mse_penalty',
    prompt:
      'Forecaster A misses by 20 units every month. Forecaster B is perfect three months '
      + 'in four, then misses by 80. Over four months, who has the lower MSE?',
    options: [
      { value: 'a', label: 'Forecaster A' },
      { value: 'b', label: 'Forecaster B' },
      { value: 'tie', label: 'They tie' },
      { value: 'unknown', label: 'Not enough information' },
    ],
    correct_value: 'a',
    explanation:
      "A's MSE is 20² = 400. B's is (0 + 0 + 0 + 80²)/4 = 1,600 — four times worse, even "
      + 'though both average an absolute error of 20. Squaring punishes the one big miss far '
      + 'more than the many small ones, which is exactly why MSE is the objective here.',
  },
  {
    field: 'kc_coefficient',
    prompt:
      'A store regresses 24 months of sales on a time trend and a promotion indicator, and '
      + 'gets Sales = 405.5 + 3.77·Month + 198.7·Promotion. What does the 198.7 mean?',
    options: [
      { value: 'units_higher', label: 'Sales in promotion months are 198.7 units higher than in non-promotion months, holding the trend constant' },
      { value: 'percent_higher', label: 'Sales in promotion months are 198.7% higher' },
      { value: 'per_year', label: 'Sales grow 198.7 units per year' },
      { value: 'error', label: 'The forecast error in promotion months is 198.7' },
    ],
    correct_value: 'units_higher',
    explanation:
      'The coefficient on an indicator variable is the difference in the level between the '
      + 'two groups, holding everything else in the model fixed. It is in units, not '
      + 'percentages, and it is separate from the trend term.',
  },
  {
    field: 'kc_pvalue',
    prompt:
      'In that same output, the coefficient on Month has a p-value of 0.0000013. What do '
      + 'you conclude?',
    options: [
      { value: 'detectable_trend', label: 'There is a detectable upward trend in sales' },
      { value: 'no_trend', label: 'There is no detectable trend' },
      { value: 'promo_insignificant', label: 'The promotion effect is insignificant' },
      { value: 'explains_nothing', label: 'The model explains nothing' },
    ],
    correct_value: 'detectable_trend',
    explanation:
      'A p-value that small says the trend is very unlikely to be an accident of this '
      + 'sample, and the coefficient is positive — so there is a real upward trend. Note '
      + 'this is the OPPOSITE verdict to the lecture example, where the trend was not '
      + 'significant: read the p-value, do not recall the conclusion.',
  },
  {
    field: 'kc_trend_bias',
    prompt:
      `Demand has risen about ${Q6_TREND_UNITS} units a month for five years. You forecast `
      + "next month at exactly this month's level. Your errors will be:",
    options: [
      { value: 'random', label: 'Random around zero' },
      { value: 'too_low', label: 'Systematically too low' },
      { value: 'too_high', label: 'Systematically too high' },
      { value: 'unaffected', label: 'Unaffected' },
    ],
    correct_value: 'too_low',
    explanation:
      'On a rising series, last month is on average below next month, so a forecast that '
      + 'repeats it is too low nearly every time. The errors are not noise — they are a '
      + 'bias, and a bias is visible as a run of same-signed errors.',
  },
  {
    field: 'kc_moving_average',
    prompt:
      'You forecast each month using the average of the previous twelve months. What does '
      + 'this do to a repeating annual pattern?',
    options: [
      { value: 'captures', label: 'Captures it' },
      { value: 'removes', label: 'Removes it entirely' },
      { value: 'doubles', label: 'Doubles it' },
      { value: 'december_only', label: 'Only affects December' },
    ],
    correct_value: 'removes',
    explanation:
      'Averaging over a full year includes every month exactly once, so the highs and lows '
      + 'cancel and the average carries no seasonality at all. The forecast is then the '
      + 'same in December as in June — which is the trap that looks sophisticated.',
  },
  {
    field: 'kc_chasing_noise',
    prompt:
      'Demand wobbles unpredictably around a stable pattern. You revise your forecast up '
      + 'whenever demand comes in high and down whenever it comes in low. Your MSE will:',
    options: [
      { value: 'rise', label: 'Rise' },
      { value: 'fall', label: 'Fall' },
      { value: 'same', label: 'Stay the same' },
      { value: 'fall_if_large', label: 'Fall only if the wobble is large' },
    ],
    correct_value: 'rise',
    explanation:
      'You are trying to explain unsystematic variability. Because the wobble is '
      + 'unpredictable, last month\'s surprise says nothing about next month\'s — so '
      + 'chasing it moves your forecast away from the true mean and makes your errors '
      + 'bigger, not smaller.',
  },
  {
    field: 'kc_parsimony',
    prompt:
      'Sales are higher on Friday and Saturday and flat the rest of the week. You add a '
      + 'separate indicator for every single day instead of one weekend indicator. What '
      + 'happens to the accuracy of your future forecasts?',
    options: [
      { value: 'slightly_worse', label: 'Gets slightly worse' },
      { value: 'improves', label: 'Improves' },
      { value: 'unchanged', label: 'Unchanged' },
      { value: 'improves_with_data', label: 'Improves only with more data' },
    ],
    correct_value: 'slightly_worse',
    explanation:
      'The extra indicators have nothing real to measure, so each one is estimated from '
      + 'noise. Every parameter you estimate adds a little error to your forecasts, so a '
      + 'model with parameters it does not need forecasts slightly worse than the lean one '
      + 'that fits the same pattern.',
  },
]

/** How many authored questions this build ships (spec §8: nine). The denominator is
 *  derived from the served set, never from this constant — it exists so the harness can
 *  assert the set is the full nine rather than a truncated copy. */
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
export type ForecastKcQuestion = PrepTextQuestion & {
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
 * Pure — no Firestore. Both the serve path (forecastGetQuestions) and the grade path
 * (forecastSubmitKcAnswer) call this with the same participant id, so the options a
 * student sees and the answer they are graded against cannot disagree. That is what
 * makes "'x' is not a valid graded KC question" impossible rather than merely unlikely.
 */
export function resolveForecastKcQuestions(participantId: string): ForecastKcQuestion[] {
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
export function toClientKcQuestions(resolved: ForecastKcQuestion[]) {
  return resolved.map(q => ({
    field: q.field,
    prompt: q.prompt,
    options: q.options.map(o => ({ value: o.value, label: o.label })),
  }))
}

// ── The single debrief question (spec §9) ──────────────────────────────────────
//
// ⚠ ONE FREE-TEXT QUESTION, NOT TWO. Newsvendor asks a prep question before play and a
// debrief after; spec §9 gives this game exactly one, asked after the final results
// screen. The Tier-2 contract follows from that (one report, one question), and
// resume.ts counts on it. Do not add a prep question without a spec change.
//
// Ungraded BY CONSTRUCTION: it carries no `grading` and no `correct_value`, so it
// cannot reach calcKCScore's denominator.

export const debriefQuestion: PrepTextQuestion = {
  field: 'debrief_method',
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
