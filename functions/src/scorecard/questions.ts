import type { ScorecardAddedKcQuestion, ScorecardConfig, ScorecardTruth, KcStage } from './config'
import { addedKcStage, DEFAULT_CONFIG, DEFAULT_TRUTH } from './config'
import { hash32 } from './rng'
import { applyKcOrder, type KcOverrideMap, type KcIdGuard } from '../shared/kcSurface'

export type { KcStage } from './config'

// ═══════════════════════════════════════════════════════════════════════════════
// KNOWLEDGE CHECK (spec §9) — SPLIT PRE/POST PLAY — and the two free-text steps (§10).
//
// ⚠⚠ THE STRATEGY QUESTIONS MOVED AFTER PLAY (Elena, 08-07), and the reason is not
// pacing. Asking students to work out the marginal threshold BEFORE playing
// **taught the answer before measuring the behaviour** — the game exists to find out what
// they do when nobody has told them, and a pre-play question that walks them through the
// arithmetic destroys the measurement.
//
// ⚠⚠ ALL THRESHOLD ARITHMETIC IS DELETED FROM THE GAME ENTIRELY, before AND after. Elena
// does not teach it. The earlier Q1/Q2 ("how much must one point be worth?") are gone, not
// moved. If a future edit reintroduces `marginalThreshold` into this file, that is the
// decision being reversed by accident — the DP and its arithmetic are instructor-facing
// only (§3.1, §11 chart 4, the optimizer robot).
//
// ⚠⚠ NOTHING PRE-PLAY MAY STATE THAT A TARGET CAN BECOME UNREACHABLE. An earlier draft
// asked "two periods left, score 4 — can you still earn the bonus?", which hands over
// §4.1's inference outright. That inference IS the decision under test. Q8 asks it only
// AFTER play, where it can no longer contaminate anything.
//
// ⚠⚠ NO HBS CASE TEXT, EXHIBITS OR FIGURES ARE REPRODUCED HERE (Elena, 08-07). Students
// buy the case in their packet. Every question names a person, plant or situation and
// stands on its own — a reader who has not opened the case can still answer from the
// sentence in front of them. Do not paste an exhibit, a table, or a quotation into a stem.
//
// ⚠ Questions are DATA OBJECTS, never inline arrays (S7). Q5/Q6's numbers derive from live
// config and are ROUNDED before render — `(4−0)/(0.4−0.3)` is `39.999999999999986` and
// would otherwise ship as an answer option (found at CP2). A `/\d\.\d{4,}/` guard runs
// across every option in the harness.
// ═══════════════════════════════════════════════════════════════════════════════

export interface KcOption {
  id: string
  text: string
}

export interface KcQuestion {
  id: string
  stage: KcStage
  prompt: string
  options: KcOption[]
  /** ⚠ NEVER SHIPS TO A STUDENT — `toClientKcQuestions` drops it. */
  correctOptionId: string
  explanation: string
  /** Instructor-facing gloss, for the reports. */
  tests: string
}

/** ⚠ Rounds before render — see the header on the 39.999999999999986 case. */
const round2 = (x: number) => Math.round(x * 100) / 100
const ecu = (x: number, currency: string) => `${round2(x)} ${currency}`

const opts = (entries: [string, string][]): KcOption[] =>
  entries.map(([id, text]) => ({ id, text }))

// ⚠ `roundDistractor` WAS DELETED WITH Q5's REWRITE (08-08). It existed to mint one
// "plausible round number" slot — the single accepted departure from "every number derives
// from config", recorded at CP2 — and Q5 was its only caller. Q5's fourth option is now
// `endowment − cost × score`, a derived misreading rather than a round guess, so the
// departure no longer exists and nothing needs the helper. `distinctValues` below is not a
// replacement for it: it de-duplicates values that are ALL derived.

/**
 * ⚠⚠ A DISTRACTOR THAT EQUALS THE ANSWER MARKS EVERY STUDENT WHO PICKS IT WRONG, AND IS
 * RIGHT. Q5's three distractors are all COMPUTED — `answer + bonus`, `endowment`, and
 * `endowment − cost×score` — so an instructor edit can collapse any of them onto the
 * answer or onto each other:
 *
 *   bonus = 0                    ⇒ "bonus added anyway" == the answer
 *   highEffortCost = 0           ⇒ "costs forgotten" == the answer, and so does the third
 *   targetScore − 2 == 6         ⇒ "paid for successes" == the answer (same period count)
 *
 * None of those is exotic; `lowEffortCost: 0` is already the shipped default, and a
 * zero-bonus demonstration instance is a thing an instructor would plausibly build.
 *
 * This keeps the answer, admits each preferred distractor ONLY if it is distinct from
 * everything already accepted, then tops the list up from a ladder that steps away from
 * the answer. A short list is fine and is what pricing does too — four options that
 * include a duplicate of the answer is not.
 *
 * `minGap` is 1, not the effort cost: the meaningful distractors can legitimately sit
 * close together (26 and 30 at the defaults are 4 apart, and a larger gap would reject
 * the most instructive wrong answer in the set). One unit is enough to stop two options
 * rendering as the same number.
 */
