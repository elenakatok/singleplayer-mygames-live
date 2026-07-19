import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, it } from 'vitest'
import {
  initializeTestEnvironment, assertFails, assertSucceeds,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing'

// ═══════════════════════════════════════════════════════════════════════════════
// Poll rules — participants are a per-INSTANCE subcollection
// (poll_game_instances/{iid}/participants/{pid}). Same structural isolation as
// pennies: read only your own doc, and only under your authenticated instance.
// Config is CLIENT-READABLE (the questions are what students answer); no truth doc.
// ═══════════════════════════════════════════════════════════════════════════════

const PROJECT_ID = 'demo-singleplayer'
const IID = 'poll-inst1'
const OTHER_IID = 'poll-inst2'
const STU_A = 'poll-a'
const STU_B = 'poll-b'
const fsHost = (process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8090').split(':')

let testEnv: RulesTestEnvironment
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
    await fs.doc(`poll_game_instances/${IID}`).set({ created_at: 1 })
    await fs.doc(`poll_game_instances/${IID}/config/main`).set({ questions: [] })
    await fs.doc(`poll_game_instances/${IID}/participants/${STU_A}`).set({ participant_id: STU_A, answers: {} })
    await fs.doc(`poll_game_instances/${IID}/participants/${STU_B}`).set({ participant_id: STU_B, answers: {} })
    await fs.doc(`poll_game_instances/${OTHER_IID}/participants/${STU_A}`).set({ participant_id: STU_A, answers: {} })
  })
})

afterAll(async () => { await testEnv?.cleanup() })

describe('poll participant isolation (per-instance subcollection)', () => {
  it('a student CAN read their OWN doc under THEIR instance', async () => {
    await assertSucceeds(student(STU_A, IID).doc(`poll_game_instances/${IID}/participants/${STU_A}`).get())
  })
  it('a student CANNOT read ANOTHER student doc', async () => {
    await assertFails(student(STU_A, IID).doc(`poll_game_instances/${IID}/participants/${STU_B}`).get())
  })
  it('a student CANNOT read their OWN doc under a DIFFERENT instance', async () => {
    await assertFails(student(STU_A, IID).doc(`poll_game_instances/${OTHER_IID}/participants/${STU_A}`).get())
  })
  it('a student may NOT write their own participant doc (callables only)', async () => {
    await assertFails(student(STU_A, IID).doc(`poll_game_instances/${IID}/participants/${STU_A}`).set({ answers: {} }, { merge: true }))
  })
})

describe('poll config is client-readable (no secret, no truth)', () => {
  it('a student CAN read config/main', async () => {
    await assertSucceeds(student(STU_A, IID).doc(`poll_game_instances/${IID}/config/main`).get())
  })
  it('a student may NOT write config/main', async () => {
    await assertFails(student(STU_A, IID).doc(`poll_game_instances/${IID}/config/main`).set({ questions: [] }))
  })
})
