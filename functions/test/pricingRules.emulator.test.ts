import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, it } from 'vitest'
import {
  initializeTestEnvironment, assertFails,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing'

// ═══════════════════════════════════════════════════════════════════════════════
// Firestore rules — Pricing Game / Cheyenne Shipping (pricing_).
//
// Pricing follows PD, not pennies/poll, on the one rule that matters: a student may
// NOT read their own participant doc. That doc carries the round history and, once
// later slices land, whatever the compute step stores beside it — and the pedagogy
// is that the student infers the competitor's rule from play (Pricing spec §5: the
// rule is revealed only in the debrief). A self-read would hand that over through
// the Firestore SDK.
//
// So the assertion below is the INVERSE of penniesRules' assertion (a): the owner is
// denied. If a later slice "fixes" this to match pennies, this test fails — which is
// the point. Everything else mirrors the family pattern:
//   • no client reads of participants, by anyone, ever
//   • no client writes (callables only)
//   • truth/ denied to ALL clients including an authenticated instructor
//   • config/main denied to clients entirely (closed 2026-08-12 — the price-entry
//     screen prints the parameters, but gets them from a callable, never from this doc)
// Runs via `npm run test:rules`.
// ═══════════════════════════════════════════════════════════════════════════════

const PROJECT_ID = 'demo-singleplayer'
const IID = 'pricing-inst1'
const STU_A = 'pricing-stu-a'
const STU_B = 'pricing-stu-b'
const fsHost = (process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8090').split(':')

let testEnv: RulesTestEnvironment

// A student's session: uid = participant_id, token carries their instance.
const student = (pid: string, gid: string) => testEnv.authenticatedContext(pid, { game_instance_id: gid }).firestore()

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
    await fs.doc(`pricing_game_instances/${IID}`).set({ created_at: 1 })
    // The market parameters and the PMG flag — student-readable by design.
    await fs.doc(`pricing_game_instances/${IID}/config/main`).set({ market_size: 190000, pmg: false })
    // The undisclosed round count lives here, never in config.
    await fs.doc(`pricing_game_instances/${IID}/truth/main`).set({ rounds: 14 })
    // Participant docs as later slices will shape them: the round history.
    await fs.doc(`pricing_game_instances/${IID}/participants/${STU_A}`).set({ participant_id: STU_A, rounds_played: 3 })
    await fs.doc(`pricing_game_instances/${IID}/participants/${STU_B}`).set({ participant_id: STU_B, rounds_played: 1 })
  })
})

afterAll(async () => { await testEnv?.cleanup() })

describe('participant docs are NOT client-readable — not even by their owner', () => {
  const own = `pricing_game_instances/${IID}/participants/${STU_A}`

  it('a student CANNOT read their OWN doc (follows pd — history goes out through callables only)', async () => {
    await assertFails(student(STU_A, IID).doc(own).get())
  })
  it('a student CANNOT read ANOTHER student doc', async () => {
    await assertFails(student(STU_A, IID).doc(`pricing_game_instances/${IID}/participants/${STU_B}`).get())
  })
  it('an authenticated instructor CANNOT read a participant doc directly', async () => {
    await assertFails(testEnv.authenticatedContext('instructor-1').firestore().doc(own).get())
  })
  it('an unauthenticated client CANNOT read a participant doc', async () => {
    await assertFails(testEnv.unauthenticatedContext().firestore().doc(own).get())
  })
  it('a student may NOT write their own participant doc (callables only)', async () => {
    await assertFails(student(STU_A, IID).doc(own).set({ rounds_played: 99 }, { merge: true }))
  })
})

describe('truth/ denied to ALL clients — including an authenticated instructor', () => {
  const truth = `pricing_game_instances/${IID}/truth/main`
  it('student DENIED read (the round count must never leak)', async () => {
    await assertFails(student(STU_A, IID).doc(truth).get())
  })
  it('authenticated instructor DENIED read', async () => {
    await assertFails(testEnv.authenticatedContext('instructor-1').firestore().doc(truth).get())
  })
  it('authenticated instructor DENIED write', async () => {
    await assertFails(testEnv.authenticatedContext('instructor-1').firestore().doc(truth).set({ rounds: 20 }))
  })
  it('unauthenticated DENIED read', async () => {
    await assertFails(testEnv.unauthenticatedContext().firestore().doc(truth).get())
  })
})

describe('config is denied to clients entirely', () => {
  // ⚠ THIS USED TO ASSERT THE OPPOSITE — "a student CAN read config/main (the market
  // parameters)". The parameters ARE shown to the student, but by a callable, never off
  // this document; nothing under frontend/ imports `db`. Meanwhile an instructor-added
  // KC question put `correct_value` here (audit 2026-08-12). Closed 2026-08-12.
  it('a student may NOT read config/main — the market parameters come from a callable', async () => {
    await assertFails(student(STU_A, IID).doc(`pricing_game_instances/${IID}/config/main`).get())
  })
  it('a student may NOT write config/main', async () => {
    await assertFails(student(STU_A, IID).doc(`pricing_game_instances/${IID}/config/main`).set({ pmg: true }))
  })
})
