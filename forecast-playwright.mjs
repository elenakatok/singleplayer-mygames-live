// ═══════════════════════════════════════════════════════════════════════════════
// Forecasting Game — REAL-BROWSER harness (spec §12).
//
// Drives the actual student UI in Chromium, through the same callables the shared UI
// invokes. The HTTP harness (forecast-playthrough.mjs) owns the server contract; this
// one owns everything that only exists once a browser has rendered it.
//
// ⚠ WHY THIS EXISTS SEPARATELY, AND WHAT IT IS FOR. Spec §4 says "the chart is not
// decoration": a sixty-point line with no year boundaries and no month labels is
// unreadable, and the whole exercise fails at the first screen. That is a claim about
// RENDERED OUTPUT, and no amount of server-side assertion touches it. So this harness
// asserts, in the DOM:
//   • the chart exists, with year-boundary rules and month tick labels;
//   • the month-by-year grid renders the §2.1 layout, and grows as months are revealed;
//   • the forecast line appears as a SECOND series once a month has been played;
//   • the high season is NOT shaded (spec §4 — spotting it is the exercise);
//   • the history table carries the ten columns spec §4 lists, signed error included;
//   • `key={screen.id}` isolation holds between months (the PD bug class, spec §12).
//
// ⚠ IT ALSO AUDITS EVERY RESPONSE THE BROWSER ACTUALLY RECEIVED. The HTTP harness
// audits what the server sends when the harness asks; this audits what the real client
// was handed while a real person played, which is the payload that would actually leak.
//
// Run:  npm run harness:forecast:browser
//       HEADED=1 npm run harness:forecast:browser     ← watch it play
// ═══════════════════════════════════════════════════════════════════════════════

import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PROJECT = 'demo-singleplayer'
const FIRESTORE = `http://127.0.0.1:8090/v1/projects/${PROJECT}/databases/(default)/documents`
const ROOT = path.dirname(fileURLToPath(import.meta.url))
const VITE_PORT = 5198
const APP = `http://localhost:${VITE_PORT}`
const HEADED = process.env.HEADED === '1'
/** Set SHOTS=<dir> to save screenshots of the chart and the two key screens. Spec §4's
 *  "the chart is not decoration" is a claim about rendered output that only a human can
 *  finally judge, so the harness can produce the images on request. */
const SHOTS = process.env.SHOTS ?? null

let passed = 0, failed = 0
const check = (cond, label) => {
  if (cond) { passed++; console.log(`  ✓ ${label}`) }
  else { failed++; console.error(`  ✗ ${label}`) }
}
const section = (t) => console.log(`\n${t}`)

// ── Emulator plumbing ──────────────────────────────────────────────────────────

async function putDoc(docPath, fields) {
  const res = await fetch(`${FIRESTORE}/${docPath}`, {
    method: 'PATCH',
    headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields }),
  })
  if (!res.ok) throw new Error(`firestore PATCH ${docPath} → ${res.status} ${await res.text()}`)
}

const intVal = (n) => ({ integerValue: String(n) })
const strVal = (s) => ({ stringValue: s })
const boolVal = (b) => ({ booleanValue: b })
const arrVal = (xs) => ({ arrayValue: { values: xs } })

/** The shipped model (spec §2). ⚠ rounds and num_history ALWAYS explicit. */
const MODEL = { a: 560, b: 4, H: 230, sigma: 30, high: [11, 12] }
const ROUNDS = 4

async function openInstance(gid) {
  await putDoc(`forecast_game_instances/${gid}/config/main`, {
    num_history: intVal(60),
    rounds: intVal(ROUNDS),
    forecast_min: intVal(0),
    forecast_max: intVal(3000),
    kc_enabled: boolVal(false),
    debrief_enabled: boolVal(false),
  })
  await putDoc(`forecast_game_instances/${gid}/truth/main`, {
    intercept: intVal(MODEL.a),
    trend: intVal(MODEL.b),
    high_season_lift: intVal(MODEL.H),
    high_season_months: arrVal(MODEL.high.map(intVal)),
    sigma: intVal(MODEL.sigma),
    seasonality: strVal('additive'),
    season_structure: strVal('twoSeason'),
    demand_draw: strVal('perStudent'),
    seed: strVal('browser-seed'),
  })
}

