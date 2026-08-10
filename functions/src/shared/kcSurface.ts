// ═══════════════════════════════════════════════════════════════════════════════
// THE SHARED KC QUESTION SURFACE — server half.
//
// Built for SIX games (scorecard, pd, pricing, newsvendor, forecast, procurement) and
// wired to ONE of them (scorecard) in this pass. Nothing here is scorecard-specific; the
// per-game files supply their own ids, stages and built-in sets.
//
// Convergence spec §5 — three fields, and that is all:
//
//   hidden     id → bool          "do not ask this question"
//   order      id → position      "ask them in this order, within a stage"
//   overrides  id → { prompt?, options? }
//                                 "ask this one with my wording"
//
// ⚠⚠ EVERY ONE OF THE THREE MUST BE HONOURED IN **TWO** PLACES: the serve path AND the
// grader's scoring set. A question hidden from the display but left in `forScoring` is
// graded against an answer the student was never shown, and the denominator counts a
// question that was never asked. That is the single most plausible bug this whole change
// introduces (spec §5), and it is why `visibleKcIds` below is exported as ONE function
// that both paths are expected to call rather than as a filter each path writes itself.
//
// ⚠ AN OVERRIDE REPLACES DISPLAY TEXT AND NOTHING ELSE. The shape enforces it rather than
// documenting it: `options` is a map from EXISTING option id to a replacement LABEL, so an
// override cannot add an option, remove one, reorder them, change an option's id, or touch
// the answer key. Grading compares option ids/values, so by construction an override
// cannot move a score. Do not "simplify" this to a list of options.
// ═══════════════════════════════════════════════════════════════════════════════

/** id → "do not ask this". Absent id ⇒ visible; that is the migration-safe default. */
export type KcHiddenMap = Record<string, boolean>

/** id → sort position within its stage. Absent id ⇒ keep authored position. */
export type KcOrderMap = Record<string, number>

/**
 * One question's instructor wording.
 *
 * ⚠ `options` is keyed by the option's OWN id and carries only its label. See the header.
 */
export interface KcOverride {
  prompt?: string
  options?: Record<string, string>
}

export type KcOverrideMap = Record<string, KcOverride>

/** Longest accepted override prompt. Generous — some stems are a short paragraph. */
export const MAX_OVERRIDE_PROMPT = 2000
/** Longest accepted override option label. */
export const MAX_OVERRIDE_OPTION = 500

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

// ── Parsers. Total on `undefined` — a doc written before these fields existed reads
//    as "no hides, no reordering, no overrides", which is exactly current behaviour.

export function parseKcHidden(raw: unknown): KcHiddenMap {
  if (!isObj(raw)) return {}
  const out: KcHiddenMap = {}
  for (const [k, v] of Object.entries(raw)) {
    // ⚠ Only `true` is stored. A `false` entry is dropped rather than kept, so the map
    // stays a set of hidden ids and a stale `false` cannot be mistaken for an assertion
    // that a question exists.
    if (v === true && k) out[k] = true
  }
  return out
}

export function parseKcOrder(raw: unknown): KcOrderMap {
  if (!isObj(raw)) return {}
  const out: KcOrderMap = {}
  for (const [k, v] of Object.entries(raw)) {
    if (k && typeof v === 'number' && Number.isFinite(v)) out[k] = v
  }
  return out
}

export function parseKcOverrides(raw: unknown): KcOverrideMap {
  if (!isObj(raw)) return {}
  const out: KcOverrideMap = {}
  for (const [id, v] of Object.entries(raw)) {
    if (!id || !isObj(v)) continue
    const entry: KcOverride = {}

    const prompt = typeof v.prompt === 'string' ? v.prompt.trim() : ''
    if (prompt) entry.prompt = prompt.slice(0, MAX_OVERRIDE_PROMPT)

    if (isObj(v.options)) {
      const options: Record<string, string> = {}
      for (const [optId, label] of Object.entries(v.options)) {
        if (!optId || typeof label !== 'string') continue
        const t = label.trim()
        if (t) options[optId] = t.slice(0, MAX_OVERRIDE_OPTION)
      }
      if (Object.keys(options).length > 0) entry.options = options
    }

    // An entry that overrides nothing is dropped — it would otherwise render as an
    // "edited" badge on a question whose text is unchanged.
    if (entry.prompt !== undefined || entry.options !== undefined) out[id] = entry
  }
  return out
}

// ── The two places that must agree ────────────────────────────────────────────

/**
 * The ids this instance actually asks, from a set of candidates.
 *
 * ⚠ CALL THIS FROM BOTH THE SERVE PATH AND THE GRADER. It exists so that "which questions
 * exist" has exactly one answer per instance. See the file header.
 */
export function visibleKcIds(ids: readonly string[], hidden: KcHiddenMap): string[] {
  return ids.filter(id => hidden[id] !== true)
}

/** Is this question asked at all? */
export function isKcHidden(id: string, hidden: KcHiddenMap): boolean {
  return hidden[id] === true
}

