// ═══════════════════════════════════════════════════════════════════════════════
// SCORECARD ROBOT PLAY STYLES — how a simulated student decides High or Low.
//
// ⚠⚠ THE PERSONAS DIFFER IN THEIR **RESPONSE TO RELIABILITY**, NOT MERELY IN EFFORT
// LEVEL. This is the design constraint, not a nicety.
//
// A cohort of personas that all ignore the treatment produces two Tier-3 series that
// are the SAME LINE — and two identical lines are exactly what a CONDITION-PLUMBING BUG
// produces. If `reliabilityUsed` were derived instead of written, or the schedule
// recomputed instead of read, the charts would look precisely like a cohort of
// non-responders and nothing would appear broken. So the cohort must contain personas
// whose effort demonstrably MOVES with reliability — otherwise the most dangerous bug in
// this game is invisible in the very artifact built to display the treatment.
//
// The seven, and what each one is for:
//
//   grinder      always High. Ignores reliability entirely.        response: NONE
//   coaster      always Low. Ignores reliability entirely.         response: NONE
//   responder    works under high reliability, mostly stops
//                under low — the student the lesson hopes for.     response: STRONG
//   optimizer    plays the DP exactly. ⚠ CALLS THE CP1 SOLVER.     response: MAXIMAL
//   minimalist   works only when pivotal (close to target,
//                few periods left), in both conditions.            response: WEAK
//   overreactor  over-responds: quits the low condition entirely
//                AND coasts early under high.                      response: EXCESSIVE
//   learner      ignores reliability for the first few contracts,
//                then responds — the drift slide 7 shows.          response: EMERGES
//
// ⚠ `grinder` and `coaster` are the CONTROLS. A cohort of only responders would make the
// Tier-3 "mass at zero" bucket empty, and spec §11 says a mass at zero IS the finding —
// the chart must be able to show one.
//
// ⚠⚠ `optimizer` CALLS THE CP1 SOLVER (spec §16: one solver, four consumers). It does
// NOT reimplement "work until you hit the target": that shortcut is wrong at
// (period 7, score 6) where Δ = 8.80 against a threshold of 10, and a second policy
// implementation is the single likeliest way to break this build. The driver imports
// `solve` from the compiled functions bundle and passes the policy in.
//
// ⚠ EVERY STYLE DECIDES FROM WHAT IS ON THE STUDENT'S OWN SCREEN — the reliability
// printed on this contract, the score, the periods remaining, the balance. NOTHING here
// knows the schedule, the other condition, or that there are exactly two. A robot handed
// the design would make the cohort's charts say something false about what a student
// could have known.
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Every style takes the SAME argument: what the effort screen shows.
 *
 *   { contract, period, periodsRemaining, score, reliability, targetScore,
 *     highEffortCost, bonus, pAcceptableLow, rand }
 *
 * and returns 'high' | 'low'. `rand` is a seeded uniform supplied by the driver, so a
 * cohort is reproducible.
 */

/** Is one more point pivotal — i.e. can the contract still be won, and is it not yet won? */
const live = (s) => s.score < s.targetScore && s.score + s.periodsRemaining >= s.targetScore

/** How many more points are needed. */
const needed = (s) => s.targetScore - s.score

