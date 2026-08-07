// ═══════════════════════════════════════════════════════════════════════════════
// Metalcraft Supplier Scorecard — per-game constants and instance configuration
// (spec §3, §14).
//
// ⚠⚠ THE CONFIG/TRUTH SPLIT HERE IS ABOUT THE **TREATMENT**, NOT THE ECONOMICS.
//
// Unlike forecast — where the demand model IS the answer — nearly every number in this
// game is PRINTED ON THE STUDENT'S SCREEN and must be (spec §8: "Told: everything in the
// parameter block, including this contract's reliability label and probability, on every
// screen"). What the student must NOT learn is the EXPERIMENTAL DESIGN:
//
//   spec §8 — Not told: that reliability alternates, that there are exactly two
//   conditions, that the schedule is counterbalanced, or that the optimal response to
//   the low condition is to stop working.
//
// So the split runs along a different seam than any other game in the family:
//
//   config/main  (student-readable)  contracts, periodsPerContract, pAcceptableLow,
//                                    highEffortCost, lowEffortCost, targetScore, bonus,
//                                    endowmentPerContract, the show* switches, nouns
//   truth/main   (rules-denied)      reliabilityHigh, reliabilityLow,
//                                    reliabilitySchedule, labelHigh, labelLow, seed
//
// ⚠ WHY `reliabilityHigh` AND `reliabilityLow` ARE BOTH IN TRUTH even though ONE of them
// is on screen at all times: holding the PAIR is what reveals the design. A student who
// reads config/main and finds two reliabilities knows immediately that there are exactly
// two conditions and that theirs alternates — which spec §8 forbids and which would let
// them reverse-engineer the counterbalancing from their own contract 1. The server sends
// the CURRENT contract's reliability and its rendered label, one contract at a time
// (spec §13 leak check: "no next-contract reliability before that contract starts").
//
// ⚠ WHY `labelHigh` / `labelLow` ARE IN TRUTH TOO: the label TEXT names the other
// condition. Shipping both strings client-side would leak the design in prose after the
// numbers had been carefully withheld — S4's rule ("remove values from the payload, not
// just the screens") applied to copy rather than to a number.
//
// ⚠ `pAcceptableLow` IS IN CONFIG AND THAT IS CORRECT. It is displayed (spec §4,
// effort-choice screen: "the 30% for low effort") and it is IDENTICAL in both conditions,
// so it discloses nothing about the treatment. It is also the mechanism (spec §2.1) —
// which makes it exactly the number a student is entitled to see and reason about.
// ═══════════════════════════════════════════════════════════════════════════════

/** game_id — lowercase, never displayed. Drives the collection prefix + fn names. */
export const SCORECARD_GAME_ID = 'scorecard'

/** Collection prefix — every Firestore collection this game owns (architecture §4.1). */
export const SCORECARD_COLLECTION_PREFIX = 'scorecard'

/** Allowed browser origin for this game's callables (its own subdomain, spec §14). */
export const SCORECARD_CORS_ORIGINS = ['https://scorecard.mygames.live']

// ── Firestore collection / doc paths (all scorecard_ prefixed) ────────────────
export const INSTANCES_COLLECTION = 'scorecard_game_instances'
// Participants are a per-INSTANCE subcollection (S2 — structural isolation):
//   scorecard_game_instances/{iid}/participants/{pid}
export const PARTICIPANTS_SUBCOLLECTION = 'participants'

/** scorecard_game_instances/{id}/config/main — STUDENT-READABLE. */
export const CONFIG_DOC = 'main'

/** scorecard_game_instances/{id}/truth/main — rules-denied to every client, forever.
 *  Holds the TREATMENT (both reliabilities, both labels, the schedule) and the seed. */
export const TRUTH_DOC = 'main'

// ── The two conditions ────────────────────────────────────────────────────────

/** Which reliability a contract runs under. */
export type Condition = 'high' | 'low'

/** How the two conditions are laid out across a student's contracts (spec §2.2). */
export type ReliabilitySchedule = 'alternating' | 'blocked' | 'betweenSubject'

// ── Shipped defaults (spec §3) ────────────────────────────────────────────────

