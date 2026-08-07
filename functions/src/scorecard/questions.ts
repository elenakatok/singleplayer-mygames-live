import { marginalThreshold, type ScorecardConfig, type ScorecardTruth } from './config'
import { binomialAtLeast } from './dp'

// ═══════════════════════════════════════════════════════════════════════════════
// KNOWLEDGE CHECK (spec §9) and the DEBRIEF PROMPT (spec §10).
//
// ⚠⚠ QUESTIONS ARE DATA OBJECTS, NEVER INLINE ARRAYS (S7, standing platform constraint).
//
// ⚠⚠ EVERY NUMBER DERIVES FROM CONFIG (spec §9). A hardcoded "10 ECU" is wrong the moment
// an instructor edits a probability — and Q1/Q2 exist precisely to make the student
// compute that number, so a stale stem would be teaching the wrong arithmetic.
//
// ⚠ Q1 AND Q2 USE THE GENERAL THRESHOLD FORM (Elena, 08-07): the answer is
// `(highEffortCost − lowEffortCost) / (reliability − pAcceptableLow)`, taken from
// `marginalThreshold()` — the same function the settings panel and the solver use. It is
// NOT `c / (reliability − p_low)` with a hardcoded numerator, which is only right while
// `lowEffortCost` is 0.
//
// ⚠ THE KC RUNS BEFORE PLAY, so deriving stems from config is safe here in a way it is
// NOT in forecast. There, a stem derived from the model would print the answer to the
// exercise; here every number in a stem is one spec §8 says the student is TOLD anyway.
// What the KC must still not disclose is the DESIGN — that reliability alternates, that
// there are two conditions, that the counterbalancing exists. Q1/Q2 and Q3/Q4 each show
// two probabilities, which is unavoidable (they are the arithmetic being tested), but
// they are framed as two SITUATIONS, never as "your two conditions".
// ═══════════════════════════════════════════════════════════════════════════════

/** One multiple-choice option. `id` is stable; the client keys on it, never on text. */
export interface KcOption {
  id: string
  text: string
}

/** One graded question (spec §9). */
export interface KcQuestion {
  id: string
  /** The stem, with every number already interpolated from config. */
  prompt: string
  options: KcOption[]
  /** ⚠ NEVER SHIPS TO A STUDENT — `toClientKcQuestions` drops it. */
  correctOptionId: string
  /** Shown after answering. Also never ships with the question itself. */
  explanation: string
  /** What the question is testing — instructor-facing, for the reports. */
  tests: string
}

const pct = (x: number) => `${Math.round(x * 100)}%`
const ecu = (x: number, currency: string) =>
  `${Number.isInteger(x) ? x : Number(x.toFixed(2))} ${currency}`

/**
 * A "round wrong number" slot, with a collision guard.
 *
 * ⚠ THE ONE PLACE §9's "every number derives" DOES NOT LITERALLY APPLY, and the reason is
 * that there is nothing to derive: this distractor encodes no quantity. Q3 and Q4 each
 * need a fourth option that is merely a plausible round percentage — the OTHER three
 * options each encode a real confusion (the period rate, the complement, the other
 * situation's answer) and are computed. At the shipped defaults this yields spec §9's own
 * 90% and 25%.
 *
 * The guard is what keeps it config-safe: if an instructor edit brings the fixed value
 * within `spread` of the correct answer or of any other option, the next candidate down
 * the ladder is used instead, so a distractor can never quietly become defensible.
 */
function roundDistractor(preferred: number, taken: number[], spread = 0.08): number {
  const ladder = [preferred, 0.9, 0.75, 0.5, 0.25, 0.1, 0.99]
  for (const c of ladder) {
    if (taken.every(t => Math.abs(t - c) >= spread)) return c
  }
  return preferred
}

/** Shuffle-free option assembly: `correct` plus distractors, in the given order. */
function opts(entries: [string, string][]): KcOption[] {
  return entries.map(([id, text]) => ({ id, text }))
}

/**
 * The knowledge check for ONE instance, derived from its live config.
 *
 * ⚠ Takes config AND truth because Q1–Q4 are about the two reliabilities. The RESULT is
 * student-facing, so it deliberately never names the conditions or says there are two of
 * them — see the file header.
 */
