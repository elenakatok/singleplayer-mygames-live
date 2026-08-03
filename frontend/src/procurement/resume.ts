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
// ⚠ THE KC INDEX IS A COUNT, NOT A findIndex OVER IDS. The server hands back the
// questions in its own resolved order and the answered ids alongside; counting how many
// of the ASKED set are answered is stable when an instructor hides a question
// mid-assignment, whereas an index into a shifted array is not.
// ═══════════════════════════════════════════════════════════════════════════════

export interface ProcurementResumeInput {
  /** How many KC questions this student is asked. Zero when the KC is off. */
  kcCount: number
  /** How many of those they have answered. */
  kcAnswered: number
  /** Is there a prep question in this instance at all? */
  prepEnabled: boolean
  prepAnswered: boolean
  /** Is there a debrief question in this instance at all? */
  debriefEnabled: boolean
  debriefAnswered: boolean
  /** The server's own verdict that play is over. */
  gameOver: boolean
  roundsPlayed: number
}

/** How many screens the flow has, for the "everything is done" comparison. */
export function procurementScreenCount(i: {
  kcCount: number; prepEnabled: boolean; debriefEnabled: boolean
}): number {
  // KC questions + prep? + the loop (one screen) + results + debrief?
  return i.kcCount + (i.prepEnabled ? 1 : 0) + 1 + 1 + (i.debriefEnabled ? 1 : 0)
}

/**
 * The first screen the student has NOT completed.
 *
 * Returns `procurementScreenCount(...)` when everything is done — the caller reads that
 * as "show the terminal results view" rather than mounting the runner past its end.
 */
export function procurementResumeIndex(i: ProcurementResumeInput): number {
  // ── The knowledge check ────────────────────────────────────────────────────
  // ⚠ Clamped. A stale `kcAnswered` larger than the asked set (an instructor hid a
  // question after this student answered it) must not push the index past the KC block.
  const answered = Math.min(i.kcAnswered, i.kcCount)
  if (answered < i.kcCount) return answered

  let idx = i.kcCount

  // ── The prep paragraph ─────────────────────────────────────────────────────
  if (i.prepEnabled) {
    if (!i.prepAnswered) return idx
    idx += 1
  }

  // ── The round loop ─────────────────────────────────────────────────────────
  // One screen, however many rounds it contains; the loop resumes itself from
  // `procurementStartIteration`.
  if (!i.gameOver) return idx
  idx += 1

  // ── Final results ──────────────────────────────────────────────────────────
  // No stored fact of its own — the debrief's answer is what moves past it.
  if (i.debriefEnabled && !i.debriefAnswered) return idx
  if (!i.debriefEnabled) return idx + 1
  idx += 1

  // ── The debrief paragraph ──────────────────────────────────────────────────
  return idx + 1
}

/** Which iteration the round loop resumes at (0-based) — simply the rounds already
 *  stored. The server is the only thing that knows this. */
export function procurementStartIteration(roundsPlayed: number): number {
  return Math.max(0, roundsPlayed)
}