/**
 * N — contracts in a session. ⚠ RAISED FROM 10 TO 20 (Elena, 08-07; spec §2.5).
 *
 * Ten per condition, for two reasons. The primary one is Elena's classroom judgement:
 * more contracts means more chances to notice the number changed and act on it.
 *
 * The measurable one is that the §11 effort-gap column — the headline — gets sharper.
 * At 5 contracts per condition it is noisy enough that **a third of the students who
 * ignored reliability show a gap by luck alone** (35% false-positive), which blurs
 * exactly the Tier-3 "mass at zero" finding. At 10 per condition that falls to 29% and
 * detection rises from 81% to 90%. Real, but not transformative — the class-AVERAGE
 * comparison was already sound at 10.
 *
 * ⚠ LENGTHENING IS SAFE ONLY BECAUSE THE SCHEDULE ALTERNATES. Under `blocked`, extra
 * contracts load fatigue onto the back half and contaminate the comparison; under
 * alternating, fatigue hits both conditions equally, so the GAP survives even if effort
 * drifts down late. If `reliabilitySchedule` is ever set to `blocked`, reduce this.
 */
export const DEFAULT_CONTRACTS = 20
export const DEFAULT_PERIODS_PER_CONTRACT = 10

export const DEFAULT_RELIABILITY_HIGH = 0.7
export const DEFAULT_RELIABILITY_LOW = 0.4
/** ⚠ SHARED BY BOTH CONDITIONS — spec §2.1, this is the mechanism, not a copy-paste. */
export const DEFAULT_P_ACCEPTABLE_LOW = 0.3
export const DEFAULT_RELIABILITY_SCHEDULE: ReliabilitySchedule = 'alternating'

export const DEFAULT_HIGH_EFFORT_COST = 4
export const DEFAULT_LOW_EFFORT_COST = 0
export const DEFAULT_TARGET_SCORE = 7
export const DEFAULT_BONUS = 120
export const DEFAULT_ENDOWMENT_PER_CONTRACT = 50

/**
 * ⚠ `{pct}` INTERPOLATES THE LIVE CONFIG VALUE — spec §3.
 *
 * The stored string carries a TOKEN, never a typed-in percentage. An instructor who
 * edits `reliabilityLow` to 0.5 and leaves a hardcoded "(40%)" ships a screen that
 * contradicts the game it is describing. Rendering is `renderLabel()` below.
 */
export const DEFAULT_LABEL_HIGH = 'High Reliability ({pct})'
export const DEFAULT_LABEL_LOW = 'Low Reliability ({pct})'

/** Nouns (spec §3) — editable text, purely cosmetic. */
export const DEFAULT_CURRENCY = 'ECU'
export const DEFAULT_CONTRACT_NOUN = 'contract'
export const DEFAULT_PERIOD_NOUN = 'period'
export const DEFAULT_DELIVERY_NOUN = 'acceptable delivery'
export const DEFAULT_SCORECARD_NOUN = 'scorecard'
export const DEFAULT_BUYER_NAME = 'Metalcraft'
export const DEFAULT_PRODUCT_NAME = 'components'

/** Bounds on what any config may set. Warnings inform; these are the hard rails. */
export const HARD_MIN_CONTRACTS = 1
export const HARD_MAX_CONTRACTS = 40
export const HARD_MIN_PERIODS = 2
export const HARD_MAX_PERIODS = 30

// ── The rules the solver needs ────────────────────────────────────────────────

/**
 * Everything the DP needs to price a contract, independent of WHICH condition is in
 * force. `solve()` takes this plus one reliability.
 *
 * ⚠ Deliberately NOT the whole config: the solver must not be able to see the schedule,
 * the labels or the other condition. Passing it a `ScorecardRules` and a single number
 * is what makes "one solver, four consumers" (spec §16) safe to honour — a consumer
 * cannot accidentally solve the wrong condition because it never holds both at once.
 */
export interface ScorecardRules {
  /** T — periods in a contract. */
  periodsPerContract: number
  /** S* — scorecard points needed for the bonus. */
  targetScore: number
  /** B — the bonus paid at S* or better. */
  bonus: number
  /** c — cost of one high-effort period. */
  highEffortCost: number
  /** Cost of one low-effort period. Zero at defaults; the DP uses the DIFFERENCE. */
  lowEffortCost: number
  /** p_low — P(acceptable | low effort). ⚠ Same in both conditions (spec §2.1). */
  pAcceptableLow: number
  /** Starting balance each contract; effort costs come out of it. */
  endowmentPerContract: number
}

/** Instance configuration — the student-readable half (see the file header). */
export interface ScorecardConfig extends ScorecardRules {
  /** N — contracts in a session. */
  contracts: number
  showTargetReachedBanner: boolean
  showPriorContractsPanel: boolean
  showRunningBalance: boolean
  /** Spec §2.3. When false, the condition is in force but never named on screen. */
  showReliabilityLabel: boolean
  currency: string
  contractNoun: string
  periodNoun: string
  deliveryNoun: string
  scorecardNoun: string
  buyerName: string
  productName: string
}