function distinctValues(
  answer: number,
  preferred: number[],
  step: number,
  want = 4,
  /**
   * ⚠⚠ EVERY VALUE MUST BE STRICTLY BELOW THIS. Q6 passes the true low-effort rate,
   * because its distractors mean "a SCALED-DOWN low rate" — one printed ABOVE the answer
   * answers a confusion nobody has and quietly makes the item easier, since the scaling
   * story rules it out on sight. Caught by driving `pAcceptableLow: 0.03`, where the
   * top-up ladder stepped UP and printed 4% against a true rate of 3%.
   *
   * Q5 passes nothing: overpaying and underpaying are both real arithmetic slips, so its
   * distractors legitimately sit on either side of the answer.
   */
  cap?: number,
): number[] {
  const out = [round2(answer)]
  const minGap = 1
  const free = (v: number) =>
    Number.isFinite(v) && v >= 0
    && (cap === undefined || v < cap)
    && out.every(t => Math.abs(t - v) >= minGap)

  for (const p of preferred) {
    const r = round2(p)
    if (out.length < want && free(r)) out.push(r)
  }
  // Top up. ⚠ Bounded — a config that makes every candidate collide must yield a SHORTER
  // LIST, never spin and never pad with something invalid. A two-option question is
  // answerable; a wrong one is not. At `pAcceptableLow: 0` Q6 correctly drops to the
  // answer plus "it depends", because below 0% there is no plausible number to offer.
  const rung = Math.max(1, Math.abs(step))
  for (let k = 1; out.length < want && k <= 12; k++) {
    const down = round2(answer - k * rung)
    if (free(down)) { out.push(down); continue }
    // Upward only when no cap forbids it — see the note on `cap`.
    const up = round2(answer + k * rung)
    if (free(up)) out.push(up)
  }
  return out
}

/**
 * The whole question set for ONE instance, derived from its live config.
 *
 * Pre-play: four case-thinking questions plus two rules-comprehension questions.
 * Post-play: four strategy questions, asked only after the §10 reveal.
 */
