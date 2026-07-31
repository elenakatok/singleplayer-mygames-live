// ═══════════════════════════════════════════════════════════════════════════════
// Newsvendor (REGULAR) — REAL BROWSER harness (Playwright + Chromium).
//
// newsvendor-playthrough.mjs beside this one drives the callables over HTTP: it proves
// the SERVER is right. This one drives the actual UI in a real browser against the real
// emulator, and proves the GAME is right — that a student clicking through the page gets
// a correct, complete, non-leaking experience. It is ADDITIONAL coverage, not a
// replacement: the HTTP harness still owns the server contract.
//
// The plumbing (vite boot, emulator seeding, response capture) is copied from
// pd-playwright.mjs / pricing-playwright.mjs, which were written to be copied; only the
// selectors and the assertions are this game's.
//
// WHAT IT COVERS, end to end:
//   • the TEN-QUESTION GRADED KC FIRST, before anything else;
//   • the prep paragraph, after the KC and before the first period;
//   • the place-order screen — the parameter box (with zero-valued lines SUPPRESSED),
//     the demand box, the bounds, and the calculator;
//   • the whole period loop to the CONFIGURED period count, with every profit, every
//     units-over/short and every service level predicted from the spec and checked
//     against the rendered results screen AND the rendered history row;
//   • browser-side order validation gating submit;
//   • resume — reload mid-loop and land on the right period with history intact;
//   • the final-results screen, then the debrief;
//   • ⚠ NO BENCHMARK ANYWHERE — not in the page text, not in any callable response the
//     browser actually received, at any point in the flow (spec §9.2);
//   • a FULL DUAL-SOURCING game — the dual KC, the relabelled screens, both the
//     top-up and leftover paths, the dual debrief, and its own leak audit;
//   • the ANALYTICAL expected-profit chart — rendering with NO students, starting
//     regular-only, and revealing the dual curve when its legend entry is clicked;
//   • the outcomes table — In-stock %, no Participation column, and no overflow;
//   • the INSTRUCTOR dashboard and all five report tiles against a MIXED population;
//   • ⚠ the dashboard's manual REFRESH button picking up play that happened after the
//     page opened — and staying stale until it is clicked, which is the design.
//
// Run:
//   npm install && npx playwright install chromium     (once)
//   npm run harness:newsvendor:browser
//   HEADED=1 npm run harness:newsvendor:browser        ← watch it play
// ═══════════════════════════════════════════════════════════════════════════════

import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PROJECT = 'demo-singleplayer'
const FUNCTIONS = `http://127.0.0.1:5010/${PROJECT}/us-central1`
const FIRESTORE = `http://127.0.0.1:8090/v1/projects/${PROJECT}/databases/(default)/documents`
const ROOT = path.dirname(fileURLToPath(import.meta.url))
const VITE_PORT = 5197
const APP = `http://localhost:${VITE_PORT}`
const HEADED = process.env.HEADED === '1'

let passed = 0, failed = 0
const check = (cond, label) => {
  if (cond) { passed++; console.log(`  ✓ ${label}`) }
  else { failed++; console.error(`  ✗ ${label}`) }
}

// ── Emulator plumbing ──────────────────────────────────────────────────────────

