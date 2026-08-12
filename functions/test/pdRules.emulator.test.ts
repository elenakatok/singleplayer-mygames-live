import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, it } from 'vitest'
import {
  initializeTestEnvironment, assertFails,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing'

// ═══════════════════════════════════════════════════════════════════════════════
// Firestore rules — Repeated Prisoner's Dilemma (pd_).
//
// PD DIVERGES from pennies/poll on ONE rule, and this file exists to keep it that
// way: a student may NOT read their own participant doc. That doc carries the
// assigned bot strategy (TFT vs GRIM) and the round history, and the entire
// pedagogy is that the student INFERS the strategy from play (PD spec §5) — a
// self-read would hand it to them through the Firestore SDK.
//
// So the assertion below is the INVERSE of penniesRules' assertion (a): the owner
// is denied. If a later slice "fixes" this to match pennies, this test fails —
// which is the point. Everything else mirrors the family pattern:
//   • no client reads of participants, by anyone, ever
//   • no client writes (callables only)
//   • truth/ denied to ALL clients including an authenticated instructor
//   • config/main denied to clients entirely (closed 2026-08-12 — the read grant was
//     vestigial and the doc carries KC answer keys)
// Runs via `npm run test:rules`.
// ═══════════════════════════════════════════════════════════════════════════════

const PROJECT_ID = 'demo-singleplayer'
const IID = 'pd-inst1'
const STU_A = 'pd-stu-a'
const STU_B = 'pd-stu-b'
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
    await fs.doc(`pd_game_instances/${IID}`).set({ created_at: 1 })
    await fs.doc(`pd_game_instances/${IID}/config/main`).set({ payoff_cc: 1 })
    // A stray instance-level doc. PD no longer writes one — both draws are per
    // student — but the rule covers the WHOLE truth/ collection, and this pins that:
    // anything anyone ever puts there is denied, named `main` or not.
    await fs.doc(`pd_game_instances/${IID}/truth/main`).set({ rounds: 14 })
    // Per-student truth: this student's bot strategy AND their drawn round count,
    // one doc per student, in the truth/ collection (see config.ts
    // truthParticipantDoc). Both are what the pedagogy depends on staying hidden.
    await fs.doc(`pd_game_instances/${IID}/truth/participant_${STU_A}`).set({ participant_id: STU_A, strategy: 'grim', rounds: 14 })
    // A participant doc as later slices will shape it: strategy + history.
    await fs.doc(`pd_game_instances/${IID}/participants/${STU_A}`).set({ participant_id: STU_A, strategy: 'grim' })
    await fs.doc(`pd_game_instances/${IID}/participants/${STU_B}`).set({ participant_id: STU_B, strategy: 'tft' })
  })
})

afterAll(async () => { await testEnv?.cleanup() })

describe('participant docs are NOT client-readable — not even by their owner', () => {
  const own = `pd_game_instances/${IID}/participants/${STU_A}`

  it('a student CANNOT read their OWN doc (diverges from pennies — hides the bot strategy)', async () => {
    await assertFails(student(STU_A, IID).doc(own).get())
  })
  it('a student CANNOT read ANOTHER student doc', async () => {
    await assertFails(student(STU_A, IID).doc(`pd_game_instances/${IID}/participants/${STU_B}`).get())
  })
  it('an authenticated instructor CANNOT read a participant doc directly', async () => {
    await assertFails(testEnv.authenticatedContext('instructor-1').firestore().doc(own).get())
  })
  it('an unauthenticated client CANNOT read a participant doc', async () => {
    await assertFails(testEnv.unauthenticatedContext().firestore().doc(own).get())
  })
  it('a student may NOT write their own participant doc (callables only)', async () => {
    await assertFails(student(STU_A, IID).doc(own).set({ strategy: 'tft' }, { merge: true }))
  })
})

describe('truth/ denied to ALL clients — including an authenticated instructor', () => {
  const truth = `pd_game_instances/${IID}/truth/main`
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

describe('per-student truth (bot strategy + drawn round count) is denied to everyone', () => {
  // truth/participant_{pid} — the strategy assignment AND this student's drawn round
  // count. The pedagogy is that the student INFERS which bot they face and never
  // knows when the game ends, so this must be unreadable by the student it belongs
  // to, by their classmates, and by the instructor's browser alike.
  // It sits in truth/ precisely so the existing `match /truth/{doc}` block covers
  // it; these tests keep that coverage honest if the block is ever narrowed.
  const own = `pd_game_instances/${IID}/truth/participant_${STU_A}`

  it('the student it belongs to CANNOT read their own strategy or horizon', async () => {
    await assertFails(student(STU_A, IID).doc(own).get())
  })
  it('another student CANNOT read it', async () => {
    await assertFails(student(STU_B, IID).doc(own).get())
  })
  it('an authenticated instructor CANNOT read it', async () => {
    await assertFails(testEnv.authenticatedContext('instructor-1').firestore().doc(own).get())
  })
  it('an unauthenticated client CANNOT read it', async () => {
    await assertFails(testEnv.unauthenticatedContext().firestore().doc(own).get())
  })
  it('nobody may write it from a client (server/callable only)', async () => {
    await assertFails(student(STU_A, IID).doc(own).set({ strategy: 'tft' }, { merge: true }))
  })
})

describe('config is denied to clients entirely', () => {
  // ⚠ THIS USED TO ASSERT THE OPPOSITE — "a student CAN read config/main (the payoff
  // matrix)" — and it passed, because the rule really did allow it. The grant was
  // vestigial: nothing under frontend/ imports `db`, so no screen ever used it, while
  // an instructor-added KC question put `correct_value` in the document (audit
  // 2026-08-12). Closed 2026-08-12; this assertion is the thing that keeps it closed.
  it('a student may NOT read config/main — the payoff matrix comes from a callable', async () => {
    await assertFails(student(STU_A, IID).doc(`pd_game_instances/${IID}/config/main`).get())
  })
  it('a student may NOT write config/main', async () => {
    await assertFails(student(STU_A, IID).doc(`pd_game_instances/${IID}/config/main`).set({ payoff_cc: 0 }))
  })
})
