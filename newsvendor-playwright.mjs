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
//   • the INSTRUCTOR dashboard and all five report tiles against a MIXED population;
//   • ⚠ the dashboard UPDATING LIVE as students play, with no reload of any kind.
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
    const wantAvgOrder = played.reduce((a, p) => a + p.Q, 0) / played.length
    const wantAvgSl = played.reduce((a, p) => a + p.sl, 0) / played.length
    check(await testId(page, 'nv-final-total') === fmtMoney(wantTotal),
      `the final screen states the total profit (${fmtMoney(wantTotal)})`)
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

    const roster = await pageI.locator('[data-testid="nv-roster"]').innerText()
    const rosterRows = roster.split('\n')
    check(rosterRows.length > 1, `the roster rendered rows (${rosterRows.length} lines)`)
    check(/Finished/.test(roster), 'the roster marks the finisher Finished')
    check(/In progress \(1 period\)/.test(roster),
      'the mid-game student shows In progress WITH how far they have got, singular')
    check(/Not started/.test(roster), 'and the never-launched student shows Not started')
    check((await testId(pageI, 'nv-counts')).includes('1 finished / 2 started / 3 on roster'),
      'the action bar counts finished / started / on roster')

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
    check(/Benchmark profit/.test(outcomes) && /Gap/.test(outcomes),
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

    // ── 9. ⚠ THE DASHBOARD UPDATES LIVE, WITH NO RELOAD ────────────────────────
    // The regression this guards: the dashboard used to be a one-shot fetch, so it
    // showed whatever was true when the page opened and never moved again — Elena had
    // to hard-refresh to see the class progress. The assertion below is deliberately
    // NOT "reload and check": the page is left completely untouched between the two
    // reads, so the only thing that can update it is the live listener.
    console.log('\n[9] ⚠ The dashboard follows the class without a reload')
    const GID_L = `nvpw-live-${stamp}`
    await openInstance(GID_L, { ...CFG, periods: 5 }, 'pw-live')
    await callFn('newsvendorBootstrap', asStudent(GID_L, 'live-stu'))
    await callFn('newsvendorSubmitRound', asStudent(GID_L, 'live-stu', { round: 1, order: 1000 }))

    const ctxL = await browser.newContext()
    const pageL = await ctxL.newPage()
    await pageL.goto(instrUrl('/dashboard', GID_L))
    await pageL.waitForSelector('[data-testid="nv-roster"]', { timeout: 30000 })
    const before = await pageL.locator('[data-testid="nv-roster"]').innerText()
    check(/In progress \(1 period\)/.test(before),
      'the dashboard opens showing one period played')

    // Two more periods, submitted from OUTSIDE the browser entirely.
    await callFn('newsvendorSubmitRound', asStudent(GID_L, 'live-stu', { round: 2, order: 1100 }))
    await callFn('newsvendorSubmitRound', asStudent(GID_L, 'live-stu', { round: 3, order: 1200 }))

    // ⚠ NO RELOAD, NO CLICK, NO NAVIGATION between `before` and this wait.
    let live = false
    try {
      await pageL.waitForFunction(
        () => /In progress \(3 periods\)/.test(
          document.querySelector('[data-testid="nv-roster"]')?.textContent ?? ''),
        { timeout: 15000 })
      live = true
    } catch { live = false }
    check(live, '⚠ …and updates itself to three periods with NO reload (the live listener)')

    const after = await pageL.locator('[data-testid="nv-roster"]').innerText()
    check(before !== after, 'the rendered roster genuinely changed in place')
    check(/In progress \(3 periods\)/.test(after), `the roster now reads three periods`)

    // …and the numeric columns moved with the status, not just the label.
    check(/1,100|1,100.0/.test(after) || /1,1\d\d/.test(after),
      'the average-order column refreshed too, not only the status text')

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
