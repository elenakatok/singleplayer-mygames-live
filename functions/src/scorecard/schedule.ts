import type { Condition, ReliabilitySchedule } from './config'

// ═══════════════════════════════════════════════════════════════════════════════
// THE RELIABILITY SCHEDULE (spec §2.2) — which condition each contract runs under.
//
// ⚠⚠ THIS FILE IS ONE HALF OF THE GAME'S SINGLE MOST FRAGILE INVARIANT. The other half
// is `reliabilityUsed` being WRITTEN on every period record (spec §14.1). If either the
// schedule is recomputed from something mutable, or the reliability is re-derived at read
// time, the two conditions can quietly collapse into one — and NOTHING WOULD LOOK BROKEN.
// The Tier-3 chart would show two plausible lines, the roster would show a small effort
// gap, and the lecture would be arguing from an experiment that never ran.
//
// The tripwire for that failure is the 0.30-in-BOTH-conditions draw cell in the harness
// (spec §13): low effort pays 30% under either condition, so a collapsed treatment still
// produces a correct-looking 0.30 there, and only the paired 0.70/0.40 cells separate.
//
// ── WHY DETERMINISTIC, NOT RANDOM ────────────────────────────────────────────
//
// `startsWith` alternates over the roster IN JOIN ORDER — no RNG anywhere. Spec §2.2
// requires exact balance ("half the roster starting high and half starting low"); a coin
// flip gives that only in expectation, and a 40-student section can land 25/15 and skew
// the class-level counterbalancing the whole design rests on. Deterministic assignment
// also makes the harness's "splits evenly across the roster" check meaningful rather than
// probabilistic.
//
// ⚠ `startsWith` is WRITTEN ONCE AT JOIN AND NEVER RECOMPUTED (spec §14.1, S1). The join
// ordinal that produced it is not stable — a student who is moved, or a roster that is
// re-synced, changes it — so recomputing on read would silently re-randomise a student's
// entire treatment history mid-session. `conditionFor` takes the STORED value.
// ═══════════════════════════════════════════════════════════════════════════════

/** The opposite condition. */
export function other(condition: Condition): Condition {
  return condition === 'high' ? 'low' : 'high'
}

/**
 * Which condition a student starts with, from their position in join order.
 *
 * Even ordinals start high, odd start low — exactly balanced on any even roster size and
 * off by at most one otherwise. ⚠ Call this ONCE, at join, and store the result.
 */
export function assignStartsWith(joinOrdinal: number): Condition {
  return joinOrdinal % 2 === 0 ? 'high' : 'low'
}

/**
 * The condition contract `contractIndex` (0-based) runs under, for a student whose
 * stored `startsWith` is given.
 *
 * ⚠ PURE AND TOTAL. It reads no clock, no RNG and no participant document beyond the two
 * arguments, which is what lets the harness assert a whole schedule from a single stored
 * field and what lets resume (spec §13) reconstruct the sequence exactly.
 */
export function conditionFor(
  contractIndex: number,
  startsWith: Condition,
  schedule: ReliabilitySchedule,
  contracts: number,
): Condition {
  switch (schedule) {
    // Spec §2.2 — the shipped design. H L H L … or L H L H …
    case 'alternating':
      return contractIndex % 2 === 0 ? startsWith : other(startsWith)

    // First half in the starting condition, second half in the other. Retained as a
    // setting (spec §15) but NOT shipped: it confounds treatment with contract order,
    // and spec §2.2 records that slide 7 shows the order effect is real.
    case 'blocked':
      return contractIndex < Math.ceil(contracts / 2) ? startsWith : other(startsWith)

    // The historical design — one condition for the whole session, varying across
    // students. Retained to reproduce prior semesters (spec §15).
    case 'betweenSubject':
      return startsWith
  }
}

/** The whole schedule for one student — what the harness and the reports both walk. */
export function scheduleFor(
  startsWith: Condition,
  schedule: ReliabilitySchedule,
  contracts: number,
): Condition[] {
  return Array.from({ length: contracts }, (_, i) =>
    conditionFor(i, startsWith, schedule, contracts),
  )
}
