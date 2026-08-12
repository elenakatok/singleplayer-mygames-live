import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, it, expect } from 'vitest'
import {
  initializeTestEnvironment, assertFails,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing'

// ═══════════════════════════════════════════════════════════════════════════════
// Firestore rules — Forecasting Game (forecast_).
//
// ⚠ THE LEAK SURFACE HERE IS UNUSUALLY LARGE (spec §4, §12), and the rules are the
// outer wall of it. Two things must never be client-readable:
//
//   1. THE MODEL — a, b, H, σ, highSeasonMonths. Newsvendor puts its economics in
//      config/main because the student is shown all of it; this game does the
//      OPPOSITE, because explaining the systematic component IS the exercise
//      (spec §7). A student who could read the model off config/main with the plain
//      SDK could forecast the conditional mean exactly.
//   2. THE SEED — it derives every future draw, so it would give away month 12's
//      demand before month 11 is forecast.
//
// Both live in truth/main, denied to every client including an authenticated
// instructor. The test below therefore does something the sibling rules tests do not:
// it writes a REALISTIC truth doc carrying the actual model, and asserts the denial —
// and it ALSO asserts, separately, that config/main carries no model parameter, so a
// future edit that moves one into config is caught by content and not only by rule.
//
// ⚠ config/main is now DENIED to clients too (closed 2026-08-12): the read grant was
// vestigial, and the doc carries KC answer keys. That content assertion therefore reads
// through `withSecurityRulesDisabled` — the invariant outlived the rule it rode on.
//
// Runs via `npm run test:rules`.
// ═══════════════════════════════════════════════════════════════════════════════

const PROJECT_ID = 'demo-singleplayer'
const IID = 'forecast-inst1'
const STU_A = 'forecast-stu-a'
const STU_B = 'forecast-stu-b'
const fsHost = (process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8090').split(':')

let testEnv: RulesTestEnvironment

/** A student's session: uid = participant_id, token carries their instance. */
const student = (pid: string, gid: string) =>
  testEnv.authenticatedContext(pid, { game_instance_id: gid }).firestore()

/** The exact shape truth/main takes in production — model AND seed together. */
const TRUTH_DOC_DATA = {
  intercept: 560,
  trend: 4,
  high_season_lift: 230,
  high_season_months: [11, 12],
  sigma: 30,
  seasonality: 'additive',
  season_structure: 'twoSeason',
  demand_draw: 'perStudent',
  seed: '1',
}

/** The exact shape config/main takes — student-safe, model-free. */
const CONFIG_DOC_DATA = {
  num_history: 60,
  rounds: 24,
  forecast_min: 0,
  forecast_max: 3000,
  product_name: 'this product',
  kc_enabled: true,
  debrief_enabled: true,
}

beforeAll(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: {
      host: fsHost[0], port: Number(fsHost[1]),
      rules: readFileSync(resolve(__dirname, '../../firestore.rules'), 'utf8'),
    },
  })
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const fs = ctx.firestore()
    await fs.doc(`forecast_game_instances/${IID}`).set({ created_at: 1 })
    await fs.doc(`forecast_game_instances/${IID}/config/main`).set(CONFIG_DOC_DATA)
    await fs.doc(`forecast_game_instances/${IID}/truth/main`).set(TRUTH_DOC_DATA)
    // Participant docs as the compute step shapes them: the realized demand a student
    // has already faced, month by month.
    await fs.doc(`forecast_game_instances/${IID}/participants/${STU_A}`).set({
      participant_id: STU_A,
      rounds: [{ round: 61, forecast: 800, actual: 812 }],
    })
    await fs.doc(`forecast_game_instances/${IID}/participants/${STU_B}`).set({
      participant_id: STU_B, rounds: [],
    })
  })
})

afterAll(async () => { await testEnv?.cleanup() })

