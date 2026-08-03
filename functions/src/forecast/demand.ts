import {
  PUBLISHED_HISTORY, PUBLISHED_HISTORY_LENGTH, PUBLISHED_HISTORY_SEED,
  DEFAULT_HIGH_SEASON_MONTHS, monthOf,
} from './history'

// ═══════════════════════════════════════════════════════════════════════════════
// Forecasting — THE DEMAND PROCESS (spec §2). Pure and Firestore-free.
//
//   D_p = round( a + b·p + H·holiday(p) + ε_p ),  floored at 0
//   holiday(p) = 1 if month(p) ∈ highSeasonMonths
//   ε_p ~ Normal(0, σ),  independent across periods
//
// ⚠⚠ THE MODEL PARAMETERS ARE SECRET (spec §4, §12). a, b, H, σ and highSeasonMonths
// are not "settings" in the newsvendor sense — KNOWING THEM IS KNOWING THE ANSWER,
// because explaining the systematic component IS the exercise (spec §7). They live in
// the rules-denied `truth/main`, never in the student-readable `config/main`, and no
// student response carries them. Nothing in this file is imported by the frontend.
//
// ⚠⚠ HISTORY IS COMMON, AND SO ARE THE FUTURES BY DEFAULT (Elena, 08-02 — this
// REVERSES spec §2.2's default). Two different functions:
//   • `resolveHistory` returns the same sixty numbers for EVERY student — no
//     participant id enters it at all, which is why byte-identity across students is
//     structural rather than a property to test for.
//   • `drawDemand` is seeded on (seed, participant_id, period) under `perStudent`, and
//     drops the participant id under `common` — which is now the DEFAULT, so every
//     student faces the same 24 months.
//
// ⚠ THAT RE-OPENS THE ASYNC LEAK spec §2.2 closed, knowingly: over a week-long
// take-home the first finisher can hand the class every answer. Elena's call, made
// with the consequence stated. `perStudent` is still there and is still the right
// setting for a take-home where the leak matters.
//
// ⚠ DRAWN SERVER-SIDE AT RESOLUTION TIME, after the forecast is committed, in the same
// transaction (spec §2.2, §4). Realized demand for an unplayed month must not exist
// anywhere the client can reach — not in config, not prefetched, not in either CSV.
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * The generating model. SECRET — read from `truth/main`, written only by the
 * instructor's Settings callable, and never present in a student payload.
 */
export interface ForecastModel {
  /** Intercept: the low-season level at p = 0. */
  a: number
  /** Trend per month. */
  b: number
  /** High-season lift, applied to `highSeasonMonths` only. */
  H: number
  /** 1-based calendar months that carry the lift. Editable — any subset. */
  highSeasonMonths: number[]
  /** Noise standard deviation. */
  sigma: number
  /**
   * `additive` (default, and the taught model) or `multiplicative`.
   *
   * ⚠ MULTIPLICATIVE IS AN UNUSED CONFIG FLIP (spec §14): available, off-method, and
   * not what any shipped instance runs. Implemented so the flag is not a lie. The
   * factor is (a + H)/a applied to the trend line, chosen so that at p = 0 the two
   * seasonalities agree EXACTLY — which makes the flip a pure statement about whether
   * the lift grows with the trend, rather than also silently changing the level.
   */
  seasonality: 'additive' | 'multiplicative'
  /**
   * `twoSeason` (default) or `perMonth` — the escape hatch of spec §2/§14 that
   * restores twelve independent month offsets.
   *
   * ⚠ UNUSED BY DEFAULT, and deliberately degenerate at the defaults: `monthOffsets`
   * ships as the two-season pattern (H on the high months, 0 elsewhere), so flipping
   * to perMonth without editing the offsets changes NOTHING. That is the property
   * that makes the flag safe to expose.
   */
  seasonStructure: 'twoSeason' | 'perMonth'
  /** perMonth only: twelve offsets, index 0 = January. Ignored under twoSeason. */
  monthOffsets: number[]
  /** `perStudent` (default) or `common` — see `drawDemand` (spec §2.2). */
  demandDraw: 'perStudent' | 'common'
}

// ── Shipped defaults (spec §2, the "Defaults" table) ───────────────────────────

