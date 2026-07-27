import { afterAll, beforeAll, describe, it, expect } from 'vitest'
import * as admin from 'firebase-admin'
import type { Firestore } from 'firebase-admin/firestore'
import { initPricingParticipant, drawRoundCount } from '../src/pricing/init'
import {
  INSTANCES_COLLECTION, CONFIG_DOC, TRUTH_DOC, truthParticipantDoc,
  DEFAULT_MIN_ROUNDS as MIN_ROUNDS, DEFAULT_MAX_ROUNDS as MAX_ROUNDS,
} from '../src/pricing/config'

// ═══════════════════════════════════════════════════════════════════════════════
// Pricing first-touch init against a REAL Firestore (emulator). Runs via
// `npm run test:rules`, which boots the Firestore emulator.
//
// This file exists because the once-only guarantee is a CONCURRENCY property, and a
// hand-rolled fake transaction cannot prove it — it would only re-assert my own
// assumptions. The load-bearing test is "fire N first-touches at once and exactly
// ONE of them draws"; that is a claim about Firestore's transaction semantics, so it
// has to run against Firestore.
//
// ⚠ THE CONTRAST WITH PD is the point of the last block: PD's round count is an
// INSTANCE-level draw, so a class starting at once contends on one document. Pricing
// draws PER PARTICIPANT, so N students starting at once perform N independent draws
// and contend with nobody — and, more importantly, they get N DIFFERENT horizons, so
// the first student to finish cannot tell the class how long the game is.
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
const readRounds = async (iid: string, pid: string) =>
  (await instanceRef(iid).collection('truth').doc(truthParticipantDoc(pid)).get()).data()?.rounds

let n = 0
const freshId = (label: string) => `pricing-${label}-${Date.now()}-${n++}`

describe('first touch draws; every later touch returns the stored value', () => {
  it('draws on first touch and reports having drawn', async () => {
    const iid = freshId('first')
    const r = await initPricingParticipant(db, iid, 'stu-a')

    expect(r.drewRounds).toBe(true)
    expect(r.rounds).toBeGreaterThanOrEqual(MIN_ROUNDS)
    expect(r.rounds).toBeLessThanOrEqual(MAX_ROUNDS)
    // A fresh instance is Standard, and Standard runs the high-start best-reply rule.
    expect(r.config.pmg).toBe(false)
    expect(r.strategy).toBe('standard-highstart-bestreply')
  })

  it('stores the horizon at the rules-denied path, and NOWHERE else', async () => {
    const iid = freshId('paths')
    const r = await initPricingParticipant(db, iid, 'stu-a')

    expect(await readRounds(iid, 'stu-a')).toBe(r.rounds)

    // NOT on the student-facing participant doc, and NOT in student-readable config.
    const pSnap = await instanceRef(iid).collection('participants').doc('stu-a').get()
    expect(pSnap.data()?.rounds).toBeUndefined()
    const cSnap = await instanceRef(iid).collection('config').doc(CONFIG_DOC).get()
    expect(cSnap.data()?.rounds).toBeUndefined()
    expect(cSnap.data()?.standard_strategy).toBeUndefined()
  })

  it('re-touching NEVER changes an already-set value', async () => {
    const iid = freshId('retouch')
    const first = await initPricingParticipant(db, iid, 'stu-a')

    for (let i = 0; i < 5; i++) {
      const again = await initPricingParticipant(db, iid, 'stu-a')
      expect(again.rounds).toBe(first.rounds)
      expect(again.drewRounds).toBe(false)
    }
    expect(await readRounds(iid, 'stu-a')).toBe(first.rounds)
  })

  it('an already-drawn horizon survives a RANGE EDIT — no mid-game redraw', async () => {
    // A student is mid-game against their drawn count; re-ranging the instance must
    // not move their finish line. This is why the validity check asks "is it a
    // playable count", not "is it inside the current range".
    const iid = freshId('rerange')
    const first = await initPricingParticipant(db, iid, 'stu-a')
    await instanceRef(iid).collection('config').doc(CONFIG_DOC)
      .set({ min_rounds: 2, max_rounds: 3 }, { merge: true })

    const after = await initPricingParticipant(db, iid, 'stu-a')
    expect(after.rounds).toBe(first.rounds)
    expect(after.drewRounds).toBe(false)
    expect(after.config.minRounds).toBe(2)   // the edit DID take effect for new students
  })

  it('students are isolated across instances — the same id re-draws per instance', async () => {
    const iidA = freshId('isoA'), iidB = freshId('isoB')
    await initPricingParticipant(db, iidA, 'shared-stu')
    const inB = await initPricingParticipant(db, iidB, 'shared-stu')
    expect(inB.drewRounds).toBe(true)  // not carried over from instance A
  })
})

