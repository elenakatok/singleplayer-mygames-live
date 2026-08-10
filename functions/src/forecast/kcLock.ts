import type { ForecastConfig } from './config'
import { FORECAST_BUILT_IN_KC_IDS, resolveForecastKc } from './questions'

// ═══════════════════════════════════════════════════════════════════════════════
// WHICH OF FORECAST'S BUILT-INS ARE LOCKED — convergence spec D1.
//
//   A question is LOCKED (an instructor may not rewrite it) IFF ITS TEXT INTERPOLATES
//   INSTANCE PARAMETERS. Not "iff it is a built-in".
//
// ⚠⚠ THE ANSWER IS MEASURED, NEVER LISTED. A hand-maintained set of ids is correct only
// until somebody threads a config value into a stem, and wrong silently thereafter. This
// rebuilds the question set under two perturbed configs and locks whatever moved.
//
// ⚠⚠ THE EXPECTED ANSWER IS "NONE", AND THAT IS A DELIBERATE PROPERTY OF THIS GAME rather
// than an accident. questions.ts's own header explains it: the KC runs BEFORE play, and in
// forecast the model parameters ARE the answer, so deriving a stem from a, b, H or σ would
// print the answer on a screen the student sees before they have forecast anything. Even
// Q6's trend is a hand-picked constant (Q6_TREND_UNITS = 12) chosen NOT to be the
// instance's own b. Nothing in the nine reads the instance, so nothing locks.
//
// ⚠⚠ A DETECTOR THAT CAN ONLY EVER RETURN "EDITABLE" IN THIS GAME IS INDISTINGUISHABLE FROM
// ONE THAT IS BROKEN — a detector that always returned the empty set would produce the
// identical report. `probeDetector` below exists solely so the suite can prove the
// machinery fires: it runs the IDENTICAL comparison over a caller-supplied builder, and a
// test hands it a controlled probe set — an all-static question that must NOT lock, and
// stem/option/explanation-interpolating ones that must.
//
// ⚠ TWO PROBES, NOT ONE. A single perturbation can agree with the live set by coincidence
// (a stem reading `rounds` would tie if the one probe happened to leave `rounds` alone).
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
 * ⚠ THE MODEL IS NOT HERE, AND CANNOT BE — a, b, H and σ live in `truth/main`, and
 * `resolveForecastKc` takes a `ForecastConfig`, which by this game's inverted config/truth
 * split (config.ts's header) can never hold one. That is not a hole in the detector: a
 * question CANNOT interpolate a model parameter without first changing that signature, and
 * changing it would be the leak, caught long before this file.
 */
function probe(config: ForecastConfig, shift: number): ForecastConfig {
  return {
    ...config,
    // ⚠⚠ THE INSTRUCTOR'S OWN MAPS ARE PERTURBED TOO, and `bare` below strips them. That
    // pairing is what makes the normalisation OBSERVABLE rather than merely intended: if
    // `bare` stopped clearing them, a question whose text depended on an override would
    // differ between arms and lock ITSELF — so an instructor's first edit would forbid
    // their second. A probe that left the maps alone would let that regression through
    // silently, which is exactly what happened when this mutant was first run.
    kcHidden: { ...config.kcHidden, [`~probe${shift}`]: true },
    kcOrder: { ...config.kcOrder, [`~probe${shift}`]: shift },
    kcOverrides: { ...config.kcOverrides, [`~probe${shift}`]: { prompt: `probe${shift}` } },
    numHistory: Math.max(12, config.numHistory + shift * 13),
    rounds: Math.max(1, config.rounds + shift * 7),
    forecastMin: config.forecastMin + shift * 3,
    forecastMax: config.forecastMax + shift * 137,
    productName: `${config.productName}~probe${shift}`,
    unitLabel: `${config.unitLabel}~probe${shift}`,
    periodLabel: `${config.periodLabel}~probe${shift}`,
  }
}

/**
 * The ids whose text moves when instance parameters move — i.e. the locked ones.
 *
 * ⚠ Overrides and hides are deliberately CLEARED in every arm. An instructor's own edit is
 * not evidence of interpolation, and a hidden question must still be classified: the
 * settings page shows locked/editable for rows the student is not currently being asked.
 * `kcEnabled` is forced on for the same reason — with it off the resolver returns nothing
 * and every question would read as "absent from the probe", locking all nine for a reason
 * that has nothing to do with interpolation.
 */
function bare(c: ForecastConfig): ForecastConfig {
  return { ...c, kcEnabled: true, kcHidden: {}, kcOverrides: {}, kcOrder: {} }
}

export function lockedKcQuestionIds(config: ForecastConfig): Set<string> {
  const live = resolveForecastKc(bare(config))
  const a = new Map(resolveForecastKc(bare(probe(config, 1))).map(q => [q.field, textOf(q)]))
  const b = new Map(resolveForecastKc(bare(probe(config, 2))).map(q => [q.field, textOf(q)]))

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
 * ⚠⚠ THE DETECTOR'S SELF-PROOF. Runs the IDENTICAL comparison over a caller-supplied
 * question builder, so a test can hand it a deliberately parameterised question and watch
 * it lock — establishing that "nothing locked in forecast" is a finding about forecast and
 * not a broken detector.
 *
 * It is exported production code rather than test-local so it cannot drift from the real
 * comparison: if `textOf` or the probe strategy changes, this changes with it. A test-local
 * copy would keep passing while the real detector rotted.
 */
export function probeDetector(
  config: ForecastConfig,
  build: (c: ForecastConfig) => { field: string; prompt: string; options: { value: string; label: string }[]; explanation: string }[],
): Set<string> {
  // ⚠ NORMALISED THROUGH THE SAME `bare`, so the self-proof exercises the normalisation
  // rather than only the comparison. A probe question that reads an instructor's map is
  // static once every arm sees an empty one — and the test suite hands it exactly that.
  const live = build(bare(config))
  const a = new Map(build(bare(probe(config, 1))).map(q => [q.field, textOf(q)]))
  const b = new Map(build(bare(probe(config, 2))).map(q => [q.field, textOf(q)]))

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
 * ⚠ Kept even though forecast locks nothing today: the detector is live, and an edit that
 * threaded a config value into a stem would lock that question the moment it landed. The
 * page must already have the sentence.
 */
export const KC_LOCK_REASON = 'Recomputed from your settings'

/** What a rejected override was rejected for, and the sentence to say about it. */
export interface KcOverrideRejection {
  id: string
  reason: 'not-built-in' | 'locked' | 'unknown-option'
  message: string
}

/**
 * ⚠⚠ THE CONTEXT `validateKcOverrides` IS CALLED WITH — built here rather than at the
 * callable, so a unit test can reach it.
 *
 * A mutant that added `debrief_method` to `builtInIds` at the CALL SITE survived the whole
 * suite, because every test constructed its own context and none exercised the one the
 * callable actually passes (spec §7 — the wiring, not the primitive).
 *
 * ⚠ `builtInIds` IS THE AUTHORED SET AND NOTHING ELSE. The debrief row is deliberately
 * absent: its prompt is edited through `debrief_prompt`, where it has always been stored,
 * and a second channel for the same paragraph would be a second source of truth.
 */
export function forecastOverrideContext(config: ForecastConfig): {
  builtInIds: ReadonlySet<string>
  locked: ReadonlySet<string>
  optionIds: ReadonlyMap<string, ReadonlySet<string>>
} {
  const built = resolveForecastKc(bare(config))
  return {
    builtInIds: FORECAST_BUILT_IN_KC_IDS,
    locked: lockedKcQuestionIds(config),
    optionIds: new Map(built.map(q => [q.field, new Set(q.options.map(o => o.value))])),
  }
}

/**
 * Check an override map against the questions this instance actually has.
 *
 * ⚠⚠ THE SERVER-SIDE HALF OF THE LOCK (spec §5, "enforced at the callable, not only in the
 * UI"). A greyed-out Edit button stops an instructor; it does not stop a stale tab, a
 * replayed payload or a hand-made call.
 *
 * ⚠ `debrief_method` is NOT a built-in for this purpose and is refused with the rest: its
 * prompt is edited through `debrief_prompt`, which is where it has always been stored, and
 * accepting a second channel for the same text would create two sources of truth for one
 * paragraph.
 */
export function validateKcOverrides(
  overrides: Record<string, { prompt?: string; options?: Record<string, string> }>,
  ctx: {
    builtInIds: ReadonlySet<string>
    locked: ReadonlySet<string>
    /** question id → the option values it offers. */
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
          + 'and the debrief paragraph has its own prompt field.',
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
    if (known === undefined) continue
    for (const optId of Object.keys(entry.options ?? {})) {
      if (!known.has(optId)) {
        out.push({ id, reason: 'unknown-option', message: `'${optId}' is not an option of '${id}'.` })
      }
    }
  }
  return out
}
