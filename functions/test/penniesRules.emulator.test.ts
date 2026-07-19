import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, it } from 'vitest'
import {
  initializeTestEnvironment, assertFails, assertSucceeds,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing'

// ═══════════════════════════════════════════════════════════════════════════════
// Firestore rules — the two correctness assertions (Part 2 TASK 10):
//   (a) a student CANNOT read another student's participant document
//       (the single-player family's defining constraint).
//   (b) truth/ is denied to ALL clients, read AND write, including an
//       authenticated instructor (the game's core secret; eBay vCommon pattern).
// Runs via `npm run test:rules`, which boots the Firestore emulator first.
// ═══════════════════════════════════════════════════════════════════════════════

const PROJECT_ID = 'demo-singleplayer'
const IID = 'inst1'
const STU_A = 'stu-a'
const STU_B = 'stu-b'
const fsHost = (process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8090').split(':')

let testEnv: RulesTestEnvironment

beforeAll(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: {
      host: fsHost[0],
      port: Number(fsHost[1]),
      rules: readFileSync(resolve(__dirname, '../../firestore.rules'), 'utf8'),
    },
  })
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const fs = ctx.firestore()
    await fs.doc(`pennies_game_instances/${IID}`).set({ created_at: 1 })
    await fs.doc(`pennies_game_instances/${IID}/config/main`).set({ jar_image: '/jar.jpg' })
    await fs.doc(`pennies_game_instances/${IID}/truth/main`).set({ true_value: 4237 })
    await fs.doc(`pennies_participants/${STU_A}`).set({ participant_id: STU_A, game_instance_id: IID, estimate: 100 })
    await fs.doc(`pennies_participants/${STU_B}`).set({ participant_id: STU_B, game_instance_id: IID, estimate: 200 })
  })
})

afterAll(async () => { await testEnv?.cleanup() })

describe('participant isolation', () => {
  it('a student CAN read their OWN participant doc', async () => {
    const fs = testEnv.authenticatedContext(STU_A).firestore()
    await assertSucceeds(fs.doc(`pennies_participants/${STU_A}`).get())
  })
  it('(a) a student CANNOT read ANOTHER student participant doc', async () => {
    const fs = testEnv.authenticatedContext(STU_A).firestore()
    await assertFails(fs.doc(`pennies_participants/${STU_B}`).get())
  })
  it('a student may NOT write their own participant doc (callables only)', async () => {
    const fs = testEnv.authenticatedContext(STU_A).firestore()
    await assertFails(fs.doc(`pennies_participants/${STU_A}`).set({ bid: 1 }, { merge: true }))
  })
})

describe('truth/ denied to ALL clients — read AND write, even an instructor', () => {
  const truth = `pennies_game_instances/${IID}/truth/main`
  it('(b) authenticated instructor DENIED read', async () => {
    const fs = testEnv.authenticatedContext('instructor-1').firestore()
    await assertFails(fs.doc(truth).get())
  })
  it('(b) authenticated instructor DENIED write', async () => {
    const fs = testEnv.authenticatedContext('instructor-1').firestore()
    await assertFails(fs.doc(truth).set({ true_value: 0 }))
  })
  it('(b) unauthenticated DENIED read', async () => {
    await assertFails(testEnv.unauthenticatedContext().firestore().doc(truth).get())
  })
})

describe('instance + config are student-readable; not client-writable', () => {
  it('a student CAN read config/main', async () => {
    const fs = testEnv.authenticatedContext(STU_A).firestore()
    await assertSucceeds(fs.doc(`pennies_game_instances/${IID}/config/main`).get())
  })
  it('a student may NOT write config/main', async () => {
    const fs = testEnv.authenticatedContext(STU_A).firestore()
    await assertFails(fs.doc(`pennies_game_instances/${IID}/config/main`).set({ jar_image: 'x' }))
  })
})
