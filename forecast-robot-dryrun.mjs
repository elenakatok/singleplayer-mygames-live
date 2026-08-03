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
import { createRequire } from 'node:module'
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
const require_ = createRequire(import.meta.url)

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
    // ⚠ σ = 60 and demandDraw = common, matching the shipped defaults (Elena, 08-02).
    // Set EXPLICITLY, per the standing rule — but chosen to mirror the real game.
    // `common` also sharpens this run: every robot faces the SAME 24 months, so their
    // MSEs differ ONLY by style, which is exactly the comparison the cohort exists for.
    sigma: intVal(60), seasonality: strVal('additive'),
    season_structure: strVal('twoSeason'), demand_draw: strVal('common'),
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
  // ⚠ THE BANDS MOVED WITH σ (Elena, 08-02: 30 → 60). The floor is now σ² = 3,600, not
  // 900, and the whole benchmark table rose with it — so a band tuned to the old table
  // would fail on a perfectly healthy cohort. The separation also narrows: worst/best
  // was ~42× in the design table at σ = 30 and is ~11× at σ = 60, because the floor
  // quadrupled while the seasonality did not.
  check(worst / best > 4,
    `the cohort SEPARATES — worst/best MSE ratio is ${(worst / best).toFixed(0)}× (~11× expected at σ=60)`)
  check(best < 9000, `the best robot is near the σ² = 3,600 floor (${Math.round(best).toLocaleString()})`)
  // The top end is whichever of the flat-mean, noise-chasing or guessing robots drew
  // worst on the day — they cluster up there and their order between runs is noise.
  check(worst > 15000, `the worst robot is up in the no-method band (${Math.round(worst).toLocaleString()})`)

  // The single strongest coherence check in the build: the regression-fitter's realized
  // MSE against the value spec §2.3 predicts for that exact rule (902). If the draws,
  // the metrics, the grid rendering or the robot's own fit were wrong, this misses.
  check(best > 2000 && best < 7000,
    `the fitted-regression robot lands in the σ=60 band for its rule (~3,601, got ${Math.round(best).toLocaleString()})`)

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

  // ── The REPORTS PAGE, in a real browser, on this populated instance ────────
  //
  // ⚠ THE ONLY PLACE THIS CAN BE CHECKED. The student browser harness has no
  // instructor data, and the HTTP harness sees the payload but not the page. A cohort
  // instance is the one context where the five report tiles have something to render,
  // so the rendering assertions live here rather than in a harness that would have to
  // fabricate a class to run them.
  console.log('\nOpening the reports page…')
  {
    const { chromium } = require_('playwright')
    const browser = await chromium.launch({ headless: true })
    try {
      const page = await (await browser.newContext()).newPage()
      await page.goto(`${APP}/reports?game=forecast&_gid=${GID}`, { waitUntil: 'domcontentloaded' })
      await page.waitForSelector('[data-testid="fc-process-banner"]', { timeout: 30000 })

      const banner = (await page.locator('[data-testid="fc-process-banner"]').innerText()).trim()
      check(/560/.test(banner) && /230/.test(banner) && /sd 60/.test(banner),
        'the instructor banner states the true process (σ = 60 since 08-02)')
      check(/3,600/.test(banner), '…including the floor σ² = 3,600 it now implies')

      // ⚠ FIVE SEPARATE TILES (Elena, 08-02) — the grid format, not one long page.
      const titles = await page.locator('h3, h2').allInnerTexts()
      const body = await page.locator('body').innerText()
      for (const t of [
        'Outcomes — all students',
        'Debrief paragraphs — after play',
        'The five years students were given',
        'Forecast vs actual vs the true process, by month',
        'Class result against the benchmark rules',
        'Spread of student MSE',
      ]) check(body.includes(t), `tile present: "${t}"`)
      void titles

      check(!/Tier 3 — the class chart/.test(body),
        'the old un-informative "Tier 3 — the class chart" heading is gone')

      // ⚠ THE NEW HISTORY TILE (Elena, 08-02). Every other chart starts at the first
      // PLAYED month, so until this tile existed the reports could show what the class
      // did but not the data they were looking at when they did it.
      await page.locator('text=The five years students were given').first().click()
      await page.waitForSelector('[data-testid="fc-demand-chart"]', { timeout: 15000 })
      const yearRules = await page.locator('[data-testid^="fc-year-boundary-"]').count()
      check(yearRules >= 4, `the history chart marks its year boundaries (${yearRules} rules)`)
      check(await page.locator('[data-testid="fc-line-forecast"]').count() === 0,
        '…and draws NO forecast line — it is the given data, not anyone\'s play')
      // ⚠ The INSTRUCTOR's copy adds the true process as a dashed reference — "here is
      // what they were given, and here is what they were supposed to find in it".
      check(await page.locator('[data-testid="fc-line-systematic"]').count() === 1,
        '…but DOES draw the true systematic component, which the student never sees')
      await page.locator('text=Close').first().click()
      await page.waitForTimeout(200)

      // Open the outcomes tile and check the column order + the removed columns.
      await page.locator('text=Outcomes — all students').first().click()
      await page.waitForSelector('[data-testid="fc-tier1"]', { timeout: 15000 })
      const headers = await page.locator('[data-testid="fc-tier1"] thead th').allInnerTexts()
      // ⚠ STRIP THE SORT INDICATOR. SortableTable appends an arrow to the active
      // column's header ("MSE ↑"), so an exact-match lookup finds -1 and the order
      // assertion fails on a page that is perfectly correct — which is exactly what the
      // first version of this check did. Keep letters, digits, spaces and %; drop the rest.
      const clean = headers.map(h => h.replace(/[^A-Za-z0-9 %]/g, '').trim())
      console.log('  roster columns:', clean.join(' | '))

      // ⚠ KC AND PARTICIPATION ARE GONE (Elena, 08-02) — graded fields do not belong
      // on an OUTCOMES report.
      check(!clean.includes('KC'), '⚠ the KC column is gone')
      check(!clean.some(h => /participation/i.test(h)), '⚠ the Participation column is gone')

      // ⚠ Y6 · Y7 · MSE — the parts before the whole.
      const iY6 = clean.indexOf('Y6 MSE'), iY7 = clean.indexOf('Y7 MSE'), iMse = clean.indexOf('MSE')
      check(iY6 >= 0 && iY7 >= 0 && iMse >= 0, 'Y6 MSE, Y7 MSE and MSE are all present')
      check(iY6 < iY7 && iY7 < iMse,
        `⚠ column order is Y6 (${iY6}) → Y7 (${iY7}) → MSE (${iMse})`)

      // …and the arithmetic that ordering asserts: for a FINISHED student, MSE is the
      // mean of the two year MSEs. Checked against the report payload, independently.
      let mseOk = true
      for (const p of rep.participants.filter(x => x.completed)) {
        if (Math.abs((p.first_year_mse + p.second_year_mse) / 2 - p.mse) > 0.5) mseOk = false
      }
      check(mseOk, 'for every finished student, MSE === (Y6 MSE + Y7 MSE) / 2')

      await browser.close()
    } catch (e) {
      failed++
      console.error(`  ✗ reports page: ${e.message}`)
      await browser.close().catch(() => {})
    }
  }

  console.log(`\nINSTANCE: ${GID}`)
  console.log(`${'─'.repeat(70)}\n  ${passed} passed, ${failed} failed\n${'─'.repeat(70)}`)
  process.exitCode = failed > 0 ? 1 : 0
} finally {
  vite.kill('SIGKILL')
}