export const DEFAULT_A = 560
export const DEFAULT_B = 4
export const DEFAULT_H = 230
/**
 * Noise standard deviation.
 *
 * ⚠ RAISED FROM 30 TO 60 (Elena, 08-02). Two consequences, both real and both
 * accounted for elsewhere in this build rather than left to surface later:
 *   • THE FLOOR QUADRUPLES, from σ² = 900 to σ² = 3,600. No forecast can beat it, and
 *     it is what the debrief reveals as the limit of the predictable.
 *   • THE WHOLE §2.3 BENCHMARK TABLE MOVES. Those figures are a function of σ, so they
 *     were re-simulated at 60 and replaced (benchmarks.ts). Leaving the old numbers in
 *     place would have printed a confident, wrong comparison on the debrief screen.
 *
 *   • THE PUBLISHED HISTORY MOVES WITH IT. σ is a GENERATOR INPUT, not an estimate —
 *     the sixty months are a function of it — so the table was redrawn at 60
 *     (history.ts). It is not a fixed artifact that survives a σ edit.
 */
export const DEFAULT_SIGMA = 60

/** The σ the PUBLISHED history was drawn at — now the SAME as the game's σ, since the
 *  table was regenerated at 60. Kept as a named fact so a future σ change has an
 *  obvious place to notice that the history must move with it. */
export const PUBLISHED_HISTORY_SIGMA = 60
/** Seed 1 is what produced the published history (spec §2.1). */
export const DEFAULT_SEED = '1'

export const DEFAULT_MODEL: ForecastModel = {
  a: DEFAULT_A,
  b: DEFAULT_B,
  H: DEFAULT_H,
  highSeasonMonths: [...DEFAULT_HIGH_SEASON_MONTHS],
  sigma: DEFAULT_SIGMA,
  seasonality: 'additive',
  seasonStructure: 'twoSeason',
  // The two-season pattern written out: the flip to perMonth is a no-op until edited.
  monthOffsets: Array.from({ length: 12 }, (_, i) =>
    DEFAULT_HIGH_SEASON_MONTHS.includes(i + 1) ? DEFAULT_H : 0),
  // ⚠ COMMON, NOT perStudent (Elena, 08-02). Every student now faces the SAME
  // realized future — the same seed, so the same 24 months of demand.
  //
  // This deliberately re-opens the async leak that spec §2.2 closed: a week-long
  // take-home means the first finisher can hand the class 24 correct answers. Elena's
  // call, made with that consequence stated. `perStudent` remains available and is
  // still the right choice for a graded take-home where the leak matters.
  //
  // What it buys: every student is comparable on identical data, so the Tier-3 class
  // chart averages one series rather than seven unrelated ones, and two students'
  // MSEs differ only by their forecasts.
  demandDraw: 'common',
}

// ── The systematic component ───────────────────────────────────────────────────

/** Is this period in the high season? */
export function isHighSeason(model: ForecastModel, period: number): boolean {
  return model.highSeasonMonths.includes(monthOf(period))
}

/**
 * The SYSTEMATIC part of demand at period p — everything except ε (spec §2).
 *
 * ⚠ This is the dashed reference line on the Tier-3 class chart (spec §10) and the
 * "true process" the debrief reveals (spec §9). Both derive it from the instance's own
 * model rather than from a hand-entered constant, so an instructor who edits a
 * parameter cannot leave a chart drawing the old process.
 *
 * Not rounded and not floored: this is the conditional MEAN, which is exactly the
 * quantity an MSE-minimizing forecaster is aiming at. Rounding belongs to the
 * REALIZATION (`realize`), not to the process.
 */
export function systematic(model: ForecastModel, period: number): number {
  const trend = model.a + model.b * period

  if (model.seasonStructure === 'perMonth') {
    // Twelve independent offsets, additive by construction — a multiplicative
    // per-month structure is not a thing the lecture teaches and is not offered.
    const offset = model.monthOffsets[monthOf(period) - 1] ?? 0
    return trend + offset
  }

  if (!isHighSeason(model, period)) return trend

  if (model.seasonality === 'multiplicative') {
    // (a + H)/a — see the ForecastModel doc for why this factor and not another.
    // Guarded: a = 0 would make the factor infinite, so it degrades to additive.
    if (model.a === 0) return trend + model.H
    return trend * ((model.a + model.H) / model.a)
  }

  return trend + model.H
}

/** A realization: the systematic component plus noise, rounded and floored at 0
 *  (spec §2). One place, so a draw and a generated history round identically. */
function realize(mean: number, noise: number): number {
  return Math.max(0, Math.round(mean + noise))
}

// ── Seeded randomness ──────────────────────────────────────────────────────────