export function scorecardKcQuestions(
  config: ScorecardConfig,
  truth: ScorecardTruth,
): KcQuestion[] {
  const { currency, targetScore: S, periodsPerContract: T, scorecardNoun, buyerName } = config
  const cHigh = config.highEffortCost
  const cLow = config.lowEffortCost
  const pLow = config.pAcceptableLow
  const relLow = truth.reliabilityLow
  /** ⚠ Q6 needs BOTH condition rates — it contrasts a good contract with a bad one. */
  const relHigh = truth.reliabilityHigh

  // ── Q5: a worked earnings figure, straight from spec §1's formula ─────────
  //
  // ⚠⚠ THE STEM STATES EVERY PARAMETER IT USES (Elena, 08-08). It used to assume the
  // student remembered the endowment, the high-effort cost and the bonus. Recall is not
  // the skill under test — applying the formula is — so the three now appear in the stem.
  // They still INTERPOLATE, so a parameter edit moves the stem, the answer and the
  // distractors together and they cannot drift apart.
  const q5High = Math.min(6, T)
  const q5Score = Math.max(0, S - 2)
  const q5Earnings = config.endowmentPerContract - cHigh * q5High - cLow * (T - q5High)
  /** Adding the bonus that was NOT earned — the score is short of the target. */
  const q5WithBonus = q5Earnings + config.bonus
  /** Forgetting that effort is paid for at all. */
  const q5NoCost = config.endowmentPerContract
  /**
   * ⚠ Paying only for the periods that WORKED. The score is the count of acceptable
   * deliveries, so charging `q5Score` periods instead of `q5High` is the reading that
   * effort is only paid for when it succeeds — the exact misreading Q5 exists to catch.
   * 50 − 4×5 = 30 at the shipped defaults.
   */
  const q5PaidForSuccesses = config.endowmentPerContract - cHigh * q5Score

  // ── Q6: low effort is the SAME on every contract ──────────────────────────
  //
  // ⚠⚠ REPLACED ENTIRELY (Elena, 08-08). The old Q6 asked for 40% − 30%, which is
  // subtraction rather than a thought. This asks the same fact in the form that matters:
  // given the low-effort rate on a GOOD contract, what is it on a BAD one?
  //
  // ⚠⚠ THE DISTRACTORS ARE SCALED-DOWN VERSIONS OF THE LOW RATE, and that is the whole
  // design. A student who picks one has assumed the two rates move together — which is
  // precisely the misreading that would make the entire reliability treatment INVISIBLE
  // to them, because if low effort fell alongside high effort there would be nothing to
  // notice and nothing to respond to. The old question could not catch it.
  const q6HighRate = Math.round(relHigh * 100)
  const q6LowConditionRate = Math.round(relLow * 100)
  const q6LowEffortRate = Math.round(pLow * 100)

  return [
    // ═══ PRE-PLAY — case thinking (spec §9.1) ══════════════════════════════
    // ⚠ These test REASONING ABOUT the case, not recall of its facts. A student who
    // read the case can answer; so can one reasoning from the sentence itself. Neither
    // needs an exhibit reproduced here.
    {
      id: 'q1_negotiated_ppm',
      stage: 'pre',
      // ⚠⚠ THE EXCLUSION CLAUSE WAS DROPPED (Elena, 08-08) BECAUSE THE ITEM WAS AMBIGUOUS.
      // The old stem bundled two OPPOSITE effects: excluding a one-time spike RAISES
      // reliability (it removes variation the supplier did not cause), while negotiating
      // the figures LOWERS it (it adds an input that is not effort). Both "weakens" and
      // "strengthens" were defensible, so the item measured which effect a student
      // happened to weight rather than whether they understood either. The stem now names
      // only the negotiation, and the answer follows from it alone.
      prompt:
        `Ellie Smith negotiates parts-per-million figures with suppliers, and can code a `
        + `reject so that it does not count against them. He says some suppliers "try to `
        + `negotiate their numbers" rather than troubleshoot. What does this do to the `
        + `${scorecardNoun}'s power to motivate?`,
      options: opts([
        ['a', `Weakens it — part of the score now reflects how well a supplier argued rather than how it performed`],
        // ⚠ THE FAIRNESS DISTRACTOR IS GONE WITH THE CLAUSE IT REFERRED TO. "Removing
        // one-time spikes makes the score fairer" answers a stem that no longer mentions
        // removing noise, and keeping it would reintroduce the ambiguity by the back door.
        // Its replacement stays on the negotiation itself.
        ['b', `Strengthens it — a supplier arguing about its numbers is paying closer attention to its quality`],
        ['c', `No effect — the adjustments are small relative to total volume`],
        ['d', `Strengthens it — suppliers work harder when they can appeal a reject`],
      ]),
      correctOptionId: 'a',
      explanation:
        `A ${scorecardNoun} motivates by making the score depend on what the supplier did. `
        + `Every point that can be argued for instead of earned moves part of the score away `
        + `from the supplier's own actions — so a plant that gets better at negotiating gains `
        + `exactly what a plant that gets better at troubleshooting gains, and effort stops `
        + `being the thing that pays.`,
      tests: 'That negotiable adjustments decouple score from behaviour',
    },
    {
      id: 'q2_charged_for_clean_parts',
      stage: 'pre',
      prompt:
        `Jack Dawkins is charged for 75 parts that he says were clean when they left his plant. `
        + `From his plant's point of view, what does that do to the value of working harder on `
        + `cleanliness?`,
      options: opts([
        ['a', `Lowers it — part of his score moves for reasons he cannot control`],
        ['b', `Raises it — he now has more to prove and a stronger reason to improve`],
        ['c', `No change — 75 parts is too small to matter either way`],
        ['d', `Raises it — cleaner parts would make the charge easier to dispute`],
      ]),
      correctOptionId: 'a',
      explanation:
        `Whether or not the charge was correct, Dawkins has just learned that his score can `
        + `move without his plant doing anything differently. Effort buys less when part of the `
        + `result is out of your hands — and that is true regardless of who was actually at fault.`,
      tests: 'Attribution error as a reliability problem',
    },
    {
      id: 'q3_buyers_ignore_score',
      stage: 'pre',
      prompt:
        `Some suppliers believe ${buyerName}'s buyers award work to whoever they want, more or `
        + `less regardless of the ${scorecardNoun}. If a supplier believes that, what happens to `
        + `its reason to improve?`,
      options: opts([
        ['a', `It falls — the score stops predicting the consequence`],
        ['b', `It rises — the supplier must work harder to stand out some other way`],
        ['c', `Nothing — suppliers improve because of their own standards`],
        ['d', `It rises — a good score becomes a useful argument in the negotiation`],
      ]),
      correctOptionId: 'a',
      explanation:
        `A ${scorecardNoun} motivates through the consequence attached to it. Break the link `
        + `between score and award and the score still gets published and suppliers still get `
        + `ranked — it just stops buying anything. ⚠ Note this is the same failure as an `
        + `unreliable measurement, arriving from the other end.`,
      tests: 'That the score must predict a consequence',
    },
    {
      id: 'q4_comfortably_green',
      stage: 'pre',
      prompt:
        `A plant sits comfortably in Green with the quarter nearly over. What is its incentive `
        + `for the rest of the quarter, and what does ${buyerName} get?`,
      options: opts([
        ['a', `Ease off; ${buyerName} buys no further improvement in that window`],
        ['b', `Push harder to build a cushion for next quarter`],
        ['c', `Unchanged — Green suppliers are the most motivated ones`],
        ['d', `Ease off; ${buyerName} still gets the improvement because standards are internal`],
      ]),
      correctOptionId: 'a',
      explanation:
        `A rating with bands has a ceiling inside each band. Once a plant is safely inside one, `
        + `further improvement changes nothing it is paid for — so the last weeks of the quarter `
        + `buy ${buyerName} nothing at all.`,
      tests: 'Coasting, in the case rather than in the game',
    },

    // ═══ PRE-PLAY — rules comprehension (spec §9.1) ═════════════════════════
    {
      id: 'q5_earnings_arithmetic',
      stage: 'pre',
      prompt:
        `Each ${config.contractNoun} starts with an endowment of ${ecu(config.endowmentPerContract, currency)}. `
        // ⚠ "low effort is free" IS ONLY TRUE AT `lowEffortCost: 0`, which is the shipped
        // default but IS a setting (spec §3). Stating it unconditionally would put a false
        // sentence in front of students the moment an instructor gave low effort a price —
        // and the answer below already charges for it, so the stem would contradict the key.
        + (cLow === 0
          ? `High effort costs ${ecu(cHigh, currency)} per ${config.periodNoun}; low effort is free. `
          : `High effort costs ${ecu(cHigh, currency)} per ${config.periodNoun}; low effort costs ${ecu(cLow, currency)}. `)
        + `Reaching a score of ${S} earns a bonus of ${ecu(config.bonus, currency)}.\n\n`
        + `You use high effort in ${q5High} of the ${T} ${config.periodNoun}s and finish with a `
        + `score of ${q5Score}. What are your earnings for that ${config.contractNoun}?`,
      options: (() => {
        // ⚠ See `distinctValues` — all three distractors are computed and an instructor
        // edit can collapse any of them onto the answer.
        const vals = distinctValues(
          q5Earnings,
          [q5WithBonus, q5NoCost, q5PaidForSuccesses],
          Math.max(1, cHigh) * 2,
        )
        return opts(vals.map((v, i) => [String.fromCharCode(97 + i), ecu(v, currency)]))
      })(),
      correctOptionId: 'a',
      explanation:
        `${round2(config.endowmentPerContract)} − ${round2(cHigh)} × ${q5High}`
        + (cLow === 0 ? `` : ` − ${round2(cLow)} × ${T - q5High}`)
        // ⚠⚠ A PRE-PLAY EXPLANATION IS PRE-PLAY TEXT. A first draft of this ended "…which
        // is what makes spending it on a contract you cannot win a real loss" — which
        // states outright that a contract can become unwinnable, the one inference §9.1
        // exists to withhold until Q8 asks it post-play. Explanations are shown the moment
        // a question is answered, so they are bound by §9.1 exactly as stems are.
        + ` = ${round2(q5Earnings)}. A score of ${q5Score} is short of ${S}, so there is no `
        + `bonus — but the effort was spent either way. ⚠ Effort is paid for whether or not `
        + `it works.`,
      tests: 'That effort is paid for regardless of outcome',
    },
    {
      id: 'q6_low_effort_is_shared',
      stage: 'pre',
      prompt:
        // ⚠ `an ${deliveryNoun}`, NOT `an acceptable ${deliveryNoun}` — the noun already
        // reads "acceptable delivery" at the defaults, and prefixing it produced "an
        // acceptable acceptable delivery". Same construction EffortScreen uses.
        `On a ${config.contractNoun} where high effort gives an ${config.deliveryNoun} `
        + `${q6HighRate}% of the time, low effort gives ${q6LowEffortRate}%. On a `
        + `${config.contractNoun} where high effort gives only ${q6LowConditionRate}%, low `
        + `effort gives —`,
      options: (() => {
        // ⚠⚠ THE TWO WRONG NUMBERS ARE SCALED-DOWN LOW RATES, and both must sit strictly
        // BELOW the true rate — a distractor above it would be answering a different
        // confusion. Two different scale factors are used rather than one, so the item does
        // not depend on a student guessing which specific scaling was intended; what it
        // detects is the belief that ANY scaling happens.
        //
        // ⚠ Deduplicated for the same reason Q5's are: at a small `pAcceptableLow` the two
        // scalings round together (3% → 2% and 2%), and at zero everything collapses.
        const scaled = distinctValues(
          q6LowEffortRate,
          [Math.round(q6LowEffortRate * 2 / 3), Math.round(q6LowEffortRate / 2)],
          Math.max(1, Math.round(q6LowEffortRate / 3)),
          3,
          // ⚠ Capped at the true rate — see `distinctValues`. Every wrong number here
          // means "lower, because this contract is worse"; one printed higher would be
          // dismissible on sight.
          q6LowEffortRate,
        ).slice(1)
        return opts([
          ['a', `${q6LowEffortRate}% — low effort is the same on every ${config.contractNoun}; only high effort changes`],
          ...scaled.map((v, i) => [String.fromCharCode(98 + i), `${v}%`] as [string, string]),
          ['d', `It depends on the ${config.contractNoun}`],
        ])
      })(),
      correctOptionId: 'a',
      explanation:
        `${q6LowEffortRate}%. ⚠ Low effort gives ${q6LowEffortRate}% on EVERY `
        + `${config.contractNoun} — that number never changes. What changes between `
        + `${config.contractNoun}s is only what HIGH effort gives you, which is why the two `
        + `kinds of ${config.contractNoun} are worth different amounts of effort. If the low `
        + `rate fell too, there would be nothing to notice and nothing to respond to.`,
      tests: 'That low effort is the same in both conditions — and that the rates do not move together',
    },

    // ═══ POST-PLAY — strategy, after the §10 reveal (spec §9.2) ═════════════
    // ⚠ Qualitative. No arithmetic, and nothing here could have been asked earlier
    // without handing over the decision the game was measuring.
    {
      id: 'q7_coasting',
      stage: 'post',
      prompt:
        `Two ${config.periodNoun}s remain in a ${config.contractNoun} and you have already `
        + `reached the target. What is worth doing?`,
      options: opts([
        ['a', `Nothing more — effort can no longer change the outcome`],
        ['b', `Keep using high effort, in case a delivery is rejected`],
        ['c', `Use high effort once, to be safe`],
        ['d', `Keep using high effort — a higher score is worth more`],
      ]),
      correctOptionId: 'a',
      explanation:
        `The bonus is already won and nothing above ${S} pays anything. Points already banked `
        + `cannot be taken away, so there is no cushion to build — every ${currency} spent from `
        + `here buys nothing.`,
      tests: 'Coasting',
    },
    {
      id: 'q8_written_off',
      stage: 'post',
      prompt:
        `Two ${config.periodNoun}s remain, your ${scorecardNoun} score is ${Math.max(0, S - 3)}, `
        + `and the target is ${S}. What is worth doing?`,
      options: opts([
        ['a', `Nothing more — the bonus is already out of reach`],
        ['b', `Use high effort in both — there is still a chance`],
        ['c', `Use high effort in one of them`],
        ['d', `It depends on how reliable this ${config.contractNoun} is`],
      ]),
      correctOptionId: 'a',
      explanation:
        `Even if both remaining deliveries are accepted you finish on `
        + `${Math.max(0, S - 3) + 2}, short of ${S}. ⚠ Nothing on the screen told you this while `
        + `you were playing — noticing it was the decision being tested.`,
      tests: 'Writing off',
    },
    {
      id: 'q9_squeeze',
      stage: 'post',
      prompt: `Across a ${config.contractNoun}, when does one ${config.periodNoun} of high effort matter most?`,
      options: opts([
        ['a', `When your score is close to the target with just enough ${config.periodNoun}s left`],
        ['b', `At the very start, to get ahead early`],
        ['c', `At the very end, whatever the score`],
        ['d', `It matters the same in every ${config.periodNoun}`],
      ]),
      correctOptionId: 'a',
      explanation:
        `One delivery is worth the whole bonus exactly when it is PIVOTAL — when it turns a `
        + `miss into a hit. Early on there is time to recover, so nothing single decides it; `
        + `once the target is met or lost, nothing decides it either.`,
      tests: 'The squeeze',
    },
    {
      id: 'q10_thesis',
      stage: 'post',
      prompt:
        `A buyer's ${scorecardNoun} is driven mostly by things the supplier cannot control. `
        + `What should the supplier do, and what does the buyer get?`,
      options: opts([
        ['a', `Stop paying for effort; the buyer stops buying improvement`],
        ['b', `Work harder, to stand out from the noise`],
        ['c', `Work harder; the buyer gets the same quality either way`],
        ['d', `Nothing changes — the ${scorecardNoun} still ranks suppliers correctly`],
      ]),
      correctOptionId: 'a',
      explanation:
        `A ${scorecardNoun} that barely responds to effort stops BUYING effort. It still gets `
        + `published, suppliers still get ranked and renewals still hang on it — the one thing it `
        + `no longer does is make anyone try harder. That is why reliability is a property a `
        + `${scorecardNoun} must have, not a nice-to-have.`,
      tests: "The lecture's thesis",
    },
  ]
}

