// ═══════════════════════════════════════════════════════════════════════════════
// Procurement Auction — the seeded random source. Pure: no Firestore, no game
// imports, no Date, no ambient state.
//
// ⚠ ONE STREAM, MANY DRAWS. Unlike newsvendor and forecast — which need exactly one
// draw per (student, period) and so can key a hash directly — this game needs an
// UNBOUNDED sequence: the open format's cascade picks a responder at each step, and a
// long cascade is a dozen picks in one round. So `makeRng` returns a stateful counter
// over the same hash rather than a keyed one-shot.
//
// ⚠ hash32 IS DUPLICATED FROM newsvendor/demand.ts ON PURPOSE, and this is the fifth
// copy (pd, pricing, newsvendor, forecast, here). The reason is stated in newsvendor's
// header and holds identically: the games in this project are isolated by design — own
// prefix, own callables, own rules block — and a cross-game import would mean a change
// made for one game's draws silently changes another's. It is twelve lines. DO NOT
// promote it to `shared/` without deciding that isolation no longer matters.
// ═══════════════════════════════════════════════════════════════════════════════

// ── THE CONVENTION, STATED ONCE ───────────────────────────────────────────────
//
// ⚠⚠ DRAWS ARE CONSUMED POSITIONALLY, NEVER CONDITIONALLY. A call site takes its draw
// whether or not it ends up using the value — `pick` is called even when there is one
// candidate, and the sealed resolver takes its tie draw even when a nominated bidder
// will decide the tie. The invariant this buys: THE STREAM POSITION AFTER AN OPERATION
// NEVER DEPENDS ON THE DATA.
//
// Break it and two seeded runs that differ only in whether some round happened to tie
// diverge in every LATER draw of the game. That surfaces as "the harness passes but
// production differs", which is among the worst shapes of bug to chase.
//
// This is exactly the kind of invariant that gets "optimised" away by someone who has
// not seen a desync — `atBest.length > 1 ? pick(rng, atBest) : atBest[0]` looks like a
// free saving. It is not. It was mutation-tested on 2026-08-03 and the first two tests
// written to catch it BOTH PASSED under the mutation, for unrelated reasons. If you are
// about to make a draw conditional, read `procurementResolve.test.ts`'s stream test
// first.
// ──────────────────────────────────────────────────────────────────────────────

/** A uniform random source in [0, 1). */
export type Rng = () => number

/**
 * FNV-1a (32-bit) followed by murmur3's fmix32 avalanche.
 *
 * The avalanche is load-bearing: raw FNV-1a low bits are poorly mixed for short,
 * similar inputs — exactly what participant ids are — and consecutive round numbers
 * differ by one character, so without fmix32 successive draws would be correlated.
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

/**
 * A deterministic stream from (seed, key) — or real randomness when there is no seed.
 *
 * ⚠ SEEDED vs REAL, and what "no seed" means. With a seed set (truth/main), every draw
 * is a pure function of (seed, key, position), so a harness run reproduces exactly while
 * students still differ from one another because the key carries their participant id.
 * Without one, `Math.random` — and note that the KEY IS THEN IGNORED, which is the trap
 * that made forecast's `demandDraw: 'common'` a silent no-op for every real instance.
 * It is harmless here only because this game has no common-draw mode: every draw is
 * meant to be independent per student. If one is ever added, read forecast's
 * `instance.ts` `drawSeed` note before wiring it.
 */
export function makeRng(seed: string | null, key: string): Rng {
  if (seed === null) return Math.random
  let n = 0
  return () => hash32(`${seed}:${key}:${n++}`) / 4294967296
}

/** A uniform integer in [min, max], inclusive both ends. */
export function randomInt(rng: Rng, min: number, max: number): number {
  if (max < min) throw new Error(`[procurement] randomInt: max ${max} < min ${min}`)
  return min + Math.floor(rng() * (max - min + 1))
}

/**
 * One element of a non-empty list, uniformly.
 *
 * ⚠ THIS IS BOTH TIE-BREAKS AND RESPONSE ORDERING. The sealed format breaks a tie at
 * the minimum bid with it (spec §7 step 4) and the open format picks which willing bot
 * answers with it (open spec §4.3). Same function, so a seeded run is reproducible
 * across both formats and neither grows its own private notion of "at random".
 */
export function pick<T>(rng: Rng, items: readonly T[]): T {
  if (items.length === 0) throw new Error('[procurement] pick from an empty list')
  return items[Math.floor(rng() * items.length)]
}