export function scorecardKcQuestions(
  config: ScorecardConfig,
  truth: ScorecardTruth,
): KcQuestion[] {
  const { currency, targetScore: S, periodsPerContract: T } = config
  const cHigh = config.highEffortCost
  const cLow = config.lowEffortCost
  const pLow = config.pAcceptableLow
  const relHigh = truth.reliabilityHigh
  const relLow = truth.reliabilityLow

  // ── The two thresholds — the pair the whole game turns on (spec §6.1) ───────
  const thHigh = marginalThreshold(config, relHigh)
  const thLow = marginalThreshold(config, relLow)
  const costGap = cHigh - cLow
  /** Dividing by the LEVEL instead of the GAIN — the most common wrong method. */
  const byLevel = (rel: number) => costGap / rel
  /** Dividing by p_low — the other wrong denominator. */
  const byPLow = costGap / pLow

  // ── The two contract-level probabilities (spec §9 Q3/Q4) ───────────────────
  const pReachHigh = binomialAtLeast(T, relHigh, S)
  const pReachLow = binomialAtLeast(T, relLow, S)

  return [
    {
      id: 'q1_threshold_high',
      prompt:
        `High effort costs ${ecu(cHigh, currency)} and lifts the chance of an acceptable ` +
        `delivery from ${pct(pLow)} to ${pct(relHigh)}. How much must ONE more point on the ` +
        `${config.scorecardNoun} be worth before high effort pays for itself?`,
      options: opts([
        ['a', ecu(thHigh, currency)],
        ['b', ecu(costGap, currency)],
        ['c', ecu(byLevel(relHigh), currency)],
        ['d', ecu(thLow, currency)],
      ]),
      correctOptionId: 'a',
      explanation:
        `High effort buys ${pct(relHigh - pLow)} more chance of a point for ` +
        `${ecu(costGap, currency)}, so a point must be worth more than ` +
        `${ecu(costGap, currency)} ÷ ${(relHigh - pLow).toFixed(2)} = ${ecu(thHigh, currency)}. ` +
        `Dividing by ${pct(relHigh)} instead of by the ${pct(relHigh - pLow)} GAIN is the ` +
        `usual slip — what you are buying is the increase, not the level.`,
      tests: 'The marginal rule',
    },
    {
      id: 'q2_threshold_low',
      prompt:
        `Same ${ecu(cHigh, currency)} cost — but now high effort lifts the chance of an ` +
        `acceptable delivery from ${pct(pLow)} to only ${pct(relLow)}. Now how much must one ` +
        `more point be worth?`,
      options: opts([
        ['a', ecu(thLow, currency)],
        ['b', ecu(thHigh, currency)],
        ['c', ecu(costGap, currency)],
        ['d', ecu(byPLow, currency)],
      ]),
      correctOptionId: 'a',
      explanation:
        `The cost has not moved, but the gain has collapsed from ${pct(relHigh - pLow)} to ` +
        `${pct(relLow - pLow)} — so the bar rises from ${ecu(thHigh, currency)} to ` +
        `${ecu(thLow, currency)}. ⚠ This is the whole exercise in one number: the same ` +
        `effort, at the same price, has to buy ${(thLow / thHigh).toFixed(0)}× as much before ` +
        `it is worth spending.`,
      tests: 'The treatment as arithmetic',
    },
    {
      id: 'q3_reach_high',
      prompt:
        `Suppose you use high effort in all ${T} ${config.periodNoun}s, at a ${pct(relHigh)} ` +
        `chance each ${config.periodNoun}. What is the chance you finish with at least ` +
        `${S} points and earn the bonus?`,
      options: (() => {
        const filler = roundDistractor(0.9, [pReachHigh, relHigh, 1 - pReachHigh])
        return opts([
          ['a', `About ${pct(pReachHigh)}`],
          ['b', `About ${pct(relHigh)}`],
          ['c', `About ${pct(filler)}`],
          ['d', `About ${pct(1 - pReachHigh)}`],
        ])
      })(),
      correctOptionId: 'a',
      explanation:
        `A ${pct(relHigh)} chance PER ${config.periodNoun.toUpperCase()} is not a ` +
        `${pct(relHigh)} chance per ${config.contractNoun}. Needing ${S} of ${T} leaves real ` +
        `room to fall short — the actual chance is about ${pct(pReachHigh)}.`,
      tests: 'A per-period rate is not a per-contract rate',
    },
    {
      id: 'q4_reach_low',
      prompt:
        `Same question, but at a ${pct(relLow)} chance each ${config.periodNoun}: high effort ` +
        `in all ${T} ${config.periodNoun}s. What is the chance you reach ${S} points?`,
      options: (() => {
        const filler = roundDistractor(0.25, [pReachLow, relLow, pReachHigh])
        return opts([
          ['a', `About ${pct(pReachLow)}`],
          ['b', `About ${pct(relLow)}`],
          ['c', `About ${pct(filler)}`],
          ['d', `About ${pct(pReachHigh)}`],
        ])
      })(),
      correctOptionId: 'a',
      explanation:
        `About ${pct(pReachLow)} — working flat out, every ${config.periodNoun}, and still ` +
        `almost certainly missing the target. ⚠ That is what effort buys when the ` +
        `${config.scorecardNoun} barely responds to it: you pay ` +
        `${ecu(costGap * T, currency)} for a ${pct(pReachLow)} shot.`,
      tests: 'How little effort buys when the scorecard is unreliable',
    },
    {
      id: 'q5_coasting',
      prompt:
        `Two ${config.periodNoun}s are left in the ${config.contractNoun} and your ` +
        `${config.scorecardNoun} already shows ${S} points. What should you do?`,
      options: opts([
        ['a', `Low effort in both`],
        ['b', `High effort in both`],
        ['c', `High effort in one, low in the other`],
        ['d', `High effort, to build a cushion in case a delivery is rejected`],
      ]),
      correctOptionId: 'a',
      explanation:
        `The bonus is already won and nothing above ${S} pays anything, so one more point ` +
        `is worth 0 — far below the ${ecu(thHigh, currency)} bar. Points already banked ` +
        `cannot be taken away, so there is no cushion to build.`,
      tests: 'Coasting',
    },
    {
      id: 'q6_writing_off',
      prompt:
        `Two ${config.periodNoun}s are left and your ${config.scorecardNoun} shows ` +
        `${Math.max(0, S - 3)} points. What should you do?`,
      options: opts([
        ['a', `Low effort in both`],
        ['b', `High effort in both`],
        ['c', `High effort in one, low in the other`],
        ['d', `High effort — there is still a chance`],
      ]),
      correctOptionId: 'a',
      explanation:
        `Even if both remaining deliveries are accepted you finish on ` +
        `${Math.max(0, S - 3) + 2}, short of ${S}. The bonus is already gone, so every ` +
        `${currency} spent from here buys nothing at all. ⚠ Nothing on the screen will tell ` +
        `you this — noticing it is the point.`,
      tests: 'Writing off',
    },
    {
      id: 'q7_squeeze',
      prompt: `When is a single high-effort ${config.periodNoun} worth the most?`,
      options: opts([
        ['a', `When your score is close to ${S} and there are just enough ${config.periodNoun}s left`],
        ['b', `At the very start of the ${config.contractNoun}, to get ahead early`],
        ['c', `At the very end of the ${config.contractNoun}, whatever the score`],
        ['d', `It is worth the same in every ${config.periodNoun}`],
      ]),
      correctOptionId: 'a',
      explanation:
        `One point is worth the whole ${ecu(config.bonus, currency)} bonus exactly when it ` +
        `is PIVOTAL — when it turns a miss into a hit. Early on there is time to recover, so ` +
        `no single point decides anything; once the target is met or lost, no point decides ` +
        `anything either. The value is concentrated in between.`,
      tests: 'The squeeze',
    },
    {
      id: 'q8_thesis',
      prompt:
        `A buyer's ${config.scorecardNoun} is driven mostly by things the supplier cannot ` +
        `control. What should the supplier do — and what does the buyer end up getting?`,
      options: opts([
        ['a', `Stop paying for effort; the buyer stops buying improvement`],
        ['b', `Work harder, to stand out from the noise`],
        ['c', `Work harder; the buyer gets the same quality either way`],
        ['d', `Nothing changes — the ${config.scorecardNoun} still ranks suppliers correctly`],
      ]),
      correctOptionId: 'a',
      explanation:
        `A ${config.scorecardNoun} that barely responds to effort stops BUYING effort. It ` +
        `still gets published, suppliers still get ranked and renewals still hang on it — ` +
        `but the one thing it no longer does is make anyone try harder. That is why ` +
        `reliability is a property a ${config.scorecardNoun} must have, not a nice-to-have.`,
      tests: "The lecture's thesis",
    },
  ]
}

