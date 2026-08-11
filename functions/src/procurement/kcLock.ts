import { poolForFormat, procurementBuiltInIdsForFormat, resolveBuiltIns } from './questions'
import type { ProcurementConfig } from './config'

// ═══════════════════════════════════════════════════════════════════════════════
// WHICH OF PROCUREMENT'S BUILT-INS ARE LOCKED — convergence spec D1.
//
//   A question is LOCKED (an instructor may not rewrite it) IFF ITS TEXT INTERPOLATES
//   INSTANCE PARAMETERS. Not "iff it is a built-in".
//
// ⚠⚠ THE ANSWER IS MEASURED, NEVER LISTED. A hand-maintained set of ids is correct exactly
// once. This rebuilds the question set under two perturbed configs and locks whatever moved.
//
// ⚠⚠ THE EXPECTED ANSWER IS "NONE", AND IT IS A PROPERTY OF THE v3 REWRITE rather than an
// accident. questions.ts's header records it: every question was rewritten as a SELF-CONTAINED
// hypothetical carrying its own numbers, precisely so that one merged pool could be served by
// both formats without any question depending on the instance it is asked in. Nothing in the
// pool reads `reserve`, `rivalCount`, the cost distributions or the currency label, so nothing
// moves when they move, so nothing locks.
//
// ⚠⚠ A DETECTOR THAT CAN ONLY EVER RETURN "EDITABLE" IS INDISTINGUISHABLE FROM ONE THAT IS
// BROKEN — a detector hard-wired to the empty set produces the identical report.
// `probeDetector` exists so the suite can prove the machinery fires, over a CONTROLLED probe
// set: an all-static question that must NOT lock, and stem / option / explanation
// interpolating ones that must, so all three surfaces are shown to fire separately.
//
// ⚠⚠ AND THE NORMALISATION IS PROVED TOO, NOT ONLY THE COMPARISON — forecast's lesson. The
// probe perturbs the instructor's OWN hide/order/override maps, and `bare` strips them, so a
// mutant that stops clearing them changes an observable answer. Without the perturbation that
// mutant survives, and an instructor's first edit would silently forbid their second.
//
// ⚠ TWO PROBES, NOT ONE. A single perturbation can agree with the live set by coincidence.
//
// ⚠ `format` IS NOT PERTURBED. Flipping it swaps the pool for a different one, so every id
// would read as "absent from the probe" and the detector would lock the lot for a reason that
// has nothing to do with interpolation. The format selects WHICH set is being classified, not
// a parameter within it — `lockedKcQuestionIds` is called per format.
// ═══════════════════════════════════════════════════════════════════════════════

/** Everything that distinguishes one rendering of a question from another. */
function textOf(q: {
  prompt: string
  options: readonly { value: string; label: string }[]
  explanation?: string | null
}): string {
  return [
    q.prompt,
    q.options.map(o => `${o.value}${o.label}`).join(''),
    q.explanation ?? '',
  ].join(' ')
}

/**
 * A config that differs from `config` in EVERY parameter a question could read, while
 * staying inside the loader's own rails so the built set is a legal one.
 */
function probe(config: ProcurementConfig, shift: number): ProcurementConfig {
  return {
    ...config,
    // ⚠⚠ THE INSTRUCTOR'S OWN MAPS ARE PERTURBED, and `bare` strips them. See the header:
    // this pairing is what makes the normalisation observable.
    kcHidden: { ...config.kcHidden, [`~probe${shift}`]: true },
    kcOrder: { ...config.kcOrder, [`~probe${shift}`]: shift },
    kcOverrides: { ...config.kcOverrides, [`~probe${shift}`]: { prompt: `probe${shift}` } },
    rounds: Math.max(1, config.rounds + shift * 7),
    rivalCount: Math.max(1, config.rivalCount + shift * 3),
    reserve: config.reserve + shift * 137,
    rivalCostDist: {
      ...config.rivalCostDist,
      min: config.rivalCostDist.min + shift * 11,
      max: config.rivalCostDist.max + shift * 23,
    },
    playerCostDist: {
      ...config.playerCostDist,
      min: config.playerCostDist.min + shift * 13,
      max: config.playerCostDist.max + shift * 29,
    },
    bidIncrementUnit: Math.max(1, config.bidIncrementUnit + shift),
    delayJitterMs: config.delayJitterMs + shift * 17,
    currencyLabel: `${config.currencyLabel}~probe${shift}`,
  }
}

/**
 * ⚠ Overrides, hides and order are CLEARED in every arm, and `kcEnabled` is forced on.
 *
 * An instructor's own edit is not evidence of interpolation. A hidden question must still be
 * classified — the settings page shows locked/editable for rows the student is not currently
 * being asked. And with `kcEnabled` off the `kc` stage resolves empty, so every graded
 * question would read as "absent from the probe" and lock for the wrong reason.
 */
function bare(c: ProcurementConfig): ProcurementConfig {
  return { ...c, kcEnabled: true, kcHidden: {}, kcOverrides: {}, kcOrder: {} }
}

/** Built from every stage, because `prep` and `debrief` are pool questions here too and an
 *  interpolating paragraph must lock exactly like an interpolating stem. */
