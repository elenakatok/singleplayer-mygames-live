import type { PdMoveLabels, PdPayoffs } from './api'

// ═══════════════════════════════════════════════════════════════════════════════
// THE DERIVED FOUR, REBUILT CLIENT-SIDE — for the SETTINGS PAGE ONLY.
//
// ⚠⚠ WHY THIS EXISTS, AND WHAT IT IS NOT.
//
// The four matrix questions are DERIVED SERVER-SIDE from (payoffs, unit, labels) on
// every serve and every grade, and that stays true: nothing here is ever served to a
// student, graded against, or stored. The student's knowledge check is untouched by
// this file.
//
// The settings page has a problem the student flow does not. The KC block renders the
// text the SERVER last resolved — captured at page load and refreshed only when a save
// round-trips. The payoff-matrix preview two sections above it is fed from LOCAL form
// state and updates on every keystroke. So an instructor who renames the moves watches
// the preview change to their new words while the knowledge-check list below still says
// "Cooperate" and "Defect", and reasonably concludes the KC does not follow the wording.
// It does — after Save. The page just never said so.
//
// ⚠ THIS IS A MIRROR AND MIRRORS DRIFT. `functions/src/pd/questions.ts` is the source of
// truth; these three functions reproduce `kcPrompt`, `kcExplanation` and the option
// ladder exactly. The drift guard is a pair of tests that assert the SAME literal
// strings on both sides of the wire — `pdQuestions.test.ts` pins what the server
// produces for the fixture below, and `derivedKc.test.ts` pins that this file produces
// the identical strings for the identical fixture. Change one and its own suite fails.
//
// The repo already accepts this shape for the payoff lookup itself (`payoffCells` in
// PayoffMatrix.tsx mirrors `yourPayoff`/`otherPayoff`), for the same reason: the
// settings preview has to be live, and a callable cannot resolve unsaved form state.
// ═══════════════════════════════════════════════════════════════════════════════

/** The four cells, in the order the questions are asked. Mirrors `kcQuestions`. */
export const KC_CELLS: { field: string; you: 'C' | 'D'; other: 'C' | 'D' }[] = [
  { field: 'kc_cc', you: 'C', other: 'C' },
  { field: 'kc_cd', you: 'C', other: 'D' },
  { field: 'kc_dc', you: 'D', other: 'C' },
  { field: 'kc_dd', you: 'D', other: 'D' },
]

/** Mirrors `unitLabel` — "1 point" / "3 points", and any non-English unit left alone. */
export function unitLabel(value: string, unit: string): string {
  const one = value === '1'
  const word = one && unit.length > 1 && unit.endsWith('s') ? unit.slice(0, -1) : unit
  return `${value} ${word}`
}

/** Mirrors `kcPrompt`. Every move name comes from `labels`; nothing is hardcoded. */
export function kcPrompt(
  cell: { you: 'C' | 'D'; other: 'C' | 'D' }, labels: PdMoveLabels, unit: string,
): string {
  const mine = cell.you === 'C' ? labels.C : labels.D
  const theirs = cell.other === 'C' ? labels.C : labels.D
  const also = cell.you === cell.other ? 'also ' : ''
  return `You choose ${mine} and the other player ${also}chooses ${theirs}. How many ${unit} do YOU get?`
}

/** Y(a,b) — mirrors `yourPayoff`. */
function yourPayoff(a: 'C' | 'D', b: 'C' | 'D', p: PdPayoffs): number {
  const k = `${a === 'C' ? 'c' : 'd'}${b === 'C' ? 'c' : 'd'}`
  return p[`you_${k}` as keyof PdPayoffs]
}

/** O(a,b) — mirrors `otherPayoff`. NOT the transpose of Y. */
function otherPayoff(a: 'C' | 'D', b: 'C' | 'D', p: PdPayoffs): number {
  const k = `${a === 'C' ? 'c' : 'd'}${b === 'C' ? 'c' : 'd'}`
  return p[`other_${k}` as keyof PdPayoffs]
}

/** Mirrors `kcExplanation`. Both numbers from the SAME cell. */
export function kcExplanation(
  cell: { you: 'C' | 'D'; other: 'C' | 'D' }, payoffs: PdPayoffs, labels: PdMoveLabels, unit: string,
): string {
  const mine = cell.you === 'C' ? labels.C : labels.D
  const theirs = cell.other === 'C' ? labels.C : labels.D
  const you = unitLabel(String(yourPayoff(cell.you, cell.other, payoffs)), unit)
  const them = unitLabel(String(otherPayoff(cell.you, cell.other, payoffs)), unit)
  return cell.you === cell.other
    ? `When you both choose ${mine}, you each get ${you}.`
    : `Choosing ${mine} while they choose ${theirs} gets you ${you}; they get ${them}.`
}

/**
 * The option ladder: the DISTINCT Y values, ascending, labelled in the unit.
 *
 * ⚠ ITS LENGTH IS NOT FOUR. It is however many distinct Y values the matrix has — three
 * for a Battle of the Sexes matrix (2/0/0/1), two for a matrix with two repeated
 * values. Every question's own correct answer is one of the four Y values, so it is
 * always present; two questions sharing a correct answer is legal and grades correctly
 * for both. Nothing may assume a count of four.
 */
export function kcOptionLadder(payoffs: PdPayoffs, unit: string): { value: string; label: string }[] {
  const distinct = [...new Set([
    payoffs.you_cc, payoffs.you_cd, payoffs.you_dc, payoffs.you_dd,
  ])].sort((a, b) => a - b)
  return distinct.map(v => ({ value: String(v), label: unitLabel(String(v), unit) }))
}

/** One built-in KC row's text, as the settings page should show it for the CURRENT,
 *  possibly unsaved, form values. Returns null for an id that is not one of the four. */
export function derivedKcRow(
  id: string, payoffs: PdPayoffs, unit: string, labels: PdMoveLabels,
): { prompt: string; options: { value: string; label: string }[]; correctValue: string } | null {
  const cell = KC_CELLS.find(c => c.field === id)
  if (!cell) return null
  return {
    prompt: kcPrompt(cell, labels, unit),
    options: kcOptionLadder(payoffs, unit),
    correctValue: String(yourPayoff(cell.you, cell.other, payoffs)),
  }
}

/** Every derived row's explanation, keyed by field — for any surface that shows it. */
export function derivedKcExplanations(
  payoffs: PdPayoffs, unit: string, labels: PdMoveLabels,
): Record<string, string> {
  return Object.fromEntries(
    KC_CELLS.map(c => [c.field, kcExplanation(c, payoffs, labels, unit)]),
  )
}
