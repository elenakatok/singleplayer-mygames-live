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

/** Years served by a player who played `own` against `other`. Spec §2. */
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
   *  the instance — read straight from the rules-denied truth/ docs, which is the only
   *  place it exists. The harness knows the round count and the strategy; the student
   *  never does, and §11 is what proves that. */
  async function openInstance(gid, pid, seed) {
    await putDoc(`pd_game_instances/${gid}/config/main`, {
      seed: { stringValue: seed },
      payoffs: payoffFields(PAYOFFS),
    })
    await callFn('pdBootstrap', asStudent(gid, pid))
    const state = await callFn('pdGetState', asStudent(gid, pid))
    const truth = await getDoc(`pd_game_instances/${gid}/truth/main`)
    const stu = await getDoc(`pd_game_instances/${gid}/truth/participant_${pid}`)
    return {
      state,
      rounds: Number(truth?.rounds?.integerValue),
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
    `first touch drew the instance round count into truth/main (${opened.rounds} ∈ [10,20])`)
  check(opened.strategy === 'tft' || opened.strategy === 'grim',
    `first touch assigned a strategy into truth/participant_* (${opened.strategy})`)

  const s0 = opened.state.result
  check(Array.isArray(s0.history) && s0.history.length === 0, 'a new student has an empty history')
  check(s0.gameOver === false, 'a new student is not game-over')
  check(s0.payoffs?.sucker === PAYOFFS.sucker && s0.payoffs?.both_defect === PAYOFFS.both_defect,
    'returns the INSTANCE payoff values (config-driven, not the shipped defaults)')
  check(s0.labels?.C === 'Cooperate' && s0.labels?.D === 'Defect', 'returns the move labels')

  // A second call must not redraw anything — once-only is the whole init contract.
  await callFn('pdGetState', asStudent(GID2, FIRST))
  const truthAgain = await getDoc(`pd_game_instances/${GID2}/truth/main`)
  const stuAgain = await getDoc(`pd_game_instances/${GID2}/truth/participant_${FIRST}`)
  check(Number(truthAgain?.rounds?.integerValue) === opened.rounds, 'a second pdGetState does NOT redraw the round count')
  check(stuAgain?.strategy?.stringValue === opened.strategy, 'a second pdGetState does NOT reassign the strategy')

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
  // The round count and the strategy are server-side truth. If either can be
  // recovered from any response, the pedagogy is broken: the student would know when
  // the last round is (and so defect on it), or know which bot they face without
  // inferring it. These checks are the reason the callables return whitelists.
  console.log('\n[10] ⚠ No leak: not the round count, not the strategy, ever')

  const GID6 = `pd-leak-${stamp}`
  const KPID = 'pd-leak-stu'
  const leak = await openInstance(GID6, KPID, 'seed-leak')

  const ALLOWED_STATE_KEYS = ['ok', 'labels', 'payoffs', 'history', 'gameOver',
    'C', 'D', 'both_cooperate', 'sucker', 'temptation', 'both_defect',
    'round', 'studentMove', 'botMove', 'studentYears', 'botYears', 'studentTotal', 'botTotal']
  const ALLOWED_SUBMIT_KEYS = ['ok', 'round', 'history', 'gameOver',
    'studentMove', 'botMove', 'studentYears', 'botYears', 'studentTotal', 'botTotal']

  /** The whole-tree audit: exact key allowlist, no forbidden word anywhere in the
   *  serialized payload, and no number that could be the drawn round count. */
  function auditNoLeak(payload, allowedKeys, where) {
    const keys = [...deepKeys(payload)]
    const extra = keys.filter(k => !allowedKeys.includes(k))
    check(extra.length === 0, `${where}: no key outside the whitelist (extra: ${JSON.stringify(extra)})`)

    const json = JSON.stringify(payload).toLowerCase()
    const forbidden = ['strategy', 'tft', 'grim', 'seed', 'remaining', 'total_rounds', 'roundcount', 'finished_at']
    const hit = forbidden.filter(w => json.includes(w))
    check(hit.length === 0, `${where}: no forbidden word in the payload (found: ${JSON.stringify(hit)})`)

    // The round count is an integer in [10,20]; every payoff in this instance is < 10
    // and only ONE round has been played, so every legitimate number in the payload is
    // < 10. Any number ≥ 10 therefore could only be the round count, under ANY key name.
    const nums = deepValues(payload).filter(v => typeof v === 'number')
    const suspicious = nums.filter(v => v >= 10)
    check(suspicious.length === 0,
      `${where}: no number ≥ 10 anywhere (the draw is ${leak.rounds}; found: ${JSON.stringify(suspicious)})`)
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
  check(qs.result.kc.length === 4, 'serves the four KC questions (spec §7)')
  check(qs.result.kc.every(q => Object.keys(q).sort().join() === 'field,options,prompt'),
    'each KC question carries only field, prompt, options')
  const qsJson = JSON.stringify(qs.result)
  check(!qsJson.includes('correct_value'), '⚠ the answer key is NOT served to the student')
  check(!qsJson.includes('explanation'), '⚠ the explanations are NOT served ahead of answering')
  check(qs.result.kcAnswered.length === 0 && qs.result.debriefSubmitted === false,
    'a new student has answered nothing')
  check(qs.result.debrief?.prompt.startsWith('In a short paragraph'), 'serves the debrief question')

  // The KC options are THIS instance's payoff values (config-driven), and the correct
  // answer follows the same matrix — a student is never graded against a matrix they
  // were not shown.
  const optionValues = qs.result.kc[0].options.map(o => o.value).sort()
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

  // ── 13. The pd play screen ships in the bundle ──────────────────────────────
  // One Vite bundle serves every game and picks by hostname, so "the pd route is
  // built and shipped" is what can be asserted here. This is a BUILD-ARTIFACT check,
  // not a DOM render — the repo has no jsdom/testing-library, so the components'
  // markup is covered by the static-render tests in frontend/src/pd/ instead.
  // `npm run build` in frontend/ must have run first.
  console.log('\n[13] pd play screen present in the shipped bundle')
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
    check(js.includes('between 10 and 20 rounds'), 'framing: between 10 and 20 rounds (the range, not the draw)')
    check(js.includes('Years in prison'), 'the matrix is framed as years in prison (losses)')

    // ⚠ The CLIENT-SIDE half of the no-leak constraint: the strategy library must not
    // exist in the bundle at all. A student who reads the shipped JS should find no
    // bot rule to read — only the moves they themselves made.
    check(!/\btit.for.tat\b/i.test(js), 'the bundle never names tit-for-tat')
    check(!/\bgrim\b/i.test(js), 'the bundle never names GRIM')
    check(!/\btft\b/i.test(js), 'the bundle carries no tft identifier')
    check(!/rounds?\s+remaining|rounds?\s+left/i.test(js), 'the bundle has no rounds-remaining copy')
    check(!/round\s*\{?\s*\w*\s*\}?\s*of\s*\{/i.test(js), 'the bundle has no "round N of M" template')
  }

  console.log(`\n${failed === 0 ? '✅' : '❌'} pd harness: ${passed} passed, ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch(err => {
  console.error('harness crashed:', err)
  process.exit(1)
})
