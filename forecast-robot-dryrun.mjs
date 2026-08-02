// ═══════════════════════════════════════════════════════════════════════════════
// FORECAST ROBOT COHORT — emulator dry run.
//
// Boots vite, seeds a full 24-month instance, runs the SHIPPED robot driver headless
// against the emulator, then reads the INSTRUCTOR REPORT back and checks the cohort
// actually did what spec §11 says it is for.
//
// ⚠ THIS IS NOT "DID THE DRIVER NOT CRASH". Spec §11 exists so a robot-populated demo
// "yields a realistic Tier-3 chart", and the seven styles ARE the seven §2.3 benchmark
// rules — so the real question is whether the cohort reproduces the comparison. This
// script therefore asserts:
//
//   • every robot finished all 24 months and wrote a debrief;
//   • the styles SEPARATE — the anchored robot's MSE is an order of magnitude above
//     the regression-fitter's, which is the 42× lesson of spec §2.3 point 1;
//   • the regression-fitter lands near the §2.3 expectation for its rule (~902), which
//     is the strongest single check that the whole stack — draws, metrics, UI, reading
//     the grid — is coherent end to end;
//   • the Tier-3 histogram and class chart are populated and shaped as expected.
//
// A cohort that ran but produced one flat line would pass a crash test and fail this.
//
// Run:  npm run robots:forecast:dryrun
// ═══════════════════════════════════════════════════════════════════════════════

import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PROJECT = 'demo-singleplayer'
const FIRESTORE = `http://127.0.0.1:8090/v1/projects/${PROJECT}/databases/(default)/documents`
const FUNCTIONS = `http://127.0.0.1:5010/${PROJECT}/us-central1`
const ROOT = path.dirname(fileURLToPath(import.meta.url))
const VITE_PORT = 5199
const APP = `http://localhost:${VITE_PORT}`
const GID = `fc-robot-${Date.now()}`
const STUDENTS = 7                      // one per style, so every rule is exercised

let passed = 0, failed = 0
const check = (cond, label) => {
  if (cond) { passed++; console.log(`  ✓ ${label}`) }
  else { failed++; console.error(`  ✗ ${label}`) }
}

const intVal = (n) => ({ integerValue: String(n) })
const boolVal = (b) => ({ booleanValue: b })
const strVal = (s) => ({ stringValue: s })
const arrVal = (xs) => ({ arrayValue: { values: xs } })

async function putDoc(p, fields) {
  const res = await fetch(`${FIRESTORE}/${p}`, {
    method: 'PATCH',
    headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields }),
  })
  if (!res.ok) throw new Error(`PATCH ${p} → ${res.status} ${await res.text()}`)
}

