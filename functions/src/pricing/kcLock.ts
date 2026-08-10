import type { PricingConfig } from './config'
import { resolvePricingKcQuestions, type PricingKcQuestion } from './questions'

// ═══════════════════════════════════════════════════════════════════════════════
// WHICH OF PRICING'S BUILT-INS ARE LOCKED — convergence spec D1.
//
//   A question is LOCKED (an instructor may not rewrite it) IFF ITS TEXT INTERPOLATES
//   INSTANCE PARAMETERS. Not "iff it is a built-in".
//
// ⚠ THE LOCK COVERS THE STEM, EVERY OPTION **AND** THE EXPLANATION (spec §3). That last
// clause is what settles `kc_below_cost`, whose four options are static English: its stem
// prints the minimum price and the unit cost, and its explanation prints the loss per
// container and the demand won. A stem-only or options-only test would unlock it.
//
// ⚠⚠ MEASURED, NOT LISTED — the method scorecard and pd both use. A hand-written array of
// locked ids is correct exactly once, on the day it is written; every later edit to
// questions.ts silently falsifies it, and the failure mode is an instructor's wording
// surviving a market change and quietly contradicting the numbers beside it.
//
// ⚠ TWO PROBES, NOT ONE. A single probe can agree with the live set by coincidence — a
// shifted price that happens to round to the same string, a label that appears nowhere.
// `pricingKcLock.test` pins the result question by question.
//
// ⚠⚠ AND IT IS RUN PER MODE. The two built-in sets are mutually exclusive, so a
// classification computed for one says nothing about the other. `lockedKcQuestionIds`
// takes the whole config (which carries `pmg`) and answers for the set THAT MODE serves.
// ═══════════════════════════════════════════════════════════════════════════════

/** Everything that distinguishes one rendering of a question from another. */
function textOf(q: PricingKcQuestion): string {
  return [
    q.prompt,
    q.options.map(o => `${o.value}${o.label}`).join(''),
    q.explanation,
  ].join(' ')
}

/**
 * Build the mode's set under one perturbation of every market parameter and label the
 * questions can read.
 *
 * ⚠ THE PERTURBED MARKET MUST STAY LEGAL, or `build()` starts returning null for reasons
 * that have nothing to do with interpolation. Shares still sum to 1, the band still spans
 * several grid steps, and both unit costs stay under the ceiling.
 */
function probeSet(config: PricingConfig, tag: string, shift: number): PricingKcQuestion[] {
  const m = config.market
  const studentBaseShare = m.studentBaseShare === 0.35 ? 0.55 : 0.35
  return resolvePricingKcQuestions(
    {
      ...m,
      marketSize: m.marketSize + shift * 137,
      slope: m.slope + shift * 11,
      minPrice: m.minPrice + shift * m.gridStep,
      maxPrice: m.maxPrice + shift * m.gridStep * 4,
      studentBaseShare,
      competitorBaseShare: 1 - studentBaseShare,
      studentUnitCost: m.studentUnitCost + shift * 13,
      competitorUnitCost: m.competitorUnitCost + shift * 17,
    },
    config.pmg,
    { student: `${config.labels.student}${tag}`, competitor: `${config.labels.competitor}${tag}` },
  )
}

/**
 * The ids whose text moves when instance parameters move — i.e. the locked ones, FOR THE
 * MODE THIS CONFIG IS IN.
 *
 * Pure, cheap (three builds of a ≤4-item array) and free of Firestore.
 */
export function lockedKcQuestionIds(config: PricingConfig): Set<string> {
  const live = resolvePricingKcQuestions(config.market, config.pmg, config.labels)
  const a = probeSet(config, '·Aq', 1)
  const b = probeSet(config, '·Bz', 2)

  const mA = new Map(a.map(q => [q.field, textOf(q)]))
  const mB = new Map(b.map(q => [q.field, textOf(q)]))

  const locked = new Set<string>()
  for (const q of live) {
    const t = textOf(q)
    // ⚠ Absent from a probe entirely ⇒ its very EXISTENCE depends on the parameters
    // (`kc_share_gap` and `kc_below_cost` both return null for some markets). That is the
    // strongest form of the thing this detects, so it locks.
    if (!mA.has(q.field) || !mB.has(q.field) || mA.get(q.field) !== t || mB.get(q.field) !== t) {
      locked.add(q.field)
    }
  }
  return locked
}

/**
 * Why a question cannot be edited, in the words the settings page shows.
 *
 * ⚠ A DISABLED CONTROL WITH NO EXPLANATION READS AS A BUG. Identical wording to scorecard's
 * and pd's — six pages must not drift into six sentences.
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
 * callable, not only in the UI"). A greyed-out Edit button stops an instructor; it does not
 * stop a stale tab, a replayed payload or a hand-made call.
 *
 * ⚠⚠ `optionIds` HOLDS ONLY THE QUESTIONS CURRENTLY BUILT, and an entry for a question that
 * is NOT currently built is CARRIED, not refused. Two things make a built-in absent from the
 * live set: the other mode is selected, or `build()` returned null for this market
 * (`kc_share_gap` on a narrow band, `kc_below_cost` when the floor is above cost). In both
 * cases the instructor cannot see the question, so they cannot have just edited it — the
 * entry is their own earlier work being round-tripped by a save about something else.
 * Refusing it would make the settings page unsaveable the moment somebody flipped the PMG
 * toggle or narrowed the price band. The option-id check still applies to every question an
 * instructor can actually see and edit, which is the case the rule is about.
 */
export function validateKcOverrides(
  overrides: Record<string, { prompt?: string; options?: Record<string, string> }>,
  ctx: {
    /** ⚠ The UNION of both modes' ids — see PRICING_BUILT_IN_KC_IDS. */
    builtInIds: ReadonlySet<string>
    locked: ReadonlySet<string>
    /** question id → the option values it offers, for the questions CURRENTLY built. */
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
          + 'would be discarded the next time you change the market.',
      })
      continue
    }
    // ⚠ Not currently served ⇒ nothing to check the option ids against. See the header.
    const known = ctx.optionIds.get(id)
    if (known === undefined) continue
    for (const optId of Object.keys(entry.options ?? {})) {
      if (!known.has(optId)) {
        out.push({ id, reason: 'unknown-option', message: `'${optId}' is not an option of '${id}'.` })
      }
    }
  }
  return out
}