function allStages(c: ProcurementConfig) {
  return [
    ...resolveBuiltIns(c, 'kc'),
    ...resolveBuiltIns(c, 'prep'),
    ...resolveBuiltIns(c, 'debrief'),
  ]
}

export function lockedKcQuestionIds(config: ProcurementConfig): Set<string> {
  const live = allStages(bare(config))
  const a = new Map(allStages(bare(probe(config, 1))).map(q => [q.id, textOf(q)]))
  const b = new Map(allStages(bare(probe(config, 2))).map(q => [q.id, textOf(q)]))

  const locked = new Set<string>()
  for (const q of live) {
    const t = textOf(q)
    if (!a.has(q.id) || !b.has(q.id) || a.get(q.id) !== t || b.get(q.id) !== t) {
      locked.add(q.id)
    }
  }
  return locked
}

/**
 * ⚠⚠ THE DETECTOR'S SELF-PROOF. Runs the IDENTICAL comparison — including the SAME `bare`
 * normalisation — over a caller-supplied builder, so a test can hand it a deliberately
 * parameterised question and watch it lock. That is what establishes "nothing locked in
 * procurement" as a finding about procurement rather than about the detector.
 *
 * Exported production code rather than test-local, so it cannot drift from the real
 * comparison: a test-local copy would keep passing while the real detector rotted.
 */
export function probeDetector(
  config: ProcurementConfig,
  build: (c: ProcurementConfig) => {
    id: string
    prompt: string
    options: readonly { value: string; label: string }[]
    explanation?: string | null
  }[],
): Set<string> {
  const live = build(bare(config))
  const a = new Map(build(bare(probe(config, 1))).map(q => [q.id, textOf(q)]))
  const b = new Map(build(bare(probe(config, 2))).map(q => [q.id, textOf(q)]))

  const locked = new Set<string>()
  for (const q of live) {
    const t = textOf(q)
    if (!a.has(q.id) || !b.has(q.id) || a.get(q.id) !== t || b.get(q.id) !== t) {
      locked.add(q.id)
    }
  }
  return locked
}

/** Why a question cannot be edited, in the words the settings page shows. */
export const KC_LOCK_REASON = 'Recomputed from your settings'

/** What a rejected override was rejected for, and the sentence to say about it. */
export interface KcOverrideRejection {
  id: string
  reason: 'not-built-in' | 'locked' | 'unknown-option'
  message: string
}

/**
 * ⚠⚠ THE CONTEXT `validateKcOverrides` IS CALLED WITH — built here rather than at the
 * callable, so a unit test can reach it. A mutant that widened `builtInIds` at the CALL SITE
 * survived forecast's entire suite, because every test constructed its own context (spec §7).
 *
 * ⚠ `builtInIds` IS THE WHOLE POOL, not this format's slice. An instructor who edits a
 * question, flips the format and saves must not have their earlier edit refused — the page
 * round-trips the whole map on every save, and refusing would make it unsaveable with the
 * instructor's own earlier work as the cause. Pricing hit the identical case.
 */
export function procurementOverrideContext(config: ProcurementConfig): {
  builtInIds: ReadonlySet<string>
  locked: ReadonlySet<string>
  optionIds: ReadonlyMap<string, ReadonlySet<string>>
} {
  return {
    builtInIds: procurementBuiltInIdsForFormat(),
    locked: lockedKcQuestionIds(config),
    // ⚠ THIS FORMAT'S questions only — an entry for a question not in it is CARRIED, not
    // refused, by validateKcOverrides below. It is the other format's.
    optionIds: new Map(
      poolForFormat(config.format).map(q => [q.id, new Set(q.options.map(o => o.value))]),
    ),
  }
}

/**
 * Check an override map against the questions this instance actually has.
 *
 * ⚠⚠ THE SERVER-SIDE HALF OF THE LOCK (spec §5, "enforced at the callable, not only in the
 * UI"). A greyed-out Edit button stops an instructor; it does not stop a stale tab, a
 * replayed payload or a hand-made call.
 *
 * ⚠ AN ENTRY FOR A QUESTION NOT IN THE CURRENT FORMAT IS CARRIED, NOT REFUSED. See
 * `procurementOverrideContext`.
 */
export function validateKcOverrides(
  overrides: Record<string, { prompt?: string; options?: Record<string, string> }>,
  ctx: {
    builtInIds: ReadonlySet<string>
    locked: ReadonlySet<string>
    optionIds: ReadonlyMap<string, ReadonlySet<string>>
  },
): KcOverrideRejection[] {
  const out: KcOverrideRejection[] = []
  for (const [id, entry] of Object.entries(overrides)) {
    if (!ctx.builtInIds.has(id)) {
      out.push({
        id,
        reason: 'not-built-in',
        message: `'${id}' is not a built-in question. Your own questions are edited directly.`,
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
    if (known === undefined) continue   // the other format's question — see the header
    for (const optId of Object.keys(entry.options ?? {})) {
      if (!known.has(optId)) {
        out.push({ id, reason: 'unknown-option', message: `'${optId}' is not an option of '${id}'.` })
      }
    }
  }
  return out
}
