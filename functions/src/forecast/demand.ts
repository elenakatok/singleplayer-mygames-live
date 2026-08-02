import {
  PUBLISHED_HISTORY, PUBLISHED_HISTORY_LENGTH, DEFAULT_HIGH_SEASON_MONTHS, monthOf,
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
// ⚠⚠ HISTORY IS COMMON, FUTURES ARE NOT (spec §2.2). Two different functions:
//   • `resolveHistory` returns the same sixty numbers for EVERY student — no
//     participant id enters it at all, which is why byte-identity across students is
//     structural rather than a property to test for.
//   • `drawDemand` is seeded on (seed, participant_id, period), so two students in
//     one instance face unrelated futures. That closes the async leak: a week-long
//     take-home with a common future lets the first finisher hand the class 24
//     correct answers.
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
export const DEFAULT_SIGMA = 30
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
  demandDraw: 'perStudent',
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
 * Whether this instance may serve the PUBLISHED history (spec §2.1) rather than a
 * generated one.
 *
 * ⚠ THE PUBLISHED TABLE IS ONLY VALID AT THE SHIPPED MODEL. It was drawn from
 * a = 560, b = 4, H = 230, σ = 30 with a Nov/Dec high season, and the Tier-3 chart
 * draws `systematic()` over it as the true process. If an instructor edits any of
 * those, the published numbers would no longer BE that instance's history and the
 * reference line would sit somewhere the data never was — so the history is
 * regenerated from the edited model instead. Settings warns before this happens
 * (spec §3: warn, never block).
 *
 * `demandDraw`, `seed` and the play-side settings are deliberately NOT part of this
 * check: none of them changes what the first sixty months are.
 */
export function usesPublishedHistory(model: ForecastModel, numHistory: number): boolean {
  return numHistory === PUBLISHED_HISTORY_LENGTH
    && model.a === DEFAULT_A
    && model.b === DEFAULT_B
    && model.H === DEFAULT_H
    && model.sigma === DEFAULT_SIGMA
    && model.seasonality === 'additive'
    && model.seasonStructure === 'twoSeason'
    && model.highSeasonMonths.length === DEFAULT_HIGH_SEASON_MONTHS.length
    && DEFAULT_HIGH_SEASON_MONTHS.every(m => model.highSeasonMonths.includes(m))
}

/**
 * The history every student in this instance sees, p = 1…numHistory (spec §2.2).
 *
 * ⚠ NO PARTICIPANT ID, ANYWHERE IN THIS FUNCTION. That is what makes "identical for
 * every student" structural rather than a coincidence the harness has to police — and
 * the harness polices it anyway (spec §12).
 *
 * The generated branch is keyed on `history:<p>` with the instance seed, so it is
 * stable across calls and across students. A null seed still generates a FIXED
 * history — it falls back to DEFAULT_SEED — because "blank = random futures"
 * (spec §2) is a statement about the futures only; a history that changed between two
 * students, or between two page loads, would not be a history.
 */
export function resolveHistory(
  model: ForecastModel,
  seed: string | null,
  numHistory: number,
): number[] {
  if (usesPublishedHistory(model, numHistory)) return [...PUBLISHED_HISTORY]

  const historySeed = seed ?? DEFAULT_SEED
  const out: number[] = []
  for (let p = 1; p <= numHistory; p++) {
    out.push(realize(systematic(model, p), gaussian(historySeed, `history:${p}`) * model.sigma))
  }
  return out
}