export const STYLES = {
  /**
   * ⚠ CONTROL. Always high, whatever the scorecard says. The 08-07 class contained a lot
   * of these — 56% effort under a scorecard that was barely listening.
   */
  grinder: () => 'high',

  /** ⚠ CONTROL. Never works. Produces the zero-effort end of the gap distribution. */
  coaster: () => 'low',

  /**
   * The student the lesson hopes for: works while the contract is live under a
   * responsive scorecard, and mostly stops when it is not.
   *
   * ⚠ The response is to the RELIABILITY ON SCREEN, not to a condition label or an
   * index — the same information a real student has.
   */
  responder: (s) => {
    if (!live(s)) return 'low'
    const responsive = s.reliability - s.pAcceptableLow >= 0.25
    if (responsive) return 'high'
    // Under a weak scorecard, work only when it is nearly decisive — and rarely.
    return needed(s) <= 1 && s.periodsRemaining <= 2 ? 'high' : 'low'
  },

  /**
   * ⚠⚠ THE DP, EXACTLY. The policy is INJECTED by the driver from the CP1 solver — this
   * function never derives one. `s.policy(periodsRemaining, score)` is
   * `highEffortOptimal` bound to this contract's reliability.
   *
   * If `policy` is missing the style THROWS rather than falling back to a heuristic: a
   * silent fallback would put a second policy in the build, which is the one thing spec
   * §16 forbids.
   */
  optimizer: (s) => {
    if (typeof s.policy !== 'function') {
      throw new Error('optimizer requires the CP1 solver policy — refusing to guess')
    }
    return s.policy(s.periodsRemaining, s.score) ? 'high' : 'low'
  },

  /**
   * Works only in the squeeze — close to target with just enough periods left — and does
   * so in BOTH conditions. ⚠ A weak responder: the gap is small but non-zero, which is
   * the middle of the Tier-3 distribution and the hardest case for the roster to rank.
   */
  minimalist: (s) => {
    if (!live(s)) return 'low'
    return needed(s) >= s.periodsRemaining ? 'high' : 'low'
  },

  /**
   * Over-responds: abandons the weak scorecard COMPLETELY (the DP still works 0.13
   * periods a contract), and under the strong one works every live period (the DP coasts
   * once the target is safe).
   *
   * ⚠ THE GAP MUST EXCEED THE OPTIMIZER'S, and that is the persona's entire job: without
   * someone above the DP, every robot gap sits below it and the Tier-3 distribution has
   * an artificial ceiling exactly where an instructor would read a boundary.
   *
   * ⚠ AN EARLIER VERSION ALSO COASTED EARLY UNDER HIGH RELIABILITY, which dragged its
   * high-condition rate down and produced a gap of 0.247 — BELOW the optimizer's 0.797.
   * It was labelled "over-responding" and was doing the opposite. The dry run caught it.
   * Over-responding means more effort where effort pays and less where it does not; it
   * does not mean less effort everywhere.
   */
  overreactor: (s) => {
    if (s.reliability - s.pAcceptableLow < 0.25) return 'low'
    return live(s) ? 'high' : 'low'
  },

  /**
   * Ignores reliability early, then responds — the ORDER EFFECT slide 7 shows.
   *
   * ⚠ This persona is why chart 1 (effort by contract ROUND) is not redundant with chart
   * 2. Without someone whose behaviour drifts across the session, chart 1 would be two
   * flat lines and could not demonstrate that plotting against round is what the
   * counterbalancing buys.
   */
  learner: (s) => {
    // ⚠⚠ THE EARLY PHASE IS UNCONDITIONALLY HIGH — it does NOT check `live()`, and that
    // is deliberate. An earlier version returned 'low' on dead contracts even in the
    // "ignoring reliability" phase, and measured an early gap of 0.318 rather than 0.
    //
    // The cause is worth knowing, because it is a property of the GAME and not of this
    // robot: LOW-RELIABILITY CONTRACTS DIE MORE OFTEN, so any student who abandons dead
    // contracts shows a positive effort gap WITHOUT EVER THINKING ABOUT RELIABILITY.
    // That is a structural floor under the Tier-1 headline column (BUILD_NOTES §12).
    //
    // For this persona to test what it claims — that a response EMERGES — its early
    // phase must be genuinely reliability-blind, which means ignoring deadness too.
    if (s.contract <= 5) return 'high'
    if (!live(s)) return 'low'
    const responsive = s.reliability - s.pAcceptableLow >= 0.25
    return responsive ? 'high' : (needed(s) <= 1 && s.periodsRemaining <= 2 ? 'high' : 'low')
  },
}

// ═══════════════════════════════════════════════════════════════════════════════
// ⚠⚠ THE ARTIFACT PERSONAS — reliability-blind, and they exist to PROVE the contested
// denominator (spec §11).
//
// Each one's action is a pure function of the STATE — dead, coasting, or contested — and
// contains no reference whatsoever to `reliability`. Over ALL periods each nonetheless
// produces a fake effort gap, because the MIX of states differs between conditions:
// low-reliability contracts die more often (biasing the gap UP) and high-reliability
// contracts reach the target more often (biasing it DOWN).
//
// Over CONTESTED periods each must measure EXACTLY 0.000 — not approximately. Restricted
// to contested periods the state is constant, so the action is constant, so the rate is
// identical in both conditions.
//
// ⚠ IF ANY OF THESE EVER MEASURES NON-ZERO ON THE CONTESTED DENOMINATOR, the headline
// column is manufacturing signal again and the Tier-1 ranking is not measuring response.
// The dry run asserts it to 3 decimal places.
// ═══════════════════════════════════════════════════════════════════════════════