/**
 * The treatment — rules-denied. See the file header for why every field is here.
 *
 * ⚠ `showRemainingPeriods` IS ABSENT ON PURPOSE, from both halves. Spec §3 marks it
 * "true, NOT editable" and spec §4.1 explains why: withholding the CONCLUSION that a
 * contract is dead is the design; withholding the INPUTS to that inference would be a
 * different and much worse game. There is no setting because there is no choice.
 */
export interface ScorecardTruth {
  reliabilityHigh: number
  reliabilityLow: number
  reliabilitySchedule: ReliabilitySchedule
  labelHigh: string
  labelLow: string
  /** Blank/null = `Math.random`. ⚠ Blank IS the classroom case (S1, T4). */
  seed: string | null
}

export const DEFAULT_CONFIG: ScorecardConfig = {
  contracts: DEFAULT_CONTRACTS,
  periodsPerContract: DEFAULT_PERIODS_PER_CONTRACT,
  targetScore: DEFAULT_TARGET_SCORE,
  bonus: DEFAULT_BONUS,
  highEffortCost: DEFAULT_HIGH_EFFORT_COST,
  lowEffortCost: DEFAULT_LOW_EFFORT_COST,
  pAcceptableLow: DEFAULT_P_ACCEPTABLE_LOW,
  endowmentPerContract: DEFAULT_ENDOWMENT_PER_CONTRACT,
  showTargetReachedBanner: true,
  showPriorContractsPanel: true,
  showRunningBalance: true,
  showReliabilityLabel: true,
  currency: DEFAULT_CURRENCY,
  contractNoun: DEFAULT_CONTRACT_NOUN,
  periodNoun: DEFAULT_PERIOD_NOUN,
  deliveryNoun: DEFAULT_DELIVERY_NOUN,
  scorecardNoun: DEFAULT_SCORECARD_NOUN,
  buyerName: DEFAULT_BUYER_NAME,
  productName: DEFAULT_PRODUCT_NAME,
}

export const DEFAULT_TRUTH: ScorecardTruth = {
  reliabilityHigh: DEFAULT_RELIABILITY_HIGH,
  reliabilityLow: DEFAULT_RELIABILITY_LOW,
  reliabilitySchedule: DEFAULT_RELIABILITY_SCHEDULE,
  labelHigh: DEFAULT_LABEL_HIGH,
  labelLow: DEFAULT_LABEL_LOW,
  seed: null,
}

// ── Derived helpers ───────────────────────────────────────────────────────────

/** The reliability in force under a condition. */
export function reliabilityOf(truth: ScorecardTruth, condition: Condition): number {
  return condition === 'high' ? truth.reliabilityHigh : truth.reliabilityLow
}

/**
 * Render one condition's label with the LIVE probability interpolated (spec §3).
 *
 * ⚠ Always call this; never ship `labelHigh` raw. The stored string holds `{pct}` and
 * this is the only place that turns a probability into the percentage a student reads.
 * Percentages are rounded before display (R8).
 */
export function renderLabel(truth: ScorecardTruth, condition: Condition): string {
  const template = condition === 'high' ? truth.labelHigh : truth.labelLow
  const pct = `${Math.round(reliabilityOf(truth, condition) * 100)}%`
  return template.replace(/\{pct\}/g, pct)
}

// ── Firestore loaders ─────────────────────────────────────────────────────────
//
// ⚠ MISSING DOCS READ AS SHIPPED DEFAULTS, and that is the CLASSROOM CASE, not an edge
// case (T4). An instance created from the classroom has NO `truth/main` at all and a
// blank seed; 361 green checks once described a configuration the classroom never
// creates. Every loader below must therefore be total on `undefined`.

const num = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback

const bool = (v: unknown, fallback: boolean): boolean =>
  typeof v === 'boolean' ? v : fallback

const str = (v: unknown, fallback: string): string =>
  typeof v === 'string' && v.length > 0 ? v : fallback

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/** A probability, clamped to [0,1]. Anything unparseable falls back. */
const prob = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? clamp(v, 0, 1) : fallback