/** Spec §2.1's published history — the first and last values, for a spot check. */
const SPEC_HISTORY_FIRST = 603
const SPEC_HISTORY_LAST = 1000

// ── The Vite dev server ────────────────────────────────────────────────────────

async function startVite() {
  const child = spawn('npx', ['vite', '--port', String(VITE_PORT), '--strictPort', '--host', '127.0.0.1'], {
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
    try { const res = await fetch(APP); if (res.ok) return child } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 250))
  }
  child.kill('SIGKILL')
  throw new Error('vite dev server did not start within 60s')
}

// ── Browser helpers ────────────────────────────────────────────────────────────

const studentUrl = (gid, pid) => `${APP}/?game=forecast&_pid=${pid}&_gid=${gid}`
const testId = async (page, id) => (await page.locator(`[data-testid="${id}"]`).first().innerText()).trim()
const count = (page, sel) => page.locator(sel).count()
const exists = async (page, sel) => (await count(page, sel)) > 0
/** innerText is an HTMLElement API and THROWS on an SVG node, so anything inside the
 *  chart has to be read with textContent instead. */
const svgText = async (page, id) =>
  ((await page.locator(`[data-testid="${id}"]`).first().textContent()) ?? '').trim()

/** Every callable response this browser actually received, for the leak audit. */
function captureResponses(page, sink) {
  page.on('response', async (res) => {
    if (!/us-central1\/forecast/.test(res.url())) return
    try { sink.push({ url: res.url(), body: await res.text() }) } catch { /* ignore */ }
  })
}

