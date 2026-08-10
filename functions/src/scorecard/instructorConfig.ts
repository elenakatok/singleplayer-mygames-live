import { onCall, HttpsError } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import { extractInstructorGameId } from '@mygames/game-server'
import {
  SCORECARD_CORS_ORIGINS, INSTANCES_COLLECTION, PARTICIPANTS_SUBCOLLECTION,
  CONFIG_DOC, TRUTH_DOC,
  HARD_MIN_CONTRACTS, HARD_MAX_CONTRACTS, HARD_MIN_PERIODS, HARD_MAX_PERIODS,
  loadScorecardConfig, loadScorecardTruth, parseAddedKcQuestion, addedKcStage,
  SCORECARD_KC_STAGES,
  type ScorecardAddedKcQuestion, type ScorecardConfig, type ScorecardTruth,
} from './config'
import {
  scorecardKcQuestions, applyKcOverride, isGradedAdded, isKcOverridden,
  BUILT_IN_KC_IDS as BUILT_IN_IDS, SCORECARD_KC_ID_GUARD as ID_GUARD,
} from './questions'
import { lockedKcQuestionIds, validateKcOverrides, KC_LOCK_REASON } from './kcLock'
import { parseKcHidden, parseKcOrder, parseKcOverrides } from '../shared/kcSurface'
import { inducedBehaviour } from './validate'

// ═══════════════════════════════════════════════════════════════════════════════
// scorecardGetConfig / scorecardUpdateConfig (instructor) — the settings page's server
// side (spec §3, §3.1). Read everything, write back only the fields that were sent,
// re-read and return what was actually STORED.
//
// ⚠⚠ THIS IS THE ONLY WAY THE TREATMENT IS EVER EDITED, AND IT MUST BE. `truth/main` is
// rules-denied to every client INCLUDING an authenticated instructor
// (firestore.rules) — by design — so the Settings page cannot reach it with the Firestore
// SDK. These callables use the ADMIN SDK, which bypasses rules, behind
// `extractInstructorGameId`.
//
// ⚠⚠ THE PATCH IS SPLIT BY DESTINATION, and that split IS the data model:
//     config/main   contracts, periods, target, bonus, costs, p_acceptable_low,
//                   endowment, the show* switches, the nouns
//     truth/main    reliability_high, reliability_low, reliability_schedule,
//                   label_high, label_low, seed
// A field routed to the wrong document is a LEAK — config/main is student-readable, and
// a student who found both reliabilities there would learn there are exactly two
// conditions (spec §8). The two maps below are built separately and never merged.
//
// ⚠ WARN, NEVER BLOCK (spec §3.1). Every response carries the §3.1 induced-behaviour
// panel — including the separation warning and the policy grid — so an instructor sees
// what their edit induced. Nothing in it refuses a save.
//
// ⚠ `showRemainingPeriods` IS NOT A FIELD HERE, in either map. Spec §3 marks it "true,
// NOT editable" and §4.1 explains why: withholding the CONCLUSION that a contract is dead
// is the design; withholding the INPUTS would be a different, worse game. There is no
// setting because there is no choice — do not add one.
// ═══════════════════════════════════════════════════════════════════════════════

/** Reads one optional field; `undefined` means "not being changed". */
function opt<T>(v: unknown, parse: (x: unknown) => T | undefined): T | undefined {
  return v === undefined ? undefined : parse(v)
}

function num(field: string, lo: number, hi: number) {
  return (x: unknown): number => {
    if (typeof x !== 'number' || !Number.isFinite(x)) {
      throw new HttpsError('invalid-argument', `${field} must be a number.`)
    }
    if (x < lo || x > hi) {
      throw new HttpsError('invalid-argument', `${field} must be between ${lo} and ${hi}.`)
    }
    return x
  }
}

function int(field: string, lo: number, hi: number) {
  const n = num(field, lo, hi)
  return (x: unknown): number => Math.round(n(x))
}

function bool(field: string) {
  return (x: unknown): boolean => {
    if (typeof x !== 'boolean') throw new HttpsError('invalid-argument', `${field} must be true or false.`)
    return x
  }
}

function text(field: string, maxLen = 200) {
  return (x: unknown): string => {
    if (typeof x !== 'string') throw new HttpsError('invalid-argument', `${field} must be text.`)
    if (x.length > maxLen) throw new HttpsError('invalid-argument', `${field} is too long.`)
    return x
  }
}

function schedule(x: unknown): 'alternating' | 'blocked' | 'betweenSubject' {
  if (x === 'alternating' || x === 'blocked' || x === 'betweenSubject') return x
  throw new HttpsError('invalid-argument',
    'reliabilitySchedule must be alternating, blocked or betweenSubject.')
}