/** The student-readable half. Total on undefined (see above). */
export function loadScorecardConfig(raw: unknown): ScorecardConfig {
  const d = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  const periodsPerContract = clamp(
    Math.round(num(d.periods_per_contract, DEFAULT_PERIODS_PER_CONTRACT)),
    HARD_MIN_PERIODS, HARD_MAX_PERIODS,
  )
  return {
    contracts: clamp(
      Math.round(num(d.contracts, DEFAULT_CONTRACTS)), HARD_MIN_CONTRACTS, HARD_MAX_CONTRACTS,
    ),
    periodsPerContract,
    // ⚠ Clamped INTO the horizon: a target above T is unreachable by construction and
    // would make every contract dead from period 1.
    targetScore: clamp(
      Math.round(num(d.target_score, DEFAULT_TARGET_SCORE)), 0, periodsPerContract,
    ),
    bonus: num(d.bonus, DEFAULT_BONUS),
    highEffortCost: num(d.high_effort_cost, DEFAULT_HIGH_EFFORT_COST),
    lowEffortCost: num(d.low_effort_cost, DEFAULT_LOW_EFFORT_COST),
    pAcceptableLow: prob(d.p_acceptable_low, DEFAULT_P_ACCEPTABLE_LOW),
    endowmentPerContract: num(d.endowment_per_contract, DEFAULT_ENDOWMENT_PER_CONTRACT),
    showTargetReachedBanner: bool(d.show_target_reached_banner, true),
    showPriorContractsPanel: bool(d.show_prior_contracts_panel, true),
    showRunningBalance: bool(d.show_running_balance, true),
    showReliabilityLabel: bool(d.show_reliability_label, true),
    currency: str(d.currency, DEFAULT_CURRENCY),
    contractNoun: str(d.contract_noun, DEFAULT_CONTRACT_NOUN),
    periodNoun: str(d.period_noun, DEFAULT_PERIOD_NOUN),
    deliveryNoun: str(d.delivery_noun, DEFAULT_DELIVERY_NOUN),
    scorecardNoun: str(d.scorecard_noun, DEFAULT_SCORECARD_NOUN),
    buyerName: str(d.buyer_name, DEFAULT_BUYER_NAME),
    productName: str(d.product_name, DEFAULT_PRODUCT_NAME),
  }
}

function isSchedule(v: unknown): v is ReliabilitySchedule {
  return v === 'alternating' || v === 'blocked' || v === 'betweenSubject'
}

/** The treatment — rules-denied. Total on undefined (the classroom case). */
export function loadScorecardTruth(raw: unknown): ScorecardTruth {
  const d = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  return {
    reliabilityHigh: prob(d.reliability_high, DEFAULT_RELIABILITY_HIGH),
    reliabilityLow: prob(d.reliability_low, DEFAULT_RELIABILITY_LOW),
    reliabilitySchedule: isSchedule(d.reliability_schedule)
      ? d.reliability_schedule
      : DEFAULT_RELIABILITY_SCHEDULE,
    labelHigh: str(d.label_high, DEFAULT_LABEL_HIGH),
    labelLow: str(d.label_low, DEFAULT_LABEL_LOW),
    // ⚠ BLANK IS THE CLASSROOM CASE (S1, T4) — null means Math.random, which is exactly
    // why every drawn value must be WRITTEN when drawn rather than derived on read.
    seed: typeof d.seed === 'string' && d.seed.length > 0 ? d.seed : null,
  }
}

/**
 * The marginal rule's threshold (spec §6.1): one scorecard point must be worth more
 * than this before high effort pays. 10 ECU high / 40 ECU low at defaults.
 *
 * ⚠⚠ DISPLAY ONLY. THE SOLVER MUST NEVER COMPARE AGAINST THIS (Elena, 08-07).
 *
 * `solve()` compares expected VALUES, which is algebraically the PRODUCT form
 * `(reliability − p_low) · Δ > (c_high − c_low)`. It does not, and must not, evaluate
 * `Δ > marginalThreshold(...)`. The two are equivalent in exact arithmetic and NOT in
 * floating point: this quotient is `39.999999999999986` at the shipped low condition,
 * because `0.4 − 0.3` is not exactly `0.1`. A quotient comparison would therefore decide
 * a cell on a rounding artefact — at defaults nothing flips, but an instructor-edited
 * parameter set could land exactly on the boundary and flip a policy cell invisibly.
 *
 * Callers: the §3.1 settings panel, the KC stems, the reveal. All of them RENDER it.
 * A test pins that the product and quotient forms can disagree, so this stays true.
 *
 * ⚠ THE GENERAL FORM USES THE COST **DIFFERENCE**. Spec §6.1 writes it as `c /
 * (reliability − p_low)` because `lowEffortCost` is 0 at defaults; it is a setting, so
 * the implemented rule is `(c_high − c_low) / (reliability − p_low)`, which reduces to
 * the spec's expression exactly at every shipped default. Not a departure — the same
 * rule, stated for the configuration space the settings screen actually allows.
 *
 * Returns Infinity when the condition buys no probability at all (reliability ≤ p_low):
 * no point is ever worth enough, which is the honest answer rather than a divide-by-zero.
 */
export function marginalThreshold(rules: ScorecardRules, reliability: number): number {
  const gain = reliability - rules.pAcceptableLow
  if (gain <= 0) return Infinity
  return (rules.highEffortCost - rules.lowEffortCost) / gain
}
