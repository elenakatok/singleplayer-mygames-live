import type { NewsvendorConfig } from './config'
import { resolveNewsvendorKc } from './questions'

// ═══════════════════════════════════════════════════════════════════════════════
// WHICH OF NEWSVENDOR'S BUILT-INS ARE LOCKED — convergence spec D1.
//
//   A question is LOCKED (an instructor may not rewrite it) IFF ITS TEXT INTERPOLATES
//   INSTANCE PARAMETERS. Not "iff it is a built-in".
//
// ⚠⚠ THE EXPECTED ANSWER HERE IS "NONE", AND THAT MAKES THIS THE ONE GAME WHERE THE
// DETECTOR CAN LOOK BROKEN WHILE WORKING. Every one of newsvendor's twenty questions is a
// literal string — the numbers are baked into the text on purpose (P=120, c=50, mean 500,
// sd 100 regular; P=200, c=60, c_l=140, mean 400, sd 100 dual), because the KC uses a
// DIFFERENT market from the one the student plays so they must recompute rather than read
// an answer off the order screen. Nothing moves when the instance moves, so nothing locks.
//
// ⚠⚠ A DETECTOR THAT CAN ONLY EVER RETURN "EDITABLE" IN THIS GAME IS INDISTINGUISHABLE FROM
// ONE THAT IS BROKEN. `probeDetector` below exists solely so the test suite can prove the
// machinery still fires: it runs the identical comparison over a deliberately
// PARAMETERISED question and must lock it. Without that, "0 of 20 locked" proves nothing.
//
// ⚠ TWO PROBES, NOT ONE. A single probe can agree with the live set by coincidence.
// ═══════════════════════════════════════════════════════════════════════════════

/** Everything that distinguishes one rendering of a question from another. */
function textOf(q: { prompt: string; options: { value: string; label: string }[]; explanation: string }): string {
  return [
    q.prompt,
    q.options.map(o => `${o.value}${o.label}`).join(''),
    q.explanation,
  ].join(' ')
}

/**
 * A config that differs from `config` in EVERY parameter a question could read, while
 * staying inside the loader's own rails so the built set is a legal one.
 *
 * ⚠ `dual` IS NOT PERTURBED. Flipping it swaps the whole set for a disjoint one, so every
 * id would read as "absent from the probe" and the detector would lock all twenty for a
 * reason that has nothing to do with interpolation. The mode is a property of WHICH set is
 * being classified, not a parameter within it — `lockedKcQuestionIds` is called per mode.
 */
function probe(config: NewsvendorConfig, shift: number): NewsvendorConfig {
  return {
    ...config,
    P: config.P + shift * 37,
    c: config.c + shift * 13,
    v: config.v + shift * 7,
    g: config.g + shift * 11,
    h: config.h + shift * 3,
    cL: config.cL + shift * 23,
    isNormal: shift % 2 === 1 ? !config.isNormal : config.isNormal,
    mean: config.mean + shift * 97,
    sd: config.sd + shift * 17,
    minD: config.minD + shift * 29,
    maxD: config.maxD + shift * 53,
    periods: Math.max(2, config.periods + shift),
  }
}

/**
 * The ids whose text moves when instance parameters move — i.e. the locked ones, FOR THE
 * MODE THIS CONFIG IS IN.
 *
 * ⚠ Overrides and hides are deliberately CLEARED in the probes. An instructor's own edit is
 * not evidence of interpolation, and a hidden question must still be classified — the
 * settings page shows locked/editable for rows the student is not currently being asked.
 */
export function lockedKcQuestionIds(config: NewsvendorConfig): Set<string> {
  const bare = (c: NewsvendorConfig): NewsvendorConfig =>
    ({ ...c, kcEnabled: true, kcHidden: {}, kcOverrides: {}, kcOrder: {} })

  const live = resolveNewsvendorKc(bare(config))
  const a = resolveNewsvendorKc(bare(probe(config, 1)))
  const b = resolveNewsvendorKc(bare(probe(config, 2)))

  const mA = new Map(a.map(q => [q.field, textOf(q)]))
  const mB = new Map(b.map(q => [q.field, textOf(q)]))

  const locked = new Set<string>()
  for (const q of live) {
    const t = textOf(q)
    if (!mA.has(q.field) || !mB.has(q.field) || mA.get(q.field) !== t || mB.get(q.field) !== t) {
      locked.add(q.field)
    }
  }
  return locked
}

