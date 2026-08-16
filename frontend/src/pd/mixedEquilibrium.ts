import type { PdPayoffs } from './api'

// ═══════════════════════════════════════════════════════════════════════════════
// THE STUDENT'S INDIFFERENCE PROBABILITY — an INSTRUCTOR-ONLY hint (spec §5.5).
//
// Beside the Random opponent's probability input, the settings page shows the mixing
// probability that would make the STUDENT indifferent between their two actions. It is
// there so Elena can set p deliberately — at the indifference point, above it, or below
// it — rather than by feel.
//
//     q = [ Y(D,D) − Y(C,D) ] / [ Y(C,C) − Y(C,D) − Y(D,C) + Y(D,D) ]
//
// ⚠⚠ THE FORMULA USES **Y**, THE STUDENT'S PAYOFF ROW — NOT O.
//
// A player's mixing probability is fixed by the OTHER player's payoffs: you mix so that
// your opponent is indifferent. The number displayed here is the probability the BOT
// would have to play the first move to leave the STUDENT indifferent, so it is built
// entirely from the student's own payoffs. The bot's numbers do not appear.
//
// This is the single most likely bug in this feature, because O sits directly beside Y
// in the config object and in the eight-box grid. `mixedEquilibrium.test.ts` asserts
// that changing ONLY the four O values leaves q untouched — that test is the point.
//
// ⚠⚠ NO DIRECTION FLAG, AND NONE IS NEEDED. Negating all eight payoffs negates the
// numerator and the denominator alike, so q is IDENTICAL under either reading of
// "better". The game is direction-agnostic (§2) and this number does not break that.
// A test pins the negation invariance. If a future pass finds itself wanting a
// higher-is-better/lower-is-better setting to make this work, something else is wrong.
//
// ⚠ ADVISORY. It never changes p, never blocks save, never warns. It is a number on a
// screen for one person.
//
// ⚠ INSTRUCTOR-FACING ONLY. Nothing here is stored, served to a student, or graded, and
// no student-facing component imports this module. The harness asserts both halves.
// ═══════════════════════════════════════════════════════════════════════════════

/** What the settings page has to render. Three states, no fourth. */
export type MixedEquilibrium =
  /** q is a probability — display it. */
  | { kind: 'probability'; q: number }
  /** q computed but outside [0,1]: one action is better whatever the bot does. */
  | { kind: 'dominant' }
  /** The denominator is zero: the student's payoffs never separate the two actions. */
  | { kind: 'undefined' }

/**
 * The student's indifference probability for this matrix.
 *
 * Pure, and a pure function of the FOUR Y VALUES ONLY. Pass the whole payoff object for
 * call-site convenience; the four O fields are read by nothing in this file.
 */
export function mixedEquilibrium(p: PdPayoffs): MixedEquilibrium {
  const numerator = p.you_dd - p.you_cd
  const denominator = p.you_cc - p.you_cd - p.you_dc + p.you_dd

  // ⚠ EXACT ZERO, not an epsilon. The payoffs are instructor-typed numbers, so a
  // denominator of zero means they really did type a matrix whose two rows never
  // separate — not that a computation drifted.
  if (denominator === 0) return { kind: 'undefined' }

  const q = numerator / denominator
  if (!Number.isFinite(q)) return { kind: 'undefined' }
  if (q < 0 || q > 1) return { kind: 'dominant' }
  return { kind: 'probability', q }
}

/**
 * The hint, as the settings page renders it, in the instance's own wording.
 *
 * ⚠ ROUNDED FOR DISPLAY ONLY. Nothing stores q — it is recomputed from the form on
 * every keystroke — so there is no stored value to round and no precision to lose.
 */
export function mixedEquilibriumText(
  p: PdPayoffs,
  labels: { C: string; D: string },
): string {
  const eq = mixedEquilibrium(p)
  switch (eq.kind) {
    case 'undefined':
      return 'Undefined'
    case 'dominant':
      return 'Undefined — a dominant strategy exists'
    case 'probability':
      return `The student is indifferent when the opponent plays ${labels.C} `
        + `${Number((eq.q * 100).toFixed(1))}% of the time.`
  }
}