/**
 * FNV-1a (32-bit) followed by murmur3's fmix32 avalanche.
 *
 * Duplicated from newsvendor/demand.ts and pricing/init.ts rather than shared, on the
 * family's standing rule: games here are isolated by design (own prefix, own callables,
 * own rules block), and a cross-game import would mean a change made for one game's
 * draws silently changes another's. It is twelve lines.
 *
 * The avalanche is load-bearing: raw FNV-1a low bits mix poorly for short, similar
 * inputs — exactly what participant ids are — and consecutive periods differ by one
 * character, so without fmix32 successive draws would be visibly correlated. In a
 * forecasting game that correlation would be a *learnable signal in the noise*, which
 * would break the one thing the game asserts is unpredictable.
 */
export function hash32(s: string): number {
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

/** A uniform in [0,1) from a hash — or real randomness when there is no seed. */
function unit(seed: string | null, key: string): number {
  if (seed === null) return Math.random()
  // 2^32 as the divisor, so the result is in [0,1) and never exactly 1.
  return hash32(`${seed}:${key}`) / 4294967296
}

/** A standard Normal from two uniforms (Box–Muller). `u1` is nudged off zero because
 *  log(0) is −∞; the nudge is far below the resolution of an integer demand. */
function gaussian(seed: string | null, key: string): number {
  const u1 = Math.max(1e-12, unit(seed, `${key}:a`))
  const u2 = unit(seed, `${key}:b`)
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
}

// ── The two draws ──────────────────────────────────────────────────────────────

/**
 * ONE realized demand for ONE student in ONE played period (spec §2.2).
 *
 * ⚠ SEEDED ON (seed, participant_id, period) — the Newsvendor pattern. With a seed
 * set, a harness run reproduces exactly while students still face unrelated futures;
 * without one, real randomness.
 *
 * `demandDraw: 'common'` drops the participant id from the key, so every student in
 * the instance faces the SAME future. That is the spec's non-default option and it
 * re-opens the async leak by design — an instructor who wants a common future for an
 * in-class run can have one, and Settings says what it costs.
 */
export function drawDemand(
  model: ForecastModel,
  seed: string | null,
  participantId: string,
  period: number,
): number {
  const who = model.demandDraw === 'common' ? 'common' : participantId
  const noise = gaussian(seed, `demand:${who}:${period}`) * model.sigma
  return realize(systematic(model, period), noise)
}

/**
 * THE SEED THE DRAWS MUST ACTUALLY USE, given the instance's own settings.
 *
 * ⚠⚠ THIS EXISTS BECAUSE `common` SHIPPED BROKEN (production, 08-02). `unit()` returns
 * Math.random() when the seed is null and IGNORES its key, so a blank seed turned
 * `demandDraw: 'common'` into a no-op: every student drew independently while the
 * setting said they shared a series. Classroom-created instances have no truth doc and
 * therefore no seed, so that was the NORMAL case, not an edge one — and nothing looked
 * wrong from outside. σ was correct, the chart was smooth, no error was raised. It was
 * caught by measuring production: 15 distinct actuals in a month where there should
 * have been one.
 *
 * THE RULE: a "common" future that differs between two students is not common, so under
 * `common` a null seed falls back to a deterministic one. This is the same sentence
 * `resolveHistory` already lives by — "blank = random futures" is a statement about the
 * FUTURES, and a history that changed between students would not be a history.
 *
 * THE FALLBACK IS THE INSTANCE ID, not DEFAULT_SEED: one shared fallback would give
 * every seedless instance the same 24 months, so this semester's class would inherit
 * last semester's answers — the very leak the below-floor flag exists to catch.
 *
 * Under `perStudent`, null still means real randomness. Students differ regardless, so
 * there is nothing for determinism to protect.
 */
export function resolveDrawSeed(
  seed: string | null,
  demandDraw: ForecastModel['demandDraw'],
  instanceId: string,
): string | null {
  if (seed !== null) return seed
  return demandDraw === 'common' ? instanceId : null
}

/**
 * Whether this instance may serve the PUBLISHED history (spec §2.1) rather than a
 * generated one.
 *
 * ⚠⚠ a, b, H, σ, the high season and the seasonal STRUCTURE ARE GENERATOR INPUTS, NOT
 * ESTIMATES (Elena, 08-02). The sixty months are a *function* of them. So the rule this
 * predicate encodes is not "the instructor has wandered off the shipped defaults, serve
 * something else" — it is that the published table is simply not this instance's history
 * once any input to it has moved, and a redraw at the new parameters is the only series
 * that IS. Every input therefore appears below; anything absent must be provably unable
 * to change the first `numHistory` months:
 *
 *   • `monthOffsets` — read by `systematic()` only under `perMonth`, which this predicate
 *     already excludes, so under twoSeason it cannot reach the draw.
 *   • `demandDraw` and `seed` — statements about the FUTURES. `resolveHistory` takes no
 *     participant id at all, and the seed only selects among series the same model
 *     generates, so neither changes what the first sixty months ARE.
 *
 * The Tier-3 chart draws `systematic()` over the history as the true process, so serving
 * a stale table would put the reference line somewhere the data never was. Settings warns
 * before any of this happens (spec §3: warn, never block).
 */
export function usesPublishedHistory(model: ForecastModel, numHistory: number): boolean {
  // ⚠ σ IS CHECKED AGAIN (Elena, 08-02, second pass). It was briefly excluded, while
  // the published table was a σ = 30 artifact that σ could not alter. The table has now
  // been REGENERATED at σ = 60 (history.ts), so it is σ-specific once more: serving it
  // to an instance at a different noise level would show sixty months whose scatter
  // contradicts the process actually generating play. The earlier asymmetry between
  // this check and `publishedBenchmarksValid` is gone — both depend on σ now.
  return numHistory === PUBLISHED_HISTORY_LENGTH
    && model.sigma === DEFAULT_SIGMA
    && model.a === DEFAULT_A
    && model.b === DEFAULT_B
    && model.H === DEFAULT_H
    && model.seasonality === 'additive'
    && model.seasonStructure === 'twoSeason'
    && model.highSeasonMonths.length === DEFAULT_HIGH_SEASON_MONTHS.length
    && DEFAULT_HIGH_SEASON_MONTHS.every(m => model.highSeasonMonths.includes(m))
}

// ── The structural screen a redrawn history must pass ──────────────────────────
//
// ⚠⚠ A REDRAW IS NOT JUST "RUN THE GENERATOR ONCE". The published table was not the
// first draw at σ = 60 — it was chosen out of a search, because at that noise level only
// about one seed in six produces five years in which the high season is visibly a season,
// and the best-FITTING candidate had a worst-year margin of 17 units on an 860 level:
// arithmetically a peak, visually a wobble. A student who cannot SEE the season has
// nothing to model, so the exercise fails at the first screen.
//
// An instructor who edits σ or H therefore needs the same treatment the shipped table
// got. Handing them one unscreened draw would silently give their class the 17-unit
// version of the game.

/**
 * The calendar months this model ELEVATES — the ones the student is meant to notice.
 *
 * Derived from the model rather than read off `highSeasonMonths`, because under
 * `perMonth` the high season is whatever the offsets say it is, and because a
 * non-positive `H` means there is no season to see however the months are listed.
 */
export function elevatedMonths(model: ForecastModel): number[] {
  if (model.seasonStructure === 'perMonth') {
    const offsets = model.monthOffsets
    if (offsets.length !== 12) return []
    const max = Math.max(...offsets)
    // A flat offset vector is a model with no season at all, not a season of twelve.
    if (max <= Math.min(...offsets)) return []
    return offsets.map((v, i) => (v === max ? i + 1 : 0)).filter(m => m > 0)
  }
  if (model.H <= 0) return []
  return model.highSeasonMonths.filter(m => m >= 1 && m <= 12)
}

/**
 * How clearly the season reads in a drawn history: the WORST YEAR's gap between the
 * lowest elevated month and the highest ordinary month. Positive means the season wins
 * outright in every year; larger means it wins obviously.
 *
 * `null` when the question is vacuous — no elevated months, every month elevated, or no
 * complete year to judge. A model with no season cannot fail a screen about its season,
 * and a redraw for such a model must not loop looking for one.
 */
export function seasonMargin(history: readonly number[], model: ForecastModel): number | null {
  const high = new Set(elevatedMonths(model))
  if (high.size === 0 || high.size >= 12) return null

  let worst = Infinity
  for (let start = 0; start + 12 <= history.length; start += 12) {
    let lowestHigh = Infinity
    let highestOrdinary = -Infinity
    for (let i = 0; i < 12; i++) {
      const value = history[start + i]
      if (high.has(monthOf(start + i + 1))) lowestHigh = Math.min(lowestHigh, value)
      else highestOrdinary = Math.max(highestOrdinary, value)
    }
    // A year with no elevated month, or none without one, cannot be judged — skip it
    // rather than let an Infinity poison the worst-case.
    if (lowestHigh === Infinity || highestOrdinary === -Infinity) continue
    worst = Math.min(worst, lowestHigh - highestOrdinary)
  }
  return worst === Infinity ? null : worst
}

/** How many candidate draws a redraw will look at before settling for its best. */
export const HISTORY_SEARCH_CAP = 400

/** One unscreened draw of `numHistory` months at a given seed. The generator itself. */
export function generateHistoryAt(
  model: ForecastModel,
  seed: string,
  numHistory: number,
): number[] {
  const out: number[] = []
  for (let p = 1; p <= numHistory; p++) {
    out.push(realize(systematic(model, p), gaussian(seed, `history:${p}`) * model.sigma))
  }
  return out
}

/**
 * The acceptance bar, in demand units: one σ of clear air in the worst year.
 *
 * Scale-free on purpose — "the season beats the noise" is the property, and stating it in
 * units of the noise means it keeps meaning that at any σ. The shipped table clears it
 * about twice over (133 against 60).
 */
const marginBar = (model: ForecastModel) => model.sigma

/**
 * THE CAPPED REJECTION SEARCH. Deterministic in (model, base seed, numHistory): walks a
 * fixed ladder of candidate seeds, stops at the first draw whose season clears the bar,
 * and if the cap runs out returns the BEST it saw rather than the last.
 *
 * ⚠ IT NEVER THROWS AND NEVER LOOPS FOREVER. An instructor can ask for σ = 400 against
 * H = 230, where no draw will ever show a clean season because the model does not have
 * one to show. That is a legitimate configuration; the honest response is the best
 * available series plus a Settings warning, not a refusal or a hang.
 */
function searchHistory(model: ForecastModel, baseSeed: string, numHistory: number): number[] {
  const first = generateHistoryAt(model, `${baseSeed}:h0`, numHistory)
  let bestMargin = seasonMargin(first, model)
  // Vacuous: this model has no season, so there is nothing to screen for.
  if (bestMargin === null) return first

  const bar = marginBar(model)
  if (bestMargin >= bar) return first

  let best = first
  for (let k = 1; k < HISTORY_SEARCH_CAP; k++) {
    const candidate = generateHistoryAt(model, `${baseSeed}:h${k}`, numHistory)
    const margin = seasonMargin(candidate, model) ?? -Infinity
    if (margin >= bar) return candidate
    if (margin > bestMargin) {
      best = candidate
      bestMargin = margin
    }
  }
  return best
}

// The search is pure, so its result is memoizable, and memoizing matters: `resolveHistory`
// runs on every getState, and a full cap sweep is four hundred sixty-month draws. Warm
// function instances make this free after the first request. Keyed on exactly the inputs
// the draw depends on — bounded, and evicted oldest-first so a long-lived instance that
// has seen many edits cannot grow it without limit.
const HISTORY_CACHE_MAX = 64
const historyCache = new Map<string, number[]>()

/**
 * The history every student in this instance sees, p = 1…numHistory (spec §2.2).
 *
 * ⚠ NO PARTICIPANT ID, ANYWHERE IN THIS FUNCTION. That is what makes "identical for
 * every student" structural rather than a coincidence the harness has to police — and
 * the harness polices it anyway (spec §12).
 *
 * A null seed still produces a FIXED history — it falls back to PUBLISHED_HISTORY_SEED —
 * because "blank = random futures" (spec §2) is a statement about the futures only; a
 * history that changed between two students, or between two page loads, would not be a
 * history. That fallback is the published table's own seed, so an edited instance lands
 * in the same family rather than somewhere unrelated.
 */
export function resolveHistory(
  model: ForecastModel,
  seed: string | null,
  numHistory: number,
): number[] {
  if (usesPublishedHistory(model, numHistory)) return [...PUBLISHED_HISTORY]

  const baseSeed = seed ?? PUBLISHED_HISTORY_SEED
  const key = JSON.stringify([
    baseSeed, numHistory, model.a, model.b, model.H, model.sigma,
    [...model.highSeasonMonths].sort((x, y) => x - y),
    model.seasonality, model.seasonStructure, model.monthOffsets,
  ])

  const hit = historyCache.get(key)
  if (hit) return [...hit]

  const drawn = searchHistory(model, baseSeed, numHistory)
  if (historyCache.size >= HISTORY_CACHE_MAX) {
    const oldest = historyCache.keys().next().value
    if (oldest !== undefined) historyCache.delete(oldest)
  }
  historyCache.set(key, drawn)
  return [...drawn]
}