/** Questions for one stage. ⚠ The caller must never merge the two. */
export function questionsForStage(all: readonly KcQuestion[], stage: KcStage): KcQuestion[] {
  return all.filter(q => q.stage === stage)
}

// ═══════════════════════════════════════════════════════════════════════════════
// THE THREE CONVERGENCE FIELDS, APPLIED (spec §5).
//
// ⚠⚠ `resolveKcQuestions` IS THE ONE ANSWER TO "WHICH QUESTIONS DOES THIS INSTANCE ASK?",
// and BOTH the serve path (`scorecardGetQuestions`) and the grader
// (`scorecardSubmitKcAnswer`) call it. That is not tidiness — a question hidden from the
// display but left in the grader's `forScoring` set is graded against an answer the student
// never saw and inflates every denominator, and it is the single most plausible bug this
// change introduces (spec §5). One function, two callers, no second filter.
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Apply an instructor's wording to one question.
 *
 * ⚠⚠ TEXT ONLY, BY CONSTRUCTION. `options` is a map from an EXISTING option id to a
 * replacement LABEL, so this cannot add an option, drop one, reorder them, change an id, or
 * touch `correctOptionId`. Grading compares option IDS (`answer === q.correctOptionId`), so
 * an override provably cannot move a score. An unknown option id in the map is ignored
 * rather than appended.
 *
 * ⚠ The EXPLANATION is deliberately NOT overridable. It is generated prose that cites the
 * question's own numbers, and a locked question cannot be overridden at all — so the only
 * questions reachable here are static ones whose explanation is already correct as written.
 */