async function callFn(name, data) {
  const res = await fetch(`${FUNCTIONS}/${name}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data }),
  })
  let body = null
  try { body = await res.json() } catch { /* ignore */ }
  if (res.ok && body && 'result' in body) return { ok: true, result: body.result }
  return { ok: false, error: body?.error?.message ?? `http ${res.status}` }
}

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
const asStudent = (gid, pid, extra = {}) => ({ _test: { participant_id: pid, game_instance_id: gid }, ...extra })

// ── The spec, re-implemented independently ─────────────────────────────────────

/** ⚠ `periods` EXPLICIT — never inherited from the shipped default. */
const CFG = {
  P: 3000, c: 1000, v: 800, g: 150, h: 300,
  isNormal: true, mean: 1000, sd: 300, minD: 0, maxD: 100, periods: 4,
}
/** A second instance with g = 0 and v = 0, to prove the zero-line suppression. */
const CFG_NO_EXTRAS = { ...CFG, v: 0, g: 0, h: 0, periods: 2 }

const bounds = (c) => c.isNormal
  ? { min: Math.max(0, Math.round(c.mean - 3 * c.sd)), max: Math.round(c.mean + 3 * c.sd) }
  : { min: Math.round(c.minD), max: Math.round(c.maxD) }

/** Spec §5 (DUAL) — written out fresh. No goodwill term anywhere. */
function modelDualPeriod(Q, D, c) {
  const topup = Math.max(D - Q, 0)
  const leftover = Math.max(Q - D, 0)
  return {
    sales: D, topup, leftover,
    profit: c.P * D - c.c * Q - c.cL * topup + leftover * (c.v - c.h),
    sl: D <= 0 ? 1 : Math.min(1, Math.min(Q, D) / D),
  }
}

function modelPeriod(Q, D, c) {
  const sales = Math.min(Q, D)
  const leftover = Math.max(Q - sales, 0)
  const short = Math.max(D - sales, 0)
  return {
    sales, leftover, short,
    profit: c.P * sales - c.c * Q + leftover * (c.v - c.h) - short * c.g,
    sl: D <= 0 ? 1 : Math.min(1, sales / D),
  }
}

// ── How the UI formats numbers (re-implemented from format.ts, not imported) ────

const fmtMoney = (v) => {
  const r = Math.round(v)
  const body = `$${Math.abs(r).toLocaleString('en-US')}`
  return r < 0 ? `−${body}` : body
}
const fmtUnits = (v) => Math.round(v).toLocaleString('en-US')
const fmtPct = (v) => `${(v * 100).toFixed(1)}%`

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

const studentUrl = (gid, pid) => `${APP}/?game=newsvendor&_pid=${pid}&_gid=${gid}`
const instrUrl = (p, gid) => `${APP}${p}?game=newsvendor&_gid=${gid}`

const text = async (page, sel) => (await page.locator(sel).first().innerText()).trim()
const testId = async (page, id) => text(page, `[data-testid="${id}"]`)
const exists = async (page, sel) => (await page.locator(sel).count()) > 0
/** innerText is an HTMLElement API and THROWS on an SVG node, so anything inside a
 *  chart (its <text> labels) has to be read with textContent instead. */
const svgText = async (page, id) =>
  ((await page.locator(`[data-testid="${id}"]`).first().textContent()) ?? '').trim()

/** Every callable response this browser actually received, for the leak audit. */
function captureResponses(page, sink) {
  page.on('response', async (res) => {
    const url = res.url()
    if (!url.includes('/us-central1/')) return
    const name = url.split('/').pop()
    try { sink.push({ name, body: await res.text() }) } catch { /* body already consumed */ }
  })
}

async function openInstance(gid, cfg, seed) {
  await putDoc(`newsvendor_game_instances/${gid}/config/main`, {
    price: intVal(cfg.P), unit_cost: intVal(cfg.c), salvage: intVal(cfg.v),
    goodwill: intVal(cfg.g), holding: intVal(cfg.h),
    is_normal: boolVal(cfg.isNormal), mean: intVal(cfg.mean), sd: intVal(cfg.sd),
    min_demand: intVal(cfg.minD), max_demand: intVal(cfg.maxD),
    periods: intVal(cfg.periods),   // ⚠ always explicit
    ...(cfg.dual ? { dual: boolVal(true), second_source_cost: intVal(cfg.cL) } : {}),
  })
  await putDoc(`newsvendor_game_instances/${gid}/truth/main`, { seed: strVal(seed) })
}

// ── Flow steps ─────────────────────────────────────────────────────────────────

/** The prep paragraph — asked AFTER the knowledge check and BEFORE the first period. */
async function doPrep(page, label) {
  await page.waitForSelector('[data-testid="nv-freetext-input"]')
  check(await exists(page, '[data-testid="nv-freetext-prompt-prep_strategy"]'),
    `${label}: the PREP question follows the knowledge check`)
  check(!(await exists(page, '[data-testid="nv-period-heading"]')),
    `${label}: …and the order screen is not on it`)
  // ⚠ The prompt is written against the KC having already run — it asks what the
  // student intends to do with the optimal quantity they just computed. If this
  // assertion ever fails, the two were resequenced independently.
  const prompt = await testId(page, 'nv-freetext-prompt-prep_strategy')
  check(/optimal order quantity/i.test(prompt),
    `${label}: …and it asks about the optimal quantity they just worked out`)
  await page.fill('[data-testid="nv-freetext-input"]', 'I will start near the mean and adjust.')
  await page.click('[data-testid="nv-freetext-submit"]')
}

/** One period: read the screen, order, check the results screen and the history row. */
async function playPeriod(page, n, Q, cfg, label) {
  await page.waitForSelector('[data-testid="nv-period-heading"]')
  check(await testId(page, 'nv-period-heading') === `Period ${n} of ${cfg.periods}`,
    `${label}: the heading says "Period ${n} of ${cfg.periods}"`)

  if (n === 1) {
    // The parameter box, and the zero-suppression rule (spec §7a).
    const params = (await testId(page, 'nv-parameters')).replace(/\s+/g, ' ')
    check(params.includes(fmtMoney(cfg.P)) && params.includes(fmtMoney(cfg.c)),
      `${label}: the price and unit cost are on screen`)
    // ⚠ Asserted on the ROW's existence, not on a text search: the panel's explanatory
    // sentence mentions salvage in prose, so a text match would report the line as
    // present when it had in fact been suppressed — a false green.
    for (const [name, value, id] of [
      ['salvage', cfg.v, 'nv-param-v'],
      ['holding', cfg.h, 'nv-param-h'],
      ['shortage', cfg.g, 'nv-param-g'],
    ]) {
      const shown = await exists(page, `[data-testid="${id}"]`)
      check(shown === (value !== 0),
        `${label}: the ${name} line is ${value === 0 ? 'SUPPRESSED at zero' : 'shown'}`)
    }
    const demandBox = (await testId(page, 'nv-demand-box')).replace(/\s+/g, ' ')
    check(cfg.isNormal
      ? /Normal/.test(demandBox) && demandBox.includes(fmtUnits(cfg.mean)) && demandBox.includes(fmtUnits(cfg.sd))
      : /Uniform/.test(demandBox),
      `${label}: the demand box states the distribution and its parameters`)

    // Browser-side validation gates submit (the server re-checks anyway).
    check(await page.locator('[data-testid="nv-submit-order"]').isDisabled(),
      `${label}: submit is disabled before an order is typed`)
    check(await page.locator('[data-testid="nv-order-input"]').inputValue() === '',
      `${label}: the order field starts EMPTY — no prefilled number to anchor on`)
    const b = bounds(cfg)
    await page.fill('[data-testid="nv-order-input"]', String(b.max + 1))
    check(await page.locator('[data-testid="nv-submit-order"]').isDisabled(),
      `${label}: an out-of-bounds order keeps submit disabled`)
    await page.fill('[data-testid="nv-order-input"]', '100.5')
    check(await page.locator('[data-testid="nv-submit-order"]').isDisabled(),
      `${label}: a fractional order keeps submit disabled`)
    await page.fill('[data-testid="nv-order-input"]', '')
  }

  // From period 2 on the history table is below the form (spec §7a).
  check(await exists(page, '[data-testid="nv-history"]') === (n > 1),
    `${label}: the history table is ${n > 1 ? 'shown' : 'absent'} on the order screen for period ${n}`)

  await page.fill('[data-testid="nv-order-input"]', String(Q))
  await page.click('[data-testid="nv-submit-order"]')
  await page.waitForSelector('[data-testid="nv-results"]')

  const D = Number((await testId(page, 'nv-result-demand')).replace(/,/g, ''))
  const want = modelPeriod(Q, D, cfg)

  check(await testId(page, 'nv-result-order') === fmtUnits(Q), `${label} p${n}: the order is echoed back`)
  check(await testId(page, 'nv-result-sales') === fmtUnits(want.sales), `${label} p${n}: sales = ${want.sales}`)
  check(await testId(page, 'nv-result-over') === fmtUnits(want.leftover), `${label} p${n}: units over = ${want.leftover}`)
  check(await testId(page, 'nv-result-short') === fmtUnits(want.short), `${label} p${n}: units short = ${want.short}`)
  check(await testId(page, 'nv-result-profit') === fmtMoney(want.profit),
    `${label} p${n}: the rendered profit is ${fmtMoney(want.profit)}`)
  check(await testId(page, 'nv-result-sl') === fmtPct(want.sl),
    `${label} p${n}: the demand proportion met is ${fmtPct(want.sl)}`)

  // …and the SAME numbers in the history row, from the same response.
  check(await testId(page, `nv-history-order-${n}`) === fmtUnits(Q), `${label} p${n}: the history row's order agrees`)
  check(await testId(page, `nv-history-demand-${n}`) === fmtUnits(D), `${label} p${n}: …its demand agrees`)
  check(await testId(page, `nv-history-profit-${n}`) === fmtMoney(want.profit), `${label} p${n}: …and its profit`)
  if (n === 1) {
    // ⚠ CUMULATIVE WAS REMOVED. Asserted on the CELL's absence rather than on a text
    // search of the table, because "Average" contains no giveaway string and a header
    // grep for "Cumulative" would pass for the wrong reason once the word is gone
    // from the markup entirely.
    check(!(await exists(page, `[data-testid="nv-history-total-${n}"]`)),
      `${label}: the history table has NO cumulative-profit cell`)
    check(await exists(page, `[data-testid="nv-history-average-${n}"]`),
      `${label}: …but keeps the average-profit cell`)
    const header = await testId(page, 'nv-history')
    check(!/Cumulative/i.test(header), `${label}: …and no "Cumulative" header`)
  }

  await page.click('[data-testid="nv-continue"]')
  return { Q, D, ...want }
}

/** The ten-question knowledge check, answered correctly. */
const KC_KEY = {
  kc_cr_concept: 'over_under', kc_underage: 'cu_90', kc_overage: 'co_10',
  kc_critical_ratio: 'cr_090', kc_direction: 'above', kc_qstar: 'q_628',
  kc_profit_leftover: 'p_26000', kc_profit_shortage: 's_22000',
  kc_salvage_rises: 'up', kc_variability: 'higher',
}

async function doKc(page, label) {
  let answered = 0
  for (let i = 0; i < 10; i++) {
    await page.waitForSelector('[data-testid="nv-kc-prompt"]')
    if (i === 0) {
      check(!(await exists(page, '[data-testid="nv-period-heading"]')),
        `${label}: ⚠ the GRADED KC comes first — no period has been played yet`)
      check(await page.locator('[data-testid="nv-kc-submit"]').isDisabled(),
        `${label}: KC submit is gated until an option is chosen`)
      const prompt = await testId(page, 'nv-kc-prompt')
      check(!prompt.includes(String(CFG.P)),
        `${label}: ⚠ the KC stem does NOT carry the instance's own price — students recompute`)
    }
    const values = await page.locator('[data-testid^="nv-kc-option-"]')
      .evaluateAll(els => els.map(e => e.getAttribute('data-testid').replace('nv-kc-option-', '')))
    const correct = values.find(v => Object.values(KC_KEY).includes(v))
    check(correct !== undefined, `${label}: question ${i + 1} offers a known-correct option`)
    await page.click(`[data-testid="nv-kc-option-${correct}"]`)
    await page.click('[data-testid="nv-kc-submit"]')
    await page.waitForSelector('[data-testid="nv-kc-correct"]')
    answered++
    await page.click('[data-testid="nv-kc-continue"]')
  }
  check(answered === 10, `${label}: all TEN knowledge-check questions were answered (${answered})`)
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  const stamp = Date.now()
  console.log('\nBooting the Vite dev server…')
  const vite = await startVite()
  const browser = await chromium.launch(HEADED ? { headless: false, slowMo: 90 } : {})

  try {
    const responses = []

    // ── 1. A full game, clicked through ────────────────────────────────────────
    console.log('\n[1] A full regular game in the browser')
    const GID = `nvpw-${stamp}`
    const PID = 'nvpw-stu'
    await openInstance(GID, CFG, 'pw-seed')

    const ctx = await browser.newContext()
    const page = await ctx.newPage()
    captureResponses(page, responses)
    await page.goto(studentUrl(GID, PID))

    // ⚠ THE ORDER UNDER TEST: graded KC → prep → periods. A regression that put the
    // prep back in front would fail inside doKc, not here, because doKc asserts that
    // no period has been played when the first question renders.
    await doKc(page, 'Main')
    await doPrep(page, 'Main')
    const b = bounds(CFG)
    const schedule = [600, 1000, 1500, b.max]
    const played = []
    for (let n = 1; n <= CFG.periods; n++) {
      played.push(await playPeriod(page, n, schedule[n - 1], CFG, 'Main'))
    }

    // ── 2. The final-results screen (spec §7d) ────────────────────────────────
    console.log('\n[2] Final results')
    await page.waitForSelector('[data-testid="nv-final-heading"]')
    const wantTotal = played.reduce((a, p) => a + p.profit, 0)
    const wantAvgProfit = wantTotal / played.length
    const wantAvgOrder = played.reduce((a, p) => a + p.Q, 0) / played.length
    const wantAvgSl = played.reduce((a, p) => a + p.sl, 0) / played.length
    check(await testId(page, 'nv-final-avg-profit') === fmtMoney(wantAvgProfit),
      `the final screen states the AVERAGE profit per period (${fmtMoney(wantAvgProfit)})`)
    check(!(await exists(page, '[data-testid="nv-final-total"]')),
      '⚠ …and NOT the total — it scales with the period count and compares to nothing')
    check(await testId(page, 'nv-final-avg-order')
      === wantAvgOrder.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 }),
      'and the average order')
    check(await testId(page, 'nv-final-avg-sl') === fmtPct(wantAvgSl), 'and the average demand met')

    // ⚠ THE HEADLINE PROHIBITION (spec §9.2), checked on the page that most invites it.
    const finalText = (await page.locator('body').innerText()).toLowerCase()
    for (const banned of ['optimal', 'benchmark', 'critical ratio', 'should have ordered', 'q*']) {
      check(!finalText.includes(banned),
        `⚠ the final screen never says "${banned}" — the benchmark is for reports only`)
    }

    await page.click('[data-testid="nv-final-continue"]')

    // ── 3. The debrief closes the flow ─────────────────────────────────────────
    console.log('\n[3] Debrief')
    await page.waitForSelector('[data-testid="nv-freetext-prompt-debrief_regular"]')
    check(true, 'the DEBRIEF is the last screen, straight after the final results')
    check(!(await exists(page, '[data-testid="nv-kc-prompt"]')),
      '⚠ …and the knowledge check is NOT here — it ran before the game')
    await page.fill('[data-testid="nv-freetext-input"]', 'I drifted above the mean as I kept running short.')
    await page.click('[data-testid="nv-freetext-submit"]')

    await page.waitForSelector('[data-testid="nv-all-done"]')
    check(await exists(page, '[data-testid="nv-final-heading"]'),
      'the terminal screen repeats the final results, so a student who comes back does not lose them')

    // ── 4. Resume mid-loop ─────────────────────────────────────────────────────
    console.log('\n[4] Resume — close the tab mid-game and come back')
    const RPID = 'nvpw-resume'
    const ctxR = await browser.newContext()
    const pageR = await ctxR.newPage()
    await pageR.goto(studentUrl(GID, RPID))
    await doKc(pageR, 'Resume')
    await doPrep(pageR, 'Resume')
    for (let n = 1; n <= 2; n++) {
      await pageR.waitForSelector('[data-testid="nv-period-heading"]')
      await pageR.fill('[data-testid="nv-order-input"]', '1000')
      await pageR.click('[data-testid="nv-submit-order"]')
      await pageR.waitForSelector('[data-testid="nv-results"]')
      await pageR.click('[data-testid="nv-continue"]')
    }
    const beforeReload = await pageR.locator('[data-testid="nv-history"]').innerText()
    await pageR.reload()
    await pageR.waitForSelector('[data-testid="nv-period-heading"]')
    check(await testId(pageR, 'nv-period-heading') === `Period 3 of ${CFG.periods}`,
      'after a reload the student is on period 3, not back at the prep or period 1')
    check(!(await exists(pageR, '[data-testid="nv-freetext-input"]')),
      '…and is not asked the prep question again')
    check(!(await exists(pageR, '[data-testid="nv-kc-prompt"]')),
      '⚠ …and is NOT sent back through the knowledge check the server has already locked')
    check(await pageR.locator('[data-testid="nv-history"]').innerText() === beforeReload,
      '…with the history intact')

    // ── 5. Zero-valued lines are suppressed (spec §7a) ─────────────────────────
    console.log('\n[5] An instance with no salvage, holding or goodwill')
    const GID_Z = `nvpw-zero-${stamp}`
    await openInstance(GID_Z, CFG_NO_EXTRAS, 'pw-zero')
    const ctxZ = await browser.newContext()
    const pageZ = await ctxZ.newPage()
    await pageZ.goto(studentUrl(GID_Z, 'nvpw-z'))
    await doKc(pageZ, 'Zero')
    await doPrep(pageZ, 'Zero')
    await playPeriod(pageZ, 1, 800, CFG_NO_EXTRAS, 'Zero')

    // ── 6. ⚠ THE NETWORK AUDIT ────────────────────────────────────────────────
    console.log('\n[6] ⚠ The benchmark reached no response this browser received')
    check(responses.length > 0, `the browser received ${responses.length} callable responses to audit`)
    const offenders = []
    for (const { name, body } of responses) {
      for (const banned of ['q_opt', 'qOpt', 'profit_opt', 'profitOpt', 'criticalRatio', 'benchmark', '"seed"']) {
        if (body.includes(banned)) offenders.push(`${name}: ${banned}`)
      }
    }
    check(offenders.length === 0,
      `⚠ no student callable response carried a benchmark or seed field (found: ${offenders.join(', ') || 'none'})`)
    check(responses.some(r => r.name === 'newsvendorSubmitRound'),
      '…and the audit really did see the period-submit responses')

    // ── 7. The instructor surfaces ─────────────────────────────────────────────
    console.log('\n[7] Instructor dashboard + reports (mixed population, mid-week)')
    const GID_I = `nvpw-instr-${stamp}`
    await openInstance(GID_I, { ...CFG, periods: 3 }, 'pw-instr')

    // A finisher, a mid-game student, and one the roster created who never launched.
    await callFn('newsvendorBootstrap', asStudent(GID_I, 'fin'))
    for (let n = 1; n <= 3; n++) {
      await callFn('newsvendorSubmitRound', asStudent(GID_I, 'fin', { round: n, order: 1200 }))
    }
    await callFn('newsvendorSubmitFreeText',
      asStudent(GID_I, 'fin', { field: 'prep_strategy', answer: 'Aim at the mean.' }))
    await callFn('newsvendorSubmitFreeText',
      asStudent(GID_I, 'fin', { field: 'debrief_regular', answer: 'I ended up ordering above it.' }))
    await callFn('newsvendorBootstrap', asStudent(GID_I, 'mid'))
    await callFn('newsvendorSubmitRound', asStudent(GID_I, 'mid', { round: 1, order: 800 }))
    await putDoc(`newsvendor_game_instances/${GID_I}/participants/never`, {
      participant_id: strVal('never'), game_instance_id: strVal(GID_I), name: strVal('Never Started'),
    })

    const ctxI = await browser.newContext()
    const pageI = await ctxI.newPage()
    await pageI.goto(instrUrl('/dashboard', GID_I))
    await pageI.waitForSelector('[data-testid="nv-roster"]', { timeout: 30000 })

    const banner = (await testId(pageI, 'nv-instance-header')).replace(/\s+/g, ' ')
    check(/Normal demand/.test(banner) && banner.includes(fmtUnits(CFG.mean)),
      'the dashboard banner states this instance’s demand distribution')
    check(banner.includes('3 periods'), '…and its period count')

    // ── 1e: the instructor reference values, in the banner ──────────────────
    // ⚠ Q* = 1265 at the shipped defaults; this instance uses them, so the number is
    // checked rather than merely "something rendered".
    const refLine = (await testId(pageI, 'nv-instance-benchmark')).replace(/\s+/g, ' ')
    check(/Critical ratio/.test(refLine) && /optimal order/i.test(refLine),
      'the dashboard banner states the critical ratio and Q* (instructor reference)')
    check(await testId(pageI, 'nv-instance-qopt') === '1,265',
      `…with the right Q* for these parameters (${await testId(pageI, 'nv-instance-qopt')})`)
    check(await testId(pageI, 'nv-instance-cr') === '0.811',
      `…and the right critical ratio (${await testId(pageI, 'nv-instance-cr')})`)

    // ── 1b: the manual refresh button ───────────────────────────────────────
    check(await exists(pageI, '[data-testid="nv-refresh"]'), 'the dashboard has a Refresh button')

    const roster = await pageI.locator('[data-testid="nv-roster"]').innerText()
    const rosterRows = roster.split('\n')
    check(rosterRows.length > 1, `the roster rendered rows (${rosterRows.length} lines)`)
    check(/Finished/.test(roster), 'the roster marks the finisher Finished')
    check(/In progress \(1 period\)/.test(roster),
      'the mid-game student shows In progress WITH how far they have got, singular')
    check(/Not started/.test(roster), 'and the never-launched student shows Not started')
    check((await testId(pageI, 'nv-counts')).includes('1 finished / 2 started / 3 on roster'),
      'the action bar counts finished / started / on roster')
    check(!(await exists(pageI, '[data-testid="nv-instance-cl"]')),
      '⚠ a REGULAR instance shows no second-source line in the banner')

    // ⚠ THE DASHBOARD IS FIVE COLUMNS, and the gap is NOT one of them.
    const headerRow = rosterRows[0] ?? ''
    for (const kept of ['Name', 'Status', 'Periods played', 'Avg order', 'Avg profit / period']) {
      check(headerRow.includes(kept), `the dashboard shows "${kept}"`)
    }
    for (const gone of ['Gap', 'Benchmark', 'KC', 'Participation']) {
      check(!headerRow.includes(gone), `…and NOT "${gone}" — that lives on Reports`)
    }

    // The four report tiles.
    await pageI.goto(instrUrl('/reports', GID_I))
    await pageI.waitForSelector('[data-testid="nv-instance-header"]', { timeout: 30000 })
    const board = await pageI.locator('body').innerText()
    check(/Outcomes — all students/.test(board), 'Tier 1 tile is present')
    check(/Prep paragraphs/.test(board), '⚠ Tier 2a — the PREP tile is present')
    check(/Debrief paragraphs/.test(board), '⚠ Tier 2b — the DEBRIEF tile is present, separately')
    check(/Order by period/.test(board), '⚠ Tier 3a — the ORDER chart is its own tile')
    check(/Profit by period/.test(board), '⚠ Tier 3b — the PROFIT chart is a SEPARATE tile')

    await pageI.click('text=Outcomes — all students')
    await pageI.waitForSelector('[data-testid="nv-report-outcomes"]')
    const outcomes = await pageI.locator('[data-testid="nv-report-outcomes"]').innerText()
    // The header reads "Benchmark", not "Benchmark profit" — shortened to buy table width.
    check(/Benchmark/.test(outcomes) && /Gap/.test(outcomes),
      '⚠ the Tier-1 table DOES carry the benchmark and the gap — instructor-only, by design')
    check(await exists(pageI, '[data-testid="nv-gap-fin"]'), 'the finisher has a gap figure')
    check(await testId(pageI, 'nv-gap-never') === '—',
      'the never-started student shows a dash for the gap, not a zero')

    await pageI.goto(instrUrl('/reports', GID_I))
    await pageI.waitForSelector('[data-testid="nv-instance-header"]')
    await pageI.click('text=Order by period')
    await pageI.waitForSelector('[data-testid="nv-order-chart"]')
    check(await exists(pageI, '[data-testid="nv-order-ref-qopt"]'),
      'the order chart draws the optimal-order reference line')
    check(!(await exists(pageI, '[data-testid="nv-profit-chart"]')),
      '⚠ …and the PROFIT chart is not on this tile — they are genuinely split')
    const n1 = await pageI.locator('[data-testid="nv-order-n-1"]').first().textContent()
    const n3 = await pageI.locator('[data-testid="nv-order-n-3"]').first().textContent()
    check(n1.trim() === 'n=2' && n3.trim() === 'n=1',
      `⚠ the per-period denominator thins from 2 to 1 (${n1.trim()} → ${n3.trim()})`)

    // The profit chart, on its own tile — and averaging over the SAME students.
    await pageI.goto(instrUrl('/reports', GID_I))
    await pageI.waitForSelector('[data-testid="nv-instance-header"]')
    await pageI.click('text=Profit by period')
    await pageI.waitForSelector('[data-testid="nv-profit-chart"]')
    check(!(await exists(pageI, '[data-testid="nv-order-chart"]')),
      'the profit tile carries only the profit chart')
    const p1 = await pageI.locator('[data-testid="nv-profit-n-1"]').first().textContent()
    const p3 = await pageI.locator('[data-testid="nv-profit-n-3"]').first().textContent()
    check(p1.trim() === n1.trim() && p3.trim() === n3.trim(),
      `⚠ SPLITTING THE TILE DID NOT SPLIT THE DENOMINATORS — both charts still average over the same students (${p1.trim()}, ${p3.trim()})`)

    await pageI.goto(instrUrl('/reports', GID_I))
    await pageI.waitForSelector('[data-testid="nv-instance-header"]')
    await pageI.click('text=Prep paragraphs')
    await pageI.waitForSelector('[data-testid="nv-report-prep"]')
    const prepTile = await pageI.locator('[data-testid="nv-report-prep"]').innerText()
    check(prepTile.includes('Aim at the mean.'), 'the prep tile shows the prep paragraph')
    check(!prepTile.includes('I ended up ordering above it.'),
      '⚠ …and NOT the debrief paragraph — they are two separate reports')

    // ── 8. Settings ────────────────────────────────────────────────────────────
    console.log('\n[8] Instructor settings')
    await pageI.goto(instrUrl('/settings', GID_I))
    await pageI.waitForSelector('[data-testid="nv-set-P"]', { timeout: 30000 })
    check(await pageI.locator('[data-testid="nv-set-periods"]').inputValue() === '3',
      'settings shows the configured period count')
    const bench = (await testId(pageI, 'nv-settings-benchmark')).replace(/\s+/g, ' ')
    check(/critical ratio/.test(bench) && /optimal order/.test(bench),
      'settings previews the critical ratio and the optimal order these parameters imply')
    check(await exists(pageI, '[data-testid="nv-settings-played-warning"]'),
      'and warns that students have already played')
    await pageI.fill('[data-testid="nv-set-periods"]', '5')
    await pageI.click('[data-testid="nv-save-settings"]')
    await pageI.waitForSelector('[data-testid="nv-settings-saved"]')
    check(await pageI.locator('[data-testid="nv-set-periods"]').inputValue() === '5',
      'a legal edit saves and is read back')
    await pageI.fill('[data-testid="nv-set-c"]', '5000')   // above the price → refused
    await pageI.click('[data-testid="nv-save-settings"]')
    await pageI.waitForSelector('[data-testid="nv-settings-error"]')
    check(/above the unit cost|greater/i.test(await testId(pageI, 'nv-settings-error')),
      'an illegal edit is refused with the reason on screen')

    // ── 9. ⚠ THE REFRESH BUTTON PICKS UP NEW PLAY, WITHOUT A PAGE RELOAD ──────
    // These dashboards are one-shot fetches by design (a live listener was tried and
    // rolled back). The contract the button has to honour is therefore narrow and
    // worth pinning: clicking it must show play that happened AFTER the page opened,
    // without reloading the page.
    console.log('\n[9] ⚠ The Refresh button picks up play that happened after load')
    const GID_L = `nvpw-refresh-${stamp}`
    await openInstance(GID_L, { ...CFG, periods: 5 }, 'pw-refresh')
    await callFn('newsvendorBootstrap', asStudent(GID_L, 'live-stu'))
    await callFn('newsvendorSubmitRound', asStudent(GID_L, 'live-stu', { round: 1, order: 1000 }))

    const ctxL = await browser.newContext()
    const pageL = await ctxL.newPage()
    await pageL.goto(instrUrl('/dashboard', GID_L))
    await pageL.waitForSelector('[data-testid="nv-roster"]', { timeout: 30000 })

    // ⚠ 1c: no error on FIRST PAINT. The "Missing token" flash showed up here, as a
    // load error that a later refetch silently cleared.
    check(!(await exists(pageL, '[data-testid="nv-load-error"]')),
      '⚠ the dashboard shows NO error on first paint (the "Missing token" flash)')
    const bodyText = await pageL.locator('body').innerText()
    check(!/Missing token/i.test(bodyText), '⚠ …and the words "Missing token" appear nowhere')

    const before = await pageL.locator('[data-testid="nv-roster"]').innerText()
    check(/In progress \(1 period\)/.test(before), 'it opens showing one period played')

    // Two more periods, submitted from OUTSIDE the browser entirely.
    await callFn('newsvendorSubmitRound', asStudent(GID_L, 'live-stu', { round: 2, order: 1100 }))
    await callFn('newsvendorSubmitRound', asStudent(GID_L, 'live-stu', { round: 3, order: 1200 }))

    // Still stale — which is the DESIGNED behaviour, and asserting it is what stops
    // this test passing for the wrong reason (a page that happened to reload itself).
    const stillStale = await pageL.locator('[data-testid="nv-roster"]').innerText()
    check(stillStale === before,
      '…and does NOT update on its own — one-shot by design, no listener')

    await pageL.click('[data-testid="nv-refresh"]')
    await pageL.waitForFunction(
      () => /In progress \(3 periods\)/.test(
        document.querySelector('[data-testid="nv-roster"]')?.textContent ?? ''),
      { timeout: 15000 })
    const after = await pageL.locator('[data-testid="nv-roster"]').innerText()
    check(/In progress \(3 periods\)/.test(after),
      '⚠ …but ONE CLICK of Refresh brings it up to three periods, with no page reload')
    check(before !== after, 'the rendered roster genuinely changed in place')

    // ── 10. ⚠ A FULL DUAL GAME, CLICKED THROUGH ───────────────────────────────
    console.log('\n[10] Dual sourcing — a full game in the browser')
    const DUAL_CFG = {
      P: 3000, c: 1000, v: 800, g: 150, h: 300, cL: 2000, dual: true,
      isNormal: true, mean: 1000, sd: 300, minD: 0, maxD: 100, periods: 4,
    }
    const GID_D = `nvpw-dual-${stamp}`
    await openInstance(GID_D, DUAL_CFG, 'pw-dual')

    const ctxD = await browser.newContext()
    const pageD = await ctxD.newPage()
    const dualResponses = []
    captureResponses(pageD, dualResponses)
    await pageD.goto(studentUrl(GID_D, 'nvpw-dual-stu'))

    // The DUAL knowledge check — a different set entirely.
    await pageD.waitForSelector('[data-testid="nv-kc-prompt"]')
    const firstDualPrompt = await testId(pageD, 'nv-kc-prompt')
    check(/dual sourcing|second source|reserve/i.test(firstDualPrompt),
      '⚠ the DUAL knowledge check is served, not the regular one')
    const DUAL_VALUES = ['never_short', 'd_80', 'both_met', 'do_20', 'dcr_080', 'dq_484',
      'dp_up', 'dpt_54000', 'dpl_52000', 'dvs_compare']
    let dualAnswered = 0
    for (let i = 0; i < 10; i++) {
      await pageD.waitForSelector('[data-testid="nv-kc-prompt"]')
      const vals = await pageD.locator('[data-testid^="nv-kc-option-"]')
        .evaluateAll(els => els.map(e => e.getAttribute('data-testid').replace('nv-kc-option-', '')))
      const correct = vals.find(v => DUAL_VALUES.includes(v))
      check(correct !== undefined, `dual KC question ${i + 1} offers a known-correct option`)
      await pageD.click(`[data-testid="nv-kc-option-${correct}"]`)
      await pageD.click('[data-testid="nv-kc-submit"]')
      await pageD.waitForSelector('[data-testid="nv-kc-correct"]')
      dualAnswered++
      await pageD.click('[data-testid="nv-kc-continue"]')
    }
    check(dualAnswered === 10, `all TEN dual questions answered (${dualAnswered})`)

    await doPrep(pageD, 'Dual')

    // ── The place-order screen, in dual dress ─────────────────────────────────
    await pageD.waitForSelector('[data-testid="nv-period-heading"]')
    check(await exists(pageD, '[data-testid="nv-param-cl"]'),
      '⚠ the second-supplier cost line is shown (spec §7a)')
    check(!(await exists(pageD, '[data-testid="nv-param-g"]')),
      '⚠ …and the goodwill line is NOT — dual never incurs a shortage cost')
    const clLine = await testId(pageD, 'nv-param-cl')
    check(clLine.includes(fmtMoney(DUAL_CFG.cL)), `…and it states ${fmtMoney(DUAL_CFG.cL)}`)

    // ── The loop, with a schedule that hits BOTH paths ────────────────────────
    const dualSchedule = [400, 1000, 1700, 1129]
    const dualPlays = []
    for (let n = 1; n <= DUAL_CFG.periods; n++) {
      await pageD.waitForSelector('[data-testid="nv-period-heading"]')
      await pageD.fill('[data-testid="nv-order-input"]', String(dualSchedule[n - 1]))
      await pageD.click('[data-testid="nv-submit-order"]')
      await pageD.waitForSelector('[data-testid="nv-results"]')

      const D = Number((await testId(pageD, 'nv-result-demand')).replace(/,/g, ''))
      const Q = dualSchedule[n - 1]
      const want = modelDualPeriod(Q, D, DUAL_CFG)
      dualPlays.push({ Q, D, ...want })

      check(await testId(pageD, 'nv-result-sales') === fmtUnits(D),
        `dual p${n}: ALL ${D} units of demand were sold`)
      check(!(await exists(pageD, '[data-testid="nv-result-short"]')),
        `dual p${n}: there is no "units short" line at all`)
      check(await testId(pageD, 'nv-result-topup') === fmtUnits(want.topup),
        `dual p${n}: "Units bought from second source" = ${want.topup}`)
      check(await testId(pageD, 'nv-result-cl') === fmtMoney(DUAL_CFG.cL),
        `dual p${n}: …at the second-supplier cost`)
      check(await testId(pageD, 'nv-result-profit') === fmtMoney(want.profit),
        `dual p${n}: profit = ${fmtMoney(want.profit)}`)

      await pageD.click('[data-testid="nv-continue"]')
    }
    const dualTopups = dualPlays.filter(p => p.topup > 0)
    const dualLeftovers = dualPlays.filter(p => p.leftover > 0)
    check(dualTopups.length > 0, `the browser game hit the TOP-UP path (${dualTopups.length})`)
    check(dualLeftovers.length > 0, `…and the LEFTOVER path (${dualLeftovers.length})`)

    // The history table relabels its column too.
    const dualHist = await pageD.locator('[data-testid="nv-history"]').innerText()
    check(/From 2nd source/.test(dualHist), 'the history table relabels the shortage column')
    check(!/Units short/.test(dualHist), '…and drops "Units short" entirely')

    // ── Final screen, then the DUAL debrief ───────────────────────────────────
    await pageD.waitForSelector('[data-testid="nv-final-heading"]')
    await pageD.click('[data-testid="nv-final-continue"]')
    await pageD.waitForSelector('[data-testid="nv-freetext-prompt-debrief_regular"]')
    const dualDebrief = await testId(pageD, 'nv-freetext-prompt-debrief_regular')
    check(/reserve/i.test(dualDebrief) && /second source/i.test(dualDebrief),
      '⚠ the DUAL debrief question is asked (reserve vs second source)')
    await pageD.fill('[data-testid="nv-freetext-input"]', 'I reserved near the optimal amount.')
    await pageD.click('[data-testid="nv-freetext-submit"]')
    await pageD.waitForSelector('[data-testid="nv-all-done"]')

    // ── ⚠ THE DUAL LEAK AUDIT ────────────────────────────────────────────────
    check(dualResponses.length > 0, `the dual browser received ${dualResponses.length} responses`)
    const dualOffenders = []
    for (const { name, body } of dualResponses) {
      for (const banned of ['q_opt', 'qOpt', 'profit_opt', 'profitOpt', 'criticalRatio', 'benchmark', '"premium"', '"seed"']) {
        if (body.includes(banned)) dualOffenders.push(`${name}: ${banned}`)
      }
    }
    check(dualOffenders.length === 0,
      `⚠ no DUAL student response carried the benchmark or the premium (found: ${dualOffenders.join(', ') || 'none'})`)
    const dualPageText = (await pageD.locator('body').innerText()).toLowerCase()
    for (const banned of ['optimal', 'benchmark', 'critical ratio']) {
      check(!dualPageText.includes(banned), `⚠ the dual final screen never says "${banned}"`)
    }

    // ── The instructor side, on a dual instance ──────────────────────────────
    const ctxDI = await browser.newContext()
    const pageDI = await ctxDI.newPage()
    await pageDI.goto(instrUrl('/dashboard', GID_D))
    await pageDI.waitForSelector('[data-testid="nv-roster"]', { timeout: 30000 })
    check(await testId(pageDI, 'nv-instance-qopt') === '1,129',
      `⚠ the dashboard states the DUAL Q* = 1,129 (got ${await testId(pageDI, 'nv-instance-qopt')})`)
    check(await testId(pageDI, 'nv-instance-cr') === '0.667',
      `⚠ …and the dual critical ratio 0.667 (got ${await testId(pageDI, 'nv-instance-cr')})`)
    // ⚠ FIX 3 — the banner names the FULL second-supplier price in dual mode.
    const dualBanner = await testId(pageDI, 'nv-instance-cl')
    check(/second source/.test(dualBanner) && dualBanner.includes(fmtMoney(DUAL_CFG.cL)),
      `⚠ the dual banner shows "second source ${fmtMoney(DUAL_CFG.cL)}" (got "${dualBanner.trim()}")`)
    check(!dualBanner.includes(fmtMoney(DUAL_CFG.cL - DUAL_CFG.c)),
      '⚠ …the FULL price, not the derived premium')

    await pageDI.goto(instrUrl('/settings', GID_D))
    await pageDI.waitForSelector('[data-testid="nv-set-dual"]', { timeout: 30000 })
    check(await pageDI.locator('[data-testid="nv-set-dual"]').isChecked(),
      'settings shows the dual toggle ON')
    check(await pageDI.locator('[data-testid="nv-set-cl"]').inputValue() === '2000',
      '…and the second-supplier cost field')
    check(!(await exists(pageDI, '[data-testid="nv-set-g"]')),
      '⚠ …and hides the shortage-cost field, which dual never uses')
    const premiumNote = await testId(pageDI, 'nv-settings-premium')
    check(/1,000/.test(premiumNote), `the settings page shows the DERIVED premium (${premiumNote})`)

    // ── 11. ⚠ THE EXPECTED-PROFIT CHART — analytical, and empty-class-proof ────
    // Opened on an instance with a config and NO PARTICIPANTS AT ALL. If the chart
    // needed student data this section could not exist.
    console.log('\n[11] The expected-profit comparison chart (no students at all)')
    const GID_EP = `nvpw-expected-${stamp}`
    await openInstance(GID_EP, CFG, 'pw-expected')   // config only; nobody bootstrapped

    const ctxE = await browser.newContext()
    const pageE = await ctxE.newPage()
    await pageE.goto(instrUrl('/reports', GID_EP))
    await pageE.waitForSelector('[data-testid="nv-instance-header"]', { timeout: 30000 })
    check(/Expected profit by order quantity/.test(await pageE.locator('body').innerText()),
      'the expected-profit tile is present')
    await pageE.click('text=Expected profit by order quantity')
    await pageE.waitForSelector('[data-testid="nv-ep-chart"]')
    check(true, '⚠ …and it RENDERS with zero participants — it is analytical, not empirical')

    // ⚠ ON LOAD: regular only, dual hidden — the lecture-pacing requirement.
    check(await exists(pageE, '[data-testid="nv-ep-line-regular"]'),
      '⚠ ON LOAD the SINGLE-SOURCE line is drawn')
    check(!(await exists(pageE, '[data-testid="nv-ep-line-dual"]')),
      '⚠ …and the DUAL line is HIDDEN')
    check(await exists(pageE, '[data-testid="nv-ep-marker-regular"]'),
      'the regular Q* marker is drawn with its line')
    check(!(await exists(pageE, '[data-testid="nv-ep-marker-dual"]')),
      '⚠ …and the dual marker is absent while its line is — a hidden line leaves nothing')
    check(await exists(pageE, '[data-testid="nv-ep-legend-dual"]'),
      '⚠ …but the dual LEGEND entry is still there, ready to be clicked')

    const regQopt = await svgText(pageE, 'nv-ep-qopt-regular')
    check(/1,265/.test(regQopt), `⚠ the regular peak is marked at Q* = 1265 (got "${regQopt}")`)
    check(!/Single|Dual/.test(regQopt),
      '⚠ the label is JUST the Q* — colour identifies the line, not a word')

    // Click the dual legend entry — the reveal.
    await pageE.click('[data-testid="nv-ep-legend-dual"]')
    await pageE.waitForSelector('[data-testid="nv-ep-line-dual"]')
    check(true, '⚠ clicking the dual legend entry REVEALS its line')
    const dualQopt = await svgText(pageE, 'nv-ep-qopt-dual')
    check(/1,129/.test(dualQopt), `⚠ …marked at the dual Q* = 1129 (got "${dualQopt}")`)
    check(!/Single|Dual/.test(dualQopt), '⚠ …and it too is just the Q*')
    check(await exists(pageE, '[data-testid="nv-ep-line-regular"]'),
      '…and the regular line is still there beside it')

    // ⚠ THE TWO LABELS MUST NOT COLLIDE with both lines shown — the bug this fixes.
    // Measured from the rendered boxes, not inferred from the offsets that produce them.
    const boxes = await pageE.evaluate(() => {
      const one = document.querySelector('[data-testid="nv-ep-qopt-regular"]')
      const two = document.querySelector('[data-testid="nv-ep-qopt-dual"]')
      if (!one || !two) return null
      const a = one.getBoundingClientRect(), b = two.getBoundingClientRect()
      return {
        a: { l: a.left, r: a.right, t: a.top, b: a.bottom },
        b: { l: b.left, r: b.right, t: b.top, b_: b.bottom },
      }
    })
    check(boxes !== null, 'measured both Q* label boxes')
    const overlapX = Math.min(boxes.a.r, boxes.b.r) - Math.max(boxes.a.l, boxes.b.l)
    const overlapY = Math.min(boxes.a.b, boxes.b.b_) - Math.max(boxes.a.t, boxes.b.t)
    check(!(overlapX > 0 && overlapY > 0),
      `⚠ THE TWO Q* LABELS DO NOT OVERLAP with both lines shown `
      + `(x-overlap ${overlapX.toFixed(0)}px, y-overlap ${overlapY.toFixed(0)}px — `
      + `they collide only if BOTH are positive)`)
    check(overlapX < 0,
      `…and they are separated horizontally by ${(-overlapX).toFixed(0)}px, which holds `
      + 'even when a config puts both Q* at the same x')

    // Toggling the regular line off hides its marker too.
    await pageE.click('[data-testid="nv-ep-legend-regular"]')
    check(!(await exists(pageE, '[data-testid="nv-ep-line-regular"]')),
      'clicking the regular entry hides that line')
    check(!(await exists(pageE, '[data-testid="nv-ep-marker-regular"]')),
      '⚠ …and its Q* marker goes with it')

    // ⚠ NOT PERSISTED — a fresh open must start regular-only again.
    await pageE.goto(instrUrl('/reports', GID_EP))
    await pageE.waitForSelector('[data-testid="nv-instance-header"]')
    await pageE.click('text=Expected profit by order quantity')
    await pageE.waitForSelector('[data-testid="nv-ep-chart"]')
    check(await exists(pageE, '[data-testid="nv-ep-line-regular"]')
      && !(await exists(pageE, '[data-testid="nv-ep-line-dual"]')),
      '⚠ a FRESH open starts regular-only again — toggle state is not persisted')

    // ── 12. ⚠ THE OUTCOMES TABLE — In-stock %, no Participation, no overflow ───
    console.log('\n[12] The outcomes table')
    // A student who orders exactly Q* should be in stock about CR of the time. Twenty
    // periods is enough for the rate to land near 0.81 without being a coin flip.
    const GID_IS = `nvpw-instock-${stamp}`
    await openInstance(GID_IS, { ...CFG, periods: 20 }, 'pw-instock')
    await callFn('newsvendorBootstrap', asStudent(GID_IS, 'optimal-stu'))
    let fullyStocked = 0
    for (let n = 1; n <= 20; n++) {
      const res = await callFn('newsvendorSubmitRound', asStudent(GID_IS, 'optimal-stu', { round: n, order: 1265 }))
      if (res.ok && 1265 >= res.result.round.demand) fullyStocked++
    }
    const expectedRate = fullyStocked / 20
    check(fullyStocked > 0 && fullyStocked < 20,
      `the optimal-ordering student was stocked out at least once (${fullyStocked}/20 in stock)`)

    const ctxT = await browser.newContext()
    const pageT = await ctxT.newPage()
    await pageT.goto(instrUrl('/reports', GID_IS))
    await pageT.waitForSelector('[data-testid="nv-instance-header"]', { timeout: 30000 })
    await pageT.click('text=Outcomes — all students')
    await pageT.waitForSelector('[data-testid="nv-report-outcomes"]')

    const shownRate = await testId(pageT, 'nv-instock-optimal-stu')
    check(shownRate === fmtPct(expectedRate),
      `In-stock % is periods-fully-stocked / periods-played (${shownRate} = ${fullyStocked}/20)`)
    // ⚠ …and it is COMPARABLE TO THE CRITICAL RATIO, which is the reason the column
    // exists. A ±0.2 band over 20 periods is generous but still falsifiable — the
    // demand-met average this replaced would sit far higher.
    check(Math.abs(expectedRate - 0.8113) < 0.2,
      `⚠ …and an optimal orderer's rate ≈ the critical ratio 0.81 (got ${expectedRate.toFixed(2)})`)

    const tableText = await pageT.locator('[data-testid="nv-report-outcomes"]').innerText()
    check(/In-stock %/.test(tableText), 'the In-stock % column is present')
    check(!/Avg demand met/.test(tableText), '⚠ …and "Avg demand met" is gone — it was replaced')
    check(!/Participation/.test(tableText), '⚠ the Participation column is REMOVED')
    check(!/\bKC\b/.test(tableText), '⚠ the KC column is REMOVED')
    check(/Avg profit/.test(tableText) && !/Total profit/.test(tableText),
      '⚠ the profit column is "Avg profit", not "Total profit"')

    // ⚠ THE DOLLAR COLUMNS ARE PER-PERIOD AVERAGES, not 20× totals. This student ordered
    // exactly Q* for twenty periods, so their average profit must land on the
    // expected-profit chart's peak (~$1.785M) rather than at ~$35M.
    const shownAvgProfit = await testId(pageT, 'nv-avgprofit-optimal-stu')
    const avgProfitNum = Number(shownAvgProfit.replace(/[^0-9.-]/g, ''))
    check(avgProfitNum > 1_500_000 && avgProfitNum < 2_100_000,
      `⚠ Avg profit is PER PERIOD — ${shownAvgProfit}, on the chart's ~$1.78M scale, not a 20× total`)
    const shownBench = await testId(pageT, 'nv-avgbench-optimal-stu')
    const benchNum = Number(shownBench.replace(/[^0-9.-]/g, ''))
    check(benchNum > 1_500_000 && benchNum < 2_100_000,
      `⚠ …and so is Benchmark (${shownBench})`)
    const shownGap = await testId(pageT, 'nv-gap-optimal-stu')
    const gapNum = Number(shownGap.replace(/[^0-9.-]/g, ''))
    check(Math.abs(gapNum) < 200_000,
      `⚠ …and Gap, which is now a per-period difference (${shownGap})`)
    check(Math.abs((benchNum - avgProfitNum) - Math.abs(gapNum)) < 2,
      'the three dollar columns are arithmetically consistent: Benchmark − Avg profit = Gap')

    // ⚠ NO HORIZONTAL OVERFLOW at a normal instructor width.
    //
    // ⚠⚠ MEASURING scrollWidth ON THE WRAPPER IS USELESS HERE, and an earlier version of
    // this check did exactly that and passed for the wrong reason. game-ui's
    // SortableTable renders `<table style={{ width: '100%' }}>` with wrapping cells, so
    // the table can NEVER exceed its container: scrollWidth always equals clientWidth
    // and the assertion is vacuous. A table that "doesn't fit" shows up as CRAMPED
    // COLUMNS AND WRAPPED TEXT, not as a scrollbar.
    //
    // So this measures the table's INTRINSIC width — what it would occupy if allowed to
    // size to its content — by flipping it to `max-content`, reading it, and restoring.
    // That number can genuinely exceed the box, which is what makes the comparison mean
    // something.
    const overflow = await pageT.evaluate(() => {
      const box = document.querySelector('[data-testid="nv-report-outcomes"]')
      const table = box?.querySelector('table')
      if (!box || !table) return null
      const client = box.clientWidth
      const laidOut = table.scrollWidth
      const prev = table.style.width
      table.style.width = 'max-content'
      const intrinsic = table.scrollWidth
      table.style.width = prev
      return { scroll: intrinsic, laidOut, client }
    })
    check(overflow !== null, 'measured the outcomes table')
    check(overflow.scroll > 0 && overflow.client > 0, 'both widths are real numbers')
    check(overflow.scroll <= overflow.client + 1,
      `⚠ the table FITS its modal — no horizontal scroll (${overflow.scroll}px content in ${overflow.client}px)`)
    // ⚠ MEASURED, THEN CHOSEN. Dropping KC and moving to per-period averages shortened
    // the dollar values enough that full precision fits, so the roster shows exact
    // figures rather than abbreviations. If a later column pushes it over, the fit
    // assertion above fails first.
    console.log(`  [width] outcomes table: intrinsic ${overflow.scroll}px in a ${overflow.client}px box `
      + `(laid out at ${overflow.laidOut}px)`)
    check(/\$[\d,]{7,}/.test(tableText),
      'the dollar columns are FULL PRECISION ($1,785,189) — measured to fit')

    console.log(`\n${'═'.repeat(70)}`)
    console.log(`Newsvendor browser harness: ${passed} passed, ${failed} failed`)
    console.log('═'.repeat(70))
    if (failed > 0) process.exitCode = 1
  } finally {
    await browser.close()
    vite.kill('SIGKILL')
  }
}

main().catch(err => {
  console.error('\nHarness crashed:', err)
  process.exit(1)
})