/** Dead: the bonus is arithmetically impossible. */
const dead = (s) => s.score + s.periodsRemaining < s.targetScore
/** Coasting: the target is already met. */
const coasting = (s) => s.score >= s.targetScore

export const ARTIFACT_STYLES = {
  /** Stops only on dead contracts. Spec §11 measures +0.275 over all periods. */
  artifact_dead_stopper: (s) => (dead(s) ? 'low' : 'high'),
  /** Stops on dead AND coasts once the target is met. Spec §11: +0.198. */
  artifact_dead_and_coast: (s) => (dead(s) || coasting(s) ? 'low' : 'high'),
  /** Coasts at target only, never writes anything off. Spec §11: −0.077. */
  artifact_coast_only: (s) => (coasting(s) ? 'low' : 'high'),
}

Object.assign(STYLES, ARTIFACT_STYLES)

export const ARTIFACT_NAMES = Object.keys(ARTIFACT_STYLES)

/**
 * The seven CLASS personas — the cohort that fills a realistic roster. The artifact
 * personas are deliberately NOT in this list: they are a control, not a student.
 */
export const STYLE_NAMES = Object.keys(STYLES).filter(n => !ARTIFACT_NAMES.includes(n))

/**
 * Round-robin assignment, so a cohort of N always contains every persona.
 *
 * ⚠⚠ KEEP IT ROUND-ROBIN. A SHUFFLE WAS TRIED AND IS STRICTLY WORSE (measured, 08-08).
 *
 * THE PROBLEM IT WAS MEANT TO SOLVE: style is `index % 7` and the condition ARM is
 * `joinOrdinal % 2` (`assignStartsWith`). In a robot run those are the SAME index, so
 * style and arm become CORRELATED — with 16 robots the high-starting arm got 2 grinders
 * and 1 coaster while the low-starting arm got 1 grinder and 2 coasters.
 *
 * WHY THAT WRECKS TIER-3 CHART 1: under `alternating`, the "high reliability" series at
 * round k is whichever half of the class is in the high condition at round k — which
 * alternates between the two ARMS every round. Two arms with different persona mixes ⇒
 * the series ZIGZAGS round to round. It looks like a dramatic order effect and is nothing
 * of the kind. ⚠ A REAL CLASS CANNOT HAVE THIS: arm is join order, and how hard a student
 * works is not keyed on their position in the queue.
 *
 * ⚠⚠ THE MEASURED FIX IS COHORT SIZE, NOT SHUFFLING. Style/arm imbalance, summed over
 * personas:
 *
 *   n:            7    8   14   16   21   28
 *   round-robin:  7    6    0    2    7    0
 *   shuffled:     7    6    8    6   11   12     ← worse, and it destroys 14 and 28
 *
 * 7 styles and 2 arms means **every multiple of 14 is EXACTLY balanced** — each style
 * lands once in each arm. Shuffling replaces a solvable structure with noise. So: keep
 * round-robin, and use a multiple of 14 when chart 1 has to be read as a real order effect.
 */
export function styleFor(index) {
  return STYLE_NAMES[index % STYLE_NAMES.length]
}


/**
 * ⚠ EXPECTED RESPONSE DIRECTION per persona, asserted by the dry run.
 *
 * 'none'   — effort must NOT differ materially between conditions
 * 'weak'   — a small positive gap
 * 'strong' — a large positive gap
 *
 * The dry run checks these, and that check is what makes the cohort a control rather
 * than merely a data source: if a condition-plumbing bug collapsed the treatment, the
 * 'strong' personas would come back with a gap near zero and the run would fail.
 */
export const EXPECTED_RESPONSE = {
  grinder: 'none',
  coaster: 'none',
  responder: 'strong',
  optimizer: 'strong',
  minimalist: 'weak',
  overreactor: 'strong',
  // ⚠ 'strong' OVERALL, not 'weak'. An earlier version labelled this 'weak' on the
  // reasoning that a learner responds late — but 15 of 20 contracts are post-learning,
  // so the SESSION-LEVEL gap is large. What makes this persona distinct is not its
  // magnitude, it is its TIME PATH, and the dry run checks that separately: gap ≈ 0 over
  // the first quarter, large over the last. Chart 1 exists to show exactly that shape.
  learner: 'strong',
}

/** ⚠ The contract after which `learner` starts responding. The dry run's time-path
 *  check reads this rather than hardcoding 5 in two places. */
export const LEARNER_SWITCH_CONTRACT = 5