export function applyKcOverride(q: KcQuestion, overrides: KcOverrideMap): KcQuestion {
  const o = overrides[q.id]
  if (!o) return q
  return {
    ...q,
    prompt: o.prompt ?? q.prompt,
    options: o.options
      ? q.options.map(opt => ({ id: opt.id, text: o.options![opt.id] ?? opt.text }))
      : q.options,
  }
}

/** Has an instructor rewritten this question? Drives the "edited" badge, nothing else. */
export function isKcOverridden(id: string, overrides: KcOverrideMap): boolean {
  return overrides[id] !== undefined
}

/** ⚠ Stage order is structural, not an instructor setting. See `resolveKcQuestions`. */
const SCORECARD_STAGE_ORDER = ['pre', 'post'] as const

/** One instance's built-in questions: overridden, hidden ones removed, in stage order. */
export function resolveKcQuestions(
  config: ScorecardConfig,
  truth: ScorecardTruth,
): KcQuestion[] {
  // ⚠⚠ THE `kcEnabled` GATE LIVES HERE, not in the caller. It used to be a
  // `config.kcEnabled ? resolveKcQuestions(...) : []` ternary in `getQuestions` ALONE —
  // which meant `kcScoringSet` (and therefore the grader's denominator) still counted all
  // ten built-ins on an instance whose students were served none of them. The blanket
  // `if (!kcEnabled) throw` in submitKcAnswer hid that, and removing that gate for D12
  // would have exposed it. One function decides; both callers get the same answer.
  //
  // ⚠ The built-ins are ALL graded, so gating them here is exactly D12: the toggle removes
  // graded questions. Ungraded additions survive it — see `resolveAddedKcQuestions`.
  if (!config.kcEnabled) return []

  const all = scorecardKcQuestions(config, truth)
    .filter(q => config.kcHidden[q.id] !== true)
    .map(q => applyKcOverride(q, config.kcOverrides))
  // Ordered WITHIN a stage — the pre/post split is structural and an `order` map must
  // never be able to move a post-play strategy question in front of play.
  return ([...SCORECARD_STAGE_ORDER] as KcStage[])
    .flatMap(stage => applyKcOrder(
      all.filter(q => q.stage === stage), q => q.id, config.kcOrder,
    ))
}