async function main() {
  const stamp = Date.now()
  console.log('\nBooting the Vite dev server…')
  const vite = await startVite()
  const browser = await chromium.launch(HEADED ? { headless: false, slowMo: 90 } : {})

  try {
    const gid = `fc-br-${stamp}`
    const pid = 'fc-br-stu'
    await openInstance(gid)

    const ctx = await browser.newContext()
    const page = await ctx.newPage()
    const responses = []
    captureResponses(page, responses)
    const consoleErrors = []
    page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()) })
    page.on('pageerror', e => consoleErrors.push(String(e)))

    await page.goto(studentUrl(gid, pid))
    await page.waitForSelector('[data-testid="fc-round-heading"]', { timeout: 30_000 })

    // ───────────────────────────────────────────────────────────────────────
    section('[1] The forecast-entry screen (spec §4)')
    // ───────────────────────────────────────────────────────────────────────
    check((await testId(page, 'fc-round-heading')) === 'Year 6, January',
      'the header names the month: "Year 6, January"')
    check(/1 of 4/.test(await testId(page, 'fc-round-progress')),
      'the horizon is SHOWN — "month 1 of 4" (spec §4, §15)')
    check(await exists(page, '[data-testid="fc-forecast-input"]'), 'there is one integer input')
    check(await exists(page, '[data-testid="fc-metric-reminder"]'),
      'the metric definitions and the objective are restated')
    const reminder = await testId(page, 'fc-metric-reminder')
    check(/MSE/.test(reminder) && /objective/i.test(reminder),
      '…and MSE is named as the objective')
    check(/Standard Error/.test(reminder) && !/RMSE/.test(reminder),
      '⚠ √MSE is labelled "Standard Error", never "RMSE" (spec §0, §5)')

    // ───────────────────────────────────────────────────────────────────────
    section('[2] ⚠ THE CHART IS NOT DECORATION (spec §4)')
    // ───────────────────────────────────────────────────────────────────────
    check(await exists(page, '[data-testid="fc-demand-chart"]'), 'the demand chart renders')
    check(await exists(page, '[data-testid="fc-line-actual"]'), '…with the demand line drawn')

    // Year boundaries: rules at Y2…Y7, plus a label per year.
    const boundaries = await count(page, '[data-testid^="fc-year-boundary-"]')
    check(boundaries >= 5, `year BOUNDARIES are marked (${boundaries} rules)`)
    const yearLabels = await count(page, '[data-testid^="fc-year-label-"]')
    check(yearLabels >= 6, `each year is LABELLED (${yearLabels} labels)`)
    check((await svgText(page, 'fc-year-label-1')) === 'Y1', '…starting at Y1')

    // Month labels: thinned to quarters, but present and named.
    const monthTicks = await count(page, '[data-testid^="fc-month-tick-"]')
    check(monthTicks >= 20, `months are LABELLED along the axis (${monthTicks} ticks)`)
    check((await svgText(page, 'fc-month-tick-1')) === 'Jan',
      '…by NAME — "the peak is in November" is a usable finding, "month 47" is not')

    // ⚠ The high season is NOT shaded — spotting it is the exercise (spec §4).
    const chartHtml = await page.locator('[data-testid="fc-demand-chart"]').innerHTML()
    check(!/highseason|season-band|holiday/i.test(chartHtml),
      '⚠ the high season is NOT shaded — noticing it is the exercise (spec §4, §7)')

    // A shot of the opening screen. Spec §4's claim — "a 60-point line is unreadable
    // without year boundaries and month labels" — is about how the chart LOOKS, and an
    // assertion that the elements exist does not establish that it reads well. The
    // image is for a human to judge.
    if (SHOTS) {
      await page.locator('[data-testid="fc-demand-chart"]').screenshot({ path: `${SHOTS}/chart-opening.png` })
      await page.screenshot({ path: `${SHOTS}/entry-screen.png`, fullPage: true })
    }

    // Before any month is played there is no forecast line to draw.
    check(!(await exists(page, '[data-testid="fc-line-forecast"]')),
      'no forecast line before the first month is played')

    // ───────────────────────────────────────────────────────────────────────
    section('[3] The month-by-year grid (spec §4, laid out as §2.1)')
    // ───────────────────────────────────────────────────────────────────────
    check(await exists(page, '[data-testid="fc-month-grid"]'), 'the grid renders')
    check((await count(page, '[data-testid^="fc-grid-row-"]')) === 5,
      'five rows — one per year of history')
    check((await testId(page, 'fc-grid-cell-1')) === String(SPEC_HISTORY_FIRST),
      `Y1 Jan is the published ${SPEC_HISTORY_FIRST} (spec §2.1)`)
    check((await testId(page, 'fc-grid-cell-60')) === '1,000',
      `Y5 Dec is the published ${SPEC_HISTORY_LAST}`)
    // The seasonality has to be VISIBLE in the grid — that is its whole job.
    const y1nov = Number((await testId(page, 'fc-grid-cell-11')).replace(/,/g, ''))
    const y1jun = Number((await testId(page, 'fc-grid-cell-6')).replace(/,/g, ''))
    check(y1nov > y1jun, 'November towers over June in Y1 — the season is visible by eye')

    // ───────────────────────────────────────────────────────────────────────
    section('[4] The data export (spec §4 — "load-bearing")')
    // ───────────────────────────────────────────────────────────────────────
    check(await exists(page, '[data-testid="fc-export-download"]'),
      'the "Download demand history (CSV)" button is on the entry screen')
    check(await exists(page, '[data-testid="fc-export-copy"]'),
      '…and a copy-to-clipboard button beside it')
    // ⚠ WHITESPACE IS NORMALIZED BEFORE MATCHING. The copy uses a NON-BREAKING space
    // in "Years&nbsp;1–5" so the range never wraps mid-label, and innerText returns
    // that as   — a plain-space regex silently misses it. The requirement is that
    // the label SAYS "Years 1–5" (spec §4), not that it uses a particular space
    // character, so the assertion normalizes rather than the copy degrading.
    const bodyText = (await page.locator('body').innerText()).replace(/ /g, ' ')
    check(/Years 1–5/.test(bodyText),
      'the file is LABELLED as the five-year history, frozen (spec §4)')
    check(/does not change as you play/.test(bodyText),
      '…and the screen says so explicitly, since the file deliberately does not grow')

    // ───────────────────────────────────────────────────────────────────────
    section('[5] Playing a month — the results screen (spec §4)')
    // ───────────────────────────────────────────────────────────────────────
    await page.fill('[data-testid="fc-forecast-input"]', '800')
    await page.click('[data-testid="fc-submit-forecast"]')
    await page.waitForSelector('[data-testid="fc-results-heading"]', { timeout: 15_000 })

    check(/Year 6, January/.test(await testId(page, 'fc-results-heading')),
      'the results screen names the month just played')
    check((await testId(page, 'fc-result-forecast')) === '800', 'the card shows the forecast')
    const actual = Number((await testId(page, 'fc-result-actual')).replace(/,/g, ''))
    check(Number.isFinite(actual) && actual > 0, `…and the revealed actual demand (${actual})`)

    // The per-month figures, recomputed in the browser from what is on screen.
    const shownError = (await testId(page, 'fc-result-error')).replace(/[+,]/g, '')
    check(Number(shownError) === actual - 800,
      'the error on screen is actual − forecast, with its sign')
    const shownSe = Number((await testId(page, 'fc-result-se')).replace(/,/g, ''))
    check(shownSe === (actual - 800) ** 2, 'the squared error on screen is the error squared')

    // The scorecard.
    check(await exists(page, '[data-testid="fc-scorecard"]'), 'the running scorecard renders')
    check((await testId(page, 'fc-scorecard-mse')) === String(shownSe.toLocaleString('en-US')),
      'after one month, running MSE is that month\'s squared error')
    const scoreText = await testId(page, 'fc-scorecard')
    check(/Standard Error/.test(scoreText), 'the scorecard names Standard Error')
    check(/MAPE/.test(scoreText) && /Forecast Accuracy/.test(scoreText),
      '…and MAPE and Forecast Accuracy beside it (spec §5a)')
    check(/\$/.test(await testId(page, 'fc-scorecard-bonus')), '…and the running bonus')

    // ⚠ The forecast line now exists — "the cheapest learning aid in the game" (§4).
    check(await exists(page, '[data-testid="fc-line-forecast"]'),
      '⚠ the student\'s forecasts are plotted as a SECOND line (spec §4)')

    // The history table and its ten columns.
    check(await exists(page, '[data-testid="fc-history-table"]'), 'the history table renders')
    const headers = await page.locator('[data-testid="fc-history-table"] thead th').allInnerTexts()
    for (const col of ['Month', 'Your forecast', 'Actual demand', 'Error', 'Absolute error',
      'Squared error', 'Absolute % error', 'MAE to date', 'MSE to date', 'MAPE to date']) {
      check(headers.includes(col), `the table has the "${col}" column (spec §4)`)
    }
    check((await testId(page, 'fc-history-row-1')).length > 0, 'the played month appears as a row')

    // ───────────────────────────────────────────────────────────────────────
    section('[6] key={screen.id} isolation between months (the PD bug class, spec §12)')
    // ───────────────────────────────────────────────────────────────────────
    await page.click('[data-testid="fc-continue"]')
    await page.waitForSelector('[data-testid="fc-round-heading"]', { timeout: 15_000 })
    check((await testId(page, 'fc-round-heading')) === 'Year 6, February',
      'continuing advances to the next month')
    const carried = await page.inputValue('[data-testid="fc-forecast-input"]')
    check(carried === '',
      '⚠ the forecast box is EMPTY — the previous month\'s input did not survive the remount')
    check(/2 of 4/.test(await testId(page, 'fc-round-progress')), 'the progress line advanced')
    // The grid has grown by the revealed month.
    check(await exists(page, '[data-testid="fc-grid-cell-61"]'),
      'the month-by-year grid has grown a Y6 row with the revealed month')

    // ───────────────────────────────────────────────────────────────────────
    section('[7] Finishing the game → the final results screen (spec §5)')
    // ───────────────────────────────────────────────────────────────────────
    for (let round = 2; round <= ROUNDS; round++) {
      await page.fill('[data-testid="fc-forecast-input"]', String(780 + round * 10))
      await page.click('[data-testid="fc-submit-forecast"]')
      await page.waitForSelector('[data-testid="fc-results-heading"]', { timeout: 15_000 })
      await page.click('[data-testid="fc-continue"]')
      if (round < ROUNDS) {
        await page.waitForSelector('[data-testid="fc-round-heading"]', { timeout: 15_000 })
      }
    }
    await page.waitForSelector('[data-testid="fc-final-heading"]', { timeout: 15_000 })

    check(await exists(page, '[data-testid="fc-final-scorecard"]'), 'the final scorecard renders')
    check(await exists(page, '[data-testid="fc-bonus-statement"]'),
      'the bonus is stated in the SoPHIE framing (spec §5)')
    check(/holiday bonus would have been/.test(await testId(page, 'fc-bonus-statement')),
      '…in those words')
    check(await exists(page, '[data-testid="fc-final-export-download"]'),
      'the full 84-month CSV export is offered here (spec §5)')
    if (SHOTS) {
      await page.locator('[data-testid="fc-demand-chart"]').screenshot({ path: `${SHOTS}/chart-final.png` })
      await page.screenshot({ path: `${SHOTS}/final-screen.png`, fullPage: true })
    }
    check((await count(page, '[data-testid^="fc-history-row-"]')) === ROUNDS,
      'the complete table lists every month played')
    // No class comparison — the family rule (architecture §2.2).
    const finalText = await page.locator('body').innerText()
    check(!/class average|compared with other|percentile|rank/i.test(finalText),
      'no class comparison on a student display screen (architecture §2.2)')
    // The benchmark table belongs to the debrief, not here.
    check(!/five-year mean|moving average|regression/i.test(finalText),
      'the benchmark table does NOT appear before the debrief (spec §9)')

    // ───────────────────────────────────────────────────────────────────────
    section('[8] ⚠ THE LEAK AUDIT — on what THIS BROWSER actually received')
    // ───────────────────────────────────────────────────────────────────────
    check(responses.length > 0, `captured ${responses.length} callable responses`)
    const all = responses.map(r => r.body).join('\n')
    const bannedKeys = /"(a|b|H|sigma|intercept|trend|highSeasonMonths|high_season_lift|seasonality|seasonStructure|monthOffsets|demandDraw|seed)"\s*:/
    check(!bannedKeys.test(all),
      '⚠ no response the browser received carries a model-parameter key')
    check(!/"systematic"|"trueMean"|"floorMse"/.test(all),
      '…nor a derived form of the process')

    // The futures: the student played 4 of 4, so period 84 is legitimately present —
    // but a student who has played 4 months of a 24-month game must see no month 65+.
    const partialGid = `fc-br2-${stamp}`
    await openInstance(partialGid)
    const page2 = await ctx.newPage()
    const responses2 = []
    captureResponses(page2, responses2)
    await page2.goto(studentUrl(partialGid, 'fc-br-stu2'))
    await page2.waitForSelector('[data-testid="fc-round-heading"]', { timeout: 30_000 })
    await page2.fill('[data-testid="fc-forecast-input"]', '800')
    await page2.click('[data-testid="fc-submit-forecast"]')
    await page2.waitForSelector('[data-testid="fc-results-heading"]', { timeout: 15_000 })
    const partial = responses2.map(r => r.body).join('\n')
    const periods = [...partial.matchAll(/"period"\s*:\s*(\d+)/g)].map(m => Number(m[1]))
    check(periods.length > 0 && Math.max(...periods) <= 61,
      `⚠ after one month, no response mentions a month past 61 (max ${Math.max(...periods)})`)
    await page2.close()

    check(consoleErrors.length === 0,
      `no console errors during the playthrough${consoleErrors.length ? `: ${consoleErrors[0]}` : ''}`)

    await ctx.close()
  } finally {
    await browser.close()
    vite.kill('SIGKILL')
  }

  console.log(`\n${'─'.repeat(70)}`)
  console.log(`  ${passed} passed, ${failed} failed`)
  console.log('─'.repeat(70))
  if (failed > 0) process.exit(1)
}

main().catch(err => { console.error(err); process.exit(1) })