/**
 * Order a stage's questions.
 *
 * ⚠ TOTAL ON A PARTIAL MAP. An id with no entry keeps its AUTHORED position, and ties
 * break by authored index, so the sort is stable and can never drop or duplicate a
 * question. The settings page writes a complete map for a stage whenever anything moves,
 * so the partial case is a migration and hand-edit safeguard rather than the normal path.
 */
export function applyKcOrder<T>(
  items: readonly T[],
  idOf: (item: T) => string,
  order: KcOrderMap,
): T[] {
  return items
    .map((item, index) => ({ item, index, key: order[idOf(item)] ?? index }))
    .sort((a, b) => (a.key - b.key) || (a.index - b.index))
    .map(x => x.item)
}

// ── Instructor-added questions ────────────────────────────────────────────────

/**
 * ⚠⚠ BOTH COLLISION-GUARD STRATEGIES, because the family needs both (spec §5).
 *
 *   `prefix`  — pd, pricing, newsvendor, forecast. Their built-ins own the `kc_`
 *               namespace, so any added id starting with it is refused.
 *   `idSet`   — scorecard. Its built-in ids are UNPREFIXED (`q1_negotiated_ppm`), so a
 *               prefix rule would protect nothing; the built-in set itself is the
 *               authority.
 *
 * Picking one silently unprotects the other, which is why this takes the strategy as an
 * argument rather than hardcoding either. ⚠ Do NOT migrate scorecard's ids to gain a
 * prefix — stored answers are keyed by question id, and renaming orphans every one.
 */
export type KcIdGuard =
  | { kind: 'prefix'; prefix: string }
  | { kind: 'idSet'; ids: ReadonlySet<string> }

export function guardRejects(id: string, guard: KcIdGuard | undefined): boolean {
  if (!guard) return false
  return guard.kind === 'prefix' ? id.startsWith(guard.prefix) : guard.ids.has(id)
}

/**
 * An instructor-written question, in the shape all five games that have one already agree
 * on, plus the optional `stage` this convergence adds.
 */
export interface AddedKcQuestion {
  id: string
  type: 'mc' | 'text'
  prompt: string
  options?: { value: string; label: string }[]
  correct_value?: string
  explanation?: string
  /** Which stage asks it. Absent ⇒ the consuming game's own default. */
  stage?: string
}

/**
 * Parse one stored/incoming added question, or null if unusable.
 *
 * ⚠ EXTRACTED FROM FIVE NEAR-COPIES, none of which were byte-identical (audit, 08-10).
 * The logic is pd's and pricing's verbatim; the only behavioural additions are the
 * pluggable id guard above and the optional `stage`, both of which default to "off" so a
 * caller that passes neither gets exactly the old behaviour.
 *
 * ⚠ OPTIONAL FIELDS ARE OMITTED, NEVER SET TO undefined. These objects are written straight
 * into Firestore, which REJECTS an undefined value outright — so an explanation-less
 * question would fail the whole save rather than store cleanly.
 */
export function parseAddedKcQuestion(
  raw: unknown,
  opts: { guard?: KcIdGuard; stages?: readonly string[] } = {},
): AddedKcQuestion | null {
  if (typeof raw !== 'object' || raw === null) return null
  const q = raw as Record<string, unknown>
  const id = typeof q.id === 'string' ? q.id.trim() : ''
  const prompt = typeof q.prompt === 'string' ? q.prompt.trim() : ''
  if (!id || !prompt) return null
  if (guardRejects(id, opts.guard)) return null

  const explanation = typeof q.explanation === 'string' && q.explanation.trim()
    ? q.explanation.trim() : null

  // An unrecognised stage is DROPPED rather than stored, so the consuming game falls back
  // to its own default instead of holding a question no flow renders.
  const stage = typeof q.stage === 'string' && opts.stages?.includes(q.stage)
    ? q.stage : null

  const type: 'mc' | 'text' = q.type === 'mc' ? 'mc' : 'text'
  if (type === 'text') {
    // Free text cannot be auto-graded, so it is recorded and left UNGRADED — it never
    // enters the KC score's numerator or denominator.
    return {
      id, type, prompt,
      ...(explanation ? { explanation } : {}),
      ...(stage ? { stage } : {}),
    }
  }

  const optionsRaw = Array.isArray(q.options) ? q.options : []
  const options: { value: string; label: string }[] = []
  for (const o of optionsRaw) {
    if (typeof o !== 'object' || o === null) continue
    const oo = o as Record<string, unknown>
    const value = typeof oo.value === 'string' ? oo.value : ''
    const label = typeof oo.label === 'string' ? oo.label : ''
    if (value && label) options.push({ value, label })
  }
  if (options.length < 2) return null   // an mc question needs something to choose between

  const key = typeof q.correct_value === 'string' ? q.correct_value : ''
  // A key that names no offered option is dropped rather than kept: it would mark every
  // student wrong, silently.
  const hasKey = options.some(o => o.value === key)

  return {
    id, type, prompt, options,
    ...(hasKey ? { correct_value: key } : {}),
    ...(explanation ? { explanation } : {}),
    ...(stage ? { stage } : {}),
  }
}
