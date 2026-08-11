// ═══════════════════════════════════════════════════════════════════════════════
// Procurement Auction — RESUME. Pure, no React, no network: it turns what the server
// says a student has already done into "which screen are they on".
//
//   KC (n questions)  →  prep  →  the round loop  →  final results  →  debrief
//
// ⚠⚠ EVERY INPUT IS A SERVER-STORED FACT. Nothing is kept in the browser, so a student
// resumes identically on another device — and, more to the point, cannot skip a step by
// clearing storage or land back at round 1 by reloading.
//
// ⚠ THE RESULTS SCREEN HAS NO STORED COMPLETION FACT, and that is deliberate rather than
// an oversight. It is a pass-through: it writes nothing, so there is nothing to record.
// A student who reads it and reloads sees it again, which is the correct behaviour for a
// screen whose whole job is to be read. The DEBRIEF's stored answer is what carries the
// flow past it — so "results is done" is expressed as "the debrief has been answered",
// which is a fact, instead of as a flag nothing would maintain.
//
// ⚠⚠ THE STAGES ARE `boolean[]`, ONE FLAG PER SERVED ROW — NEVER A COUNT, and this
// REPLACES an earlier note here arguing the opposite. That note said a count was more
// stable than "a findIndex over ids" because an instructor hiding a question mid-assignment
// shifts the array. The premise is gone: the server now sends one `answered` flag PER ROW,
// computed against the list it is serving in the same response, so there is no stale index
// to shift. And a count is actively wrong once rows can be REORDERED or hidden — it assumes
// the answered rows are a PREFIX. A student who answered rows 1 and 3 resumes at row 2 under
// findIndex and at row 3 under a count, silently skipping the question they missed.
// ═══════════════════════════════════════════════════════════════════════════════

export interface ProcurementResumeInput {
  /** One flag per PRE-PLAY row, in served order: the graded built-ins, the prep paragraph
   *  and any pre-play addition, already ordered and with hidden rows removed. */
  preAnswered: readonly boolean[]
  /** One flag per DEBRIEF row, in served order. */
  debriefAnswered: readonly boolean[]
  /** The server's own verdict that play is over. */
  gameOver: boolean
  roundsPlayed: number
}

/** How many screens the flow has, for the "everything is done" comparison. */
export function procurementScreenCount(i: {
  preCount: number; debriefCount: number
}): number {
  // the pre-play stage + the loop (one screen) + results + the debrief stage
  return i.preCount + 1 + 1 + i.debriefCount
}

/**
 * The first screen the student has NOT completed.
 *
 * Returns `procurementScreenCount(...)` when everything is done — the caller reads that
 * as "show the terminal results view" rather than mounting the runner past its end.
 */
export function procurementResumeIndex(i: ProcurementResumeInput): number {
  // ── The pre-play stage ─────────────────────────────────────────────────────
  const firstPre = i.preAnswered.findIndex(a => !a)
  if (firstPre !== -1) return firstPre

  const preCount = i.preAnswered.length
  let idx = preCount

  // ── The round loop ─────────────────────────────────────────────────────────
  // One screen, however many rounds it contains; the loop resumes itself from
  // `procurementStartIteration`.
  if (!i.gameOver) return idx
  idx += 1

  // ── Final results ──────────────────────────────────────────────────────────
  // ⚠ No stored fact of its own — a pass-through screen that writes nothing. The DEBRIEF
  // stage's stored answers are what carry the flow past it, so "results is done" is
  // expressed as a fact rather than as a flag nothing would maintain.
  const firstDebrief = i.debriefAnswered.findIndex(a => !a)

  // Nothing left in the debrief stage — past the end.
  if (firstDebrief === -1) return idx + 1 + i.debriefAnswered.length

  // ⚠ NOTHING ANSWERED YET ⇒ THE RESULTS SCREEN FIRST. Arriving from the last round, a
  // student reads their own outcome before being asked to reflect on it. Once they are
  // PART-WAY through the stage the results screen is behind them, and re-showing it would
  // be a step backwards.
  if (firstDebrief === 0) return idx
  return idx + 1 + firstDebrief
}

export function procurementStartIteration(roundsPlayed: number): number {
  return Math.max(0, roundsPlayed)
}