/**
 * ⚠⚠ THE DETECTOR'S SELF-PROOF. Runs the IDENTICAL comparison over a caller-supplied
 * question builder, so a test can hand it a deliberately parameterised question and watch
 * it lock — establishing that "nothing locked in newsvendor" is a finding about newsvendor
 * and not a broken detector.
 *
 * It is exported production code rather than test-local so it cannot drift from the real
 * comparison: if `textOf` or the probe strategy changes, this changes with it.
 */
export function probeDetector(
  config: NewsvendorConfig,
  build: (c: NewsvendorConfig) => { field: string; prompt: string; options: { value: string; label: string }[]; explanation: string }[],
): Set<string> {
  const live = build(config)
  const a = new Map(build(probe(config, 1)).map(q => [q.field, textOf(q)]))
  const b = new Map(build(probe(config, 2)).map(q => [q.field, textOf(q)]))

  const locked = new Set<string>()
  for (const q of live) {
    const t = textOf(q)
    if (!a.has(q.field) || !b.has(q.field) || a.get(q.field) !== t || b.get(q.field) !== t) {
      locked.add(q.field)
    }
  }
  return locked
}

/**
 * Why a question cannot be edited, in the words the settings page shows.
 *
 * ⚠ Kept even though newsvendor locks nothing today: the detector is live, and a future
 * edit that threaded a config value into a stem would lock that question immediately. The
 * page must have the sentence ready.
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
 * ⚠⚠ THE SERVER-SIDE HALF OF THE LOCK (spec §5, "enforced at the callable, not only in the
 * UI"). A greyed-out Edit button stops an instructor; it does not stop a stale tab, a
 * replayed payload or a hand-made call.
 *
 * ⚠ `optionIds` HOLDS ONLY THE CURRENT MODE'S QUESTIONS, and an entry for a question that is
 * not in it is CARRIED, not refused — it is the other mode's, and the settings page
 * round-trips the whole map on every save. Refusing would make the page unsaveable the
 * moment somebody flipped the dual toggle, with the instructor's own earlier work as the
 * cause. Pricing hit the identical case with its vanishing questions.
 */
export function validateKcOverrides(
  overrides: Record<string, { prompt?: string; options?: Record<string, string> }>,
  ctx: {
    /** ⚠ The UNION of both modes' ids. */
    builtInIds: ReadonlySet<string>
    locked: ReadonlySet<string>
    /** question id → the option values it offers, for the CURRENT mode's questions. */
    optionIds: ReadonlyMap<string, ReadonlySet<string>>
  },
): KcOverrideRejection[] {
  const out: KcOverrideRejection[] = []
  for (const [id, entry] of Object.entries(overrides)) {
    if (!ctx.builtInIds.has(id)) {
      out.push({
        id,
        reason: 'not-built-in',
        message: `'${id}' is not a built-in question. Your own questions are edited directly, `
          + 'and the prep and debrief paragraphs have their own prompt fields.',
      })
      continue
    }
    if (ctx.locked.has(id)) {
      out.push({
        id,
        reason: 'locked',
        message: `'${id}' cannot be edited — ${KC_LOCK_REASON.toLowerCase()}, so a rewrite `
          + 'would be discarded the next time you change a parameter.',
      })
      continue
    }
    const known = ctx.optionIds.get(id)
    if (known === undefined) continue   // the other mode's question — see the header
    for (const optId of Object.keys(entry.options ?? {})) {
      if (!known.has(optId)) {
        out.push({ id, reason: 'unknown-option', message: `'${optId}' is not an option of '${id}'.` })
      }
    }
  }
  return out
}