/**
 * One instance's added questions: hidden ones removed, in order, for ONE stage.
 *
 * ⚠⚠ D12 — `kcEnabled` GATES GRADED QUESTIONS ONLY. A graded addition disappears with the
 * toggle, exactly as the built-in ten do. An UNGRADED free-text addition does NOT: it is
 * governed by its own visibility checkbox, the same rule the §10 free-text steps follow.
 *
 * ⚠ ALIGNED TO PD. Scorecard used to gate ALL additions on the toggle — the gating lived in
 * `getQuestions` as `config.kcEnabled ? resolve(...) : []`, which also meant the grader's
 * scoring set (which calls this with no stage) disagreed with the serve path about what an
 * instance asks. Moving the rule in here makes one function answer that question for both,
 * and makes scorecard and pd say the same thing about the same toggle.
 */
export function resolveAddedKcQuestions(
  config: ScorecardConfig,
  stage?: KcStage,
): ScorecardAddedKcQuestion[] {
  const visible = config.addedKcQuestions.filter(q => config.kcHidden[q.id] !== true)
  const gated = config.kcEnabled ? visible : visible.filter(q => !isGradedAdded(q))
  const scoped = stage === undefined ? gated : gated.filter(q => addedKcStage(q) === stage)
  return applyKcOrder(scoped, q => q.id, config.kcOrder)
}

/**
 * ⚠⚠ THE GRADER'S SCORING SET — the whole of it, in one place.
 *
 * `scorecardSubmitKcAnswer` calls exactly this and does not build a list of its own. That
 * is the mechanism behind spec §5's warning: the serve path and the grader must agree about
 * which questions exist, and they cannot disagree if only one of them decides.
 *
 * ⚠ VISIBLE **AND** GRADED. A hidden question is absent (it was never asked); an ungraded
 * one — free text, or an mc whose key named no offered option and was dropped at parse
 * time — is absent from the numerator AND the denominator, so adding one cannot lower
 * anybody's score.
 */
