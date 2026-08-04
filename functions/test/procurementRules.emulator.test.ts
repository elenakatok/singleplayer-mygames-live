import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, it, expect } from 'vitest'
import {
  initializeTestEnvironment, assertFails, assertSucceeds,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing'

// ═══════════════════════════════════════════════════════════════════════════════
// Firestore rules — Procurement Auction (procurement_).
//
// ⚠ THE ONE SECRET IN THIS GAME IS THE SEED, and that is worth stating because this
// game's config/truth split is the OPPOSITE of forecast's. Almost everything here is
// public on purpose: the reserve, the round count, and — the field that looks like it
// should be hidden and is not — the RIVAL COST RANGE. The equilibrium markup the debrief
// discusses is only computable by a student who knows the top of that range, and the
// lecture states it. Hiding it would hide the lesson, not protect it.
//
// What ends the game is the SEED. It derives every rival cost draw, so a student holding
// it could compute round 5's rivals before bidding in round 4. It lives in truth/main,
// denied to every client including an authenticated instructor.
//
// ⚠ ONE RULES BLOCK SERVES BOTH FORMATS. Sealed-bid and open-bid are two INSTANCES of
// one game_id, so the tests below cover both by construction — there is no
// procurement_open_ anything to test separately.
//
// Runs via `npm run test:rules`.
// ═══════════════════════════════════════════════════════════════════════════════

const PROJECT_ID = 'demo-singleplayer'
const IID = 'procurement-inst1'
const OTHER_IID = 'procurement-inst2'
const STU_A = 'procurement-stu-a'
const STU_B = 'procurement-stu-b'
const fsHost = (process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8090').split(':')

let testEnv: RulesTestEnvironment

/** A student's session: uid = participant_id, token carries their instance. */
const student = (pid: string, gid: string) =>
  testEnv.authenticatedContext(pid, { game_instance_id: gid }).firestore()

/** The exact shape truth/main takes in production — the seed, and only the seed. */
const TRUTH_DOC_DATA = { seed: 'demo-seed-1' }

/** The exact shape config/main takes — everything the bidding screen prints. */
const CONFIG_DOC_DATA = {
  format: 'sealed_first_price',
  rounds: 8,
  rivalCount: 4,
  reserve: 110,
  rivalCostDist: { distribution: 'uniform', min: 10, max: 110, integer: true },
  playerCostDist: { distribution: 'uniform', min: 10, max: 60, integer: true },
  bidIncrementUnit: 1,
  kcEnabled: true,
  kcVisible: [],
}

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
    const db = ctx.firestore()
    const inst = db.collection('procurement_game_instances').doc(IID)
    await inst.set({ game_id: 'procurement' })
    await inst.collection('config').doc('main').set(CONFIG_DOC_DATA)
    await inst.collection('truth').doc('main').set(TRUTH_DOC_DATA)
    await inst.collection('participants').doc(STU_A).set({
      participant_id: STU_A,
      rounds: [{ round: 1, cost: 34, bid: 53, won: true, price: 53, profit: 19 }],
    })
    await inst.collection('participants').doc(STU_B).set({ participant_id: STU_B })

    const other = db.collection('procurement_game_instances').doc(OTHER_IID)
    await other.set({ game_id: 'procurement' })
    await other.collection('participants').doc(STU_A).set({ participant_id: STU_A })
  })
})

afterAll(async () => { await testEnv?.cleanup() })

describe('procurement_ rules — the instance and its config', () => {
  it('an authenticated student may read the instance doc', async () => {
    await assertSucceeds(
      student(STU_A, IID).collection('procurement_game_instances').doc(IID).get())
  })

  it('an UNauthenticated client may not', async () => {
    await assertFails(
      testEnv.unauthenticatedContext().firestore()
        .collection('procurement_game_instances').doc(IID).get())
  })

  it('config/main IS student-readable — the auction parameters are taught, not hidden', async () => {
    const snap = await assertSucceeds(
      student(STU_A, IID)
        .collection('procurement_game_instances').doc(IID)
        .collection('config').doc('main').get())
    // ⚠ THE ASSERTION THAT CATCHES A FUTURE MISTAKE. If someone ever moves the seed into
    // config "for convenience", this passes and the next one fails — but this line is
    // what documents that config is deliberately open, so the failure reads as a moved
    // secret rather than as a broken rule.
    expect(snap.data()?.rivalCostDist?.max).toBe(110)
    expect(snap.data()?.seed).toBeUndefined()
  })

  it('no client may WRITE config, not even an authenticated one', async () => {
    await assertFails(
      student(STU_A, IID)
        .collection('procurement_game_instances').doc(IID)
        .collection('config').doc('main').set({ reserve: 10 }))
  })
})