async function callFn(name, data) {
  const res = await fetch(`${FUNCTIONS}/${name}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data }),
  })
  const body = await res.json().catch(() => null)
  if (res.ok && body && 'result' in body) return body.result
  throw new Error(body?.error?.message ?? `http ${res.status}`)
}

async function startVite() {
  const child = spawn('npx', ['vite', '--port', String(VITE_PORT), '--strictPort', '--host', '127.0.0.1'], {
    cwd: path.join(ROOT, 'frontend'), stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env,
      VITE_FIREBASE_API_KEY: 'demo-key', VITE_FIREBASE_AUTH_DOMAIN: 'localhost',
      VITE_FIREBASE_PROJECT_ID: PROJECT, VITE_FIREBASE_STORAGE_BUCKET: `${PROJECT}.appspot.com`,
      VITE_FIREBASE_MESSAGING_SENDER_ID: '0', VITE_FIREBASE_APP_ID: 'demo-app' },
  })
  const deadline = Date.now() + 60000
  while (Date.now() < deadline) {
    try { if ((await fetch(APP)).ok) return child } catch { /* not up */ }
    await new Promise(r => setTimeout(r, 250))
  }
  child.kill('SIGKILL'); throw new Error('vite did not start')
}

const vite = await startVite()
try {
  // ⚠ THE FULL 24-MONTH GAME at the SHIPPED model. The point of this run is the §2.3
  // comparison, and that comparison is only meaningful at the published parameters over
  // both years — a short game would not separate the rules.
  await putDoc(`forecast_game_instances/${GID}/config/main`, {
    num_history: intVal(60), rounds: intVal(24),
    forecast_min: intVal(0), forecast_max: intVal(3000),
    kc_enabled: boolVal(true), debrief_enabled: boolVal(true),
  })
  await putDoc(`forecast_game_instances/${GID}/truth/main`, {
    intercept: intVal(560), trend: intVal(4), high_season_lift: intVal(230),
    high_season_months: arrVal([intVal(11), intVal(12)]),
    sigma: intVal(30), seasonality: strVal('additive'),
    season_structure: strVal('twoSeason'), demand_draw: strVal('perStudent'),
    seed: strVal('robot-dryrun'),
  })

  const driver = spawn('node', [
    path.join(ROOT, 'bot', 'forecast-robot-driver.mjs'),
    '--instance', GID, '--students', String(STUDENTS), '--pace', 'fast',
    '--emulator', '--app', APP, '--headless', '--exit-when-done',
  ], { stdio: 'inherit', cwd: path.join(ROOT, 'bot') })

  const code = await new Promise(r => driver.on('exit', r))
  console.log(`\nDRIVER EXIT CODE: ${code}`)
  check(code === 0, 'every robot completed its game')

  // ── Now read the INSTRUCTOR REPORT and check the cohort is useful ───────────
  console.log('\nReading the instructor report…')
  const rep = await callFn('forecastGetReport', { _dev: { game_instance_id: GID } })

  check(rep.participants.length === STUDENTS, `${STUDENTS} students appear on the roster`)
  const finished = rep.participants.filter(p => p.completed)
  check(finished.length === STUDENTS, `all ${STUDENTS} finished all 24 months`)
  check(rep.participants.every(p => p.months_played === 24), 'each played the full 24 months')
  check(rep.participants.every(p => p.debrief !== null),
    'every robot wrote a debrief paragraph (Tier 2 is populated)')
  check(rep.participants.every(p => p.knowledge_check_score !== null),
    'every robot completed the knowledge check')

  // ⚠ THE STYLES MUST SEPARATE. This is the assertion that makes the cohort worth
  // having: spec §2.3 point 1 is a 42× improvement from the worst rule to the best, and
  // a cohort that did not reproduce a wide spread would draw a Tier-3 histogram with
  // everything in one bucket.
  const mses = rep.participants.map(p => p.mse).filter(m => m !== null).sort((a, b) => a - b)
  const best = mses[0], worst = mses[mses.length - 1]
  console.log(`\n  MSE spread: ${mses.map(m => Math.round(m).toLocaleString()).join(' · ')}`)
  check(worst / best > 8,
    `the cohort SEPARATES — worst/best MSE ratio is ${(worst / best).toFixed(0)}× (spec §2.3)`)
  check(best < 3000, `the best robot is near the §2.3 floor (${Math.round(best).toLocaleString()})`)
  // The top end is whichever of the flat-mean, noise-chasing or guessing robots drew
  // worst on the day — they cluster up there and their order between runs is noise.
  check(worst > 15000, `the worst robot is up in the no-method band (${Math.round(worst).toLocaleString()})`)

  // The single strongest coherence check in the build: the regression-fitter's realized
  // MSE against the value spec §2.3 predicts for that exact rule (902). If the draws,
  // the metrics, the grid rendering or the robot's own fit were wrong, this misses.
  check(best > 700 && best < 2500,
    `the fitted-regression robot lands in the §2.3 band for its rule (~902, got ${Math.round(best).toLocaleString()})`)

  // Tier 3 is populated and correctly shaped.
  check(rep.classChart.length === 24, 'the Tier-3 class chart spans all 24 months')
  check(rep.classChart.every(pt => pt.n === STUDENTS),
    `every month averages over all ${STUDENTS} students`)
  check(rep.histogram !== null
    && rep.histogram.bins.reduce((s, b) => s + b.count, 0) === STUDENTS,
    'the MSE histogram bins every student exactly once')
  check(rep.benchmarks !== null && rep.benchmarks.length === 8,
    'the §2.3 benchmark table is attached for the reference lines')
  check(rep.summary.students === STUDENTS, 'the summary box counts the whole cohort')

  // Score & Record over a robot cohort — the real rehearsal.
  const rec = await callFn('forecastScoreAndRecord', { _dev: { game_instance_id: GID } })
  check(rec.finishers === STUDENTS, `Score & Record finds all ${STUDENTS} finishers`)

  console.log(`\nINSTANCE: ${GID}`)
  console.log(`${'─'.repeat(70)}\n  ${passed} passed, ${failed} failed\n${'─'.repeat(70)}`)
  process.exitCode = failed > 0 ? 1 : 0
} finally {
  vite.kill('SIGKILL')
}
