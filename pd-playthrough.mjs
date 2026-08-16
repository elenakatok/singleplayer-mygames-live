// ═══════════════════════════════════════════════════════════════════════════════
// Repeated Prisoner's Dilemma — SLICE 2 emulator harness. Drives the onCall/onRequest
// endpoints over HTTP (pennies/poll style; no browser — this family's harnesses are
// HTTP + build-artifact, and the repo carries no browser driver).
//
// Slice 0 coverage (§1–§5): health, launch, pd_ prefix + cross-game isolation,
// instructor session, the student route in the shipped bundle.
//
// Slice 2 coverage (§6–§12): the round loop — first-touch init, full playthroughs to
// game over against BOTH strategies with every bot move and payoff predicted
// independently, submit-and-lock, resume mid-loop, and the LEAK ASSERTIONS that are
// the spec's hard constraint: no response may carry the round count or the strategy.
//
// Later slices extend this file with the KC, the debrief, and Score & Record.
//
// Run (build both first — §11 reads frontend/dist, §1–§10 read functions/lib):
//   env -C functions npm run build && env -C frontend npm run build
//   firebase emulators:exec --only functions,firestore,auth --project demo-singleplayer \
//     --config firebase.json "node pd-playthrough.mjs"
// ═══════════════════════════════════════════════════════════════════════════════

import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PROJECT = 'demo-singleplayer'
const FUNCTIONS = `http://127.0.0.1:5010/${PROJECT}/us-central1`
const FIRESTORE = `http://127.0.0.1:8090/v1/projects/${PROJECT}/databases/(default)/documents`
const ROOT = path.dirname(fileURLToPath(import.meta.url))

let passed = 0, failed = 0
const check = (cond, label) => {
  if (cond) { passed++; console.log(`  ✓ ${label}`) }
  else { failed++; console.error(`  ✗ ${label}`) }
}

async function callFn(name, data) {
  const res = await fetch(`${FUNCTIONS}/${name}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data }),
  })
  let body = null
  try { body = await res.json() } catch { /* ignore */ }
  if (res.ok && body && 'result' in body) return { ok: true, result: body.result }
  return { ok: false, error: body?.error?.message ?? `http ${res.status}`, status: body?.error?.status }
}

/** GETs an onRequest health probe (not a callable — plain JSON, no envelope). */
async function getJson(name) {
  const res = await fetch(`${FUNCTIONS}/${name}`)
  try { return { status: res.status, body: await res.json() } } catch { return { status: res.status, body: null } }
}

/** Reads one document straight out of the Firestore emulator (REST). Returns the
 *  raw field map, or null on 404. Used to assert WHICH collection a write landed in —
 *  Slice 0 has no read callable to ask instead. */
async function getDoc(docPath) {
  const res = await fetch(`${FIRESTORE}/${docPath}`, { headers: { Authorization: 'Bearer owner' } })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`firestore GET ${docPath} → ${res.status}`)
  const body = await res.json()
  return body.fields ?? {}
}

/** Writes one document into the Firestore emulator as owner (REST). Slice 2 uses this
 *  ONLY to seed config/main — PD has no instructor-config callable yet, and the seed is
 *  what makes the strategy assignment reproducible enough to drive one TFT student and
 *  one GRIM student deliberately. */
async function putDoc(docPath, fields) {
  const res = await fetch(`${FIRESTORE}/${docPath}`, {
    method: 'PATCH',
    headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields }),
  })
  if (!res.ok) throw new Error(`firestore PATCH ${docPath} → ${res.status} ${await res.text()}`)
}

const intVal = (n) => ({ integerValue: String(n) })
/**
 * ⚠⚠ SEEDS THE **LEGACY FOUR-VALUE** SHAPE, DELIBERATELY AND PERMANENTLY.
 *
 * The matrix is eight values now (Y and O per cell). Every instance this harness opens
 * is seeded in the OLD shape on purpose: that makes the whole playthrough below a live
 * migration test. The server must normalize four → eight on read (O = the transpose of
 * Y) and produce byte-for-byte the play it produced before the change — which is what
 * `expectedYears`, still written as the old symmetric lookup, asserts round by round.
 *
 * If this is ever "modernized" to write eight, the migration path stops being exercised
 * end to end. Add a second instance instead; §14b does exactly that.
 */
const payoffFields = (p) => ({ mapValue: { fields: {
  both_cooperate: intVal(p.both_cooperate), sucker: intVal(p.sucker),
  temptation: intVal(p.temptation), both_defect: intVal(p.both_defect),
} } })

const asStudent = (gid, pid, extra = {}) => ({ _test: { participant_id: pid, game_instance_id: gid }, ...extra })
const asDev = (gid) => ({ _dev: { game_instance_id: gid } })

// ── Mock classroom (the gradebook callback + the roster endpoint) ──────────────
// Same shape pennies' harness uses. In the emulator both URLs and the secret are
// passed explicitly inside _dev, so nothing here depends on a deployed classroom or
// on PD_CALLBACK_SECRET being present.
let pushCount = 0
const pushed = []
const callbackServer = http.createServer((req, res) => {
  let raw = ''
  req.on('data', c => (raw += c))
  req.on('end', () => {
    pushCount++
    try { pushed.push(JSON.parse(raw)) } catch { /* ignore */ }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
  })
})
await new Promise(r => callbackServer.listen(0, r))
const CALLBACK_URL = `http://127.0.0.1:${callbackServer.address().port}/push`
const CALLBACK_SECRET = 'test-secret'

/** The roster the mock classroom hands back: the two students who play, plus one who
 *  never launches — the −2 floor case only a roster sync can create. */
const ROSTER = [
  { participant_id: 'pd-finisher', name: 'Fin Isher', external_id: 'ext-1' },
  { participant_id: 'pd-quitter', name: 'Quinn Itter', external_id: 'ext-2' },
  { participant_id: 'pd-absent', name: 'Abby Sent', external_id: 'ext-3' },
]
const rosterServer = http.createServer((req, res) => {
  let raw = ''
  req.on('data', c => (raw += c))
  req.on('end', () => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true, participants: ROSTER }))
  })
})
await new Promise(r => rosterServer.listen(0, r))
const ROSTER_URL = `http://127.0.0.1:${rosterServer.address().port}/roster`

// ── Independent models of the server's logic ───────────────────────────────────
// Deliberately re-implemented here rather than imported from functions/lib: a harness
// that imports the code under test can only prove it is self-consistent. These are
// written from the SPEC (§2, §5), so a change in the server that breaks the spec fails
// here instead of quietly agreeing with itself.

/** The bot's move for the round following `priorMoves` (the student's own moves). */
function expectedBotMove(strategy, priorMoves) {
  if (strategy === 'tft') return priorMoves.length === 0 ? 'C' : priorMoves[priorMoves.length - 1]
  if (strategy === 'grim') return priorMoves.includes('D') ? 'D' : 'C'
  throw new Error(`unknown strategy ${strategy}`)
}

/**
 * Years served by a player who played `own` against `other`, under the LEGACY four-value
 * matrix. Spec §2, as it stood before the matrix became eight values.
 *
 * ⚠ THIS IS THE MIGRATION ORACLE AND IT MUST STAY LEGACY. The instances it is used
 * against are seeded four-value (see `payoffFields`), so "the server still produces
 * exactly this" is the end-to-end statement that a pre-existing instance plays
 * identically after the change. The asymmetric case has its own oracle in §14b.
 */
function expectedYears(own, other, p) {
  if (own === 'C') return other === 'C' ? p.both_cooperate : p.sucker
  return other === 'C' ? p.temptation : p.both_defect
}

// ── Deep response inspection (the leak assertions) ─────────────────────────────

/** Every key name appearing anywhere in a response tree. */
function deepKeys(value, out = new Set()) {
  if (Array.isArray(value)) { for (const v of value) deepKeys(v, out); return out }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) { out.add(k); deepKeys(v, out) }
  }
  return out
}

/** Every primitive value appearing anywhere in a response tree. */
function deepValues(value, out = []) {
  if (Array.isArray(value)) { for (const v of value) deepValues(v, out); return out }
  if (value && typeof value === 'object') {
    for (const v of Object.values(value)) deepValues(v, out)
    return out
  }
  out.push(value)
  return out
}

