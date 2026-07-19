import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, it } from 'vitest'
import {
  initializeTestEnvironment, assertFails, assertSucceeds,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing'

// ═══════════════════════════════════════════════════════════════════════════════
// Firestore rules — participants are now a per-INSTANCE subcollection
// (pennies_game_instances/{iid}/participants/{pid}), so isolation is structural.
// Assertions:
//   (a) a student can read their OWN doc under THEIR instance;
//   (b) a student CANNOT read another student's doc (defining constraint);
//   (c) a student CANNOT read their OWN doc under a DIFFERENT instance (the leak that
//       the subcollection move fixes — enforced by the token's game_instance_id claim);
//   (d) truth/ is denied to ALL clients including an authenticated instructor.
// Runs via `npm run test:rules`.
// ═══════════════════════════════════════════════════════════════════════════════

const PROJECT_ID = 'demo-singleplayer'
const IID = 'inst1'
const OTHER_IID = 'inst2'
const STU_A = 'stu-a'
const STU_B = 'stu-b'
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
    await fs.doc(`pennies_game_instances/${IID}`).set({ created_at: 1 })
    await fs.doc(`pennies_game_instances/${IID}/config/main`).set({ jar_image: '/jar.jpg' })
    await fs.doc(`pennies_game_instances/${IID}/truth/main`).set({ true_value: 4237 })
    await fs.doc(`pennies_game_instances/${IID}/participants/${STU_A}`).set({ participant_id: STU_A, estimate: 100 })
    await fs.doc(`pennies_game_instances/${IID}/participants/${STU_B}`).set({ participant_id: STU_B, estimate: 200 })
    // The SAME student also has a doc under a DIFFERENT instance.
    await fs.doc(`pennies_game_instances/${OTHER_IID}/participants/${STU_A}`).set({ participant_id: STU_A, estimate: 999 })
  })
})

afterAll(async () => { await testEnv?.cleanup() })

describe('participant isolation (per-instance subcollection)', () => {
  it('(a) a student CAN read their OWN doc under THEIR instance', async () => {
    await assertSucceeds(student(STU_A, IID).doc(`pennies_game_instances/${IID}/participants/${STU_A}`).get())
  })
  it('(b) a student CANNOT read ANOTHER student doc', async () => {
    await assertFails(student(STU_A, IID).doc(`pennies_game_instances/${IID}/participants/${STU_B}`).get())
  })
  it('(c) a student CANNOT read their OWN doc under a DIFFERENT instance', async () => {
    await assertFails(student(STU_A, IID).doc(`pennies_game_instances/${OTHER_IID}/participants/${STU_A}`).get())
  })
  it('a student may NOT write their own participant doc (callables only)', async () => {
    await assertFails(student(STU_A, IID).doc(`pennies_game_instances/${IID}/participants/${STU_A}`).set({ bid: 1 }, { merge: true }))
  })
})

describe('truth/ denied to ALL clients — including an authenticated instructor', () => {
  const truth = `pennies_game_instances/${IID}/truth/main`
  it('(d) authenticated instructor DENIED read', async () => {
    await assertFails(testEnv.authenticatedContext('instructor-1').firestore().doc(truth).get())
  })
  it('(d) authenticated instructor DENIED write', async () => {
    await assertFails(testEnv.authenticatedContext('instructor-1').firestore().doc(truth).set({ true_value: 0 }))
  })
  it('(d) unauthenticated DENIED read', async () => {
    await assertFails(testEnv.unauthenticatedContext().firestore().doc(truth).get())
  })
})

describe('instance + config are student-readable; not client-writable', () => {
  it('a student CAN read config/main', async () => {
    await assertSucceeds(student(STU_A, IID).doc(`pennies_game_instances/${IID}/config/main`).get())
  })
  it('a student may NOT write config/main', async () => {
    await assertFails(student(STU_A, IID).doc(`pennies_game_instances/${IID}/config/main`).set({ jar_image: 'x' }))
  })
})
