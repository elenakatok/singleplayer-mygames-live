// ═══════════════════════════════════════════════════════════════════════════════
// PROCUREMENT ROBOT COHORT — emulator dry run.
//
// Boots vite, seeds a full instance, runs the SHIPPED robot driver headless against the
// emulator, then reads the INSTRUCTOR REPORT back and checks the cohort actually did
// what it is for.
//
// ⚠ THIS IS NOT "DID THE DRIVER NOT CRASH". The cohort exists so a robot-populated demo
// yields a REALISTIC §12 chart, and the styles ARE that chart's features. So this script
// asserts the SHAPE:
//
//   • every robot finished every round and wrote a debrief;
//   • the `equilibrium` robot's bids land ON the optimal line — the benchmark the chart
//     draws is the one the bots actually played;
//   • the `cost-bidder` lands ON the 45° line and earns exactly zero — the lesson;
//   • the `loss-maker` puts points BELOW the 45° line, so the chart's lower half is not
//     empty in a demo;
//   • the styles SEPARATE on profit rather than collapsing into one band;
//   • the Tier-3 payload contains every robot's bids.
//
// A cohort that ran but produced one flat line would pass a crash test and fail this.
//
// Run:  npm run robots:procurement:dryrun
//       HEADED=1 npm run robots:procurement:dryrun
// ═══════════════════════════════════════════════════════════════════════════════

import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runCohort } from './bot/procurement-robot-driver.mjs'
import { beta } from './bot/procurement-styles.mjs'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const PROJECT = 'demo-singleplayer'
const FUNCTIONS = `http://127.0.0.1:5010/${PROJECT}/us-central1`
const FIRESTORE = `http://127.0.0.1:8090/v1/projects/${PROJECT}/databases/(default)/documents`
const VITE_PORT = 5189
const APP = `http://127.0.0.1:${VITE_PORT}`
const HEADED = process.env.HEADED === '1'

const GID = `proc-robot-${Date.now()}`
const ROUNDS = Number(process.env.PROC_ROUNDS ?? 6)
const RESERVE = 110
const STUDENTS = Number(process.env.PROC_STUDENTS ?? 6)           // one per style, so every rule is exercised

let passed = 0, failed = 0
const check = (cond, label) => {
  if (cond) { passed++; console.log(`  ✓ ${label}`) }
  else { failed++; console.error(`  ✗ ${label}`) }
}
const section = (t) => console.log(`\n${t}`)