async function main() {
  const stamp = Date.now()

  // ── 1. Health probes ────────────────────────────────────────────────────────
  // pd's own probe, plus the two existing games: adding a third game to the shared
  // index.ts must not disturb the functions already deployed alongside it.
  console.log('\n[1] Health probes')
  const pdH = await getJson('pdHealth')
  check(pdH.status === 200 && pdH.body?.ok === true, 'pdHealth responds 200 ok')
  check(pdH.body?.game === 'pd', 'pdHealth identifies itself as game "pd"')

  const penH = await getJson('penniesHealth')
  const polH = await getJson('pollHealth')
  check(penH.body?.game === 'pennies', 'penniesHealth still reports "pennies" (untouched)')
  check(polH.body?.game === 'poll', 'pollHealth still reports "poll" (untouched)')

  // ── 2. Student launch ───────────────────────────────────────────────────────
  console.log('\n[2] Student launch (pdBootstrap)')
  const GID = `pd-${stamp}`
  const PID = 'pd-stu-a'

  const boot = await callFn('pdBootstrap', asStudent(GID, PID))
  check(boot.ok, 'pdBootstrap succeeds')
  check(boot.result?.participant_id === PID, 'returns the participant_id')
  check(boot.result?.game_instance_id === GID, 'returns the game_instance_id')
  check(typeof boot.result?.customToken === 'string' && boot.result.customToken.length > 0,
    'mints a Firebase custom token (the session the student route needs)')

  // Relaunching is the normal case (student closes the tab and comes back).
  const boot2 = await callFn('pdBootstrap', asStudent(GID, PID))
  check(boot2.ok && boot2.result?.participant_id === PID, 'relaunch is idempotent, not an error')

  // A launch with no token and no _test is rejected.
  const bootBad = await callFn('pdBootstrap', {})
  check(!bootBad.ok, 'pdBootstrap without a token is rejected')

  // ── 3. Collection prefix + cross-GAME isolation ─────────────────────────────
  // The whole family separates games by prefix, so this is the load-bearing check:
  // the write must land under pd_game_instances and NOWHERE else.
  console.log('\n[3] pd_ collection prefix + cross-game isolation')
  const pdDoc = await getDoc(`pd_game_instances/${GID}/participants/${PID}`)
  check(pdDoc !== null, 'participant doc exists at pd_game_instances/{iid}/participants/{pid}')
  check(pdDoc?.launched_at != null, 'launch stamped launched_at')

  // The SAME student id and the SAME instance id in pennies must be a DIFFERENT doc
  // in a different prefixed collection — never a shared one.
  await callFn('penniesBootstrap', asStudent(GID, PID))
  const penDoc = await getDoc(`pennies_game_instances/${GID}/participants/${PID}`)
  check(penDoc !== null, 'the same ids under pennies create a SEPARATE pennies_ doc')
  const pdStillThere = await getDoc(`pd_game_instances/${GID}/participants/${PID}`)
  check(pdStillThere !== null, 'the pd doc is untouched by the pennies launch')

  // Slice 0 writes no game state at all — no strategy, no rounds, no scores yet.
  const scaffoldOnly = ['estimate', 'bid', 'submitted_at', 'strategy', 'rounds', 'raw_score']
  check(scaffoldOnly.every(f => pdStillThere?.[f] === undefined),
    'pd participant doc carries identity only (no game state in Slice 0)')

  // ── 4. Instructor session ───────────────────────────────────────────────────
  console.log('\n[4] Instructor session (pdInstructorSession)')
  const sess = await callFn('pdInstructorSession', asDev(GID))
  check(sess.ok, 'pdInstructorSession succeeds')
  check(typeof sess.result?.customToken === 'string' && sess.result.customToken.length > 0,
    'mints an instructor custom token (the dashboard/settings/reports shell needs it)')

  const sessBad = await callFn('pdInstructorSession', {})
  check(!sessBad.ok, 'pdInstructorSession without a token is rejected')

  // ═══════════════════════════════════════════════════════════════════════════
  // SLICE 2 — the round loop.
  // ═══════════════════════════════════════════════════════════════════════════

  // The four payoff values every playthrough below runs on. Small and DISTINCT from
  // the round-count range on purpose: with every payoff < 10 and every legal round
  // count ≥ 10, "no number ≥ 10 appears in the response" is a sound leak test after
  // the first round (§11). The defaults (…15…) would collide with a 15-round draw.
  const PAYOFFS = { both_cooperate: 1, sucker: 9, temptation: 0, both_defect: 6 }

  /** Seeds config/main, then first-touches `pid` and reports the SERVER'S TRUTH for
   *  THAT STUDENT — read straight from their rules-denied truth/participant_* doc,
   *  which is the only place it exists. Both the round count and the strategy are
   *  per student now; the harness knows them, the student never does, and §10 is what
   *  proves that. */
  async function openInstance(gid, pid, seed) {
    await putDoc(`pd_game_instances/${gid}/config/main`, {
      seed: { stringValue: seed },
      payoffs: payoffFields(PAYOFFS),
    })
    await callFn('pdBootstrap', asStudent(gid, pid))
    const state = await callFn('pdGetState', asStudent(gid, pid))
    const stu = await getDoc(`pd_game_instances/${gid}/truth/participant_${pid}`)
    return {
      state,
      rounds: Number(stu?.rounds?.integerValue),
      strategy: stu?.strategy?.stringValue,
    }
  }

  /** First-touches students under one seeded instance until one of each strategy is
   *  found, so both playthroughs below are driven against a KNOWN opponent. */
  async function findStudents(gid, seed) {
    const found = {}
    for (let i = 1; i <= 12 && (!found.tft || !found.grim); i++) {
      const pid = `pd-stu-${i}`
      const { strategy, rounds } = await openInstance(gid, pid, seed)
      if (strategy && !found[strategy]) found[strategy] = { pid, rounds }
    }
    return found
  }

  // ── 5. First touch: pdGetState wires up the Slice 1 init ────────────────────
  console.log('\n[5] pdGetState — first touch draws the truth, returns none of it')
  const GID2 = `pd-loop-${stamp}`
  const FIRST = 'pd-first'
  const opened = await openInstance(GID2, FIRST, 'seed-loop')

  check(opened.state.ok, 'pdGetState succeeds on a student who has never played')
  check(Number.isInteger(opened.rounds) && opened.rounds >= 10 && opened.rounds <= 20,
    `first touch drew THIS STUDENT'S round count into truth/participant_* (${opened.rounds} ∈ [10,20])`)
  check(opened.strategy === 'tft' || opened.strategy === 'grim',
    `first touch assigned a strategy into truth/participant_* (${opened.strategy})`)

  const s0 = opened.state.result
  check(Array.isArray(s0.history) && s0.history.length === 0, 'a new student has an empty history')
  check(s0.gameOver === false, 'a new student is not game-over')
  check(s0.payoffs?.you_cd === PAYOFFS.sucker && s0.payoffs?.you_dd === PAYOFFS.both_defect,
    'returns the INSTANCE payoff values (config-driven, not the shipped defaults)')
  // ⚠ THE LAZY MIGRATION, OBSERVED END TO END. config/main holds the LEGACY four; the
  // student is served EIGHT, with O the transpose of Y — exactly what the old symmetric
  // derive computed. Nothing is written back: the doc still has four keys and no more.
  check(s0.payoffs?.you_cc === PAYOFFS.both_cooperate && s0.payoffs?.you_dc === PAYOFFS.temptation,
    'a LEGACY four-value instance is normalized to the eight-value shape on read')
  check(s0.payoffs?.other_cc === PAYOFFS.both_cooperate
    && s0.payoffs?.other_cd === PAYOFFS.temptation
    && s0.payoffs?.other_dc === PAYOFFS.sucker
    && s0.payoffs?.other_dd === PAYOFFS.both_defect,
    '…and the O values are the TRANSPOSE of the Y values — O(C,D)=Y(D,C), O(D,C)=Y(C,D)')
  const cfgDocAfterRead = await getDoc(`pd_game_instances/${GID2}/config/main`)
  check(cfgDocAfterRead?.payoffs?.mapValue?.fields?.you_cc === undefined,
    '⚠ NO BACKFILL — reading a legacy instance does not write the eight values to it')
  check(s0.labels?.C === 'Cooperate' && s0.labels?.D === 'Defect', 'returns the move labels')

  // A second call must not redraw anything — once-only is the whole init contract.
  await callFn('pdGetState', asStudent(GID2, FIRST))
  const stuAgain = await getDoc(`pd_game_instances/${GID2}/truth/participant_${FIRST}`)
  check(Number(stuAgain?.rounds?.integerValue) === opened.rounds, 'a second pdGetState does NOT redraw the round count')
  check(stuAgain?.strategy?.stringValue === opened.strategy, 'a second pdGetState does NOT reassign the strategy')

  // ⚠ THE LEAK FIX, at the top of the loop coverage: the horizon is drawn PER
  // STUDENT, so classmates in ONE instance do not share a last round. It used to be
  // an instance-level draw, and the first student to finish could hand the class a
  // known horizon — restoring exactly the backward induction spec §3 exists to
  // prevent. The legacy instance-level doc must not exist at all: a fallback read
  // path would silently mask a consumer this fix missed.
  const classHorizons = new Set()
  for (let i = 0; i < 10; i++) {
    const pid = `pd-horizon-${i}`
    await callFn('pdGetState', asStudent(GID2, pid))
    const t = await getDoc(`pd_game_instances/${GID2}/truth/participant_${pid}`)
    classHorizons.add(Number(t?.rounds?.integerValue))
  }
  check(classHorizons.size > 1,
    `students in ONE instance draw DIFFERENT horizons (${[...classHorizons].join(', ')})`)
  const legacyTruth = await getDoc(`pd_game_instances/${GID2}/truth/main`)
  check(legacyTruth === null,
    'and the legacy instance-level truth/main is never written (no fallback read path)')

  // ── 6/7. Full playthroughs to game over, against BOTH strategies ────────────
  const GID3 = `pd-play-${stamp}`
  const students = await findStudents(GID3, 'seed-play')
  check(!!students.tft && !!students.grim,
    'the seeded assignment produces both a TFT student and a GRIM student to drive')

  /**
   * Plays a student to game over, verifying EVERY round independently:
   * the bot's move against the strategy model, both payoffs against the matrix,
   * the running totals, and that gameOver flips exactly once, on the last round.
   *
   * @param moveFor (roundNumber, priorOwnMoves) → the student's move this round
   */
  async function playToEnd(gid, pid, strategy, truthRounds, moveFor, label) {
    console.log(`\n[${label}] full playthrough vs ${strategy.toUpperCase()} (${pid})`)
    const mine = []
    let studentTotal = 0, botTotal = 0
    let last = null
    let over = false
    let n = 0

    while (!over && n < 30) { // guard: the draw can never exceed 20
      n++
      const move = moveFor(n, mine)
      const predictedBot = expectedBotMove(strategy, mine.slice())
      const res = await callFn('pdSubmitRound', asStudent(gid, pid, { round: n, move }))
      if (!res.ok) { check(false, `round ${n} submitted (${res.error})`); return null }
      last = res.result

      if (last.round?.botMove !== predictedBot) {
        check(false, `round ${n}: bot played ${predictedBot} as ${strategy} predicts (got ${last.round?.botMove})`)
        return null
      }
      const wantStudent = expectedYears(move, predictedBot, PAYOFFS)
      const wantBot = expectedYears(predictedBot, move, PAYOFFS)
      if (last.round.studentYears !== wantStudent || last.round.botYears !== wantBot) {
        check(false, `round ${n}: payoffs ${wantStudent}/${wantBot} (got ${last.round.studentYears}/${last.round.botYears})`)
        return null
      }

      mine.push(move)
      studentTotal += wantStudent
      botTotal += wantBot

      const row = last.history[last.history.length - 1]
      if (last.history.length !== n || row.round !== n
        || row.studentTotal !== studentTotal || row.botTotal !== botTotal) {
        check(false, `round ${n}: history row + running totals (${studentTotal}/${botTotal})`)
        return null
      }
      if (last.gameOver && n < truthRounds) {
        check(false, `round ${n}: gameOver arrived EARLY (truth says ${truthRounds})`)
        return null
      }
      over = last.gameOver
    }

    check(true, `every round's bot move matched ${strategy.toUpperCase()} exactly (${n} rounds)`)
    check(true, 'every round\'s payoffs and running totals matched the matrix')
    check(over, 'the game reached game over')
    check(n === truthRounds, `it ended on the DRAWN round count (${n} = ${truthRounds}), not a client-side count`)
    check(truthRounds >= 10 && truthRounds <= 20, 'the drawn round count was in [10, 20]')
    return { rounds: n, last, mine, studentTotal, botTotal }
  }

  // TFT: cooperate, cooperate, DEFECT, then cooperate — the bot should punish exactly
  // once and then forgive, which is the whole difference from GRIM.
  const tftMoves = (n) => (n === 3 ? 'D' : 'C')
  const tftRun = await playToEnd(GID3, students.tft.pid, 'tft', students.tft.rounds, tftMoves, '6')
  if (tftRun) {
    const h = tftRun.last.history
    check(h[3]?.botMove === 'D', 'TFT punished the round-3 defection in round 4')
    check(h[4]?.botMove === 'C', 'TFT FORGAVE in round 5 after one cooperative move')
  }

  // GRIM: same defection, and the bot must never cooperate again.
  const grimMoves = (n) => (n === 3 ? 'D' : 'C')
  const grimRun = await playToEnd(GID3, students.grim.pid, 'grim', students.grim.rounds, grimMoves, '7')
  if (grimRun) {
    const h = grimRun.last.history
    check(h.slice(0, 3).every(r => r.botMove === 'C'), 'GRIM cooperated until the first defection')
    check(h.slice(3).every(r => r.botMove === 'D'), 'GRIM defected FOREVER after it — never forgave')
  }

  // ── 8. Submit-and-lock: a played round can never be revised ─────────────────
  console.log('\n[8] Submit-and-lock + idempotency')
  const GID4 = `pd-lock-${stamp}`
  const LPID = 'pd-lock-stu'
  const lockOpen = await openInstance(GID4, LPID, 'seed-lock')
  const r1 = await callFn('pdSubmitRound', asStudent(GID4, LPID, { round: 1, move: 'C' }))
  check(r1.ok && r1.result.round.studentMove === 'C', 'round 1 plays')

  // The same round again, with the OPPOSITE move: discarded, stored one returned.
  const r1again = await callFn('pdSubmitRound', asStudent(GID4, LPID, { round: 1, move: 'D' }))
  check(r1again.ok, 'resubmitting a played round is a no-op, not an error (idempotent)')
  check(r1again.result.round.studentMove === 'C', 'the resubmitted move is DISCARDED — the stored move stands')
  check(r1again.result.history.length === 1, 'the resubmit did not append a second round')

  const lockDoc = await getDoc(`pd_game_instances/${GID4}/participants/${LPID}`)
  check(lockDoc?.rounds?.arrayValue?.values?.length === 1, 'the stored rounds array still holds exactly one round')
  check(Number(lockDoc?.rounds_played?.integerValue) === 1, 'rounds_played is 1')

  // Out of order: you cannot skip a round or replay from a stale tab two rounds back.
  const skipped = await callFn('pdSubmitRound', asStudent(GID4, LPID, { round: 4, move: 'C' }))
  check(!skipped.ok, 'submitting a FUTURE round is rejected (no skipping ahead)')

  const badMove = await callFn('pdSubmitRound', asStudent(GID4, LPID, { round: 2, move: 'X' }))
  check(!badMove.ok, 'an invalid move is rejected')
  const noRound = await callFn('pdSubmitRound', asStudent(GID4, LPID, { move: 'C' }))
  check(!noRound.ok, 'a submit with no round number is rejected')

  // Past the end: play out this student, then try one more round.
  let over8 = false
  for (let n = 2; n <= lockOpen.rounds && !over8; n++) {
    const r = await callFn('pdSubmitRound', asStudent(GID4, LPID, { round: n, move: 'C' }))
    over8 = r.ok && r.result.gameOver
  }
  check(over8, 'the lock student reached game over')
  const afterEnd = await callFn('pdSubmitRound', asStudent(GID4, LPID, { round: lockOpen.rounds + 1, move: 'D' }))
  check(!afterEnd.ok, 'submitting after the last round is rejected — the game cannot be extended')
  const replayLast = await callFn('pdSubmitRound', asStudent(GID4, LPID, { round: lockOpen.rounds, move: 'D' }))
  check(replayLast.ok && replayLast.result.gameOver === true,
    'replaying the FINAL round still returns the stored result + gameOver (idempotent, not an error)')

  // ── 9. Resume mid-loop ──────────────────────────────────────────────────────
  console.log('\n[9] Resume mid-loop (close the tab, come back)')
  const GID5 = `pd-resume-${stamp}`
  const RPID = 'pd-resume-stu'
  const resumeOpen = await openInstance(GID5, RPID, 'seed-resume')
  const played = ['C', 'D', 'C', 'D']
  for (let i = 0; i < played.length; i++) {
    await callFn('pdSubmitRound', asStudent(GID5, RPID, { round: i + 1, move: played[i] }))
  }

  // "Reload": a fresh pdGetState is the ONLY thing the returning client has.
  const resumed = await callFn('pdGetState', asStudent(GID5, RPID))
  check(resumed.ok, 'pdGetState succeeds on return')
  check(resumed.result.history.length === 4, 'the returning student sees all 4 played rounds')
  check(resumed.result.history.map(r => r.studentMove).join('') === played.join(''),
    'the history came back intact, in order, with the moves actually played')
  check(resumed.result.gameOver === false, 'and is not game-over')
  // This IS the resume computation the play screen does: startIteration = history.length.
  const nextRound = resumed.result.history.length + 1
  check(nextRound === 5, 'history.length ⇒ the client resumes on round 5')
  const r5 = await callFn('pdSubmitRound', asStudent(GID5, RPID, { round: nextRound, move: 'C' }))
  check(r5.ok && r5.result.history.length === 5, 'round 5 plays straight on from the stored history')
  check(r5.result.history[4].studentTotal === resumed.result.history[3].studentTotal + r5.result.round.studentYears,
    'the cumulative total carried across the reload')

  // A student who returns AFTER finishing lands on game-over, not on a new round.
  const finishedState = await callFn('pdGetState', asStudent(GID4, LPID))
  check(finishedState.result.gameOver === true, 'a returning FINISHED student is told the game is over')
  check(finishedState.result.history.length === lockOpen.rounds, 'and gets their full final history')

  // ── 10. ⚠ THE LEAK ASSERTIONS — the spec's hard constraint ──────────────────
  // The round count and the strategy are server-side truth, and both are now drawn
  // PER STUDENT. If either can be recovered from any response, the pedagogy is
  // broken: the student would know when their last round is (and so defect on it), or
  // know which bot they face without inferring it. These checks are the reason the
  // callables return whitelists. The per-student draw closes the OTHER route to the
  // same knowledge — a classmate who has already finished (see §5).
  console.log('\n[10] ⚠ No leak: not the round count, not the strategy, ever')

  const GID6 = `pd-leak-${stamp}`
  const KPID = 'pd-leak-stu'
  const leak = await openInstance(GID6, KPID, 'seed-leak')

  // Slice 5 added three legitimate student-facing settings: the unit word and the
  // configured round RANGE. The range is the ONE thing about the schedule a student
  // may be told (spec §3) — the DRAW still never appears, which §10 proves below by
  // stripping the two declared bounds and sweeping what is left.
  const ALLOWED_STATE_KEYS = ['ok', 'labels', 'payoffs', 'history', 'gameOver',
    'unit', 'minRounds', 'maxRounds',
    'C', 'D',
    'you_cc', 'you_cd', 'you_dc', 'you_dd', 'other_cc', 'other_cd', 'other_dc', 'other_dd',
    'round', 'studentMove', 'botMove', 'studentYears', 'botYears', 'studentTotal', 'botTotal']
  const ALLOWED_SUBMIT_KEYS = ['ok', 'round', 'history', 'gameOver',
    'studentMove', 'botMove', 'studentYears', 'botYears', 'studentTotal', 'botTotal']

  /** The whole-tree audit: exact key allowlist, no forbidden word anywhere in the
   *  serialized payload, and no number that could be THIS STUDENT'S drawn count. */
  function auditNoLeak(payload, allowedKeys, where) {
    const keys = [...deepKeys(payload)]
    const extra = keys.filter(k => !allowedKeys.includes(k))
    check(extra.length === 0, `${where}: no key outside the whitelist (extra: ${JSON.stringify(extra)})`)

    const json = JSON.stringify(payload).toLowerCase()
    const forbidden = ['strategy', 'tft', 'grim', 'seed', 'remaining', 'total_rounds', 'roundcount', 'finished_at']
    const hit = forbidden.filter(w => json.includes(w))
    check(hit.length === 0, `${where}: no forbidden word in the payload (found: ${JSON.stringify(hit)})`)

    // The count is an integer ≥ 10; every payoff in this instance is < 10 and only ONE
    // round has been played, so every legitimate number left is < 10 ONCE the two
    // declared range bounds are removed. Any survivor ≥ 10 could only be this
    // student's draw, under ANY key name. Stripping minRounds/maxRounds is sound
    // precisely because the key allowlist above proves the range cannot appear
    // anywhere else.
    const stripped = JSON.parse(JSON.stringify(payload))
    delete stripped.minRounds
    delete stripped.maxRounds
    const nums = deepValues(stripped).filter(v => typeof v === 'number')
    const suspicious = nums.filter(v => v >= 10)
    check(suspicious.length === 0,
      `${where}: no number ≥ 10 outside the declared range (the draw is ${leak.rounds}; found: ${JSON.stringify(suspicious)})`)
  }

  auditNoLeak(leak.state.result, ALLOWED_STATE_KEYS, 'pdGetState (before any round)')

  const leakRound = await callFn('pdSubmitRound', asStudent(GID6, KPID, { round: 1, move: 'C' }))
  auditNoLeak(leakRound.result, ALLOWED_SUBMIT_KEYS, 'pdSubmitRound (round 1)')
  const leakState = await callFn('pdGetState', asStudent(GID6, KPID))
  auditNoLeak(leakState.result, ALLOWED_STATE_KEYS, 'pdGetState (mid-game)')

  // And the same audit on the LAST round, where the server does know the game is
  // ending — the one response most at risk of leaking "…because that was round 13".
  for (let n = 2; n < leak.rounds; n++) {
    await callFn('pdSubmitRound', asStudent(GID6, KPID, { round: n, move: 'C' }))
  }
  const finalRound = await callFn('pdSubmitRound', asStudent(GID6, KPID, { round: leak.rounds, move: 'C' }))
  check(finalRound.result.gameOver === true, 'the final round reports gameOver')
  const finalKeys = [...deepKeys(finalRound.result)].filter(k => !ALLOWED_SUBMIT_KEYS.includes(k))
  check(finalKeys.length === 0, 'the FINAL round response carries no key outside the whitelist')
  check(!JSON.stringify(finalRound.result).toLowerCase().match(/tft|grim|strategy|remaining/),
    'the final round response names no strategy and no remainder')
  // gameOver is a BOOLEAN, never a count — "true" tells the student it ended, not how long it was.
  check(typeof finalRound.result.gameOver === 'boolean', 'gameOver is a boolean, not a round number')

  // The truth itself must still be unreadable by any client — the rules suite proves
  // the denial; this proves the data is actually there to be denied.
  const leakTruth = await getDoc(`pd_game_instances/${GID6}/truth/participant_${KPID}`)
  check(leakTruth?.strategy?.stringValue === leak.strategy,
    'the strategy lives in the rules-denied truth/ doc (never on the participant doc)')
  check(Number(leakTruth?.rounds?.integerValue) === leak.rounds,
    'and so does this student’s round count — same rules-denied doc, same denial')
  const leakParticipant = await getDoc(`pd_game_instances/${GID6}/participants/${KPID}`)
  check(leakParticipant?.strategy === undefined, 'the participant doc carries no strategy field at all')

  // ── 11. KC + debrief server contract ────────────────────────────────────────
  // The browser harness (pd-playwright.mjs) walks these through the UI. This section
  // owns the parts a UI cannot reach: the answer key never being served, the
  // per-question lock, and rejection of malformed input.
  console.log('\n[11] Knowledge check + debrief (server contract)')
  const GID7 = `pd-kc-${stamp}`
  const QPID = 'pd-kc-stu'
  await openInstance(GID7, QPID, 'seed-kc')

  const qs = await callFn('pdGetQuestions', asStudent(GID7, QPID))
  check(qs.ok, 'pdGetQuestions succeeds')
  check(qs.result.kc.derived.length === 4, 'serves the four DERIVED KC questions (spec §7)')
  check(Array.isArray(qs.result.kc.added) && qs.result.kc.added.length === 0,
    'and an empty ADDED list — the two sources arrive separately, never merged')
  check(qs.result.kc.derived.every(q => Object.keys(q).sort().join() === 'field,options,prompt'),
    'each derived question carries only field, prompt, options')
  const qsJson = JSON.stringify(qs.result)
  check(!qsJson.includes('correct_value'), '⚠ the answer key is NOT served to the student')
  check(!qsJson.includes('explanation'), '⚠ the explanations are NOT served ahead of answering')
  check(qs.result.kcAnswered.length === 0 && qs.result.debriefSubmitted === false,
    'a new student has answered nothing')
  check(qs.result.debrief?.prompt.startsWith('In a short paragraph'), 'serves the debrief question')

  // The KC options are THIS instance's payoff values (config-driven), and the correct
  // answer follows the same matrix — a student is never graded against a matrix they
  // were not shown.
  const optionValues = qs.result.kc.derived[0].options.map(o => o.value).sort()
  check(optionValues.join() === ['0', '1', '6', '9'].sort().join(),
    `KC options come from the instance matrix (${optionValues.join('/')})`)

  const kcCorrect = {
    kc_cc: String(PAYOFFS.both_cooperate), kc_cd: String(PAYOFFS.sucker),
    kc_dc: String(PAYOFFS.temptation), kc_dd: String(PAYOFFS.both_defect),
  }
  const a1 = await callFn('pdSubmitKcAnswer', asStudent(GID7, QPID, { field: 'kc_cc', answer: kcCorrect.kc_cc }))
  check(a1.ok && a1.result.correct === true, 'a correct answer is graded correct')
  check(typeof a1.result.explanation === 'string' && a1.result.explanation.length > 0,
    'the explanation IS returned post-answer (earned by answering)')

  // Per-question lock: a second attempt cannot upgrade a wrong answer.
  const wrongFirst = await callFn('pdSubmitKcAnswer', asStudent(GID7, QPID, { field: 'kc_cd', answer: kcCorrect.kc_dc }))
  check(wrongFirst.ok && wrongFirst.result.correct === false, 'a wrong answer is graded incorrect — and accepted')
  const retry = await callFn('pdSubmitKcAnswer', asStudent(GID7, QPID, { field: 'kc_cd', answer: kcCorrect.kc_cd }))
  check(retry.ok && retry.result.correct === false, 'retrying a question returns the STORED verdict — no second chance')

  const badField = await callFn('pdSubmitKcAnswer', asStudent(GID7, QPID, { field: 'kc_nope', answer: '1' }))
  check(!badField.ok, 'an unknown question field is rejected')
  const badOption = await callFn('pdSubmitKcAnswer', asStudent(GID7, QPID, { field: 'kc_dc', answer: '99' }))
  check(!badOption.ok, 'an answer outside the offered options is rejected')

  // No score until every question is answered; then correct/total.
  const midDoc = await getDoc(`pd_game_instances/${GID7}/participants/${QPID}`)
  check(midDoc?.knowledge_check_score === undefined, 'no KC score is written until all four are answered')
  await callFn('pdSubmitKcAnswer', asStudent(GID7, QPID, { field: 'kc_dc', answer: kcCorrect.kc_dc }))
  await callFn('pdSubmitKcAnswer', asStudent(GID7, QPID, { field: 'kc_dd', answer: kcCorrect.kc_dd }))
  const kcDoc = await getDoc(`pd_game_instances/${GID7}/participants/${QPID}`)
  const kcScore = Number(kcDoc?.knowledge_check_score?.doubleValue ?? kcDoc?.knowledge_check_score?.integerValue)
  check(kcScore === 0.75, `three of four correct scores 0.75 (got ${kcScore})`)

  // NO GATE: the KC never blocks the game. This student can play round 1 right now,
  // and so could a student who got every question wrong.
  const kcThenPlay = await callFn('pdSubmitRound', asStudent(GID7, QPID, { round: 1, move: 'C' }))
  check(kcThenPlay.ok, 'a student with a WRONG KC answer still enters the round loop (no gate)')

  // Debrief: ungraded, one-shot, and it must not disturb the KC score.
  const dbEmpty = await callFn('pdSubmitDebrief', asStudent(GID7, QPID, { answer: '   ' }))
  check(!dbEmpty.ok, 'an empty debrief paragraph is rejected')
  const db1 = await callFn('pdSubmitDebrief', asStudent(GID7, QPID, { answer: 'I cooperated throughout.' }))
  check(db1.ok && db1.result.stored === false, 'the debrief paragraph is stored')
  const db2 = await callFn('pdSubmitDebrief', asStudent(GID7, QPID, { answer: 'Actually I defected.' }))
  check(db2.ok && db2.result.stored === true && db2.result.answer === 'I cooperated throughout.',
    'a second debrief submit returns the STORED paragraph — one-shot, like every other submit')
  const dbDoc = await getDoc(`pd_game_instances/${GID7}/participants/${QPID}`)
  check(Number(dbDoc?.knowledge_check_score?.doubleValue ?? dbDoc?.knowledge_check_score?.integerValue) === 0.75,
    'the ungraded debrief did NOT touch the knowledge-check score')

  // ── 12. Participation scoring + the gradebook push ──────────────────────────
  console.log('\n[12] Score & Record → the classroom gradebook')
  const GID8 = `pd-score-${stamp}`
  const finisher = 'pd-finisher'
  const quitter = 'pd-quitter'
  const scoreTruth = await openInstance(GID8, finisher, 'seed-score')
  await openInstance(GID8, quitter, 'seed-score')

  // One student plays to the end; the other plays two rounds and walks away.
  for (let n = 1; n <= scoreTruth.rounds; n++) {
    await callFn('pdSubmitRound', asStudent(GID8, finisher, { round: n, move: n % 3 === 0 ? 'D' : 'C' }))
  }
  await callFn('pdSubmitRound', asStudent(GID8, quitter, { round: 1, move: 'C' }))
  await callFn('pdSubmitRound', asStudent(GID8, quitter, { round: 2, move: 'D' }))

  // A third student is enrolled by the roster sync but never launches at all.
  const sync = await callFn('pdSyncRoster', {
    _dev: { game_instance_id: GID8, roster_url: ROSTER_URL, callback_secret: 'x' },
  })
  check(sync.ok && sync.result.synced === 3, `pdSyncRoster pre-created the roster (${sync.result?.synced})`)
  const neverDoc = await getDoc(`pd_game_instances/${GID8}/participants/pd-absent`)
  check(neverDoc !== null && neverDoc.finished_at === undefined,
    'a rostered student who never launched has an identity-only doc')
  // …and the sync did not clobber the student who was mid-game.
  const quitterAfterSync = await getDoc(`pd_game_instances/${GID8}/participants/${quitter}`)
  check(quitterAfterSync?.rounds?.arrayValue?.values?.length === 2,
    'the roster sync did NOT clobber a student who had already played (safe identity-only merge)')

  const pushBefore = pushCount
  const score = await callFn('pdScoreAndRecord', {
    _dev: { game_instance_id: GID8, callback_url: CALLBACK_URL, callback_secret: CALLBACK_SECRET },
  })
  check(score.ok, 'pdScoreAndRecord succeeds')
  check(score.result.finishers === 1, 'exactly one student finished')
  check(pushCount - pushBefore === 3, `pushed 3 grade records (got ${pushCount - pushBefore})`)

  const byId = Object.fromEntries(pushed.slice(-3).map(r => [r.participant_id, r]))
  check(byId[finisher].normalized_score === 0, 'the finisher normalizes to 0 (participation)')
  check(byId[finisher].status === 'completed', 'the finisher pushes status completed')
  check(byId[quitter].normalized_score === -2, 'a student who played but never FINISHED gets the −2 floor')
  check(byId[quitter].status === 'no_show', 'and pushes status no_show')
  check(byId['pd-absent'].normalized_score === -2, 'a never-launched student gets the −2 floor')
  check(byId[finisher].role === null, 'role is null — this family has no roles')
  check(!('raw_score' in byId[finisher]), 'the push omits raw_score (gradebook contract)')

  // ⚠ PRISON-YEARS ARE NEVER GRADED (spec §6). The finisher served a real number of
  // years; none of it may appear in, or move, anything the gradebook receives.
  const finisherDoc = await getDoc(`pd_game_instances/${GID8}/participants/${finisher}`)
  const yearsServed = Number(finisherDoc?.student_years_total?.integerValue)
  check(yearsServed > 0, `the finisher's prison-years were recorded for the report (${yearsServed})`)
  check(byId[finisher].normalized_score === 0 && byId[finisher].knowledge_check_score === null,
    '…and the pushed record carries participation + KC only — no years, in any field')
  check(!JSON.stringify(byId[finisher]).includes(String(yearsServed)),
    '…and the years total appears nowhere in the pushed payload')

  // Re-running is byte-identical: nothing is ranked, so there is no tie to break.
  const rerun = await callFn('pdScoreAndRecord', {
    _dev: { game_instance_id: GID8, callback_url: CALLBACK_URL, callback_secret: CALLBACK_SECRET },
  })
  check(rerun.ok && rerun.result.finishers === 1, 'a re-run reproduces the same result exactly')

  // ── 13. pdGetReport — the instructor's single data source ───────────────────
  // The browser harness opens the tiles; this owns the CONTRACT: the roster fields,
  // the two chart datasets, and the fact that this callable — unlike every student
  // one — is ALLOWED to carry the strategy and the round count.
  console.log('\n[13] pdGetReport (instructor)')
  const rep = await callFn('pdGetReport', { _dev: { game_instance_id: GID8 } })
  check(rep.ok, `pdGetReport succeeds (${rep.error ?? 'ok'})`)
  const R = rep.result

  check(R.participants.length === 3, `one row per rostered student (${R.participants?.length})`)
  const finRow = R.participants.find(p => p.participant_id === finisher)
  const quitRow = R.participants.find(p => p.participant_id === quitter)
  const absRow = R.participants.find(p => p.participant_id === 'pd-absent')

  check(finRow.completed === true && finRow.rounds_played === scoreTruth.rounds,
    `the finisher: completed, ${finRow?.rounds_played} rounds`)
  check(quitRow.completed === false && quitRow.rounds_played === 2, 'the quitter: not completed, 2 rounds')
  check(absRow.launched === false && absRow.rounds_played === 0, 'the absentee: never launched, 0 rounds')

  // Tier-1 derived columns, checked against an independent recomputation.
  // The finisher played D on every 3rd round (see §12), C otherwise.
  const finMoves = Array.from({ length: scoreTruth.rounds }, (_, i) => ((i + 1) % 3 === 0 ? 'D' : 'C'))
  const wantCoop = finMoves.filter(m => m === 'C').length / finMoves.length
  check(Math.abs(finRow.cooperation_rate - wantCoop) < 1e-9,
    `cooperation rate is over rounds played (${finRow.cooperation_rate?.toFixed(3)} = ${wantCoop.toFixed(3)})`)
  check(Math.abs(finRow.avg_years - finRow.student_years_total / finRow.rounds_played) < 1e-9,
    'avg years = total years ÷ rounds played (per-round normalized)')
  check(finRow.first_move === 'C', 'first_move is the student’s opening move')
  check(quitRow.cooperation_rate !== null && absRow.cooperation_rate === null,
    'a student who never played has a NULL rate, not 0 — absence is not defection')

  // ⚠ The instructor-only fields. This is the ONE callable allowed to carry them.
  check(finRow.strategy === 'tft' || finRow.strategy === 'grim',
    `the roster carries the strategy faced (${finRow?.strategy}) — instructor-only, by design`)
  // ⚠ NOT a drawn horizon any more: horizons are per student, so the chart's x-axis
  // is the LONGEST GAME ACTUALLY PLAYED. Here that is the finisher's game (the
  // quitter stopped at 2), so it coincides with their count — but it is derived from
  // the games, not read from any truth doc.
  check(R.maxRoundsPlayed === scoreTruth.rounds,
    `carries the longest game played (${R.maxRoundsPlayed}) for the chart x-axis`)
  check(R.roundCount === undefined,
    '⚠ and the old instance-level roundCount field is GONE, not merely unused')
  check(finRow.participation_score === 0 && quitRow.participation_score === -2,
    'participation scores are reflected after Score & Record')
  check(typeof finRow.debrief === 'string' || finRow.debrief === null, 'the debrief paragraph is carried for Tier 2')

  // Tier 3a — one point per round, both series, denominators included.
  const coop = R.charts.cooperation
  check(coop.length === R.maxRoundsPlayed, `cooperation chart has one point per round played (${coop.length})`)
  // ⚠ THE SHAPE MOVED from four named fields to a SERIES LIST when the library went
  // from two ids to seven. `{tft, grim, tftN, grimN}` hardcoded a two-strategy game
  // into the wire format.
  const nAt = (p) => (p.series ?? []).reduce((a, x) => a + x.n, 0)
  check(coop.every(p => Array.isArray(p.series) && p.series.length === 2),
    'each point carries one entry per ASSIGNED strategy (two here)')
  check(coop.every(p => p.series.every(x => 'strategy' in x && 'rate' in x && 'n' in x)),
    'each series entry carries its strategy, its rate and its own n=')
  check(nAt(coop[0]) === 2, 'round 1 counts the two students who played it')
  const lastRoundPt = coop[coop.length - 1]
  check(nAt(lastRoundPt) === 1,
    'the final round counts only the finisher — the quitter thins the tail, not drags it down')

  // Tier 3b — always four cells, in a stable order.
  const fm = R.charts.firstMove
  check(fm.length === 4, 'first-move chart always has four cells')
  check(fm.map(o => `${o.firstMove}${o.strategy}`).join(',') === 'Ctft,Cgrim,Dtft,Dgrim',
    '…in a stable order, so bars never move between renders')
  check(fm.reduce((a, o) => a + o.n, 0) === 2, 'both players are counted exactly once across the cells')
  check(fm.every(o => o.n > 0 ? typeof o.avgYearsPerRound === 'number' : o.avgYearsPerRound === null),
    'a populated cell has a value; an empty one is null, not 0')

  // A student-side callable must STILL refuse to carry any of this.
  const studentState = await callFn('pdGetState', asStudent(GID8, finisher))
  const studentJson = JSON.stringify(studentState.result).toLowerCase()
  check(!studentJson.includes('tft') && !studentJson.includes('grim') && !studentJson.includes('strategy'),
    '⚠ the STUDENT callable still carries none of it — the report is a different audience, not a relaxed rule')
  check(studentState.result.roundCount === undefined
    && studentState.result.maxRoundsPlayed === undefined
    && studentState.result.charts === undefined,
    '⚠ …and no round count or chart data leaked into the student payload')

  // ── 14. Settings: pdGetConfig / pdUpdateConfig (Slice 5) ────────────────────
  console.log('\n[14] Instructor settings')
  const GIDS = `pd-settings-${stamp}`
  const SPID = 'pd-settings-stu'

  // A fresh instance defaults everything.
  const cfg0 = await callFn('pdGetConfig', asDev(GIDS))
  check(cfg0.ok, 'pdGetConfig succeeds on an untouched instance')
  check(cfg0.result.minRounds === 10 && cfg0.result.maxRounds === 20, 'defaults to the shipped [10,20] range')
  check(cfg0.result.unit === 'years', 'defaults to the shipped unit')
  check(cfg0.result.kcEnabled === true && cfg0.result.debriefEnabled === true, 'KC and debrief default ON')
  check(cfg0.result.anyRoundsDrawn === false, 'reports that NO student has drawn a round count yet')
  check(cfg0.result.derivedKcPreview.length === 4, 'previews the four derived KC questions')
  check(cfg0.result.rounds === undefined && !JSON.stringify(cfg0.result).includes('"rounds"'),
    '⚠ even the INSTRUCTOR settings page never receives the drawn count — only whether it exists')

  // ── Validation ────────────────────────────────────────────────────────────
  const badRange = await callFn('pdUpdateConfig', { ...asDev(GIDS), minRounds: 9, maxRounds: 4 })
  check(!badRange.ok, 'rejects min > max')
  const badMin = await callFn('pdUpdateConfig', { ...asDev(GIDS), minRounds: 0, maxRounds: 4 })
  check(!badMin.ok, 'rejects a minimum below 1')
  const badFloat = await callFn('pdUpdateConfig', { ...asDev(GIDS), minRounds: 2.5, maxRounds: 4 })
  check(!badFloat.ok, 'rejects a non-integer bound')
  const EIGHT = (yCC, yCD, yDC, yDD, oCC, oCD, oDC, oDD) => ({
    you_cc: yCC, you_cd: yCD, you_dc: yDC, you_dd: yDD,
    other_cc: oCC, other_cd: oCD, other_dc: oDC, other_dd: oDD,
  })
  // ⚠ A NEGATIVE PAYOFF IS LEGAL NOW. The `>= 0` floor came from the shipped
  // prison-years matrix and was never a rule of the game — the unit is the
  // instructor's word, so a payoff may be a cost. Only genuinely invalid input is
  // refused, and the four checks below are what "invalid" still means.
  const negOk = await callFn('pdUpdateConfig',
    { ...asDev(GIDS), payoffs: EIGHT(-1, 9, 0, 6, 1, 0, 9, 6) })
  check(negOk.ok, '⚠ ACCEPTS a negative payoff — no floor')
  check(negOk.result?.payoffs?.you_cc === -1, '…and stores it with the sign intact')
  for (const [label, bad] of [
    ['NaN', Number.NaN], ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY], ['an empty string', ''], ['text', 'twelve'],
  ]) {
    // ⚠ NaN and ±Infinity do not survive JSON, so they arrive as null / a string —
    // which is exactly what a hand-made call or a broken form would send, and is the
    // case the validator has to refuse either way.
    const r = await callFn('pdUpdateConfig',
      { ...asDev(GIDS), payoffs: { ...EIGHT(1, 9, 0, 6, 1, 0, 9, 6), you_cd: bad } })
    check(!r.ok, `still rejects ${label} as a payoff`)
  }
  // ⚠ ALL EIGHT ARE REQUIRED ON SAVE. The legacy four-key shape is accepted on READ
  // (migration) and refused on WRITE — a save carrying four would leave O stale.
  const shortPayoff = await callFn('pdUpdateConfig',
    { ...asDev(GIDS), payoffs: { both_cooperate: 1, sucker: 9, temptation: 0, both_defect: 6 } })
  check(!shortPayoff.ok, '⚠ rejects a LEGACY four-value payload on save — all eight or nothing')
  const missingO = await callFn('pdUpdateConfig',
    { ...asDev(GIDS), payoffs: { you_cc: 1, you_cd: 9, you_dc: 0, you_dd: 6 } })
  check(!missingO.ok, 'rejects a payload with the Y values but no O values')
  const badLabel = await callFn('pdUpdateConfig', { ...asDev(GIDS), labels: { C: '', D: 'Defect' } })
  check(!badLabel.ok, 'rejects an empty move label')
  const badUnit = await callFn('pdUpdateConfig', { ...asDev(GIDS), unit: '  ' })
  check(!badUnit.ok, 'rejects a blank unit')
  const reservedId = await callFn('pdUpdateConfig', {
    ...asDev(GIDS),
    addedKcQuestions: [{ id: 'kc_cc', type: 'mc', prompt: 'Sneaky', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }], correct_value: 'a' }],
  })
  check(!reservedId.ok, '⚠ rejects an added question claiming a reserved kc_ id')

  // ── A real edit, and its effect on the DERIVED four ───────────────────────
  const saved = await callFn('pdUpdateConfig', {
    ...asDev(GIDS),
    payoffs: EIGHT(2, 8, 1, 5, 2, 1, 8, 5),
    labels: { C: 'Share', D: 'Take' },
    unit: 'points',
    minRounds: 3,
    maxRounds: 4,
    debriefPrompt: 'What was your plan?',
  })
  check(saved.ok, 'a valid settings save succeeds')
  check(saved.result.unit === 'points' && saved.result.minRounds === 3 && saved.result.maxRounds === 4,
    'the save returns the stored values')
  // ⚠ THE NO-DRIFT PROPERTY: the derived four followed the new matrix, labels AND unit.
  const preview = saved.result.derivedKcPreview
  check(preview.map(q => q.correct_value).join() === '2,8,1,5',
    `the derived four re-derived their answers from the new matrix (${preview.map(q => q.correct_value).join('/')})`)
  check(preview[0].prompt.includes('Share') && preview[0].prompt.includes('points'),
    'the derived prompts picked up the new labels AND unit')
  check(preview[0].options.every(o => /point/.test(o.label)), 'the derived options are labelled in the new unit')

  // The student sees the same thing.
  await callFn('pdBootstrap', asStudent(GIDS, SPID))
  const sState = await callFn('pdGetState', asStudent(GIDS, SPID))
  check(sState.result.unit === 'points', 'the student is served the new unit')
  check(sState.result.minRounds === 3 && sState.result.maxRounds === 4, 'the student is served the new RANGE')
  check(sState.result.payoffs.you_cd === 8 && sState.result.payoffs.other_dc === 8,
    'the student is served the new matrix')
  check(sState.result.labels.C === 'Share', 'the student is served the new labels')
  const sQs = await callFn('pdGetQuestions', asStudent(GIDS, SPID))
  check(sQs.result.kc.derived[0].prompt.includes('Share'), 'the student\'s KC uses the new labels')
  check(!JSON.stringify(sQs.result).includes('correct_value'), '…and still ships no answer key')

  // ── ⚠ A RANGE EDIT MUST NOT REDRAW AN ALREADY-LAUNCHED STUDENT ────────────
  // Slice 5's no-redraw rule, now enforced at PARTICIPANT level: the student who has
  // already launched keeps their horizon, and the new range reaches only students who
  // have not.
  const drawnTruth = await getDoc(`pd_game_instances/${GIDS}/truth/participant_${SPID}`)
  const drawn = Number(drawnTruth?.rounds?.integerValue)
  check(drawn >= 3 && drawn <= 4, `the draw used the configured range (${drawn} ∈ [3,4])`)
  const cfgAfterDraw = await callFn('pdGetConfig', asDev(GIDS))
  check(cfgAfterDraw.result.anyRoundsDrawn === true, 'settings now reports that someone has started')

  // ═══════════════════════════════════════════════════════════════════════════
  // [14b] ⚠ THE ASYMMETRIC MATRIX — the thing four values could not express.
  //
  // Eight PAIRWISE-DISTINCT payoffs saved through the real callable, then real rounds
  // played against them. Under the old symmetric derive the bot's number would have been
  // Y of the TRANSPOSED cell; it must now be O of the SAME cell. On any symmetric or
  // migrated matrix those two agree, which is exactly why this instance is asymmetric —
  // it is the only shape where that bug has anywhere to show.
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n[14b] An ASYMMETRIC eight-value matrix, saved and played')
  const GIDAS = `pd-asym-${stamp}`
  const ASPID = 'pd-asym-stu'
  // Y(C,C)=11 Y(C,D)=12 Y(D,C)=13 Y(D,D)=14 / O(C,C)=21 O(C,D)=22 O(D,C)=23 O(D,D)=24
  const ASYM = EIGHT(11, 12, 13, 14, 21, 22, 23, 24)
  const asymSave = await callFn('pdUpdateConfig', {
    ...asDev(GIDAS), payoffs: ASYM, minRounds: 4, maxRounds: 4,
  })
  check(asymSave.ok, 'an asymmetric eight-value matrix saves')
  check(JSON.stringify(asymSave.result?.payoffs) === JSON.stringify(ASYM),
    'the save returns all eight values, unaltered and unsymmetrized')
  const asymDoc = await getDoc(`pd_game_instances/${GIDAS}/config/main`)
  const asymStored = asymDoc?.payoffs?.mapValue?.fields ?? {}
  check(Object.keys(asymStored).length === 8 && asymStored.other_cd?.integerValue === '22',
    'all eight landed in config/main')

  await callFn('pdBootstrap', asStudent(GIDAS, ASPID))
  await callFn('pdGetState', asStudent(GIDAS, ASPID))
  // Round 1: both strategies open with the FIRST move, so the cell is (student's move, C)
  // whichever bot this student drew. Play the SECOND move to land in (D,C) — the cell
  // whose O value a transposition would have replaced with O(C,D).
  const asymR1 = await callFn('pdSubmitRound', asStudent(GIDAS, ASPID, { round: 1, move: 'D' }))
  check(asymR1.ok && asymR1.result?.round?.botMove === 'C',
    'round 1: the bot opened with the first move')
  check(asymR1.result?.round?.studentYears === 13,
    `round 1: the student got Y(D,C)=13 (got ${asymR1.result?.round?.studentYears})`)
  check(asymR1.result?.round?.botYears === 23,
    `⚠ round 1: the bot got O(D,C)=23, NOT O(C,D)=22 and NOT Y(C,D)=12 (got ${asymR1.result?.round?.botYears})`)
  // Round 2 lands in (C,C) against TFT-after-D? No — TFT mirrors the D, GRIM has flipped.
  // Either way the bot plays D, so the cell is (C,D). Assert the pair comes from ONE cell.
  const asymR2 = await callFn('pdSubmitRound', asStudent(GIDAS, ASPID, { round: 2, move: 'C' }))
  const ASYM_CELL = { CC: [11, 21], CD: [12, 22], DC: [13, 23], DD: [14, 24] }
  const want2 = ASYM_CELL[`C${asymR2.result?.round?.botMove}`] ?? []
  check(asymR2.ok && asymR2.result?.round?.studentYears === want2[0]
    && asymR2.result?.round?.botYears === want2[1],
    `round 2: both numbers came from the SAME cell C${asymR2.result?.round?.botMove} `
    + `(want ${want2.join('/')}, got ${asymR2.result?.round?.studentYears}/${asymR2.result?.round?.botYears})`)

  // ── ⚠ THE NOT-A-DILEMMA WARNING NEVER BLOCKS SAVE ─────────────────────────
  // ASYM above is a dilemma under NEITHER reading — the settings page shows its advisory
  // notice for exactly that matrix — and the save succeeded. Stated again with a flat
  // matrix so the rule is pinned rather than incidental.
  const flatSave = await callFn('pdUpdateConfig',
    { ...asDev(GIDAS), payoffs: EIGHT(5, 5, 5, 5, 5, 5, 5, 5) })
  // (asymmetric + flat both saved; the BoS instance below is the third such matrix)
  check(flatSave.ok,
    '⚠ a matrix that is a dilemma under NEITHER reading SAVES — the warning informs, never blocks')
  check(flatSave.result?.payoffs?.you_cc === 5 && flatSave.result?.payoffs?.other_dd === 5,
    '…and it is stored verbatim, not corrected')

  // ═══════════════════════════════════════════════════════════════════════════
  // [14c] ⚠ BATTLE OF THE SEXES — the worked non-dilemma, end to end.
  //
  // Y = 2,0,0,1 / O = 1,0,0,2, moves renamed to two words that appear NOWHERE ELSE in
  // this repo. It exercises three paths pd's own 1/15/0/10 default cannot reach: an
  // asymmetric matrix, a THREE-value option ladder, and TWO questions sharing the
  // correct answer 0. Settings save → KC serve → KC grade (all four) → a played round
  // → history → reports.
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n[14c] Battle of the Sexes — settings, KC, play, reports')
  const GIDB = `pd-bos-${stamp}`
  const BPID = 'pd-bos-stu'
  const OPERA = 'Zarquon'
  const BOXING = 'Blorptide'
  const BOS = EIGHT(2, 0, 0, 1, 1, 0, 0, 2)

  const bosSave = await callFn('pdUpdateConfig', {
    ...asDev(GIDB), payoffs: BOS, labels: { C: OPERA, D: BOXING }, unit: 'points',
    minRounds: 4, maxRounds: 4,
  })
  check(bosSave.ok, 'a Battle of the Sexes matrix saves')
  check(JSON.stringify(bosSave.result?.payoffs) === JSON.stringify(BOS),
    'all eight values stored verbatim')
  // ⚠ The advisory fires for this matrix — it is a dilemma under NEITHER reading — and
  // the save above still succeeded. Informs, never blocks.
  check(bosSave.result?.derivedKcPreview?.length === 4, 'the four derived questions survive')
  const bosLadder = bosSave.result?.derivedKcPreview?.[0]?.options ?? []
  check(bosLadder.length === 3,
    `⚠ THE LADDER IS THREE OPTIONS, not four (got ${bosLadder.length})`)
  check(bosLadder.map(o => o.value).join(',') === '0,1,2',
    `…and they are the distinct Y values ascending (${bosLadder.map(o => o.value).join(',')})`)
  const bosKeys = (bosSave.result?.derivedKcPreview ?? []).map(q => q.correct_value)
  check(bosKeys.join(',') === '2,0,0,1',
    `⚠ TWO QUESTIONS SHARE the answer 0 (${bosKeys.join(',')})`)

  await callFn('pdBootstrap', asStudent(GIDB, BPID))
  const bosState = await callFn('pdGetState', asStudent(GIDB, BPID))
  check(bosState.result?.labels?.C === OPERA && bosState.result?.labels?.D === BOXING,
    'the student is served the renamed moves')

  const bosQs = await callFn('pdGetQuestions', asStudent(GIDB, BPID))
  const bosSurface = JSON.stringify(bosQs.result?.kc?.derived ?? [])
  check(bosSurface.includes(OPERA) && bosSurface.includes(BOXING),
    '⚠ the KC surface carries the INSTANCE wording')
  check(!bosSurface.includes('Cooperate') && !bosSurface.includes('Defect'),
    '⚠⚠ …and NEITHER shipped default word appears anywhere on it')
  const served = bosQs.result?.kc?.derived ?? []
  check(served.length === 4 && served.every(q => (q.options ?? []).length === 3),
    'every served question offers exactly three options')

  // Grade all four, INCLUDING both zero-answer questions.
  const bosAnswers = { kc_cc: '2', kc_cd: '0', kc_dc: '0', kc_dd: '1' }
  let bosGraded = 0
  for (const [field, answer] of Object.entries(bosAnswers)) {
    const r = await callFn('pdSubmitKcAnswer', asStudent(GIDB, BPID, { field, answer }))
    if (r.ok && r.result.correct) bosGraded++
    if (field === 'kc_dc') {
      check(!String(r.result?.explanation ?? '').includes('Cooperate'),
        '⚠ the earned explanation uses the instance wording, not the default')
      check(String(r.result?.explanation ?? '').includes(BOXING),
        `…and names the configured move (${r.result?.explanation})`)
    }
  }
  check(bosGraded === 4,
    `⚠ ALL FOUR graded correct, both zero-answer questions included (${bosGraded}/4)`)
  const bosP = await getDoc(`pd_game_instances/${GIDB}/participants/${BPID}`)
  check(Number(bosP?.knowledge_check_score?.doubleValue ?? bosP?.knowledge_check_score?.integerValue) === 1,
    'the KC score is 1.0 over a denominator of four')

  // A played round on the BoS matrix.
  const bosR1 = await callFn('pdSubmitRound', asStudent(GIDB, BPID, { round: 1, move: 'C' }))
  check(bosR1.ok && bosR1.result.round.botMove === 'C', 'round 1: the bot opened with the first move')
  check(bosR1.result?.round?.studentYears === 2 && bosR1.result?.round?.botYears === 1,
    `round 1 (C,C): Y=2 to the student, O=1 to the bot (got ${bosR1.result?.round?.studentYears}/${bosR1.result?.round?.botYears})`)
  check(bosR1.result?.history?.[0]?.studentTotal === 2 && bosR1.result?.history?.[0]?.botTotal === 1,
    'the history row carries the asymmetric pair')

  const bosReport = await callFn('pdGetReport', asDev(GIDB))
  check(bosReport.ok && bosReport.result.unit === 'points', 'the report is served in the instance unit')
  check(bosReport.result?.labels?.C === OPERA, 'the report carries the renamed moves')
  check(JSON.stringify(bosReport.result.payoffs) === JSON.stringify(BOS),
    'the report carries all eight values')
  check(bosReport.result?.strategyText?.always_second?.label === `Always ${BOXING}`,
    `⚠ the report's strategy labels interpolate the wording (${bosReport.result?.strategyText?.always_second?.label})`)
  const bosStratJson = JSON.stringify(bosReport.result?.strategyText ?? {})
  check(bosStratJson.includes(OPERA) && bosStratJson.includes(BOXING),
    '…the fixture words really are in them (guards the absence check below)')
  check(!bosStratJson.includes('Defect') && !bosStratJson.includes('Cooperate'),
    '⚠⚠ …and NEITHER shipped default word appears anywhere in them')

  // ═══════════════════════════════════════════════════════════════════════════
  // [14d] ⚠ THE OPPONENT POOL — seven strategies, instructor-selectable (spec §5).
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n[14d] Available strategies — the pool, the draw, and the never-redraw rule')
  const psGid = `pd-pool-${stamp}`

  const psCfg0 = await callFn('pdGetConfig', asDev(psGid))
  check(psCfg0.ok, 'pdGetConfig succeeds on an untouched instance')
  check(JSON.stringify(psCfg0.result?.strategies) === JSON.stringify(['tft', 'grim']),
    `⚠⚠ AN UNCONFIGURED INSTANCE MIGRATES TO EXACTLY tft + grim (${JSON.stringify(psCfg0.result?.strategies)})`)
  const psDoc0 = await getDoc(`pd_game_instances/${psGid}/config/main`)
  check(psDoc0?.strategies === undefined,
    '⚠ NO BACKFILL — reading an unconfigured instance writes no `strategies` field')
  check((psCfg0.result?.strategyOptions ?? []).length === 6,
    `the settings payload offers all six ids (${(psCfg0.result?.strategyOptions ?? []).length})`)
  check(!(psCfg0.result?.strategyOptions ?? []).some(o => o.id === 'match_stay'),
    '⚠ …and the retired id is not among them')

  // ── ⚠ ZERO CHECKED IS A HARD BLOCK (and NOT the dilemma advisory's shape) ──
  const psEmpty = await callFn('pdUpdateConfig', { ...asDev(psGid), strategies: [] })
  check(!psEmpty.ok, '⚠⚠ ZERO CHECKED IS REFUSED — an instance with no strategies cannot run')
  check(/at least one/i.test(String(psEmpty.error ?? '')), `…and the message says so (${psEmpty.error})`)
  const psBadId = await callFn('pdUpdateConfig', { ...asDev(psGid), strategies: ['tft', 'pavlov'] })
  check(!psBadId.ok, 'an unknown strategy id is refused')
  // ── P(first move) for Random — [0,1], default 0.5 ─────────────────────────
  check(psCfg0.result?.randomFirstMoveProbability === 0.5,
    `⚠ an unconfigured instance reads p = 0.5 (${psCfg0.result?.randomFirstMoveProbability})`)
  check(psDoc0?.random_first_move_probability === undefined,
    '⚠ NO BACKFILL — reading it writes no probability field')
  for (const bad of [-0.01, 1.01, 2, 'half', null]) {
    const r = await callFn('pdUpdateConfig', { ...asDev(psGid), randomFirstMoveProbability: bad })
    check(!r.ok, `rejects p = ${JSON.stringify(bad)}`)
  }
  const pOk = await callFn('pdUpdateConfig', { ...asDev(psGid), randomFirstMoveProbability: 0.25 })
  check(pOk.ok && pOk.result.randomFirstMoveProbability === 0.25,
    `p = 0.25 saves and reads back (${pOk.result?.randomFirstMoveProbability})`)
  for (const edge of [0, 1]) {
    const r = await callFn('pdUpdateConfig', { ...asDev(psGid), randomFirstMoveProbability: edge })
    check(r.ok && r.result.randomFirstMoveProbability === edge, `p = ${edge} is legal`)
  }
  await callFn('pdUpdateConfig', { ...asDev(psGid), randomFirstMoveProbability: 0.5 })

  const psOne = await callFn('pdUpdateConfig', { ...asDev(psGid), strategies: ['alternate'] })
  check(psOne.ok, 'ONE checked is legal')
  check(JSON.stringify(psOne.result?.strategies) === JSON.stringify(['alternate']),
    'and it is exactly what gets stored')

  // ── THE DRAW COMES FROM THE POOL, AND ONLY FROM THE POOL ──────────────────
  // ⚠ THE SEED IS WRITTEN FIRST. `putDoc` is a whole-document PATCH, so writing it
  // AFTER the callable would wipe the `strategies` field the callable just stored —
  // which it did, on the first draft of this section.
  const psPool = ['random', 'always_second', 'alternate']
  await putDoc(`pd_game_instances/${psGid}/config/main`, { seed: { stringValue: 'pool-seed' } })
  await callFn('pdUpdateConfig', {
    ...asDev(psGid), strategies: psPool, minRounds: 3, maxRounds: 3,
  })
  const psAfterSave = await getDoc(`pd_game_instances/${psGid}/config/main`)
  check(psAfterSave?.seed?.stringValue === 'pool-seed'
    && (psAfterSave?.strategies?.arrayValue?.values ?? []).length === 3,
    'the instance carries both the seed and the three-strategy pool')

  const psDrawn = []
  for (let i = 1; i <= 24; i++) {
    const pid = `pool-stu-${i}`
    await callFn('pdBootstrap', asStudent(psGid, pid))
    await callFn('pdGetState', asStudent(psGid, pid))
    const t = await getDoc(`pd_game_instances/${psGid}/truth/participant_${pid}`)
    psDrawn.push(t?.strategy?.stringValue)
  }
  // ⚠ THE COUNT IS ASSERTED FIRST, so an empty loop cannot pass "never outside".
  check(psDrawn.length === 24 && psDrawn.every(x => typeof x === 'string'),
    `24 students were assigned a strategy (${psDrawn.length})`)
  check(psDrawn.every(x => psPool.includes(x)),
    `⚠⚠ NO STUDENT DREW AN UNCHECKED STRATEGY (${[...new Set(psDrawn)].sort().join(',')})`)
  check(new Set(psDrawn).size === psPool.length,
    `…and every checked strategy was drawn by someone (${new Set(psDrawn).size}/${psPool.length})`)

  // ── ⚠ RE-ENTRY DOES NOT REDRAW ────────────────────────────────────────────
  const psPid = 'pool-stu-1'
  const psBefore = (await getDoc(`pd_game_instances/${psGid}/truth/participant_${psPid}`))?.strategy?.stringValue
  for (let i = 0; i < 5; i++) await callFn('pdGetState', asStudent(psGid, psPid))
  const psAfter = (await getDoc(`pd_game_instances/${psGid}/truth/participant_${psPid}`))?.strategy?.stringValue
  check(psBefore === psAfter, `⚠ five more launches did NOT redraw the strategy (${psBefore})`)

  // ── ⚠⚠ A RETIRED STORED ASSIGNMENT PLAYS AS TIT-FOR-TAT ───────────────────
  //
  // `match_stay` was removed because it was provably tit-for-tat. No live document
  // held it (checked in singleplayer-mygames-live before the removal), but a truth doc
  // COULD have, so a stored assignment maps to `tft` at read time — exact, not
  // approximate. Written straight into truth/ here, because no code path can produce
  // it any more, and then played through the real callables.
  const psrGid = `pd-retired-${stamp}`
  const psrPid = 'retired-stu'
  await callFn('pdUpdateConfig', { ...asDev(psrGid), strategies: ['alternate'], minRounds: 6, maxRounds: 6 })
  await callFn('pdBootstrap', asStudent(psrGid, psrPid))
  await putDoc(`pd_game_instances/${psrGid}/truth/participant_${psrPid}`, {
    participant_id: { stringValue: psrPid },
    strategy: { stringValue: 'match_stay' },
    rounds: intVal(6),
  })
  const psrCheck = await getDoc(`pd_game_instances/${psrGid}/truth/participant_${psrPid}`)
  check(psrCheck?.strategy?.stringValue === 'match_stay',
    'the truth doc really holds the retired id (the premise of this check)')

  const psrStu = ['C', 'D', 'D', 'C', 'D', 'C']
  const psrBot = []
  for (let n = 1; n <= 6; n++) {
    const r = await callFn('pdSubmitRound', asStudent(psrGid, psrPid, { round: n, move: psrStu[n - 1] }))
    if (!r.ok) { check(false, `round ${n} played on a retired assignment (${r.error})`); break }
    psrBot.push(r.result.round.botMove)
  }
  check(psrBot.length === 6, `⚠⚠ A RETIRED STORED ASSIGNMENT PLAYS TO COMPLETION (${psrBot.length}/6)`)
  // ⚠ EXPECTED FROM THE DEFINITION of tit-for-tat, computed here — not by asking the
  // server for a tft game and comparing.
  const psrWant = psrStu.map((_, i) => (i === 0 ? 'C' : psrStu[i - 1]))
  check(psrWant.join('') === 'CCDDCD', `the tft oracle is what it should be (${psrWant.join('')})`)
  check(psrBot.join('') === psrWant.join(''),
    `⚠⚠ …AS TIT-FOR-TAT, exactly (want ${psrWant.join('')}, got ${psrBot.join('')})`)
  check((await getDoc(`pd_game_instances/${psrGid}/truth/participant_${psrPid}`))?.strategy?.stringValue === 'match_stay',
    '⚠ the stored id is NOT rewritten — the mapping is read-time only, no migration')
  const psrReport = await callFn('pdGetReport', asDev(psrGid))
  const psrRow = (psrReport.result?.participants ?? []).find(x => x.participant_id === psrPid)
  check(psrRow?.strategy === 'tft',
    `⚠ the roster reports it as what it is PLAYED as (${psrRow?.strategy})`)

  // ── ⚠⚠ RE-ENTRY DOES NOT REDRAW — ON AN **UNSEEDED** INSTANCE ─────────────
  //
  // ⚠ THE SEEDED CHECK ABOVE CANNOT DETECT A REDRAW, and that is why this one exists.
  // With a seed the draw is a pure function of (seed, participant), so an implementation
  // that redrew on every launch would return the SAME id every time and the before/after
  // comparison would pass. Only an UNSEEDED instance can tell the two apart: there a
  // redraw is a fresh uniform pick, so over 8 launches against a 3-strategy pool a
  // redrawing build survives with probability (1/3)^8 ≈ 1 in 6600.
  const psuGid = `pd-pool-unseeded-${stamp}`
  await callFn('pdUpdateConfig', { ...asDev(psuGid), strategies: psPool, minRounds: 3, maxRounds: 3 })
  const psuDoc = await getDoc(`pd_game_instances/${psuGid}/config/main`)
  check(psuDoc?.seed === undefined, 'the instance really is unseeded (the premise of this check)')
  const psuPid = 'pool-unseeded-stu'
  await callFn('pdBootstrap', asStudent(psuGid, psuPid))
  await callFn('pdGetState', asStudent(psuGid, psuPid))
  const psuFirst = (await getDoc(`pd_game_instances/${psuGid}/truth/participant_${psuPid}`))?.strategy?.stringValue
  check(psPool.includes(psuFirst), `the unseeded student drew from the pool (${psuFirst})`)
  const psuSeen = new Set([psuFirst])
  for (let i = 0; i < 8; i++) {
    await callFn('pdGetState', asStudent(psuGid, psuPid))
    psuSeen.add((await getDoc(`pd_game_instances/${psuGid}/truth/participant_${psuPid}`))?.strategy?.stringValue)
  }
  check(psuSeen.size === 1,
    `⚠⚠ EIGHT UNSEEDED RE-LAUNCHES NEVER REDREW (saw ${[...psuSeen].join(',')})`)

  // ── ⚠⚠ UNCHECKING MID-GAME DOES NOT DISTURB AN ASSIGNED STUDENT ───────────
  const psHeld = psAfter
  const psNarrow = await callFn('pdUpdateConfig',
    { ...asDev(psGid), strategies: psPool.filter(x => x !== psHeld) })
  check(psNarrow.ok, `the pool narrows to exclude '${psHeld}'`)
  check(!psNarrow.result.strategies.includes(psHeld), `…and '${psHeld}' really is unchecked now`)
  const psStill = (await getDoc(`pd_game_instances/${psGid}/truth/participant_${psPid}`))?.strategy?.stringValue
  check(psStill === psHeld,
    `⚠⚠ THE ASSIGNED STUDENT KEEPS '${psHeld}' — a pool edit never reassigns (got ${psStill})`)

  // …and plays it to completion, against the rule they HOLD rather than anything in
  // the current pool. Predicted independently of the server.
  const psPredict = (strategy, stu) => {
    const bot = []
    for (let i = 0; i < stu.length; i++) {
      if (strategy === 'always_second') { bot.push('D'); continue }
      if (strategy === 'alternate') { bot.push(i % 2 === 0 ? 'C' : 'D'); continue }
      bot.push(null)   // random — unpredictable by construction
    }
    return bot
  }
  const psStu = ['C', 'D', 'C']
  const psBot = []
  for (let n = 1; n <= 3; n++) {
    const r = await callFn('pdSubmitRound', asStudent(psGid, psPid, { round: n, move: psStu[n - 1] }))
    if (!r.ok) { check(false, `round ${n} played against an unchecked-but-held strategy (${r.error})`); break }
    psBot.push(r.result.round.botMove)
  }
  check(psBot.length === 3,
    `⚠⚠ A STORED-BUT-UNCHECKED STRATEGY PLAYS TO COMPLETION (${psBot.length}/3 rounds)`)
  const psWant = psPredict(psHeld, psStu)
  check(psWant.every((m, i) => m === null || m === psBot[i]),
    `…and every bot move matched '${psHeld}' exactly (want ${psWant.join('')}, got ${psBot.join('')})`)
  check((await getDoc(`pd_game_instances/${psGid}/truth/participant_${psPid}`))?.strategy?.stringValue === psHeld,
    '…and the stored strategy is STILL untouched after playing')

  // ── THE REPORTS ───────────────────────────────────────────────────────────
  const psReport = await callFn('pdGetReport', asDev(psGid))
  check(psReport.ok, 'pdGetReport succeeds on the pooled instance')
  check(Object.keys(psReport.result?.strategyText ?? {}).length === 6,
    "the report carries all six strategies' labels and reveal lines")
  check(String(psReport.result?.strategyText?.alternate?.reveal ?? '').includes('never reacted to your choices'),
    'the alternating reveal line is served')
  const psCoop = psReport.result?.charts?.cooperation ?? []
  check(psCoop.length > 0 && Array.isArray(psCoop[0]?.series),
    'Tier 3a points carry a SERIES LIST, not two named fields')
  const psSeries = (psCoop[0]?.series ?? []).map(x => x.strategy)
  check(psSeries.length > 0 && psSeries.every(id => psDrawn.includes(id)),
    `⚠ every plotted series is a strategy actually ASSIGNED (${psSeries.join(',')})`)
  check(!psSeries.includes('tft') && !psSeries.includes('grim'),
    '⚠⚠ …and a strategy NOBODY was assigned gets NO series')
  check((psCoop[0]?.series ?? []).every(x => typeof x.n === 'number'),
    'every series carries its own n= for the legend')
  const psFm = psReport.result?.charts?.firstMove ?? []
  check(psFm.length > 0 && psFm.every(o => psDrawn.includes(o.strategy)),
    'Tier 3b cells cover the assigned strategies only')

  // ═══════════════════════════════════════════════════════════════════════════
  // [14e] ⚠ P(first move) REACHES REAL PLAY, and the reveal line tells the truth.
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n[14e] Random’s probability — save → store → serve → play')
  const prGid = `pd-randp-${stamp}`
  const prPid = 'randp-stu'
  const prSave = await callFn('pdUpdateConfig', {
    ...asDev(prGid), strategies: ['random'], minRounds: 40, maxRounds: 40,
    randomFirstMoveProbability: 0,
  })
  check(prSave.ok, 'an instance pinned to Random at p = 0 saves')
  const prDoc = await getDoc(`pd_game_instances/${prGid}/config/main`)
  check(prDoc?.random_first_move_probability?.doubleValue === 0
    || Number(prDoc?.random_first_move_probability?.integerValue) === 0,
    'p landed in config/main')

  await callFn('pdBootstrap', asStudent(prGid, prPid))
  await callFn('pdGetState', asStudent(prGid, prPid))
  const prBot = []
  for (let n = 1; n <= 40; n++) {
    const r = await callFn('pdSubmitRound', asStudent(prGid, prPid, { round: n, move: 'C' }))
    if (!r.ok) { check(false, `round ${n} played (${r.error})`); break }
    prBot.push(r.result.round.botMove)
  }
  // ⚠ p = 0 MAKES THE OUTCOME CHECKABLE. At 0.5 a 40-round sequence proves nothing;
  // at 0 every draw must be the second move, so a build ignoring p fails outright.
  check(prBot.length === 40, `40 rounds played (${prBot.length})`)
  check(prBot.every(m => m === 'D'),
    `⚠⚠ p = 0 PRODUCED THE SECOND MOVE EVERY ROUND — p reached the compute step (${[...new Set(prBot)].join(',')})`)
  const prStored = await getDoc(`pd_game_instances/${prGid}/participants/${prPid}`)
  const prRounds = prStored?.rounds?.arrayValue?.values ?? []
  check(prRounds.length === 40
    && prRounds.every(v => v.mapValue.fields.bot_move.stringValue === 'D'),
    '⚠ …and every drawn move was WRITTEN to the round record, not recomputed')

  const prReport = await callFn('pdGetReport', asDev(prGid))
  const prReveal = String(prReport.result?.strategyText?.random?.reveal ?? '')
  check(!prReveal.includes('equal probability'),
    '⚠⚠ the reveal line does NOT claim equal probability at p = 0')
  check(prReveal.includes('every time'), `…it states what actually happened (${prReveal.slice(0, 60)}…)`)

  // ── ⚠ THE EQUILIBRIUM HINT IS INSTRUCTOR-ONLY ─────────────────────────────
  // It is computed CLIENT-SIDE on the settings page and has no server surface at
  // all — so the strongest assertion available is that no callable, student or
  // instructor, carries it, and that no student-facing module imports it.
  const prState = await callFn('pdGetState', asStudent(prGid, prPid))
  const prQs = await callFn('pdGetQuestions', asStudent(prGid, prPid))
  for (const [label, payload] of [['pdGetState', prState], ['pdGetQuestions', prQs]]) {
    const j = JSON.stringify(payload.result ?? {}).toLowerCase()
    check(!j.includes('indifferen') && !j.includes('equilibri') && !j.includes('mixed'),
      `⚠ ${label} carries no equilibrium hint`)
  }
  const prCfgJson = JSON.stringify(prSave.result ?? {}).toLowerCase()
  check(!prCfgJson.includes('indifferen') && !prCfgJson.includes('equilibri'),
    '⚠ …and neither does the INSTRUCTOR config payload — the hint is client-side only')

  await callFn('pdUpdateConfig', { ...asDev(GIDS), minRounds: 15, maxRounds: 20 })
  await callFn('pdGetState', asStudent(GIDS, SPID))   // a touch that could have redrawn
  const truthAfterRangeChange = await getDoc(`pd_game_instances/${GIDS}/truth/participant_${SPID}`)
  check(Number(truthAfterRangeChange?.rounds?.integerValue) === drawn,
    `⚠ widening the range did NOT redraw the launched student (still ${drawn}) — they keep their horizon`)

  // …and a student who had NOT launched draws inside the NEW range.
  const LATE = 'pd-settings-latecomer'
  await callFn('pdBootstrap', asStudent(GIDS, LATE))
  await callFn('pdGetState', asStudent(GIDS, LATE))
  const lateTruth = await getDoc(`pd_game_instances/${GIDS}/truth/participant_${LATE}`)
  const lateDrawn = Number(lateTruth?.rounds?.integerValue)
  check(lateDrawn >= 15 && lateDrawn <= 20,
    `a student who launches AFTER the edit draws in the new range (${lateDrawn} ∈ [15,20])`)

  // ── Added KC questions: separate source, separate grading ─────────────────
  const GIDA = `pd-added-${stamp}`
  const APID = 'pd-added-stu'
  const addedMc = { id: 'akc_one', type: 'mc', prompt: 'Which move did you use most?',
    options: [{ value: 'a', label: 'Cooperate' }, { value: 'b', label: 'Defect' }], correct_value: 'b' }
  const addedText = { id: 'akc_two', type: 'text', prompt: 'Why?' }
  const addSave = await callFn('pdUpdateConfig', { ...asDev(GIDA), addedKcQuestions: [addedMc, addedText] })
  check(addSave.ok && addSave.result.addedKcQuestions.length === 2, 'two added questions saved')

  await callFn('pdBootstrap', asStudent(GIDA, APID))
  const aQs = await callFn('pdGetQuestions', asStudent(GIDA, APID))
  check(aQs.result.kc.derived.length === 4 && aQs.result.kc.added.length === 2,
    '⚠ the two sources arrive SEPARATELY (4 derived + 2 added), never flattened')
  check(aQs.result.kc.added[0].field === 'akc_one' && aQs.result.kc.added[0].type === 'mc',
    'the added question carries its own id and type')
  check(!JSON.stringify(aQs.result.kc.added).includes('correct_value'),
    'the added question\'s key is NOT served either')

  // The added mc grades on ITS OWN key, not the matrix.
  const aWrong = await callFn('pdSubmitKcAnswer', asStudent(GIDA, APID, { field: 'akc_one', answer: 'a' }))
  check(aWrong.ok && aWrong.result.correct === false && aWrong.result.graded === true,
    'an added mc question grades against its stored key')
  const aRight = await callFn('pdSubmitKcAnswer', asStudent(GIDA, APID, { field: 'akc_one', answer: 'b' }))
  check(aRight.ok && aRight.result.correct === false,
    '…and is locked on first answer, like every other question')
  const aText = await callFn('pdSubmitKcAnswer', asStudent(GIDA, APID, { field: 'akc_two', answer: 'Because.' }))
  check(aText.ok && aText.result.graded === false,
    'an added FREE-TEXT question is recorded but UNGRADED — never marked wrong')

  // Denominator: 4 derived + 1 graded added = 5. The free-text one is in neither.
  const derivedKey = { kc_cc: '1', kc_cd: '15', kc_dc: '0', kc_dd: '10' }
  for (const [f, v] of Object.entries(derivedKey)) {
    await callFn('pdSubmitKcAnswer', asStudent(GIDA, APID, { field: f, answer: v }))
  }
  const aDoc = await getDoc(`pd_game_instances/${GIDA}/participants/${APID}`)
  const aScore = Number(aDoc?.knowledge_check_score?.doubleValue ?? aDoc?.knowledge_check_score?.integerValue)
  check(Math.abs(aScore - 0.8) < 1e-9,
    `4 derived right + 1 added wrong = 0.8 — the graded added question IS in the denominator, the free-text one is NOT (got ${aScore})`)

  // ── The toggles actually remove the screens ───────────────────────────────
  const GIDT = `pd-toggles-${stamp}`
  const TPID = 'pd-toggle-stu'
  await callFn('pdUpdateConfig', { ...asDev(GIDT), kcEnabled: false, debriefEnabled: false })
  await callFn('pdBootstrap', asStudent(GIDT, TPID))
  const tQs = await callFn('pdGetQuestions', asStudent(GIDT, TPID))
  check(tQs.result.kcEnabled === false && tQs.result.kc.derived.length === 0 && tQs.result.kc.added.length === 0,
    'KC off ⇒ no questions served at all')
  check(tQs.result.debriefEnabled === false && tQs.result.debrief === null, 'debrief off ⇒ no debrief served')
  const tKc = await callFn('pdSubmitKcAnswer', asStudent(GIDT, TPID, { field: 'kc_cc', answer: '1' }))
  check(!tKc.ok, 'and the KC callable REFUSES an answer when the KC is off')
  const tDb = await callFn('pdSubmitDebrief', asStudent(GIDT, TPID, { answer: 'x' }))
  check(!tDb.ok, 'and the debrief callable refuses when the debrief is off')
  // The game itself still plays.
  const tRound = await callFn('pdSubmitRound', asStudent(GIDT, TPID, { round: 1, move: 'C' }))
  check(tRound.ok, 'the round loop still plays with both extras switched off')

  // ── 15. The pd play screen ships in the bundle ──────────────────────────────
  // One Vite bundle serves every game and picks by hostname, so "the pd route is
  // built and shipped" is what can be asserted here. This is a BUILD-ARTIFACT check,
  // not a DOM render — the repo has no jsdom/testing-library, so the components'
  // markup is covered by the static-render tests in frontend/src/pd/ instead.
  // `npm run build` in frontend/ must have run first.
  console.log('\n[15] pd play screen present in the shipped bundle')
  const distDir = path.join(ROOT, 'frontend', 'dist', 'assets')
  if (!fs.existsSync(distDir)) {
    check(false, `frontend/dist/assets missing — run \`npm run build\` in frontend/ first`)
  } else {
    const js = fs.readdirSync(distDir).filter(f => f.endsWith('.js'))
      .map(f => fs.readFileSync(path.join(distDir, f), 'utf8')).join('')
    check(js.includes('Repeated Prisoner'), 'bundle contains the pd student shell')
    check(js.includes('pdBootstrap'), 'bundle wires pdBootstrap')
    check(js.includes('pdInstructorSession'), 'bundle wires pdInstructorSession')
    check(js.includes('pdGetState') && js.includes('pdSubmitRound'), 'bundle wires the two round callables')
    check(js.includes('Jar of Pennies') && js.includes('pollBootstrap'),
      'pennies + poll are still in the same bundle (shared artifact intact)')

    // The framing copy the spec allows — and nothing sharper than it.
    check(js.includes('the same automated player every round'), 'framing: the same automated player every round')
    check(js.includes('programmed to act realistically'), 'framing: programmed to act realistically')
    // The range is now templated from config, so the literal "between 10 and 20" is
    // gone; what must still be true is that the framing states a RANGE and nothing
    // sharper. The bounds themselves come from config at runtime.
    check(js.includes('between ') && js.includes(' rounds'),
      'framing: states a round RANGE (now templated from config, not hardcoded)')
    check(js.includes('you will not be told when'), 'framing: still refuses to say when the last round is')

    // ⚠ INVERTED IN SLICE 5. These used to assert the matrix said "Years in prison";
    // the directional framing was DELETED because the unit is now configurable and
    // the software cannot know whether a bigger number is better. The checks now
    // guard the removal, so the copy cannot creep back.
    //
    // ⚠⚠ THE "lower is better" CHECK USED TO LIVE HERE AND WAS REMOVED — DO NOT RESTORE IT.
    // `js` is the WHOLE single-player bundle: one artifact serves all eight games. Forecast
    // legitimately tells students "This is your objective — lower is better" about forecast
    // error, where lower genuinely IS better (afa00a8, 08-02). A bundle-wide grep cannot
    // tell PD's copy from Forecast's, so from that commit onward this check failed for a
    // reason that had nothing to do with PD, and a permanently-red suite is worse than no
    // suite — the next REAL pd failure hides in the noise.
    //
    // THE PROPERTY IS STILL COVERED, and better: three frontend tests assert it against
    // RENDERED PD COMPONENTS rather than a string search over shared bytes —
    // src/pd/render.test.tsx (PayoffMatrix, HistoryTable) and src/pd/charts.test.tsx.
    // Those cannot be fooled by another game's copy, and they fail on the component that
    // actually regressed. The two greps below survive because those phrases are PD-specific:
    // no other game in the bundle has any reason to say them.
    check(!/years in prison/i.test(js), 'no "years in prison" copy ships in the bundle')
    check(!/these are losses/i.test(js), 'no "these are losses" copy ships in the bundle')

    // ⚠ THE CLIENT-SIDE HALF OF THE NO-LEAK CONSTRAINT — restated for Slice 4.
    //
    // Through Slice 3 this asserted that the strings "tit-for-tat"/"GRIM"/"tft"
    // appeared NOWHERE in the bundle. That check is no longer meaningful and has been
    // replaced rather than deleted: Slice 4 added the instructor dashboard and reports,
    // which legitimately DISPLAY the strategy faced, and ONE Vite bundle serves both
    // the student and the instructor routes (App.tsx picks by hostname). So those
    // strings are now necessarily present — as instructor-page labels.
    //
    // What must still hold, and is asserted instead:
    //   1. the bundle carries no BOT DECISION LOGIC — a student reading the shipped JS
    //      still cannot compute the opponent's next move (that lives server-side, in
    //      functions/src/pd/strategy.ts, and must never be imported by the frontend);
    //   2. no student RESPONSE carries the strategy — §10 above, unchanged;
    //   3. the student PAGE never renders it — asserted at the DOM level in
    //      pd-playwright.mjs, unchanged, and that is the real guarantee.
    // Only the crude bundle-wide grep is gone; nothing that constrains the student is.
    // (1) is checked against the SOURCE, not the bundle: minification renames
    // parameters and inlines functions, so a bundle grep for the strategy's shape
    // would pass vacuously and prove nothing. `botMove` in particular CANNOT be
    // grepped for in the bundle — it is also the legitimate client field name for the
    // move the student is shown after committing. What is worth asserting is that no
    // frontend module reaches into the server's strategy library at all.
    const feFiles = fs.readdirSync(path.join(ROOT, 'frontend', 'src', 'pd'))
      .filter(f => f.endsWith('.ts') || f.endsWith('.tsx'))
      .map(f => fs.readFileSync(path.join(ROOT, 'frontend', 'src', 'pd', f), 'utf8'))
    check(feFiles.every(src => !/from\s+['"].*functions\//.test(src)),
      'no frontend module imports anything from functions/ (the strategy library stays server-side)')
    check(feFiles.every(src => !/function\s+botMove|=>\s*studentHistory/.test(src)),
      'no frontend module implements a bot decision function of its own')

    // The strategy names appear ONLY as instructor-page furniture — assert the
    // instructor markers that account for them are present, so a future stray
    // occurrence in student copy is a visible diff rather than a silent pass.
    //
    // ⚠ THE MARKERS MOVED with the seven-strategy pass. 'Faced tit-for-tat' was a
    // HARDCODED debrief group title; group titles are now built from the server's
    // per-instance labels (`Faced ${name}`), so that literal no longer exists and its
    // absence is correct rather than a regression. The markers below are the strings
    // that DO account for every strategy name left in the bundle: the settings
    // checkbox list (the only client-side name mirror, instructor-only) and the two
    // instructor roster columns.
    check(js.includes('Opponent faced') && js.includes('Available strategies'),
      'the strategy names in the bundle are accounted for by the instructor pages')
    check(js.includes('Alternating') && js.includes('Tit-for-tat'),
      '…specifically by the settings checkbox list, which is instructor-only')
    check(!js.toLowerCase().includes('pavlov'),
      '⚠ nothing in the shipped bundle is called "Pavlov"')
    // ⚠ THE RETIRED ID IS GONE FROM THE CLIENT ENTIRELY. `match_stay` was removed
    // because it was provably tit-for-tat; the server still MAPS a stored assignment
    // to `tft`, but nothing client-side may offer it as a choice again.
    check(!js.includes('match_stay') && !js.includes('Match-and-stay'),
      '⚠ the retired match_stay id appears nowhere in the shipped bundle')
    // ⚠ AND NO TEAL. `alternate` was #0891b2, which merged with tit-for-tat's blue
    // under a projector — the defect this palette pass exists to fix.
    check(!js.includes('#0891b2'),
      '⚠ the retired teal is gone from the bundle (it collided with blue on a projector)')

    // ⚠⚠ THE EQUILIBRIUM HINT IS INSTRUCTOR-ONLY, AND THE BUNDLE IS SHARED. Settings,
    // Dashboard, Reports and Play all ship in one JS bundle, so "absent from the
    // bundle" is not the available guarantee and asserting it would be a lie. What IS
    // assertable, and is what actually matters:
    //   (1) the hint's own module is imported by NO student-facing component, and
    //   (2) no student callable carries it (asserted at the payloads in §14e).
    // Same shape as the strategy-library check above: assert against the SOURCE, where
    // the import graph is legible, rather than against minified output.
    const STUDENT_MODULES = [
      'Play.tsx', 'RoundScreen.tsx', 'KcScreen.tsx', 'DebriefScreen.tsx',
      'HistoryTable.tsx', 'PayoffMatrix.tsx', 'resume.ts',
    ]
    const studentSrc = STUDENT_MODULES.map(f =>
      fs.readFileSync(path.join(ROOT, 'frontend', 'src', 'pd', f), 'utf8'))
    check(studentSrc.length === STUDENT_MODULES.length,
      `read all ${STUDENT_MODULES.length} student-facing modules`)
    check(studentSrc.every(src => !/mixedEquilibrium/.test(src)),
      '⚠⚠ NO student-facing module imports the equilibrium hint')
    check(studentSrc.every(src => !/indifferen/i.test(src)),
      '⚠ …and none of them mentions indifference at all')
    // NEGATIVE CONTROL: the module IS imported by the instructor settings page, so the
    // assertion above is about where it is used and not about it being unused.
    const settingsSrc = fs.readFileSync(path.join(ROOT, 'frontend', 'src', 'pd', 'Settings.tsx'), 'utf8')
    check(/mixedEquilibrium/.test(settingsSrc),
      '⚠ NEGATIVE CONTROL — the instructor settings page DOES import it')
    check(!/rounds?\s+remaining|rounds?\s+left/i.test(js), 'the bundle has no rounds-remaining copy')
    check(!/round\s*\{?\s*\w*\s*\}?\s*of\s*\{/i.test(js), 'the bundle has no "round N of M" template')
  }

  // ── 16. ⚠⚠ The AFTER PLAY stage receives added questions, AT THE CALLABLES ──
  //
  // ⚠⚠ TESTS WHAT THE CALLABLE SERVES, NOT THE HELPER. The unit suite passes the stage
  // explicitly, so a mutation that DROPS the stage argument in pdGetQuestions — serving
  // every after-play question before play — is invisible to it. That mutant survived the
  // first calibration run of this pass, exactly as the shuffle one did last pass. This
  // section is what kills it.
  console.log('\n[16] The AFTER PLAY stage, at the callables')
  {
    const GIDP = `pd-poststage-${stamp}`
    const PPID = 'pd-post-stu'

    const saved = await callFn('pdUpdateConfig', {
      ...asDev(GIDP),
      minRounds: 2,
      maxRounds: 2,
      debriefPrompt: 'What was your plan, and when did it change?',
      addedKcQuestions: [
        { id: 'akc_before', type: 'mc', prompt: 'Asked BEFORE play?', stage: 'pre',
          options: [{ value: 'b0', label: 'B0' }, { value: 'b1', label: 'B1' },
            { value: 'b2', label: 'B2' }, { value: 'b3', label: 'B3' }], correct_value: 'b0' },
        { id: 'akc_after', type: 'mc', prompt: 'Asked AFTER play?', stage: 'post',
          options: [{ value: 'a0', label: 'A0' }, { value: 'a1', label: 'A1' },
            { value: 'a2', label: 'A2' }, { value: 'a3', label: 'A3' }], correct_value: 'a0' },
        { id: 'akc_after_text', type: 'text', prompt: 'A paragraph, after play.', stage: 'post' },
        { id: 'akc_legacy', type: 'mc', prompt: 'No stage given — must stay BEFORE play.',
          options: [{ value: 'l0', label: 'L0' }, { value: 'l1', label: 'L1' }], correct_value: 'l0' },
      ],
    })
    check(saved.ok, 'added questions with an explicit stage save')
    check(saved.result.kc.added.find(q => q.id === 'akc_after').stage === 'post',
      '⚠ the settings inventory files the post question under the AFTER PLAY heading')
    check(saved.result.kc.added.find(q => q.id === 'akc_legacy').stage === 'pre',
      '⚠⚠ …and a stage-less question stays BEFORE play — nothing already stored moves')

    await callFn('pdBootstrap', asStudent(GIDP, PPID))
    const qs = await callFn('pdGetQuestions', asStudent(GIDP, PPID))

    // ── The split, as the STUDENT receives it ────────────────────────────
    const preIds = qs.result.kc.added.map(q => q.field)
    const postIds = qs.result.postStage.map(q => q.field)
    check(preIds.includes('akc_before') && preIds.includes('akc_legacy'),
      'the pre-play list carries the pre question and the stage-less one')
    check(!preIds.includes('akc_after') && !preIds.includes('akc_after_text'),
      '⚠⚠ …and NOT the after-play ones — they are not served before play')
    check(postIds.includes('akc_after') && postIds.includes('akc_after_text'),
      '⚠⚠ the AFTER PLAY stage carries them')
    check(postIds[0] === 'debrief_reflection',
      'the debrief row leads the after-play stage')
    check(qs.result.postStage.find(q => q.field === 'debrief_reflection').prompt
      === 'What was your plan, and when did it change?',
    '⚠ the debrief row renders the instructor\'s prompt from debrief_prompt')
    check(!JSON.stringify(qs.result.postStage).includes('correct_value'),
      '⚠ the after-play payload ships no answer key')

    // ── The shuffle, through the callable ────────────────────────────────
    const slots = new Set()
    for (let i = 0; i < 60; i++) {
      const r = await callFn('pdGetQuestions', asStudent(GIDP, `pd-post-shuf-${i}`))
      const row = r.result.postStage.find(q => q.field === 'akc_after')
      slots.add(row.options.findIndex(o => o.value === 'a0'))
    }
    check(slots.size === 4,
      `⚠⚠ the after-play question's answer reaches EVERY slot over a cohort (${slots.size}/4)`)

    // ── Answering it AFTER the rounds, and the denominator ───────────────
    const st0 = await callFn('pdGetState', asStudent(GIDP, PPID))
    check(st0.ok, 'the student has a game')
    for (const q of [...qs.result.kc.derived, ...qs.result.kc.added]) {
      await callFn('pdSubmitKcAnswer', asStudent(GIDP, PPID, { field: q.field, answer: q.options[0].value }))
    }
    let done = false
    for (let n = 1; n <= 40 && !done; n++) {
      const r = await callFn('pdSubmitRound', asStudent(GIDP, PPID, { round: n, move: 'C' }))
      if (!r.ok) break
      done = r.result.gameOver === true
    }
    check(done, 'the game finishes')

    const mid = await callFn('pdGetQuestions', asStudent(GIDP, PPID))
    check(mid.result.postStage.every(q => q.answered === false),
      'every after-play row is still unanswered when the game ends')

    // Answer the DEBRIEF only — resume must then land on the next row, not the first.
    await callFn('pdSubmitDebrief', asStudent(GIDP, PPID, { answer: 'I cooperated throughout.' }))
    const afterDebrief = await callFn('pdGetQuestions', asStudent(GIDP, PPID))
    const flags = afterDebrief.result.postStage.map(q => q.answered)
    check(flags[0] === true && flags.slice(1).every(f => f === false),
      '⚠⚠ RESUME: the debrief reads answered and the rest do not — the client lands on row 2')

    // The graded after-play question counts in the denominator.
    const gradedRow = afterDebrief.result.postStage.find(q => q.field === 'akc_after')
    const ans = await callFn('pdSubmitKcAnswer',
      asStudent(GIDP, PPID, { field: 'akc_after', answer: gradedRow.options[0].value }))
    check(ans.ok, '⚠ an after-play MC question is answerable through pdSubmitKcAnswer')
    check(ans.result.graded === true,
      '⚠⚠ …and it is GRADED — gradedness follows the answer key, never the stage (D3)')
    const txt = await callFn('pdSubmitKcAnswer',
      asStudent(GIDP, PPID, { field: 'akc_after_text', answer: 'Because it seemed safest.' }))
    check(txt.ok && txt.result.graded === false,
      '⚠ …while an after-play FREE-TEXT question is recorded and NOT graded')

    const pdoc = await getDoc(`pd_game_instances/${GIDP}/participants/${PPID}`)
    // 4 derived + akc_before + akc_legacy + akc_after = 7 graded; akc_after_text ungraded.
    check(pdoc?.knowledge_check_score != null,
      '⚠ the score lands only once EVERY graded question — including the after-play one — is answered')

    // ── Hiding an after-play addition removes it from the stage ──────────
    const hid = await callFn('pdUpdateConfig', { ...asDev(GIDP), kcHidden: { akc_after_text: true } })
    check(hid.ok, 'hiding an after-play addition is accepted')
    const hidQs = await callFn('pdGetQuestions', asStudent(GIDP, 'pd-post-hid'))
    check(!hidQs.result.postStage.some(q => q.field === 'akc_after_text'),
      '⚠ a hidden after-play question is not served')

    // ── Reordering ACROSS both kinds ─────────────────────────────────────
    const ord = await callFn('pdUpdateConfig',
      { ...asDev(GIDP), kcOrder: { akc_after: 0, debrief_reflection: 1 } })
    check(ord.ok, 'reordering the after-play stage is accepted')
    const ordQs = await callFn('pdGetQuestions', asStudent(GIDP, 'pd-post-ord'))
    check(ordQs.result.postStage[0].field === 'akc_after',
      '⚠ an added question can be put BEFORE the debrief paragraph')
  }

  // ⚠ BLOCK-SCOPED. This file is one long function and section 15 introduces a dozen
  // locals; braces keep them off the shared scope rather than renaming each one.
  {
  // ── 15. ⚠⚠ The shared KC surface — hidden / order / overrides, AT THE CALLABLES ──
  //
  // ⚠⚠ THESE RUN AGAINST THE DEPLOYED CALLABLES, not the compiled modules. The unit suite
  // (functions/test/pdKcSurface.test.ts) pins the pure logic and kills 14 mutants; this
  // pins that pdUpdateConfig, pdGetQuestions and pdSubmitKcAnswer are actually WIRED to
  // it. A guard that exists only in a module nothing calls is the exact failure spec §5
  // warns about — and it is the failure that let one mutant survive this pass's first
  // calibration run.
  console.log('\n[15] The shared KC surface, at the callables')
  const GIDK = `pd-kcsurface-${stamp}`

  const inv0 = await callFn('pdGetConfig', asDev(GIDK))
  check(inv0.ok && inv0.result.kc != null, 'pdGetConfig returns the kc inventory')
  const kc0 = inv0.result.kc
  check(kc0.builtIn.length === 4, `⚠ ALL FOUR derived questions are listed for the instructor (${kc0.builtIn.length})`)
  check(kc0.builtIn.every(q => q.prompt.length > 0 && q.options.length >= 2 && q.correctValue),
    '…each with its prompt, its options and its answer')
  check(kc0.builtIn.every(q => q.locked), '⚠ ALL FOUR are LOCKED — every one is built from the payoff matrix')
  check(kc0.builtIn.every(q => (q.lockReason ?? '').length > 0),
    '⚠ …and every locked row carries a REASON — a disabled control with no explanation is a bug')
  check(kc0.debrief != null && kc0.debrief.id === 'debrief_reflection',
    '⚠⚠ THE DEBRIEF IS A ROW IN THE LIST (spec D9), not a separate surface')
  check(kc0.debrief.stage === 'post' && kc0.debrief.graded === false,
    '…in the post stage, and never graded')
  check(kc0.poolTotal === 5 && kc0.visibleCount === 5 && kc0.gradedCount === 4,
    `the count line reads 5 of 5 visible, 4 graded (${kc0.visibleCount}/${kc0.poolTotal}, ${kc0.gradedCount})`)

  // ── Overrides: refused on a locked question, AT THE CALLABLE ─────────────
  const ovLocked = await callFn('pdUpdateConfig',
    { ...asDev(GIDK), kcOverrides: { kc_cc: { prompt: 'my own stem' } } })
  check(!ovLocked.ok, '⚠⚠ an override on a LOCKED question is REFUSED by the callable')
  check((ovLocked.error ?? '').includes('cannot be edited'), '…with a reason the page can show')

  const ovDebrief = await callFn('pdUpdateConfig',
    { ...asDev(GIDK), kcOverrides: { debrief_reflection: { prompt: 'x' } } })
  check(!ovDebrief.ok, '⚠ an override aimed at the DEBRIEF row is refused — it is backed by debriefPrompt')

  const ovUnknown = await callFn('pdUpdateConfig',
    { ...asDev(GIDK), kcHidden: { not_a_question: true } })
  check(!ovUnknown.ok, 'a hide naming a question this game does not have is refused')

  // ── Hidden: gone from the serve path AND the denominator ─────────────────
  const hid = await callFn('pdUpdateConfig', { ...asDev(GIDK), kcHidden: { kc_cd: true } })
  check(hid.ok, 'hiding one derived question is accepted')
  check(hid.result.kc.visibleCount === 4 && hid.result.kc.gradedCount === 3,
    `⚠ the count line follows: 4 of 5 visible, 3 graded (${hid.result.kc.visibleCount}/${hid.result.kc.gradedCount})`)

  const KCPID = 'pd-kc-stu'
  await callFn('pdBootstrap', asStudent(GIDK, KCPID))
  const kQs = await callFn('pdGetQuestions', asStudent(GIDK, KCPID))
  check(!kQs.result.kc.derived.some(q => q.field === 'kc_cd'),
    '⚠⚠ a hidden question is NOT SERVED to the student')
  check(kQs.result.kc.derived.length === 3, `…three derived questions remain (${kQs.result.kc.derived.length})`)
  const hidSubmit = await callFn('pdSubmitKcAnswer', asStudent(GIDK, KCPID, { field: 'kc_cd', answer: '15' }))
  check(!hidSubmit.ok, '⚠⚠ …and SUBMITTING it is refused — it is not a question in this game')

  // ── …and the denominator followed: answering the THREE visible ones completes it ──
  for (const q of kQs.result.kc.derived) {
    await callFn('pdSubmitKcAnswer', asStudent(GIDK, KCPID, { field: q.field, answer: q.options[0].value }))
  }
  const kDoc = await getDoc(`pd_game_instances/${GIDK}/participants/${KCPID}`)
  check(kDoc?.knowledge_check_score != null,
    '⚠⚠ the score LANDS after only the THREE visible questions — the denominator dropped the hidden one')

  // ── Reorder survives a save/reload round trip ────────────────────────────
  const wanted = ['kc_dd', 'kc_dc', 'kc_cc']
  const ord = await callFn('pdUpdateConfig',
    { ...asDev(GIDK), kcOrder: Object.fromEntries(wanted.map((id, i) => [id, i])) })
  check(ord.ok, 'a reorder is accepted')
  const reread = await callFn('pdGetConfig', asDev(GIDK))
  const sortedEntries = o => Object.entries(o ?? {}).sort(([a], [b]) => a.localeCompare(b))
  check(JSON.stringify(sortedEntries(reread.result.kcOrder))
    === JSON.stringify(sortedEntries(Object.fromEntries(wanted.map((id, i) => [id, i])))),
  '⚠ the order SURVIVES a save/reload round trip')
  const ordQs = await callFn('pdGetQuestions', asStudent(GIDK, 'pd-kc-ord'))
  check(JSON.stringify(ordQs.result.kc.derived.map(q => q.field)) === JSON.stringify(wanted),
    '⚠ …and the STUDENT is served that order')

  // ── The debrief row still writes to the EXISTING key ─────────────────────
  const dbSave = await callFn('pdUpdateConfig', { ...asDev(GIDK), debriefPrompt: 'Rewritten by the row.' })
  check(dbSave.ok, 'the debrief row\'s prompt saves')
  const dbDoc = await getDoc(`pd_game_instances/${GIDK}/config/main`)
  check(dbDoc?.debrief_prompt?.stringValue === 'Rewritten by the row.',
    '⚠⚠ …to the EXISTING `debrief_prompt` key — NO storage migration')
  check(dbDoc?.kc_overrides == null || !JSON.stringify(dbDoc.kc_overrides).includes('debrief_reflection'),
    '⚠ …and NOT into kc_overrides — the row is backed by its own key')
  check(dbSave.result.kc.debrief.prompt === 'Rewritten by the row.', 'the row reads back the new prompt')

  const dbHide = await callFn('pdUpdateConfig', { ...asDev(GIDK), debriefEnabled: false })
  check(dbHide.ok && dbHide.result.kc.debrief.visible === false,
    '⚠ unticking the debrief row stores debrief_enabled:false')
  const dbQs = await callFn('pdGetQuestions', asStudent(GIDK, 'pd-kc-db'))
  check(dbQs.result.debrief === null, '…and the student is served no debrief')
  await callFn('pdUpdateConfig', { ...asDev(GIDK), debriefEnabled: true })

  // ── D12: the toggle gates GRADED questions only ──────────────────────────
  const GIDD = `pd-kcd12-${stamp}`
  const d12 = await callFn('pdUpdateConfig', {
    ...asDev(GIDD),
    kcEnabled: false,
    addedKcQuestions: [
      { id: 'akc_free', type: 'text', prompt: 'A free-text addition.' },
      { id: 'akc_graded', type: 'mc', prompt: 'A graded addition?',
        options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }], correct_value: 'a' },
    ],
  })
  check(d12.ok, 'kcEnabled:false with two additions saves')
  const d12Qs = await callFn('pdGetQuestions', asStudent(GIDD, 'pd-d12-stu'))
  check(d12Qs.result.kc.derived.length === 0, '⚠ D12: the toggle removed the derived four')
  check(!d12Qs.result.kc.added.some(q => q.field === 'akc_graded'), '…and the GRADED addition')
  check(d12Qs.result.kc.added.some(q => q.field === 'akc_free'),
    '⚠⚠ …but LEFT the ungraded free-text one — it has its own visibility (D12)')
  check(d12Qs.result.debrief !== null, '⚠ …and left the debrief paragraph alone')

  // ── Zero visible graded ⇒ null, not 1.0 ─────────────────────────────────
  const zDoc0 = await callFn('pdSubmitKcAnswer',
    asStudent(GIDD, 'pd-d12-stu', { field: 'akc_free', answer: 'here you go' }))
  check(zDoc0.ok, 'the one ungraded question is still answerable')
  const zDoc = await getDoc(`pd_game_instances/${GIDD}/participants/pd-d12-stu`)
  const zScore = zDoc?.knowledge_check_score
  check(zScore != null && zScore.nullValue !== undefined,
    `⚠⚠ ZERO VISIBLE GRADED ⇒ the stored score is NULL, not 1.0 (${JSON.stringify(zScore)})`)
  check(!(zScore?.doubleValue === 1 || zScore?.integerValue === '1'),
    '⚠ …calcKCScore would have answered the empty set with 1.0 and pushed a perfect score to the gradebook')
  }

  console.log(`\n${failed === 0 ? '✅' : '❌'} pd harness: ${passed} passed, ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch(err => {
  console.error('harness crashed:', err)
  process.exit(1)
})
