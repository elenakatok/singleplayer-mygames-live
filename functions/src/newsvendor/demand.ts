import type { NewsvendorConfig } from './config'

// ═══════════════════════════════════════════════════════════════════════════════
// Newsvendor — THE DEMAND DRAW (spec §3). Pure and Firestore-free.
//
// ⚠ DRAWN PER STUDENT, PER PERIOD, SERVER-SIDE, AT RESOLUTION TIME — after the order
// has been committed, inside the same transaction (architecture §8, spec §3). The
// value must not exist anywhere the student could reach before committing, which is
// why nothing in this file is imported by the frontend and why submitRound calls it
// only after the order is in hand.
//
// ⚠ INDEPENDENT ACROSS STUDENTS. There is no pre-generated per-instance demand
// sequence: two students in the same instance see unrelated demand, so nothing a
// classmate reports about period 7 tells you anything about your own.
//
// SEEDED vs REAL: with a seed set (truth/main — see config.ts for why it is not in
// config/main), every draw is a pure function of (seed, participant_id, period), so a
// harness run reproduces exactly while students still differ from one another.
// Without one, Math.random.
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * FNV-1a (32-bit) followed by murmur3's fmix32 avalanche.
 *
 * Deliberately duplicated from pd/init.ts and pricing/init.ts rather than shared: the
 * games in this project are isolated by design (own prefix, own callables, own rules
 * block), and a cross-game import would mean a change made for one game's draws
 * silently changes another's. It is twelve lines.
 *
 * The avalanche is load-bearing: raw FNV-1a low bits are poorly mixed for short,
 * similar inputs — exactly what participant ids are — and consecutive periods differ
 * by one character, so without fmix32 successive draws would be visibly correlated.
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

/**
 * One demand realization (spec §3).
 *
 *   Normal  (isNormal):  D = round(Gaussian(mean, sd)), CLAMPED AT 0.
 *   Uniform (!isNormal): D = an integer uniform on [minD, maxD], inclusive.
 *
 * Box–Muller for the Gaussian, taking two independent uniforms. `u1` is nudged off
 * zero because log(0) is −∞; the nudge is far below the resolution of an integer
 * demand and cannot bias a draw anyone could measure.
 *
 * The clamp is a real case, not defensive padding: Normal(1000, 300) puts a negative
 * draw beyond three sigma, but an instructor is free to configure mean 200, sd 300.
 */
export function drawDemand(
  seed: string | null,
  participantId: string,
  period: number,
  config: NewsvendorConfig,
): number {
  if (!config.isNormal) {
    const u = unit(seed, `demand:${participantId}:${period}`)
    const span = Math.round(config.maxD) - Math.round(config.minD) + 1  // inclusive both ends
    return Math.round(config.minD) + Math.min(span - 1, Math.floor(u * span))
  }

  const u1 = Math.max(1e-12, unit(seed, `demand:${participantId}:${period}:a`))
  const u2 = unit(seed, `demand:${participantId}:${period}:b`)
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
  return Math.max(0, Math.round(config.mean + z * config.sd))
}
