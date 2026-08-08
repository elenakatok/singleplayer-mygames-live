import type { ScorecardConfig, ScorecardTruth } from './config'
import { hash32 } from './rng'

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

/** When a question is asked. ⚠ The split is the whole point — see the header. */
export type KcStage = 'pre' | 'post'

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

/**
 * A "round wrong number" slot with a collision guard.
 *
 * ⚠ The one accepted departure from "every number derives from config" (recorded at CP2):
 * where a distractor would have to encode a confusion that does not exist, it is a
 * plausible round value. The guard keeps it config-safe — if an instructor edit brings it
 * within `spread` of the correct answer or another option, the next candidate is used.
 */
function roundDistractor(preferred: number, taken: number[], spread: number): number {
  const ladder = [preferred, preferred * 2, preferred / 2, preferred + spread * 3, preferred * 3]
  for (const c of ladder) {
    if (taken.every(t => Math.abs(t - c) >= spread)) return round2(c)
  }
  return round2(preferred)
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

  // ── Q5: a worked earnings figure, straight from spec §1's formula ─────────
  // 6 high-effort periods, final score 5, target 7 ⇒ no bonus.
  const q5High = Math.min(6, T)
  const q5Score = Math.max(0, S - 2)
  const q5Earnings = config.endowmentPerContract - cHigh * q5High - cLow * (T - q5High)
  const q5WithBonus = q5Earnings + config.bonus
  const q5NoCost = config.endowmentPerContract

  // ── Q6: the lift from low to the LOW condition's high rate ────────────────
  // ⚠ Comprehension, not strategy: it checks the student noticed low effort is the same
  // in both conditions. It says nothing about what to do with that.
  const q6Lift = Math.round((relLow - pLow) * 100)
  const q6HighRate = Math.round(relLow * 100)
  const q6LowRate = Math.round(pLow * 100)

  return [
    // ═══ PRE-PLAY — case thinking (spec §9.1) ══════════════════════════════
    // ⚠ These test REASONING ABOUT the case, not recall of its facts. A student who
    // read the case can answer; so can one reasoning from the sentence itself. Neither
    // needs an exhibit reproduced here.
    {
      id: 'q1_negotiated_ppm',
      stage: 'pre',
      prompt:
        `Ellie Smith negotiates parts-per-million figures with suppliers, excludes one-time `
        + `spikes, and can code a reject so that it does not count against the supplier. What `
        + `does this do to the ${scorecardNoun}'s power to motivate suppliers?`,
      options: opts([
        ['a', `Weakens it — the score now depends partly on negotiation rather than on what the supplier did`],
        ['b', `Strengthens it — removing one-time spikes makes the score fairer and so more motivating`],
        ['c', `No effect — the adjustments are small relative to total volume`],
        ['d', `Strengthens it — suppliers work harder when they can appeal a reject`],
      ]),
      correctOptionId: 'a',
      explanation:
        `Fairness and motivating power are different things. Every adjustment that is `
        + `negotiated rather than measured moves part of the score away from the supplier's own `
        + `actions — and a score that partly reflects how well you argued is a score that partly `
        + `stops rewarding how well you performed.`,
      tests: 'That negotiated adjustments decouple score from behaviour',
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
        `You use high effort in ${q5High} of the ${T} ${config.periodNoun}s of a `
        + `${config.contractNoun} and finish with a ${scorecardNoun} score of ${q5Score}. The `
        + `target is ${S}. What are your earnings for that ${config.contractNoun}?`,
      options: (() => {
        const filler = roundDistractor(
          q5Earnings + cHigh * 2, [q5Earnings, q5WithBonus, q5NoCost], Math.max(1, cHigh),
        )
        return opts([
          ['a', ecu(q5Earnings, currency)],
          ['b', ecu(q5WithBonus, currency)],
          ['c', ecu(q5NoCost, currency)],
          ['d', ecu(filler, currency)],
        ])
      })(),
      correctOptionId: 'a',
      explanation:
        `${config.endowmentPerContract} − ${cHigh} × ${q5High} = ${round2(q5Earnings)}. A score `
        + `of ${q5Score} is short of ${S}, so there is no bonus — the effort was spent either `
        + `way. ⚠ Effort is paid for whether or not it works.`,
      tests: 'That effort is paid for regardless of outcome',
    },
    {
      id: 'q6_low_effort_is_shared',
      stage: 'pre',
      prompt:
        `Low effort gives an acceptable delivery ${q6LowRate}% of the time. On a `
        + `${config.contractNoun} where high effort gives ${q6HighRate}%, how much does `
        + `switching to high effort raise your chance in one ${config.periodNoun}?`,
      options: opts([
        ['a', `${q6Lift} percentage points`],
        ['b', `${q6HighRate} percentage points`],
        ['c', `${q6LowRate} percentage points`],
        ['d', `It depends on how many ${config.periodNoun}s are left`],
      ]),
      correctOptionId: 'a',
      explanation:
        `${q6HighRate}% − ${q6LowRate}% = ${q6Lift} percentage points. ⚠ Low effort gives `
        + `${q6LowRate}% on EVERY ${config.contractNoun} — that number never changes. What `
        + `changes between ${config.contractNoun}s is only what high effort gives you.`,
      tests: 'That low effort is the same in both conditions',
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

/** ⚠ DYNAMIC denominator, never a hardcoded count. */
export function kcDenominator(questions: readonly KcQuestion[]): number {
  return questions.length
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
