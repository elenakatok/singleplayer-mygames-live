import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, it } from 'vitest'
import {
  initializeTestEnvironment, assertFails, assertSucceeds,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing'

// ═══════════════════════════════════════════════════════════════════════════════
// Poll Firestore rules. The family's defining constraint (Poll spec §8.3): a student
// may read ONLY their own participant doc — never another student's answers. Config is
// CLIENT-READABLE (the question definitions are what students answer); there is NO
// truth document. Runs via `npm run test:rules`.
// ═══════════════════════════════════════════════════════════════════════════════

const PROJECT_ID = 'demo-singleplayer'
const IID = 'poll-inst1'
const STU_A = 'poll-a'
const STU_B = 'poll-b'
const fsHost = (process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8090').split(':')

let testEnv: RulesTestEnvironment

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
    await fs.doc(`poll_game_instances/${IID}`).set({ created_at: 1 })
    await fs.doc(`poll_game_instances/${IID}/config/main`).set({ questions: [] })
    await fs.doc(`poll_participants/${STU_A}`).set({ participant_id: STU_A, game_instance_id: IID, answers: {} })
    await fs.doc(`poll_participants/${STU_B}`).set({ participant_id: STU_B, game_instance_id: IID, answers: {} })
  })
})

afterAll(async () => { await testEnv?.cleanup() })

describe('poll participant isolation', () => {
  it('a student CAN read their OWN participant doc', async () => {
    const fs = testEnv.authenticatedContext(STU_A).firestore()
    await assertSucceeds(fs.doc(`poll_participants/${STU_A}`).get())
  })
  it('a student CANNOT read ANOTHER student participant doc', async () => {
    const fs = testEnv.authenticatedContext(STU_A).firestore()
    await assertFails(fs.doc(`poll_participants/${STU_B}`).get())
  })
  it('a student may NOT write their own participant doc (callables only)', async () => {
    const fs = testEnv.authenticatedContext(STU_A).firestore()
    await assertFails(fs.doc(`poll_participants/${STU_A}`).set({ answers: {} }, { merge: true }))
  })
})

describe('poll config is client-readable (no secret, no truth)', () => {
  it('a student CAN read config/main (the questions they answer)', async () => {
    const fs = testEnv.authenticatedContext(STU_A).firestore()
    await assertSucceeds(fs.doc(`poll_game_instances/${IID}/config/main`).get())
  })
  it('a student may NOT write config/main', async () => {
    const fs = testEnv.authenticatedContext(STU_A).firestore()
    await assertFails(fs.doc(`poll_game_instances/${IID}/config/main`).set({ questions: [] }))
  })
})
