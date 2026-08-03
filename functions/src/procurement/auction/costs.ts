import { randomInt, type Rng } from './rng'

// ═══════════════════════════════════════════════════════════════════════════════
// Procurement Auction — COST DRAWS (spec §4). Pure: no Firestore, no game imports.
//
// ⚠ THE DISTRIBUTION IS AN EXPLICIT OBJECT, NOT BARE min/max FIELDS (spec §3, §13.3).
// That shape is a decision frozen at spec time because it is expensive to change later:
// the eventual auction-engine extraction needs one distribution primitive, and a game
// that stored `costMin`/`costMax` would have to be migrated to reach it. Built LOCAL —
// the two-consumer rule says do not extract the primitive yet (§13.3).
//
// ⚠ THE PLAYER AND THE RIVALS DRAW FROM DIFFERENT RANGES — U[10,60] vs U[10,110] — and
// that is deliberate (spec §4, derivation §5.2). It raises the player's win rate from
// ~20% to ~39% without disturbing anything, because A BIDDER'S OWN COST DISTRIBUTION
// DOES NOT ENTER THEIR OPTIMIZATION: the cost is realized before bidding, so the
// optimal markup depends only on the RIVALS' distribution. Students are told the rival
// range only; their own is never mentioned because it is not needed to bid well.
//
// ⚠ WHEN EACH IS DRAWN — and the two are NOT the same moment:
//   • The PLAYER's cost is drawn at ROUND START, because the screen shows it before
//     they bid.
//   • The RIVAL costs are drawn at RESOLUTION TIME, inside the same transaction that
//     accepts the bid, and must not exist anywhere reachable before then (spec §4).
// Nothing in this file knows or enforces that ordering — it is the callable's job, and
// the harness asserts it from the outside rather than trusting a comment.
// ═══════════════════════════════════════════════════════════════════════════════

/** A cost distribution, as stored in instance config. */
export interface CostDist {
  distribution: 'uniform'
  min: number
  max: number
  integer: boolean
}

/** One cost from a distribution. Integer distributions are inclusive of both ends. */
export function drawCost(rng: Rng, dist: CostDist): number {
  if (dist.integer) return randomInt(rng, dist.min, dist.max)
  return dist.min + rng() * (dist.max - dist.min)
}

/**
 * `n` costs from the same distribution, in order.
 *
 * ⚠ INDEPENDENT ACROSS DRAWS AND ACROSS STUDENTS (spec §4). There is no pre-generated
 * per-instance sequence: two students in the same instance face unrelated rivals, so
 * nothing a classmate reports about round 7 tells you anything about your own.
 */
export function drawCosts(rng: Rng, dist: CostDist, n: number): number[] {
  const out: number[] = []
  for (let i = 0; i < n; i++) out.push(drawCost(rng, dist))
  return out
}