export function kcScoringSet(
  config: ScorecardConfig,
  truth: ScorecardTruth,
): { field: string; correct_value: string }[] {
  return [
    ...resolveKcQuestions(config, truth).map(q => ({ field: q.id, correct_value: q.correctOptionId })),
    ...resolveAddedKcQuestions(config)
      .filter(isGradedAdded)
      .map(q => ({ field: q.id, correct_value: q.correct_value! })),
  ]
}

/**
 * The knowledge-check score to STORE, or null when there is nothing to score.
 *
 * ⚠ PROMOTED TO `@mygames/game-server` (v0.29.0) and re-exported here. It shipped local to
 * scorecard in fb4a33d; pd needed the identical rule, so rather than let each game
 * re-derive it — and get it subtly different — the body now lives beside `calcKCScore`,
 * which is the function whose empty-set answer (1.0) it exists to correct. See its note
 * there for why `calcKCScore` itself must not change.
 *
 * Kept as a named re-export rather than deleted outright so scorecard's own call sites and
 * tests keep importing from one place.
 */
export { kcScoreOrNull } from '@mygames/game-server'

/**
 * The BUILT-IN ids — the collision guard's authority, and scorecard's strategy for it.
 *
 * ⚠⚠ AN EXPLICIT SET, NOT A `kc_` PREFIX RULE, AND THAT IS SCORECARD-SPECIFIC. pd, pricing,
 * forecast and newsvendor reject any added id starting with `kc_` because their built-ins
 * own that namespace. Scorecard's built-in ids are UNPREFIXED (`q1_negotiated_ppm`), so a
 * prefix rule would let one straight through — and the grader looks built-ins up FIRST, so
 * the instructor's key would be shadowed and students marked against the built-in answer.
 * The shared parser carries both strategies (spec §5); this is the one scorecard passes.
 *
 * ⚠ Resolved against the DEFAULTS, deliberately, and it needs no Firestore read: a built-in
 * question's ID is a literal, while only its prompt and options interpolate config.
 *
 * ⚠ Do NOT migrate these ids to gain a prefix — stored answers are keyed by question id,
 * and renaming orphans every stored answer.
 */
export const BUILT_IN_KC_IDS: ReadonlySet<string> = new Set(
  scorecardKcQuestions(DEFAULT_CONFIG, DEFAULT_TRUTH).map(q => q.id),
)

export const SCORECARD_KC_ID_GUARD: KcIdGuard = { kind: 'idSet', ids: BUILT_IN_KC_IDS }

/** The KC as it ships to a student. ⚠ Answer key and explanation are DROPPED. */
export interface ClientKcQuestion {
  id: string
  stage: KcStage
  prompt: string
  options: KcOption[]
}

/**
 * ⚠⚠ PER-STUDENT OPTION ORDER. Every question above declares its answer FIRST, as `'a'` —
 * which is readable to write and review, and was a live tell to a student: ten questions
 * whose answer is always the top radio button is answerable without reading one of them.
 * The authoring order is kept and the SERVED order is permuted here, so the two concerns
 * stay separate.
 *
 * DETERMINISTIC IN (participant, question). A student who answers, reloads and comes back
 * must see the list they answered on — a re-ordered list on return is a different screen
 * from the one they read, and on a graded item that is indistinguishable from tampering.
 *
 * ⚠ GRADING IS BY OPTION ID (`answer === q.correctOptionId` in scorecardSubmitKcAnswer),
 * never by index, so order cannot touch a score. That is the property that makes this a
 * presentation change and nothing more — do not "simplify" grading to a position.
 */
function shuffleFor(participantId: string, questionId: string, options: readonly KcOption[]): KcOption[] {
  const out = [...options]
  for (let i = out.length - 1; i > 0; i--) {
    // A fresh hash per position. One 32-bit draw reused across all positions would make
    // the permutation a function of a single number, so students would visibly share
    // layouts — the same reasoning newsvendor's shuffle records.
    const j = hash32(`${participantId}:${questionId}:${i}`) % (i + 1)
    const tmp = out[i]
    out[i] = out[j]
    out[j] = tmp
  }
  return out
}

export function toClientKcQuestions(
  questions: readonly KcQuestion[],
  participantId: string,
): ClientKcQuestion[] {
  // Built field by field, never spread — a field added to KcQuestion later cannot ride out
  // to a student by accident.
  return questions.map(q => ({
    id: q.id,
    stage: q.stage,
    prompt: q.prompt,
    options: shuffleFor(participantId, q.id, q.options).map(o => ({ id: o.id, text: o.text })),
  }))
}

