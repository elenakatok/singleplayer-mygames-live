import { afterAll, beforeAll, describe, it, expect } from 'vitest'
import * as admin from 'firebase-admin'
import type { Firestore } from 'firebase-admin/firestore'
import { initPdParticipant, drawRoundCount, drawStrategy } from '../src/pd/init'
import {
  INSTANCES_COLLECTION, CONFIG_DOC, truthParticipantDoc,
  DEFAULT_MIN_ROUNDS as MIN_ROUNDS, DEFAULT_MAX_ROUNDS as MAX_ROUNDS,
} from '../src/pd/config'
import { isStrategy } from '../src/pd/strategy'

// ═══════════════════════════════════════════════════════════════════════════════
// PD first-touch init against a REAL Firestore (emulator). Runs via
// `npm run test:rules`, which boots the Firestore emulator.
//
// This file exists because the once-only guarantee is a CONCURRENCY property, and a
// hand-rolled fake transaction cannot prove it — it would only re-assert my own
// assumptions. The load-bearing test is "fire N first-touches at once and exactly
// ONE of them draws"; that is a claim about Firestore's transaction semantics, so
// it has to run against Firestore.
//
// ⚠ BOTH DRAWS ARE PER PARTICIPANT NOW. The round count used to be an instance-level
// draw in truth/main, shared by the class — a leak, since the first student to finish
// could tell everyone the horizon. There is no instance-level truth doc left, and the
// tests below assert that students in ONE instance get DIFFERENT counts.
// ═══════════════════════════════════════════════════════════════════════════════

const PROJECT_ID = 'demo-singleplayer'

let db: Firestore

beforeAll(() => {
  // The emulator host is exported by `firebase emulators:exec`; guard the app
  // singleton because vitest may load this module more than once in a worker.
  const app = admin.apps.length ? admin.app() : admin.initializeApp({ projectId: PROJECT_ID })
  db = admin.firestore(app)
})

afterAll(async () => { await Promise.all(admin.apps.map(a => a?.delete())) })

const instanceRef = (iid: string) => db.collection(INSTANCES_COLLECTION).doc(iid)
const readTruth = async (iid: string, pid: string) =>
  (await instanceRef(iid).collection('truth').doc(truthParticipantDoc(pid)).get()).data()
const readRounds = async (iid: string, pid: string) => (await readTruth(iid, pid))?.rounds
const readStrategy = async (iid: string, pid: string) => (await readTruth(iid, pid))?.strategy

let n = 0
const freshId = (label: string) => `pd-${label}-${Date.now()}-${n++}`

describe('first touch draws; every later touch returns the stored value', () => {
  it('draws both on first touch and reports having drawn them', async () => {
    const iid = freshId('first')
    const r = await initPdParticipant(db, iid, 'stu-a')

    expect(r.drewRounds).toBe(true)
    expect(r.drewStrategy).toBe(true)
    expect(r.rounds).toBeGreaterThanOrEqual(MIN_ROUNDS)
    expect(r.rounds).toBeLessThanOrEqual(MAX_ROUNDS)
    expect(isStrategy(r.strategy)).toBe(true)
  })

  it('stores BOTH at the student’s rules-denied path, and NOWHERE else', async () => {
    const iid = freshId('paths')
    const r = await initPdParticipant(db, iid, 'stu-a')

    // truth/participant_stu-a → this student's round count AND strategy.
    expect(await readRounds(iid, 'stu-a')).toBe(r.rounds)
    expect(await readStrategy(iid, 'stu-a')).toBe(r.strategy)

    // ⚠ And the legacy instance-level doc is NOT written — no fallback path survives.
    const legacy = await instanceRef(iid).collection('truth').doc('main').get()
    expect(legacy.exists).toBe(false)

    // NOT on the student-facing participant doc, and NOT in student-readable config.
    const pSnap = await instanceRef(iid).collection('participants').doc('stu-a').get()
    expect(pSnap.data()?.strategy).toBeUndefined()
    expect(pSnap.data()?.rounds).toBeUndefined()
    const cSnap = await instanceRef(iid).collection('config').doc(CONFIG_DOC).get()
    expect(cSnap.data()?.rounds).toBeUndefined()
    expect(cSnap.data()?.strategy).toBeUndefined()
  })

  it('re-touching NEVER changes an already-set value', async () => {
    const iid = freshId('retouch')
    const first = await initPdParticipant(db, iid, 'stu-a')

    for (let i = 0; i < 5; i++) {
      const again = await initPdParticipant(db, iid, 'stu-a')
      expect(again.rounds).toBe(first.rounds)
      expect(again.strategy).toBe(first.strategy)
      expect(again.drewRounds).toBe(false)
      expect(again.drewStrategy).toBe(false)
    }
    expect(await readRounds(iid, 'stu-a')).toBe(first.rounds)
    expect(await readStrategy(iid, 'stu-a')).toBe(first.strategy)
  })

  it('⚠ a second student in the SAME instance draws their OWN count', async () => {
    // The leak fix, at the storage layer: nothing about student A's horizon is
    // consulted for student B.
    const iid = freshId('second')
    const a = await initPdParticipant(db, iid, 'stu-a')
    const b = await initPdParticipant(db, iid, 'stu-b')

    expect(b.drewRounds).toBe(true)    // their own draw, not A's
    expect(b.drewStrategy).toBe(true)
    expect(await readRounds(iid, 'stu-a')).toBe(a.rounds)
    expect(await readRounds(iid, 'stu-b')).toBe(b.rounds)
    expect(await readStrategy(iid, 'stu-b')).toBe(b.strategy)
  })

  it('an already-drawn count survives a RANGE EDIT — no mid-game redraw', async () => {
    // Slice 5's no-redraw rule, now at PARTICIPANT level: a student mid-game keeps
    // their horizon, and the new range reaches only students who have not launched.
    const iid = freshId('rerange')
    const early = await initPdParticipant(db, iid, 'stu-early')
    await instanceRef(iid).collection('config').doc(CONFIG_DOC)
      .set({ min_rounds: 2, max_rounds: 3 }, { merge: true })

    const again = await initPdParticipant(db, iid, 'stu-early')
    expect(again.rounds).toBe(early.rounds)
    expect(again.drewRounds).toBe(false)
    expect(again.rounds).toBeGreaterThanOrEqual(MIN_ROUNDS)  // still the OLD range

    // …while a student who had not launched draws inside the NEW range.
    const late = await initPdParticipant(db, iid, 'stu-late')
    expect(late.drewRounds).toBe(true)
    expect(late.rounds).toBeGreaterThanOrEqual(2)
    expect(late.rounds).toBeLessThanOrEqual(3)
  })

  it('students are isolated across instances — the same id re-draws per instance', async () => {
    const iidA = freshId('isoA'), iidB = freshId('isoB')
    await initPdParticipant(db, iidA, 'shared-stu')
    const inB = await initPdParticipant(db, iidB, 'shared-stu')
    expect(inB.drewStrategy).toBe(true) // not carried over from instance A
    expect(inB.drewRounds).toBe(true)
  })
})

