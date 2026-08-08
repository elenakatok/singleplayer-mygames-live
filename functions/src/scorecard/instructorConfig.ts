import { onCall, HttpsError } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import { extractInstructorGameId } from '@mygames/game-server'
import {
  SCORECARD_CORS_ORIGINS, INSTANCES_COLLECTION, PARTICIPANTS_SUBCOLLECTION,
  CONFIG_DOC, TRUTH_DOC,
  HARD_MIN_CONTRACTS, HARD_MAX_CONTRACTS, HARD_MIN_PERIODS, HARD_MAX_PERIODS,
  loadScorecardConfig, loadScorecardTruth, parseAddedKcQuestion,
  DEFAULT_CONFIG, DEFAULT_TRUTH, type ScorecardAddedKcQuestion,
} from './config'
import { scorecardKcQuestions } from './questions'
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
    // ⚠⚠ THE COLLISION CHECK IS SCORECARD-SPECIFIC AND HAS TO BE. pd, pricing, forecast
    // and newsvendor reject any added id starting with `kc_`, because their built-in
    // questions own that namespace. Scorecard's built-in ids are NOT prefixed — they are
    // `q1_negotiated_ppm`, `q5_earnings_arithmetic` and so on — so a prefix rule would
    // protect nothing. The set itself is the authority, and it is available here.
    //
    // ⚠ Resolved against the DEFAULTS, deliberately, and it needs no Firestore read: a
    // built-in question's ID is a literal ('q1_negotiated_ppm'), while only its prompt and
    // options interpolate config. The id set is therefore the same for every instance.
    const builtIn = new Set(
      scorecardKcQuestions(DEFAULT_CONFIG, DEFAULT_TRUTH).map(q => q.id),
    )

    const parsed: ScorecardAddedKcQuestion[] = []
    const seen = new Set<string>()
    for (const raw of data.addedKcQuestions) {
      const q = parseAddedKcQuestion(raw)
      if (!q) {
        throw new HttpsError('invalid-argument',
          'An added question is incomplete — every question needs a prompt, and a multiple-choice question needs at least two options and a correct answer among them.')
      }
      if (builtIn.has(q.id)) {
        // The grader looks built-in questions up FIRST, so a collision would silently
        // shadow the instructor's key and mark students against the built-in answer.
        throw new HttpsError('invalid-argument',
          `'${q.id}' is the id of a built-in question and cannot be reused.`)
      }
      if (seen.has(q.id)) {
        throw new HttpsError('invalid-argument', `Duplicate question id '${q.id}'.`)
      }
      seen.add(q.id)
      parsed.push(q)
    }
    configPatch.added_kc_questions = parsed
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