describe('the PMG toggle selects the competitor rule at first touch (spec §5, §6)', () => {
  it('a PMG instance runs the ceiling poster', async () => {
    const iid = freshId('pmg')
    await instanceRef(iid).collection('config').doc(CONFIG_DOC).set({ pmg: true })

    const r = await initPricingParticipant(db, iid, 'stu-a')
    expect(r.config.pmg).toBe(true)
    expect(r.strategy).toBe('pmg-ceiling')
  })

  it('an instructor-set rule in truth/main overrides the shipped one', async () => {
    const iid = freshId('override')
    await instanceRef(iid).collection('truth').doc(TRUTH_DOC)
      .set({ standard_strategy: 'pmg-ceiling' })

    const r = await initPricingParticipant(db, iid, 'stu-a')
    expect(r.strategy).toBe('pmg-ceiling')
  })
})

describe('once-only under CONCURRENCY (the real guarantee)', () => {
  // ARTIFICIAL WORST CASE, deliberately kept: N transactions contending on the SAME
  // document serialize into a retry storm, so this is slow (seconds, not ms) and needs
  // a raised timeout. It does not model production — one student means one browser.
  // It is here for CORRECTNESS under contention, not for performance.
  it('N simultaneous first-touches for ONE student: exactly one draws, all agree', { timeout: 60_000 }, async () => {
    const iid = freshId('race-one')
    const N = 15

    const results = await Promise.all(
      Array.from({ length: N }, () => initPricingParticipant(db, iid, 'stu-a')),
    )

    // Exactly one transaction performed the draw; the rest observed the committed
    // value on retry. This is the compare-and-set property, not a coincidence.
    expect(results.filter(r => r.drewRounds)).toHaveLength(1)
    expect(new Set(results.map(r => r.rounds)).size).toBe(1)
    expect(await readRounds(iid, 'stu-a')).toBe(results[0].rounds)
  })

  it('N students racing into a FRESH instance: N independent horizons, N draws', async () => {
    const iid = freshId('race-many')
    const N = 12

    const results = await Promise.all(
      Array.from({ length: N }, (_, i) => initPricingParticipant(db, iid, `stu-${i}`)),
    )

    // Every student drew their OWN count — no shared instance-level draw to contend
    // for, and no shared answer to leak.
    expect(results.filter(r => r.drewRounds)).toHaveLength(N)
    for (let i = 0; i < N; i++) {
      expect(await readRounds(iid, `stu-${i}`)).toBe(results[i].rounds)
    }
    // And they genuinely differ — one class, many finish lines.
    expect(new Set(results.map(r => r.rounds)).size).toBeGreaterThan(1)
  })
})

describe('seeded instances are reproducible end to end', () => {
  it('a seed in config/main drives the draw to the pure function’s value', async () => {
    const iid = freshId('seeded')
    await instanceRef(iid).collection('config').doc(CONFIG_DOC).set({ seed: 'harness-1' })

    const r = await initPricingParticipant(db, iid, 'stu-a')
    expect(r.config.seed).toBe('harness-1')
    expect(r.rounds).toBe(drawRoundCount('harness-1', 'stu-a', MIN_ROUNDS, MAX_ROUNDS))
  })

  it('the draw keys on the PARTICIPANT, not the instance', async () => {
    // Same seed, same student id, two instances ⇒ the same horizon. That is the
    // deliberate consequence of a per-participant key, and it is what makes a harness
    // run reproducible without pinning the instance id.
    const iidA = freshId('seedA'), iidB = freshId('seedB')
    for (const iid of [iidA, iidB]) {
      await instanceRef(iid).collection('config').doc(CONFIG_DOC).set({ seed: 'same' })
    }
    const a = await initPricingParticipant(db, iidA, 'stu-a')
    const b = await initPricingParticipant(db, iidB, 'stu-a')
    expect(a.rounds).toBe(b.rounds)
    // …while two DIFFERENT students under one seed are independent.
    const c = await initPricingParticipant(db, iidA, 'stu-b')
    expect(c.rounds).toBe(drawRoundCount('same', 'stu-b', MIN_ROUNDS, MAX_ROUNDS))
  })
})
