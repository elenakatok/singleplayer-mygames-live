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
// The SHIPPED auto-drive sequence — the same module the launcher's "Start at game" runs
// before it opens a student tab. Imported rather than reimplemented so the tab this
// harness opens is the tab Elena gets.
import { driveForecastStudentPastKc } from './bot/forecast-autodrive.mjs'

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

const FUNCTIONS = `http://127.0.0.1:5010/${PROJECT}/us-central1`

/** Callable transport, for the parts of a launch that happen BEFORE a tab exists. */
async function callFn(name, data) {
  const res = await fetch(`${FUNCTIONS}/${name}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data }),
  })
  let body = null
  try { body = await res.json() } catch { /* ignore */ }
  if (res.ok && body && 'result' in body) return body.result
  throw new Error(`${name}: ${body?.error?.message ?? `http ${res.status}`}`)
}

async function getDoc(docPath) {
  const res = await fetch(`${FIRESTORE}/${docPath}`, { headers: { Authorization: 'Bearer owner' } })
  if (!res.ok) return null
  return (await res.json()).fields ?? null
}

const intVal = (n) => ({ integerValue: String(n) })
const strVal = (s) => ({ stringValue: s })
const boolVal = (b) => ({ booleanValue: b })
const arrVal = (xs) => ({ arrayValue: { values: xs } })

/** The shipped model (spec §2). ⚠ rounds and num_history ALWAYS explicit. */
const MODEL = { a: 560, b: 4, H: 230, sigma: 60, high: [11, 12] }
const ROUNDS = 4

async function openInstance(gid, opts = {}) {
  await putDoc(`forecast_game_instances/${gid}/config/main`, {
    num_history: intVal(60),
    rounds: intVal(ROUNDS),
    forecast_min: intVal(0),
    forecast_max: intVal(3000),
    kc_enabled: boolVal(opts.kc ?? true),
    debrief_enabled: boolVal(opts.debrief ?? true),
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
const SPEC_HISTORY_FIRST = 665
const SPEC_HISTORY_LAST = 1048

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

    // ───────────────────────────────────────────────────────────────────────
    section('[0] The knowledge check comes FIRST (spec §4, §8)')
    // ───────────────────────────────────────────────────────────────────────
    await page.waitForSelector('[data-testid="fc-kc-prompt"]', { timeout: 30_000 })
    check(true, 'the flow opens on the knowledge check, not the month loop')

    // ⚠ THE GAME'S OWN DATA IS NOT ON THE KC SCREEN. The KC runs before play and checks
    // the LECTURE; showing the demand history beside it would invite answering from the
    // chart instead of from the method.
    check(!(await exists(page, '[data-testid="fc-demand-chart"]')),
      '⚠ the demand chart is NOT on the knowledge-check screen')
    check(!(await exists(page, '[data-testid="fc-month-grid"]')),
      '⚠ nor is the month-by-year grid')

    // Answer all nine, taking the first option each time (correctness is irrelevant —
    // the KC is not a gate).
    let kcCount = 0
    for (let i = 0; i < 20; i++) {
      if (!(await exists(page, '[data-testid="fc-kc-prompt"]'))) break
      const prompt = await testId(page, 'fc-kc-prompt')
      check(prompt.length > 10, `question ${i + 1} renders a prompt`)
      await page.locator('[data-testid^="fc-kc-option-"] input').first().check()
      await page.click('[data-testid="fc-kc-submit"]')
      await page.waitForSelector('[data-testid="fc-kc-verdict"]', { timeout: 15_000 })
      // ⚠ The explanation is EARNED — it arrives with the verdict, not with the question.
      if (i === 0) {
        const verdict = await testId(page, 'fc-kc-verdict')
        check(verdict.length > 20, 'the verdict carries an explanation, returned on submit')
      }
      kcCount++
      await page.click('[data-testid="fc-kc-continue"]')
      await page.waitForTimeout(120)
    }
    check(kcCount === 9, `all NINE knowledge-check questions were served (got ${kcCount})`)

    await page.waitForSelector('[data-testid="fc-round-heading"]', { timeout: 15_000 })

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

    // ⚠⚠ AND NO SYSTEMATIC REFERENCE, EVER. DemandChartSVG takes an optional
    // `reference` prop that draws the TRUE process — the reports page passes it, and a
    // student screen never may. It is the worst leak available in this game: the
    // process is exactly what the exercise asks them to infer.
    check(!(await exists(page, '[data-testid="fc-line-systematic"]')),
      '⚠⚠ the student chart draws NO true-process reference line')

    // ───────────────────────────────────────────────────────────────────────
    section('[3] The month-by-year grid (spec §4, laid out as §2.1)')
    // ───────────────────────────────────────────────────────────────────────
    check(await exists(page, '[data-testid="fc-month-grid"]'), 'the grid renders')
    check((await count(page, '[data-testid^="fc-grid-row-"]')) === 5,
      'five rows — one per year of history')
    check((await testId(page, 'fc-grid-cell-1')) === String(SPEC_HISTORY_FIRST),
      `Y1 Jan is the published ${SPEC_HISTORY_FIRST} (spec §2.1)`)
    check((await testId(page, 'fc-grid-cell-60')) === '1,048',
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
    check(!(await exists(page, '[data-testid="fc-line-systematic"]')),
      '⚠⚠ …and still NO true-process reference, now that months have been played')

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
    section('[7b] ⚠⚠ THE DEBRIEF, AND THE REVEAL BEHIND IT (spec §9)')
    // ───────────────────────────────────────────────────────────────────────
    await page.click('[data-testid="fc-final-continue"]')
    await page.waitForSelector('[data-testid="fc-debrief-text"]', { timeout: 15_000 })
    check(await exists(page, '[data-testid="fc-debrief-prompt"]'), 'the debrief question is asked')

    // ⚠ THE REVEAL IS NOT ON SCREEN YET, and not in the page at all.
    const beforeText = await page.locator('body').innerText()
    check(!/560|230|systematic component|standard deviation of/i.test(beforeText),
      '⚠ the process is NOT revealed before the paragraph is written')
    check(!(await exists(page, '[data-testid="fc-reveal"]')), '…and the reveal panel is absent')

    await page.fill('[data-testid="fc-debrief-text"]', 'I fitted a trend plus a November/December dummy in Excel.')
    await page.click('[data-testid="fc-debrief-submit"]')
    await page.waitForSelector('[data-testid="fc-reveal"]', { timeout: 15_000 })

    check(await exists(page, '[data-testid="fc-reveal-process"]'), 'the true process is revealed on submit')
    const revealText = await testId(page, 'fc-reveal-process')
    check(/560/.test(revealText) && /230/.test(revealText),
      'the reveal names the intercept and the high-season lift')
    check(/November and December/.test(revealText), '…and names the high season in words')
    check(await exists(page, '[data-testid="fc-benchmark-table"]'),
      'the §2.3 benchmark table is shown beside their own MSE (spec §9)')
    check(await exists(page, '[data-testid="fc-benchmark-reg_holiday"]'),
      "…including the lecture's own model")
    check(await exists(page, '[data-testid="fc-benchmark-yours"]'),
      "…and the student's own row, placed in the same table")
    const floorText = await testId(page, 'fc-reveal-floor')
    // ⚠ σ² = 3,600 at the shipped σ = 60. This asserted 900 while the harness seeded
    // σ = 30 of its own; both are now aligned to the real game.
    check(/3,600/.test(floorText), 'the floor σ² = 3,600 is stated')

    // ⚠ RESUME: a reload must land back on the reveal, not on a dead end.
    await page.reload()
    await page.waitForSelector('[data-testid="fc-reveal"]', { timeout: 30_000 })
    check(true, '⚠ reloading after the debrief returns to the REVEAL, not a dead end (spec §4, §9)')

    // ───────────────────────────────────────────────────────────────────────
    section('[8] ⚠ THE LEAK AUDIT — on what THIS BROWSER actually received')
    // ───────────────────────────────────────────────────────────────────────
    check(responses.length > 0, `captured ${responses.length} callable responses`)

    // ⚠⚠ PARTITIONED BY CALLABLE, NOT LUMPED TOGETHER. The reveal legitimately carries
    // the model (spec §9) — it is the whole point of the debrief screen — so a blanket
    // "no model anywhere" assertion would fail on correct behaviour. The MEANINGFUL
    // claim is sharper and is what is asserted here:
    //
    //     the model appears in EXACTLY the two GATED endpoints, and nowhere else.
    //
    // That is a stronger statement than the blanket one, because it also fails if the
    // model stops appearing where it should — i.e. if the reveal silently breaks.
    const REVEAL_FNS = /forecastSubmitDebrief|forecastGetReveal/
    const modelKeys = /"(intercept|trend|highSeasonLift|highSeasonMonths|sigma|floorMse|seasonality)"\s*:/

    const gated = responses.filter(r => REVEAL_FNS.test(r.url))
    const ungated = responses.filter(r => !REVEAL_FNS.test(r.url))

    check(gated.length > 0, `the two gated reveal endpoints were exercised (${gated.length} responses)`)
    check(gated.some(r => modelKeys.test(r.body)),
      'the reveal DOES carry the process — the debrief screen works (spec §9)')

    const leaked = ungated.filter(r => modelKeys.test(r.body))
    check(leaked.length === 0,
      `⚠⚠ NO UNGATED response carries a model parameter${leaked.length ? ` (${leaked[0].url})` : ''}`)

    const ungatedBodies = ungated.map(r => r.body).join('\n')
    check(!/"seed"\s*:/.test(responses.map(r => r.body).join('\n')),
      '⚠ the SEED appears in NO response at all — not even the reveal')
    // ⚠ KEY POSITION, NOT BARE SUBSTRING. The first draft matched `"systematic"`
    // anywhere and false-positived on the knowledge check, whose Q1 has an OPTION whose
    // value is literally "systematic" — a question about systematic variability is
    // supposed to say the word. A leak is a KEY, so the colon is what makes the match
    // mean anything.
    check(!/"(systematic|trueMean|model)"\s*:/.test(ungatedBodies),
      '…nor a derived form of the process on an ungated payload')

    // And the ungated set is not trivially small — the audit has real coverage.
    check(ungated.length >= 4,
      `the ungated audit covers ${ungated.length} responses across the whole flow`)

    // The futures: the student played 4 of 4, so period 84 is legitimately present —
    // but a student who has played 4 months of a 24-month game must see no month 65+.
    // ⚠ NO KC ON THIS INSTANCE, deliberately. This check is about the FUTURES — that a
    // student one month in sees no month past 61 — so the nine knowledge-check screens
    // in front of the loop are nine round-trips of noise. Turning the KC off keeps the
    // assertion pointed at the thing it is testing.
    const partialGid = `fc-br2-${stamp}`
    await openInstance(partialGid, { kc: false, debrief: false })
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

    // ───────────────────────────────────────────────────────────────────────────
    section('[LAUNCHER] ⚠ "Start at game" — the auto-drive the launcher runs')
    // ───────────────────────────────────────────────────────────────────────────
    // ⚠ THIS OPTION SHIPPED DOING NOTHING (Elena, 08-03). The launcher offered the
    // second start position for forecast, and choosing it left the student on the
    // knowledge check — there was no driver behind the radio at all. What makes that
    // bug possible is a sequence that nobody executes in test, so the sequence is
    // executed here, from the SHIPPED module, and the tab is then opened to see where
    // a student actually lands.
    {
      const GID_D = `pw-drive-${stamp}`
      const DPID = 'pw-drive-stu'
      await openInstance(GID_D)

      const drove = await driveForecastStudentPastKc(
        callFn,
        { _test: { participant_id: DPID, game_instance_id: GID_D } },
      )
      check(drove.kcEnabled === true, 'the drive reports the KC it found')
      check(drove.questionsAnswered === 9 && drove.kcTotal === 9,
        `it answered every knowledge-check question (${drove.questionsAnswered}/${drove.kcTotal})`)

      // Recorded SERVER-SIDE, so the student is past it for good rather than appearing
      // to be — the launcher's whole claim rests on this being durable.
      const droveDoc = await getDoc(`forecast_game_instances/${GID_D}/participants/${DPID}`)
      check(droveDoc?.kc_static_answers != null, 'the answers are RECORDED on the participant')
      check(droveDoc?.knowledge_check_score != null, '…with a score stamped')

      // Now open the tab, exactly as the launcher does after driving.
      const ctxD = await browser.newContext()
      const pageD = await ctxD.newPage()
      await pageD.goto(studentUrl(GID_D, DPID))
      await pageD.waitForSelector('[data-testid="fc-round-heading"], [data-testid="fc-kc-prompt"]',
        { timeout: 30_000 })

      check(await exists(pageD, '[data-testid="fc-round-heading"]'),
        '⚠ the opened tab lands on the FORECAST-ENTRY screen')
      check(!(await exists(pageD, '[data-testid="fc-kc-prompt"]')),
        '…not on the knowledge check')
      check((await testId(pageD, 'fc-round-heading')).includes('Year 6'),
        'on the first playable month, with nothing yet forecast')
      check(await exists(pageD, '[data-testid="fc-demand-chart"]'),
        '…and the five-year history is already on screen')

      // ⚠ THE TAB STAYS OPEN. An opened student tab is something Elena inspects.
      await new Promise(r => setTimeout(r, 1500))
      check(!pageD.isClosed(), '⚠ the tab is STILL OPEN after the drive (not auto-closed)')

      // A re-drive is the normal case — Elena reopens a tab — and must not disturb
      // anything. ⚠ IT IS NOT A COUNT OF ZERO: forecastSubmitKcAnswer accepts the second
      // submission, DISCARDS it and returns the stored result, so the drive sees nine
      // successes. The property that matters is that the STORED answers and the score
      // are untouched — a re-drive must not be able to overwrite a wrong answer with a
      // right one, which is exactly what that server-side discard exists to prevent.
      const before = JSON.stringify(droveDoc?.kc_static_answers)
      const beforeScore = JSON.stringify(droveDoc?.knowledge_check_score)
      const again = await driveForecastStudentPastKc(
        callFn, { _test: { participant_id: DPID, game_instance_id: GID_D } })
      check(again.questionsAnswered === 9, 're-driving the same student does not throw')
      const afterDoc = await getDoc(`forecast_game_instances/${GID_D}/participants/${DPID}`)
      check(JSON.stringify(afterDoc?.kc_static_answers) === before,
        '⚠ …and the stored answers are BYTE-IDENTICAL — a re-drive cannot re-answer')
      check(JSON.stringify(afterDoc?.knowledge_check_score) === beforeScore,
        '…nor move the score')

      // KC switched off: nothing to skip, and the drive must not invent work or fail.
      const GID_NK = `pw-drive-nokc-${stamp}`
      await openInstance(GID_NK, { kc: false })
      const droveNoKc = await driveForecastStudentPastKc(
        callFn, { _test: { participant_id: 'pw-drive-nokc-stu', game_instance_id: GID_NK } })
      check(droveNoKc.kcEnabled === false && droveNoKc.questionsAnswered === 0,
        'with the KC disabled the drive is a clean no-op')

      await pageD.close()
      await ctxD.close()
    }

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