/**
 * The instructor-facing inventory of every question this instance COULD ask — the payload
 * the shared settings block renders.
 *
 * ⚠ THE LIST ITSELF IS THE MOST VALUABLE PART OF THIS CHANGE (spec §2). Scorecard's page
 * used to say the built-in ten could not be edited and then never showed them, so an
 * instructor could not read their own knowledge check. Every question ships here, in both
 * stages, with its answer, whether it is visible, whether it is locked and why.
 *
 * ⚠ THIS IS THE INSTRUCTOR CALLABLE — `correctOptionId` and the added questions' keys are
 * meant to be here. `scorecardGetQuestions` (the STUDENT path) still strips them.
 */
function kcInventory(config: ScorecardConfig, truth: ScorecardTruth) {
  const locked = lockedKcQuestionIds(config, truth)
  const authored = scorecardKcQuestions(config, truth)

  const builtIn = authored.map((raw) => {
    const q = applyKcOverride(raw, config.kcOverrides)
    return {
      id: q.id,
      kind: 'builtin' as const,
      stage: q.stage,
      prompt: q.prompt,
      options: q.options.map(o => ({ value: o.id, label: o.text })),
      correctValue: q.correctOptionId,
      /** Always graded — every built-in carries a key. */
      graded: true,
      visible: config.kcHidden[q.id] !== true,
      locked: locked.has(q.id),
      /** ⚠ A disabled control with no explanation reads as a bug. Always populated when
       *  `locked`, so no page has to invent its own wording. */
      lockReason: locked.has(q.id) ? KC_LOCK_REASON : null,
      overridden: isKcOverridden(q.id, config.kcOverrides),
      /** ⚠ The GENERATED text, so the page can offer "revert to the original". */
      originalPrompt: raw.prompt,
      originalOptions: raw.options.map(o => ({ value: o.id, label: o.text })),
      order: config.kcOrder[q.id] ?? null,
    }
  })

  const added = config.addedKcQuestions.map(q => ({
    id: q.id,
    kind: 'added' as const,
    stage: addedKcStage(q),
    type: q.type,
    prompt: q.prompt,
    options: (q.options ?? []).map(o => ({ value: o.value, label: o.label })),
    correctValue: q.correct_value ?? null,
    graded: isGradedAdded(q),
    visible: config.kcHidden[q.id] !== true,
    /** ⚠ Added questions are stored DATA, so they are edited in place, never overridden —
     *  and they interpolate nothing, so they are never locked. */
    locked: false,
    lockReason: null,
    overridden: false,
    order: config.kcOrder[q.id] ?? null,
  }))

  const pool = [...builtIn, ...added]
  return {
    stages: SCORECARD_KC_STAGES,
    builtIn,
    added,
    /** ⚠ THE COUNT LINE'S THREE NUMBERS, derived exactly as the grader's denominator is —
     *  visible AND graded. Never stored (D5). */
    poolTotal: pool.length,
    visibleCount: pool.filter(q => q.visible).length,
    gradedCount: pool.filter(q => q.visible && q.graded).length,
  }
}

async function readAll(db: admin.firestore.Firestore, instanceId: string) {
  const ref = db.collection(INSTANCES_COLLECTION).doc(instanceId)
  const [c, t, participants] = await Promise.all([
    ref.collection('config').doc(CONFIG_DOC).get(),
    ref.collection('truth').doc(TRUTH_DOC).get(),
    ref.collection(PARTICIPANTS_SUBCOLLECTION).get(),
  ])
  const config = loadScorecardConfig(c.data())
  const truth = loadScorecardTruth(t.data())
  return {
    config,
    truth,
    /** ⚠ The standing parameter lock's input (spec §3.1): has anyone STARTED? */
    started: participants.docs.some(d => d.data().starts_with != null),
    induced: inducedBehaviour(config, truth),
    /** Everything the shared knowledge-check block renders. */
    kc: kcInventory(config, truth),
  }
}

export const scorecardGetConfig = onCall({ cors: SCORECARD_CORS_ORIGINS }, async (request) => {
  const data = request.data as Record<string, unknown>
  const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true'
  const authHeader = request.rawRequest.headers.authorization as string | undefined
  const gameInstanceId = await extractInstructorGameId(data, isEmulator, authHeader)
  const all = await readAll(admin.firestore(), gameInstanceId)
  return { ok: true as const, ...all }
})