describe('procurement_ rules — truth/ is denied to every client', () => {
  it('a student cannot read the seed', async () => {
    await assertFails(
      student(STU_A, IID)
        .collection('procurement_game_instances').doc(IID)
        .collection('truth').doc('main').get())
  })

  it('an UNauthenticated client cannot read the seed', async () => {
    await assertFails(
      testEnv.unauthenticatedContext().firestore()
        .collection('procurement_game_instances').doc(IID)
        .collection('truth').doc('main').get())
  })

  it('nobody can write it either', async () => {
    await assertFails(
      student(STU_A, IID)
        .collection('procurement_game_instances').doc(IID)
        .collection('truth').doc('main').set({ seed: 'mine' }))
  })

  // ⚠⚠ THE OPEN FORMAT PUTS SOMETHING ELSE IN HERE, AND IT IS THE GAME ITSELF.
  //
  // Bot costs must exist from ROUND OPEN in the open format — every bot decision, from the
  // first, is a function of its cost — which the sealed format never required, since there
  // rival costs are drawn at resolution and simply do not exist before the bid. Spec §4
  // anticipates exactly this: "if drawn earlier for any reason, they live in the
  // rules-denied `truth` subcollection".
  //
  // The rule is `match /truth/{doc}`, so it already covers any doc id — but the id is
  // DERIVED FROM THE PARTICIPANT'S OWN ID (`bots_{pid}`), which is the one string a student
  // definitely knows. A student who guessed the path and got their round's bot costs would
  // know every rival's stopping point before bidding, which is the whole auction. Asserted
  // by NAME rather than left to the wildcard, and asserted for the student's OWN doc rather
  // than a stranger's, because that is the reachable case.
  const botsDoc = `bots_${STU_A}`

  it('⚠⚠ a student cannot read their OWN round\'s bot costs', async () => {
    await assertFails(
      student(STU_A, IID)
        .collection('procurement_game_instances').doc(IID)
        .collection('truth').doc(botsDoc).get())
  })

  it('nor an unauthenticated client', async () => {
    await assertFails(
      testEnv.unauthenticatedContext().firestore()
        .collection('procurement_game_instances').doc(IID)
        .collection('truth').doc(botsDoc).get())
  })

  it('and nobody can write bot costs either', async () => {
    await assertFails(
      student(STU_A, IID)
        .collection('procurement_game_instances').doc(IID)
        .collection('truth').doc(botsDoc).set({ r1: [1, 1, 1, 1] }))
  })
})

describe('procurement_ rules — participants are denied outright', () => {
  // ⚠ FOLLOWS PD / PRICING / NEWSVENDOR / FORECAST, NOT pennies/poll: read is DENIED
  // rather than scoped to "your own doc". Checkpoint 2 stores the rival costs alongside
  // each resolved round for the reports, and a self-read would hand a student the losing
  // bidders' costs through the plain SDK with no callable involved.
  it('a student cannot read even their OWN participant doc', async () => {
    await assertFails(
      student(STU_A, IID)
        .collection('procurement_game_instances').doc(IID)
        .collection('participants').doc(STU_A).get())
  })

  it('a student cannot read another student\'s doc', async () => {
    await assertFails(
      student(STU_A, IID)
        .collection('procurement_game_instances').doc(IID)
        .collection('participants').doc(STU_B).get())
  })

  it('a student cannot read their own doc under a DIFFERENT instance', async () => {
    await assertFails(
      student(STU_A, IID)
        .collection('procurement_game_instances').doc(OTHER_IID)
        .collection('participants').doc(STU_A).get())
  })

  it('a student cannot write their participant doc', async () => {
    await assertFails(
      student(STU_A, IID)
        .collection('procurement_game_instances').doc(IID)
        .collection('participants').doc(STU_A).set({ rounds: [] }))
  })
})

describe('procurement_ rules — no top-level participants collection is reachable', () => {
  // ⚠ THE v1 BUG IN pennies AND poll: participants at the top level rather than a
  // per-instance subcollection. Nothing in these rules matches such a path, so it is
  // denied by absence — asserted here so a future rules edit that adds a wildcard block
  // cannot silently open it.
  it('a top-level procurement_participants read is denied', async () => {
    await assertFails(
      student(STU_A, IID).collection('procurement_participants').doc(STU_A).get())
  })
})