describe('truth/ denied to ALL clients — the MODEL and the SEED both live there', () => {
  const truth = `forecast_game_instances/${IID}/truth/main`

  it('a student is DENIED read (the model IS the answer — spec §7)', async () => {
    await assertFails(student(STU_A, IID).doc(truth).get())
  })
  it('an authenticated instructor is DENIED read (callables only)', async () => {
    await assertFails(testEnv.authenticatedContext('instructor-1').firestore().doc(truth).get())
  })
  it('an authenticated instructor is DENIED write', async () => {
    await assertFails(testEnv.authenticatedContext('instructor-1').firestore().doc(truth).set({ trend: 0 }))
  })
  it('an unauthenticated client is DENIED read', async () => {
    await assertFails(testEnv.unauthenticatedContext().firestore().doc(truth).get())
  })
  it('a student is DENIED write', async () => {
    await assertFails(student(STU_A, IID).doc(truth).set({ sigma: 0 }, { merge: true }))
  })
})

describe('participant docs are NOT client-readable — not even by their owner', () => {
  const own = `forecast_game_instances/${IID}/participants/${STU_A}`

  it('a student CANNOT read their OWN doc (history goes out through callables only)', async () => {
    await assertFails(student(STU_A, IID).doc(own).get())
  })
  it('a student CANNOT read ANOTHER student doc', async () => {
    await assertFails(student(STU_A, IID).doc(`forecast_game_instances/${IID}/participants/${STU_B}`).get())
  })
  it('an authenticated instructor CANNOT read a participant doc directly', async () => {
    await assertFails(testEnv.authenticatedContext('instructor-1').firestore().doc(own).get())
  })
  it('an unauthenticated client CANNOT read a participant doc', async () => {
    await assertFails(testEnv.unauthenticatedContext().firestore().doc(own).get())
  })
  it('a student may NOT write their own participant doc (callables only)', async () => {
    await assertFails(student(STU_A, IID).doc(own).set({ rounds: [] }, { merge: true }))
  })
  it('a student cannot LIST the participants collection', async () => {
    await assertFails(student(STU_A, IID).collection(`forecast_game_instances/${IID}/participants`).get())
  })
})

describe('config is denied to clients entirely', () => {
  const config = `forecast_game_instances/${IID}/config/main`

  // ⚠ THIS USED TO ASSERT THE OPPOSITE — "a student CAN read config/main". The grant was
  // vestigial (nothing under frontend/ imports `db`; every read goes through a callable)
  // while an instructor-added KC question put `correct_value` in the document
  // (audit 2026-08-12). Closed 2026-08-12.
  it('a student may NOT read config/main', async () => {
    await assertFails(student(STU_A, IID).doc(config).get())
  })
  it('a student may NOT write config/main', async () => {
    await assertFails(student(STU_A, IID).doc(config).set({ rounds: 1 }))
  })

  it('⚠ and config/main carries NO model parameter even so', async () => {
    // ⚠⚠ THIS ASSERTION SURVIVED THE RULE CHANGE ON PURPOSE, AND ITS READ MOVED.
    // It used to read as a student, which is how it also demonstrated the doc was open;
    // that read now correctly fails, so the content check reads through
    // `withSecurityRulesDisabled` instead. The invariant is INDEPENDENT of who may read:
    // "the model must not live in config" would still matter if config were public
    // tomorrow, and defence in depth is the point — the rule is one layer, this is the
    // other. Deleting it because the doc is now denied would trade a real check for the
    // assumption that the rule never regresses.
    // ⚠ `withSecurityRulesDisabled` resolves to void — it does NOT pass the callback's
    // return value out. Capture through an outer binding, not a `return`.
    let data: Record<string, unknown> = {}
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const snap = await ctx.firestore().doc(config).get()
      data = (snap.data() ?? {}) as Record<string, unknown>
    })
    for (const banned of [
      'intercept', 'trend', 'high_season_lift', 'high_season_months', 'sigma',
      'seasonality', 'season_structure', 'month_offsets', 'demand_draw', 'seed',
    ]) {
      expect(data, `config/main must not carry '${banned}'`).not.toHaveProperty(banned)
    }
  })
})