describe('once-only under CONCURRENCY (the real guarantee)', () => {
  // ARTIFICIAL WORST CASE, deliberately kept: N transactions contending on the SAME
  // two documents serialize into a retry storm, so this is slow (seconds, not ms) and
  // needs a raised timeout. It does not model production — one student means one
  // browser; the realistic burst is many DIFFERENT students, which is the next test
  // and is fast because each has its own strategy doc. This test is here for
  // CORRECTNESS under contention, not for performance.
  it('N simultaneous first-touches for ONE student: exactly one draws, all agree', { timeout: 60_000 }, async () => {
    const iid = freshId('race-one')
    const N = 15

    const results = await Promise.all(
      Array.from({ length: N }, () => initPdParticipant(db, iid, 'stu-a')),
    )

    // Exactly one transaction performed each draw; the rest observed the committed
    // value on retry. This is the compare-and-set property, not a coincidence.
    expect(results.filter(r => r.drewStrategy)).toHaveLength(1)
    expect(results.filter(r => r.drewRounds)).toHaveLength(1)

    // And every caller agrees on the outcome.
    expect(new Set(results.map(r => r.strategy)).size).toBe(1)
    expect(new Set(results.map(r => r.rounds)).size).toBe(1)
    expect(await readStrategy(iid, 'stu-a')).toBe(results[0].strategy)
    expect(await readRounds(iid, 'stu-a')).toBe(results[0].rounds)
  })

  it('N students racing into a FRESH instance: N independent horizons, no contention', async () => {
    const iid = freshId('race-many')
    const N = 12

    const results = await Promise.all(
      Array.from({ length: N }, (_, i) => initPdParticipant(db, iid, `stu-${i}`)),
    )

    // Every student drew their OWN count and their OWN strategy — there is no shared
    // document left to contend for, and no shared answer to leak.
    expect(results.filter(r => r.drewRounds)).toHaveLength(N)
    expect(results.filter(r => r.drewStrategy)).toHaveLength(N)
    expect(new Set(results.map(r => r.rounds)).size).toBeGreaterThan(1)

    for (let i = 0; i < N; i++) {
      expect(await readStrategy(iid, `stu-${i}`)).toBe(results[i].strategy)
      expect(await readRounds(iid, `stu-${i}`)).toBe(results[i].rounds)
    }
  })
})

describe('seeded instances are reproducible end to end', () => {
  it('a seed in config/main drives both draws to the pure functions’ values', async () => {
    const iid = freshId('seeded')
    await instanceRef(iid).collection('config').doc(CONFIG_DOC).set({ seed: 'harness-1' })

    const r = await initPdParticipant(db, iid, 'stu-a')
    expect(r.config.seed).toBe('harness-1')
    expect(r.rounds).toBe(drawRoundCount('harness-1', 'stu-a', MIN_ROUNDS, MAX_ROUNDS))
    expect(r.strategy).toBe(drawStrategy('harness-1', 'stu-a'))
  })

  it('both draws key on the PARTICIPANT, so one seed still separates students', async () => {
    const iid = freshId('seed-students')
    await instanceRef(iid).collection('config').doc(CONFIG_DOC).set({ seed: 'same' })

    const a = await initPdParticipant(db, iid, 'stu-a')
    const b = await initPdParticipant(db, iid, 'stu-b')
    expect(a.rounds).toBe(drawRoundCount('same', 'stu-a', MIN_ROUNDS, MAX_ROUNDS))
    expect(b.rounds).toBe(drawRoundCount('same', 'stu-b', MIN_ROUNDS, MAX_ROUNDS))

    // The same student under the same seed is reproducible across INSTANCES — which
    // is what lets a harness pin a horizon without pinning the instance id.
    const iid2 = freshId('seed-students-2')
    await instanceRef(iid2).collection('config').doc(CONFIG_DOC).set({ seed: 'same' })
    const aAgain = await initPdParticipant(db, iid2, 'stu-a')
    expect(aAgain.rounds).toBe(a.rounds)
    expect(aAgain.strategy).toBe(a.strategy)
  })
})
