// ═══════════════════════════════════════════════════════════════════════════════
// THE DRAW SOURCE. Game-local by convention — forecast has its own `unit`, procurement
// has `auction/rng.ts`. A cross-game import would mean a change made for one game's
// reasons silently altering another's draws.
//
// ⚠⚠ A NULL SEED MEANS `Math.random`, AND THAT IS THE CLASSROOM CASE (S1, T4).
// Instances created from the classroom have no `truth/main` at all, so `seed` is null
// for every real instance. This is the whole reason `resolvePeriod` returns `u` and the
// caller WRITES it: a value re-derived from (seed, key) on read would come back
// different every single time in production, while being perfectly stable in any test
// that happened to set a seed. That is exactly how the CP3 blocker shipped — a cost
// shown as 33 and resolved against 58.
//
// ⚠ THE KEY IS POSITIONAL, NEVER CONDITIONAL (procurement BUILD_NOTES §4). The key for
// a period is built from (participant, contract, period) — never from the action, the
// score or the condition. Two seeded students who differ only in what they CHOSE must
// see the same `u` in every later period, or a seeded replay diverges from production
// the moment a choice differs.
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * FNV-1a (32-bit) followed by murmur3's fmix32 avalanche.
 *
 * The avalanche step matters here for the same reason it does in PD: participant ids
 * are short and similar, and raw FNV-1a diffuses poorly across such inputs. fmix32
 * spreads every input bit across all 32 output bits, so consecutive ids do not produce
 * correlated draw streams.
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

/** A uniform in [0,1) — or real randomness when there is no seed. */
export function unit(seed: string | null, key: string): number {
  if (seed === null) return Math.random()
  // 2^32 as the divisor, so the result is in [0,1) and never exactly 1 — which keeps
  // `u < p` a correct test at p = 1.
  return hash32(`${seed}:${key}`) / 4294967296
}

/**
 * The draw key for one period. POSITIONAL ONLY (see the header).
 *
 * ⚠ `condition` is deliberately NOT in the key. It is determined by the contract index,
 * so including it would be redundant — but worse, it would couple the draw stream to the
 * treatment, and a schedule edit would then silently rewrite the draws of contracts
 * already played.
 */
export function periodKey(participantId: string, contractIndex: number, periodIndex: number): string {
  return `${participantId}:c${contractIndex}:p${periodIndex}`
}

/** The draw function for one period, ready to hand to `resolvePeriod`. */
export function periodDraw(
  seed: string | null,
  participantId: string,
  contractIndex: number,
  periodIndex: number,
): () => number {
  return () => unit(seed, periodKey(participantId, contractIndex, periodIndex))
}