/**
 * Instructor-added questions in the SAME client shape as the built-in ten, so the student
 * screen and the resume logic cannot tell them apart.
 *
 * ⚠⚠ THE STAGE IS THE INSTRUCTOR'S (spec D13). It used to be pinned to `'post'` because
 * spec §9.1 keeps the PRE set closed — nothing before play may state that a target can
 * become unreachable. That rule survives as the settings page's save-time warning rather
 * than as this pin. An added question with no stage is still `post`, so nothing stored
 * before the change moves.
 *
 * ⚠⚠ THE SAME SHUFFLE, DELIBERATELY. `cef36fe` fixed instructor-added questions being
 * served in typed order across forecast, newsvendor, pricing and pd — an instructor has no
 * reason to think about where they put the right answer, and most people type it first.
 * Scorecard's added path was written after that fix and must not reintroduce it, so it
 * goes through `shuffleFor` exactly as the built-in ten do.
 *
 * ⚠ A free-text added question keeps `options: []`. That is the signal the client renders a
 * textarea on; it is never a shuffled empty list by accident.
 */
export function addedToClientKcQuestions(
  added: readonly ScorecardAddedKcQuestion[],
  participantId: string,
): ClientKcQuestion[] {
  return added.map(q => {
    const options: KcOption[] = (q.options ?? []).map(o => ({ id: o.value, text: o.label }))
    return {
      id: q.id,
      stage: addedKcStage(q),
      prompt: q.prompt,
      options: options.length > 1 ? shuffleFor(participantId, q.id, options) : options,
    }
  })
}

/**
 * ⚠ DYNAMIC denominator, never a hardcoded count.
 *
 * ⚠⚠ AN UNGRADED ADDED QUESTION COUNTS NOWHERE. A free-text addition, or an mc addition
 * whose key named no offered option (dropped by `parseAddedKcQuestion`), is RECORDED but is
 * absent from both the numerator and this denominator — so adding one cannot silently lower
 * every student's score. Same rule as the other four single-player games.
 */
export function kcDenominator(
  questions: readonly KcQuestion[],
  added: readonly ScorecardAddedKcQuestion[] = [],
): number {
  return questions.length + added.filter(isGradedAdded).length
}

/** An added question that carries a usable key, and therefore a mark. */
export function isGradedAdded(q: ScorecardAddedKcQuestion): boolean {
  return q.type === 'mc' && typeof q.correct_value === 'string'
}

// ═══════════════════════════════════════════════════════════════════════════════
// §10 — THE THREE STEPS, IN ORDER. ⚠⚠ THE ORDER IS LOAD-BEARING.
//
//   1. NOTICING   free text, ungraded, BEFORE the reveal
//   2. REVEAL     their two curves vs each other and the class average
//   3. LINKING    free text, GRADED BY ELENA OFFLINE — never scored in game
//
// Step 1 must be captured before the student sees any result. Students who never acted on
// the reliability label are the most valuable data in the room, and letting them answer
// after seeing their own two curves would let them retrofit a story.
//
// ⚠ STEP 3 IS NOT SCORED IN THE GAME. That is why the Tier-2 export carries each student's
// name and their own per-condition figures beside the text (§11) — Elena grades the
// reflection outside, and "I eased off when it got unreliable" cannot be assessed without
// the numbers next to it.
// ═══════════════════════════════════════════════════════════════════════════════

export type FreeTextStep = 'noticing' | 'linking'

export interface FreeTextQuestion {
  id: string
  step: FreeTextStep
  prompt: string
  followUps: string[]
  /** Instructor-facing note for the Tier-2 report header. */
  gradedNote: string
}

/**
 * ⚠ THE NOTICING PROMPT MUST NOT NAME THE TREATMENT (spec §10). It asks whether they
 * worked harder on some contracts than others and what was different — and lets the
 * student supply the reason, or fail to. That failure is the finding.
 */
export function noticingQuestion(config: ScorecardConfig): FreeTextQuestion {
  return {
    id: 'noticing',
    step: 'noticing',
    prompt:
      `Did you work harder on some ${config.contractNoun}s than others — and what was `
      + `different about them?`,
    followUps: [`A couple of sentences is enough.`],
    gradedNote: 'Ungraded. Captured BEFORE the student saw any results.',
  }
}

/**
 * ⚠ THE LINKING QUESTION comes AFTER the reveal and IS allowed to name the treatment —
 * the student has just seen their own two curves. Elena grades it offline.
 */
export function linkingQuestion(config: ScorecardConfig): FreeTextQuestion {
  return {
    id: 'linking',
    step: 'linking',
    prompt:
      `Now look at your two effort curves. Explain what you actually did, and why.`,
    followUps: [
      `Then connect it to ${config.buyerName}: where in that case does a supplier's score `
      + `stop depending on what the supplier did?`,
      `If you were designing ${config.buyerName}'s ${config.scorecardNoun}, what would you `
      + `change — and what would you expect suppliers to do differently?`,
    ],
    gradedNote:
      'Graded by the instructor offline. Not scored in the game — see the per-condition '
      + 'figures beside each answer in the export.',
  }
}

export function freeTextQuestions(config: ScorecardConfig): FreeTextQuestion[] {
  return [noticingQuestion(config), linkingQuestion(config)]
}