/** The KC as it ships to a student. ⚠ The answer key and explanation are DROPPED. */
export interface ClientKcQuestion {
  id: string
  prompt: string
  options: KcOption[]
}

export function toClientKcQuestions(questions: readonly KcQuestion[]): ClientKcQuestion[] {
  // Built field by field, never spread — a field added to KcQuestion later cannot ride
  // out to a student by accident.
  return questions.map(q => ({
    id: q.id,
    prompt: q.prompt,
    options: q.options.map(o => ({ id: o.id, text: o.text })),
  }))
}

/** How many questions are graded — the denominator. ⚠ DYNAMIC, never a hardcoded /8. */
export function kcDenominator(questions: readonly KcQuestion[]): number {
  return questions.length
}

// ── Debrief (spec §10) ────────────────────────────────────────────────────────

/**
 * The free-text debrief prompt.
 *
 * ⚠⚠ IT MUST NOT NAME THE TREATMENT (spec §10). Even though the conditions are labelled
 * on screen, the reveal comes AFTER submit — students who never acted on the label are
 * the most valuable data in the room, and a prompt that said "you played under two
 * different reliabilities" would retroactively let them claim they had noticed.
 *
 * So the prompt asks whether they worked harder on SOME contracts than others and what
 * was different about them, and lets the student supply the reason or fail to.
 */
export interface DebriefQuestion {
  id: string
  prompt: string
  /** Sub-prompts, rendered beneath the headline. */
  followUps: string[]
}

export function scorecardDebriefQuestion(config: ScorecardConfig): DebriefQuestion {
  return {
    id: 'debrief_effort',
    prompt:
      `Did you work harder on some ${config.contractNoun}s than others — and what was ` +
      `different about them?`,
    followUps: [
      `How did you decide when to use high effort?`,
      `Was there a point in any ${config.contractNoun} where you stopped trying?`,
      `If you were the buyer, and your ${config.scorecardNoun} only weakly reflected what ` +
      `your supplier actually did, what would you change?`,
    ],
  }
}
