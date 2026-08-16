import type { PdConfig } from './config'
import { resolveKcQuestions, type PdKcQuestion } from './questions'

// ═══════════════════════════════════════════════════════════════════════════════
// WHICH OF PD'S BUILT-IN QUESTIONS ARE LOCKED — convergence spec D1.
//
//   A question is LOCKED (an instructor may not rewrite it) IFF ITS TEXT INTERPOLATES
//   INSTANCE PARAMETERS. Not "iff it is a built-in".
//
// ⚠ THE LOCK COVERS THE STEM, EVERY OPTION **AND** THE EXPLANATION (spec §3). Checking
// stems alone would unlock a question whose stem is static English but whose options are
// the payoff values.
//
// ⚠⚠ MEASURED, NOT LISTED — the same method scorecard uses, and for the same reason: a
// hand-written array of locked ids is correct exactly once, on the day it is written, and
// every later edit to questions.ts silently falsifies it. So the classification is DERIVED
// by rebuilding the set under deliberately different parameters and seeing whose text moves.
//
// ⚠ TWO PROBES, NOT ONE. A single probe can agree with the live set by coincidence — a
// shifted payoff that happens to render the same string, a label that appears nowhere. Both
// probes are compared against each other AND against the live config; a question is static
// only if all three render identically. `pdKcLock.test.ts` pins the result question by
// question, so an edit that moves one between classes fails a test rather than passing.
//
// ⚠ PD IS EXPECTED TO COME OUT ALL-LOCKED, and that is the honest answer rather than a
// disappointing one: all four questions are BUILT from the payoff matrix, which is exactly
// what D1 describes. The spec predicted it; this measures it rather than trusting it.
// ═══════════════════════════════════════════════════════════════════════════════

/** Everything that distinguishes one rendering of a question from another. */
function textOf(q: PdKcQuestion): string {
  return [
    q.prompt,
    (q.options ?? []).map(o => `${o.value}${o.label}`).join(''),
    q.explanation ?? '',
  ].join(' ')
}

/** Build pd's four under one perturbation of every parameter they can read. */
function probeSet(
  config: PdConfig,
  tag: string,
  shift: number,
): PdKcQuestion[] {
  return resolveKcQuestions(
    // ⚠ ALL EIGHT ARE PERTURBED, each by a different multiple, so no two cells can
    // collide onto the same number and make a question look static by coincidence.
    {
      you_cc: config.payoffs.you_cc + shift,
      you_cd: config.payoffs.you_cd + shift * 2,
      you_dc: config.payoffs.you_dc + shift * 3,
      you_dd: config.payoffs.you_dd + shift * 5,
      other_cc: config.payoffs.other_cc + shift * 7,
      other_cd: config.payoffs.other_cd + shift * 11,
      other_dc: config.payoffs.other_dc + shift * 13,
      other_dd: config.payoffs.other_dd + shift * 17,
    },
    `${config.unit}${tag}`,
    { C: `${config.labels.C}${tag}`, D: `${config.labels.D}${tag}` },
  )
}

/**
 * The ids whose text moves when instance parameters move — i.e. the locked ones.
 *
 * Pure, cheap (three builds of a four-item array) and free of Firestore, so both the
 * instructor callable and the settings payload call it on every request rather than caching
 * a classification that could go stale.
 */
export function lockedKcQuestionIds(config: PdConfig): Set<string> {
  const live = resolveKcQuestions(config.payoffs, config.unit, config.labels)
  const a = probeSet(config, '·Aq', 3)
  const b = probeSet(config, '·Bz', 7)

  const mA = new Map(a.map(q => [q.field, textOf(q)]))
  const mB = new Map(b.map(q => [q.field, textOf(q)]))

  const locked = new Set<string>()
  for (const q of live) {
    const t = textOf(q)
    // Absent from a probe at all ⇒ its very existence depends on the parameters, which is
    // the strongest form of the thing this detects. Lock it.
    if (!mA.has(q.field) || !mB.has(q.field) || mA.get(q.field) !== t || mB.get(q.field) !== t) {
      locked.add(q.field)
    }
  }
  return locked
}

/**
 * Why a question cannot be edited, in the words the settings page shows.
 *
 * ⚠ A DISABLED CONTROL WITH NO EXPLANATION READS AS A BUG. Identical wording to
 * scorecard's, from `scorecard/kcLock.ts` — six pages must not drift into six sentences.
 * (Duplicated as a constant rather than imported across game folders, which are otherwise
 * independent; the shared block renders whatever string it is given.)
 */
export const KC_LOCK_REASON = 'Recomputed from your settings'

/** What a rejected override was rejected for, and the sentence to say about it. */
export interface KcOverrideRejection {
  id: string
  reason: 'not-built-in' | 'locked' | 'unknown-option'
  message: string
}

/**
 * Check an override map against the questions this instance actually has.
 *
 * ⚠⚠ THE SERVER-SIDE HALF OF THE LOCK, AND IT IS NOT OPTIONAL (spec §5, "enforced at the
 * callable, not only in the UI"). A settings page that greys out an Edit button stops an
 * instructor; it does not stop a stale tab whose payload still carries the old
 * classification, a replayed request, or a hand-made call.
 *
 * Returns every problem rather than the first, so a page that batches edits can report them
 * together.
 */
export function validateKcOverrides(
  overrides: Record<string, { prompt?: string; options?: Record<string, string> }>,
  ctx: {
    builtInIds: ReadonlySet<string>
    locked: ReadonlySet<string>
    /** question id → the option values it actually offers. */
    optionIds: ReadonlyMap<string, ReadonlySet<string>>
  },
): KcOverrideRejection[] {
  const out: KcOverrideRejection[] = []
  for (const [id, entry] of Object.entries(overrides)) {
    if (!ctx.builtInIds.has(id)) {
      out.push({
        id,
        reason: 'not-built-in',
        message: `'${id}' is not a built-in question. Your own questions are edited directly, not overridden.`,
      })
      continue
    }
    if (ctx.locked.has(id)) {
      out.push({
        id,
        reason: 'locked',
        message: `'${id}' cannot be edited — ${KC_LOCK_REASON.toLowerCase()}, so a rewrite `
          + 'would be discarded the next time you change the payoff matrix.',
      })
      continue
    }
    // ⚠ An option key that names no offered option is REFUSED rather than ignored: it is
    // the instructor's edit silently going nowhere, which is worse than an error.
    for (const optId of Object.keys(entry.options ?? {})) {
      if (!ctx.optionIds.get(id)?.has(optId)) {
        out.push({ id, reason: 'unknown-option', message: `'${optId}' is not an option of '${id}'.` })
      }
    }
  }
  return out
}