export const scorecardUpdateConfig = onCall({ cors: SCORECARD_CORS_ORIGINS }, async (request) => {
  const data = request.data as Record<string, unknown>
  const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true'
  const authHeader = request.rawRequest.headers.authorization as string | undefined
  const gameInstanceId = await extractInstructorGameId(data, isEmulator, authHeader)

  const db = admin.firestore()
  const ref = db.collection(INSTANCES_COLLECTION).doc(gameInstanceId)

  // ── config/main — STUDENT-READABLE ────────────────────────────────────────
  const configPatch: Record<string, unknown> = {}
  const setC = (key: string, v: unknown) => { if (v !== undefined) configPatch[key] = v }
  setC('contracts', opt(data.contracts, int('contracts', HARD_MIN_CONTRACTS, HARD_MAX_CONTRACTS)))
  setC('periods_per_contract', opt(data.periodsPerContract, int('periodsPerContract', HARD_MIN_PERIODS, HARD_MAX_PERIODS)))
  setC('target_score', opt(data.targetScore, int('targetScore', 0, HARD_MAX_PERIODS)))
  setC('bonus', opt(data.bonus, num('bonus', 0, 100000)))
  setC('high_effort_cost', opt(data.highEffortCost, num('highEffortCost', 0, 100000)))
  setC('low_effort_cost', opt(data.lowEffortCost, num('lowEffortCost', 0, 100000)))
  setC('p_acceptable_low', opt(data.pAcceptableLow, num('pAcceptableLow', 0, 1)))
  setC('endowment_per_contract', opt(data.endowmentPerContract, num('endowmentPerContract', 0, 100000)))
  setC('show_target_reached_banner', opt(data.showTargetReachedBanner, bool('showTargetReachedBanner')))
  setC('show_prior_contracts_panel', opt(data.showPriorContractsPanel, bool('showPriorContractsPanel')))
  setC('show_running_balance', opt(data.showRunningBalance, bool('showRunningBalance')))
  setC('show_reliability_label', opt(data.showReliabilityLabel, bool('showReliabilityLabel')))
  setC('currency', opt(data.currency, text('currency', 12)))
  setC('contract_noun', opt(data.contractNoun, text('contractNoun', 40)))
  setC('period_noun', opt(data.periodNoun, text('periodNoun', 40)))
  setC('delivery_noun', opt(data.deliveryNoun, text('deliveryNoun', 60)))
  setC('scorecard_noun', opt(data.scorecardNoun, text('scorecardNoun', 40)))
  setC('buyer_name', opt(data.buyerName, text('buyerName', 80)))
  setC('product_name', opt(data.productName, text('productName', 80)))

  // ── The knowledge check (spec §9) ─────────────────────────────────────────
  //
  // ⚠ UNKNOWN FIELDS ARE STILL SILENTLY IGNORED, here and in all four reference games.
  // Every one of them builds its patch from a NAMED list and never inspects the incoming
  // key set, so a misspelt or unsupported field is dropped without a word. That is how a
  // question-shaped payload failed quietly before this change, and it is unchanged now
  // because changing it in scorecard alone would make scorecard the odd one out. Recorded
  // in BUILD_NOTES as a platform-wide gap rather than fixed in one game.
  if (data.kcEnabled !== undefined) {
    if (typeof data.kcEnabled !== 'boolean') {
      throw new HttpsError('invalid-argument', 'kcEnabled must be true or false.')
    }
    configPatch.kc_enabled = data.kcEnabled
  }

  if (data.addedKcQuestions !== undefined) {
    if (!Array.isArray(data.addedKcQuestions)) {
      throw new HttpsError('invalid-argument', 'addedKcQuestions must be an array.')
    }
    // ⚠⚠ THE COLLISION CHECK USES THE EXPLICIT BUILT-IN ID SET — see `BUILT_IN_IDS` above
    // for why a `kc_` prefix rule would protect nothing here.
    const parsed: ScorecardAddedKcQuestion[] = []
    const seen = new Set<string>()
    for (const raw of data.addedKcQuestions) {
      // The guard is applied INSIDE the shared parser, so an id in the built-in set comes
      // back as null. The explicit re-check below turns that into a specific message
      // rather than the generic "incomplete question" one.
      if (typeof raw === 'object' && raw !== null
        && BUILT_IN_IDS.has(String((raw as Record<string, unknown>).id ?? ''))) {
        // The grader looks built-in questions up FIRST, so a collision would silently
        // shadow the instructor's key and mark students against the built-in answer.
        throw new HttpsError('invalid-argument',
          `'${String((raw as Record<string, unknown>).id)}' is the id of a built-in question and cannot be reused.`)
      }
      const q = parseAddedKcQuestion(raw, ID_GUARD)
      if (!q) {
        throw new HttpsError('invalid-argument',
          'An added question is incomplete — every question needs a prompt, and a multiple-choice question needs at least two options and a correct answer among them.')
      }
      if (seen.has(q.id)) {
        throw new HttpsError('invalid-argument', `Duplicate question id '${q.id}'.`)
      }
      seen.add(q.id)
      parsed.push(q)
    }
    configPatch.added_kc_questions = parsed
  }

  // ── The three convergence fields (spec §5) ────────────────────────────────
  //
  // ⚠ Every key is checked against the ids this instance actually has. A stale id — from a
  // question deleted between page load and save — is REFUSED rather than stored, because a
  // hidden map full of ids nothing serves is how "10 of 12 visible" starts lying.
  //
  // ⚠ ADDED-QUESTION IDS COUNT AS KNOWN. Hiding and reordering apply to them too; only
  // `overrides` is built-in-only, because added questions are stored data and are edited
  // in place.
  const knownAdded = new Set(
    (configPatch.added_kc_questions as ScorecardAddedKcQuestion[] | undefined)
      ?.map(q => q.id)
    // Not being changed in this save ⇒ validate against what is already stored.
    ?? (await ref.collection('config').doc(CONFIG_DOC).get()
      .then(s => loadScorecardConfig(s.data()).addedKcQuestions.map(q => q.id))),
  )
  const knownId = (id: string) => BUILT_IN_IDS.has(id) || knownAdded.has(id)

  if (data.kcHidden !== undefined) {
    const parsed = parseKcHidden(data.kcHidden)
    for (const id of Object.keys(parsed)) {
      if (!knownId(id)) {
        throw new HttpsError('invalid-argument', `'${id}' is not a question in this game.`)
      }
    }
    configPatch.kc_hidden = parsed
  }

  if (data.kcOrder !== undefined) {
    const parsed = parseKcOrder(data.kcOrder)
    for (const id of Object.keys(parsed)) {
      if (!knownId(id)) {
        throw new HttpsError('invalid-argument', `'${id}' is not a question in this game.`)
      }
    }
    configPatch.kc_order = parsed
  }

  if (data.kcOverrides !== undefined) {
    // ⚠⚠ THE LOCK IS ENFORCED HERE, NOT ONLY IN THE UI (spec §5). A settings page that
    // greys out an Edit button stops an instructor; it does not stop a stale tab, a
    // replayed payload or a hand-made call. A locked question is one whose text is
    // RECOMPUTED from the instance's parameters, so an override on it would be silently
    // discarded on the next parameter edit — or, worse, kept and left contradicting the
    // numbers around it.
    //
    // ⚠ Classified against THIS instance's live config, not a hardcoded list — see
    // kcLock.ts for why the classification is measured rather than listed.
    const current = loadScorecardConfig((await ref.collection('config').doc(CONFIG_DOC).get()).data())
    const currentTruth = loadScorecardTruth((await ref.collection('truth').doc(TRUTH_DOC).get()).data())
    const locked = lockedKcQuestionIds(current, currentTruth)
    const optionIds = new Map(
      scorecardKcQuestions(current, currentTruth).map(q => [q.id, new Set(q.options.map(o => o.id))]),
    )

    const parsed = parseKcOverrides(data.kcOverrides)
    const rejections = validateKcOverrides(parsed, {
      builtInIds: BUILT_IN_IDS, locked, optionIds,
    })
    if (rejections.length > 0) {
      throw new HttpsError('invalid-argument', rejections[0].message)
    }
    configPatch.kc_overrides = parsed
  }

  // ── truth/main — RULES-DENIED ─────────────────────────────────────────────
  const truthPatch: Record<string, unknown> = {}
  const setT = (key: string, v: unknown) => { if (v !== undefined) truthPatch[key] = v }
  setT('reliability_high', opt(data.reliabilityHigh, num('reliabilityHigh', 0, 1)))
  setT('reliability_low', opt(data.reliabilityLow, num('reliabilityLow', 0, 1)))
  setT('reliability_schedule', opt(data.reliabilitySchedule, schedule))
  // ⚠ The label templates carry `{pct}` and the SERVER interpolates the live value
  // (config.ts renderLabel). An instructor may edit the wording freely; what they must
  // not do is bake in a percentage, and the token is what makes that unnecessary.
  setT('label_high', opt(data.labelHigh, text('labelHigh', 120)))
  setT('label_low', opt(data.labelLow, text('labelLow', 120)))
  setT('seed', opt(data.seed, (x) => (typeof x === 'string' ? x : '')))

  if (Object.keys(configPatch).length > 0) {
    // merge:true — a save touches only the fields it was given, so it can never blank a
    // setting the form did not send.
    await ref.collection('config').doc(CONFIG_DOC).set(configPatch, { merge: true })
  }
  if (Object.keys(truthPatch).length > 0) {
    await ref.collection('truth').doc(TRUTH_DOC).set(truthPatch, { merge: true })
  }

  // ⚠ RE-READ AND RETURN WHAT WAS ACTUALLY STORED, with the §3.1 panel recomputed from
  // it. The instructor sees the induced behaviour of the config that is now live, not of
  // the form they submitted — which differ whenever a value was clamped on load.
  const all = await readAll(db, gameInstanceId)
  return { ok: true as const, ...all }
})