async function callFn(name, data) {
  const res = await fetch(`${FUNCTIONS}/${name}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data }),
  })
  const body = await res.json().catch(() => null)
  if (res.ok && body && 'result' in body) return body.result
  throw new Error(body?.error?.message ?? `http ${res.status}`)
}

async function putDoc(docPath, fields) {
  const res = await fetch(`${FIRESTORE}/${docPath}`, {
    method: 'PATCH',
    headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields }),
  })
  if (!res.ok) throw new Error(`firestore PATCH ${docPath} → ${res.status}`)
}

const intVal = (n) => ({ integerValue: String(n) })
const strVal = (s) => ({ stringValue: s })
const boolVal = (b) => ({ booleanValue: b })
const arrVal = (xs) => ({ arrayValue: { values: xs } })
const mapVal = (f) => ({ mapValue: { fields: f } })
const distVal = (min, max) => mapVal({
  distribution: strVal('uniform'), min: intVal(min), max: intVal(max), integer: boolVal(true),
})

async function startVite() {
  // ⚠⚠ FAIL FAST IF THE PORT IS ALREADY SERVING. The obvious loop — spawn, then poll
  // until `fetch(APP)` succeeds — accepts ANY server answering on that port, including a
  // stale one left behind by a killed run. When that happens the spawned child dies of
  // EADDRINUSE, the poll succeeds against the OLD server, and the harness proceeds while
  // `vite.kill()` at the end kills nothing. That is how a 25-minute hang and a
  // half-finished run got mistaken for a slow cohort on 08-03. Same shape as the
  // updateMask trap: the harness believed it controlled something it did not.
  try {
    await fetch(APP, { signal: AbortSignal.timeout(1500) })
    throw new Error(
      `port ${VITE_PORT} is already serving — a stale dev server is up. ` +
      `Kill it first (pkill -f "vite --port ${VITE_PORT}"); this harness will not ` +
      `test against a server it did not start.`)
  } catch (err) {
    if (!/already serving/.test(String(err?.message))) { /* nothing there: good */ }
    else throw err
  }

  const child = spawn('npx',
    ['vite', '--port', String(VITE_PORT), '--strictPort', '--host', '127.0.0.1'],
    {
      cwd: path.join(ROOT, 'frontend'),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        VITE_FIREBASE_API_KEY: 'demo-key',
        VITE_FIREBASE_AUTH_DOMAIN: 'localhost',
        VITE_FIREBASE_PROJECT_ID: PROJECT,
        VITE_FIREBASE_STORAGE_BUCKET: `${PROJECT}.appspot.com`,
        VITE_FIREBASE_MESSAGING_SENDER_ID: '0',
        VITE_FIREBASE_APP_ID: 'demo-app',
      },
    })
  child.stderr.on('data', d => process.stderr.write(`[vite] ${d}`))
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    try { if ((await fetch(APP)).ok) return child } catch { /* not up */ }
    await new Promise(r => setTimeout(r, 250))
  }
  child.kill('SIGKILL')
  throw new Error('vite dev server did not start within 60s')
}

async function main() {
  // ⚠ ONE WRITE, EVERY FIELD — a maskless REST PATCH replaces the document.
  await putDoc(`procurement_game_instances/${GID}/config/main`, {
    format: strVal('sealed_first_price'),
    rounds: intVal(ROUNDS),
    rivalCount: intVal(4),
    reserve: intVal(RESERVE),
    rivalCostDist: distVal(10, 110),
    playerCostDist: distVal(10, 60),
    bidIncrementUnit: intVal(1),
    currencyLabel: strVal('ECU'),
    kcEnabled: boolVal(true),
    kcVisible: arrVal(['S1', 'S2', 'S8', 'S9'].map(strVal)),
  })
  await putDoc(`procurement_game_instances/${GID}/truth/main`, { seed: strVal('robot-seed') })

  const params = { reserve: RESERVE, rivalCostMax: 110, totalBidders: 5 }
  const vite = await startVite()

  let results
  try {
    section(`[COHORT]  ${STUDENTS} robots × ${ROUNDS} rounds, through the real UI`)
    results = await runCohort({
      call: (fn, data) => callFn(fn, data),
      studentUrl: (pid) => `${APP}/?game=procurement&_pid=${pid}&_gid=${GID}`,
      authFor: (pid) => ({ _test: { participant_id: pid, game_instance_id: GID } }),
      params, rounds: ROUNDS, students: STUDENTS, headed: HEADED,
    })
  } finally {
    vite.kill('SIGKILL')
  }

  // ⚠ A style-specific check is SKIPPED LOUDLY when that style was not assigned (a
  // reduced cohort under PROC_STUDENTS). Silently passing it would report a green shape
  // check for a rule that never ran — a smaller version of exactly what this file exists
  // to catch.
  const by = (name) => {
    const r = results.find(x => x.style === name)
    if (!r) console.log(`  … skipped: no \`${name}\` robot in a cohort of ${STUDENTS}`)
    return r
  }
  const withStyle = (name, fn) => { const r = by(name); if (r) fn(r) }

  check(results.length === STUDENTS, `all ${STUDENTS} robots completed a game`)
  check(results.every(r => r.bids.length === ROUNDS),
    `and each played all ${ROUNDS} rounds`)
  check(results.every(r => r.debriefSubmitted),
    'and each wrote a debrief paragraph — a finished robot looks like a finished student')

  // ── The chart's features ───────────────────────────────────────────────────
  section('[SHAPE]  The cohort reproduces the §12 chart\'s features')

  withStyle('equilibrium', (eq) =>
    check(eq.bids.every(b => b.bid === Math.round(beta(b.cost, params))),
      '⚠ the `equilibrium` robot\'s bids land ON the optimal line — the benchmark is played, not asserted'))

  withStyle('cost-bidder', (cb) => {
    check(cb.bids.every(b => b.bid === b.cost), 'the `cost-bidder` lands ON the 45° line')
    check(cb.totalProfit === 0,
      '⚠ and earns EXACTLY zero — winning at your own cost pays nothing, which is the lesson')
  })

  withStyle('loss-maker', (lm) =>
    check(lm.bids.some(b => b.bid < b.cost),
      '⚠ the `loss-maker` puts points BELOW the 45° line — the chart\'s lower half is not empty'))

  withStyle('over-marker', (om) =>
    check(om.bids.every(b => b.bid >= Math.round(beta(b.cost, params))),
      'the `over-marker` sits above the optimal line'))

  check(results.every(r => r.bids.every(b => b.bid >= 0 && b.bid <= RESERVE)),
    'every bid every robot made was inside the legal band — none was refused at submit')

  const profits = results.map(r => r.totalProfit)
  check(new Set(profits).size > 1,
    'the styles SEPARATE on profit rather than collapsing into one band')

  // ── What the instructor sees ───────────────────────────────────────────────
  section('[REPORT]  The cohort as Elena reads it')

  const rep = await callFn('procurementGetReport', { _dev: { game_instance_id: GID } })
  check(rep.rows.length === STUDENTS, 'every robot is on the roster')
  check(rep.rows.every(r => r.roundsPlayed === ROUNDS), 'each with a full game')

  const allBids = rep.rows.flatMap(r => r.rounds).filter(x => x.yourBid !== null)
  check(allBids.length === STUDENTS * ROUNDS,
    `the Tier-3 payload carries every bid (${allBids.length})`)
  check(allBids.every(x => x.yourEquilibriumBid !== null),
    'and every row carries the optimal bid the chart\'s line is drawn from')

  // ⚠ The robots' paragraphs are MARKED, so a demo instance's Tier-2 report cannot be
  // mistaken for a class's real answers.
  const paragraphs = rep.rows.map(r => r.freeText?.S9 ?? '')
  check(paragraphs.every(p => /Robot seat/i.test(p)),
    '⚠ every robot\'s debrief is MARKED as a robot seat in the Tier-2 report')

  // Score & Record over a robot cohort is a real rehearsal for the class run.
  const scored = await callFn('procurementScoreAndRecord', { _dev: { game_instance_id: GID } })
  check(scored.finishers === STUDENTS,
    `Score & Record counts all ${STUDENTS} robots as finishers (${scored.finishers})`)

  console.log(`\n${'═'.repeat(70)}`)
  console.log(`  ${passed} passed, ${failed} failed`)
  console.log('═'.repeat(70))
  if (failed > 0) process.exit(1)
}

main().catch(err => {
  console.error('\nDRY RUN ERROR:', err)
  process.exit(1)
})
