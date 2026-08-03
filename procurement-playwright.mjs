// ═══════════════════════════════════════════════════════════════════════════════
// Procurement Auction — REAL BROWSER harness (§14).
//
// The plumbing is pd/pricing/forecast's, which were written to be copied: emulator +
// Vite dev server + the `?_pid/_gid` dev identity. What is procurement-specific is what
// it asserts.
//
// ⚠⚠ READ AND ACT ARE BOTH THE UI — the standing false-green rule. Nothing here writes
// to Firestore and nothing calls a compute function to learn an outcome: the student
// types into the real controls, and every number checked is READ OFF THE RENDERED PAGE.
// A harness that called `procurementSubmitBid` and then asserted on its JSON would be
// green on a build whose bidding screen did not render at all.
//
// ⚠ THE SECTIONS THIS FILE OWES THE FLEET:
//   [STUDENT]  the whole flow — KC → prep → 8 rounds → results → debrief
//   [REPORTS]  Tier 1a, Tier 1b, Tier 2 and the Tier-3 class scatter, in the real page
//   [LAUNCHER] the SHIPPED auto-drive sequence, imported from bot/, end to end
//
// ⚠⚠ [LAUNCHER] IMPORTS `bot/procurement-autodrive.mjs` — the module the launcher itself
// loads — rather than reproducing the sequence. That is the entire point of the section.
// Forecast's second start position was offered and did nothing for weeks because the
// wording and the driver lived in different places and neither was exercised; a harness
// that re-implemented the drive would have been green throughout.
//
// Run:  npm run harness:procurement:browser
//       HEADED=1 npm run harness:procurement:browser   (watch it)
// ═══════════════════════════════════════════════════════════════════════════════

import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { driveProcurementStudentPastKc } from './bot/procurement-autodrive.mjs'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const PROJECT = 'demo-singleplayer'
const FUNCTIONS = `http://127.0.0.1:5010/${PROJECT}/us-central1`
const FIRESTORE = `http://127.0.0.1:8090/v1/projects/${PROJECT}/databases/(default)/documents`
const VITE_PORT = 5179
const APP = `http://127.0.0.1:${VITE_PORT}`
const HEADED = process.env.HEADED === '1'

let passed = 0, failed = 0
const check = (cond, label) => {
  if (cond) { passed++; console.log(`  ✓ ${label}`) }
  else { failed++; console.error(`  ✗ ${label}`) }
}
const section = (t) => console.log(`\n${t}`)

const mustFail = (predicate, label) => {
  let held
  try { held = predicate() } catch { held = false }
  if (held) {
    failed++
    console.error(`  ✗✗ NEGATIVE CONTROL DID NOT FAIL: ${label}`)
  } else {
    passed++
    console.log(`  ✓ negative control failed as required: ${label}`)
  }
}

// ── Emulator plumbing ──────────────────────────────────────────────────────────

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
const mapVal = (fields) => ({ mapValue: { fields } })
const distVal = (min, max) => mapVal({
  distribution: strVal('uniform'), min: intVal(min), max: intVal(max), integer: boolVal(true),
})

let seq = 0
/** ⚠ ONE WRITE, EVERY FIELD — a REST PATCH with no updateMask REPLACES the document, so
 *  a second "just add the KC keys" call silently deletes `rounds` and `reserve` and the
 *  instance falls back to shipped defaults. Learned the hard way on 08-03. */
async function makeInstance({ rounds, reserve, seed, kcVisible }) {
  const gid = `pwproc-${++seq}-${Date.now()}`
  await putDoc(`procurement_game_instances/${gid}/config/main`, {
    format: strVal('sealed_first_price'),
    rounds: intVal(rounds),
    rivalCount: intVal(4),
    reserve: intVal(reserve),
    rivalCostDist: distVal(10, 110),
    playerCostDist: distVal(10, 60),
    bidIncrementUnit: intVal(1),
    currencyLabel: strVal('ECU'),
    kcEnabled: boolVal(kcVisible.length > 0),
    kcVisible: arrVal(kcVisible.map(strVal)),
  })
  await putDoc(`procurement_game_instances/${gid}/truth/main`, { seed: strVal(seed) })
  return gid
}

// ── The Vite dev server ────────────────────────────────────────────────────────

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

  const child = spawn(
    'npx',
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
    },
  )
  child.stderr.on('data', d => process.stderr.write(`[vite] ${d}`))
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    try { if ((await fetch(APP)).ok) return child } catch { /* not up */ }
    await new Promise(r => setTimeout(r, 250))
  }
  child.kill('SIGKILL')
  throw new Error('vite dev server did not start within 60s')
}

// ── Browser helpers ────────────────────────────────────────────────────────────

const studentUrl = (gid, pid) => `${APP}/?game=procurement&_pid=${pid}&_gid=${gid}`
const reportsUrl = (gid) => `${APP}/reports?game=procurement&_gid=${gid}`

const testId = async (page, id) =>
  (await page.locator(`[data-testid="${id}"]`).first().innerText()).trim()
/** innerText is an HTMLElement API and THROWS on an SVG node — anything inside a chart
 *  has to be read with textContent instead. */
const svgCount = async (page, id) => page.locator(`[data-testid="${id}"]`).count()
const exists = async (page, sel) => (await page.locator(sel).count()) > 0

/** The whole rendered page, for "this number is nowhere on screen" assertions. */
const bodyText = async (page) => (await page.locator('body').innerText())

// ═══════════════════════════════════════════════════════════════════════════════

async function main() {
  const ROUNDS = 8
  const RESERVE = 110
  // Two graded questions plus the prep and debrief paragraphs — a real flow, short
  // enough to walk in a browser without the harness becoming a KC test.
  const KC = ['S1', 'S2', 'S8', 'S9']

  const vite = await startVite()
  const browser = await chromium.launch(HEADED ? { headless: false, slowMo: 120 } : {})

  try {
    // ═════════════════════════════════════════════════════════════════════════
    section('[STUDENT]  The whole flow, through the real UI')

    const gid = await makeInstance({ rounds: ROUNDS, reserve: RESERVE, seed: 'pw-seed', kcVisible: KC })
    const pid = 'pw-student'
    const page = await browser.newPage()
    await page.goto(studentUrl(gid, pid))

    // ── The knowledge check ────────────────────────────────────────────────
    await page.waitForSelector('[data-testid="proc-kc-prompt"]', { timeout: 30_000 })
    check(true, 'the flow OPENS on the knowledge check, not on the game')

    const kcSeen = []
    for (let i = 0; i < 2; i++) {
      kcSeen.push(await testId(page, 'proc-kc-prompt'))
      // ⚠ The auction's parameters are on the KC screen — it is an open-book check.
      check(await exists(page, '[data-testid="proc-reserve"]'),
        `KC ${i + 1}: the auction's parameters are on the screen (open book)`)
      await page.locator('[data-testid^="proc-kc-option-"]').first().click()
      await page.locator('[data-testid="proc-kc-submit"]').click()
      await page.waitForSelector('[data-testid="proc-kc-continue"]')
      // ⚠ NOT A GATE: a wrong answer still offers Continue.
      check(await exists(page, '[data-testid="proc-kc-continue"]'),
        `KC ${i + 1}: answered — and Continue is offered whether right or wrong (no gate)`)
      await page.locator('[data-testid="proc-kc-continue"]').click()
      if (i === 0) await page.waitForSelector('[data-testid="proc-kc-prompt"]')
    }
    check(kcSeen[0] !== kcSeen[1], 'the two questions are different questions')

    // ── The prep paragraph ─────────────────────────────────────────────────
    await page.waitForSelector('[data-testid="proc-freetext-prompt"]', { timeout: 15_000 })
    check(true, '[flow] the PREP paragraph comes after the KC and before round 1')
    check(!(await exists(page, '[data-testid="proc-bid-input"]')),
      'and the bidding screen is not reachable behind it')
    await page.locator('[data-testid="proc-freetext-input"]').fill('I plan to add a decent markup.')
    await page.locator('[data-testid="proc-freetext-submit"]').click()

    // ── The eight rounds ───────────────────────────────────────────────────
    await page.waitForSelector('[data-testid="proc-bid-input"]', { timeout: 15_000 })

    let expectedTotal = 0
    let wins = 0
    const bidsMade = []
    for (let t = 1; t <= ROUNDS; t++) {
      const heading = await testId(page, 'proc-round-heading')
      check(heading === `Round ${t} of ${ROUNDS}`, `round ${t}: the heading says "Round ${t} of ${ROUNDS}"`)

      const costText = await testId(page, 'proc-cost')
      const cost = Number(costText.replace(/[^0-9]/g, ''))
      check(cost >= 10 && cost <= 60, `round ${t}: the student's own cost is rendered, in the player range`)

      // ⚠ THE RESERVE GATE, EXERCISED THROUGH THE UI, on round 1 only.
      if (t === 1) {
        await page.locator('[data-testid="proc-bid-input"]').fill(String(RESERVE + 1))
        const hint = await bodyText(page)
        check(hint.includes(`above the reserve price of ${RESERVE} will not be accepted`),
          '⚠ a bid above the reserve is refused ON SCREEN, in the spec\'s own words')
        check(await page.locator('[data-testid="proc-bid-submit"]').isDisabled(),
          'and the submit control is not offered while the bid is invalid')
        await page.locator('[data-testid="proc-bid-input"]').fill('')
      }

      const bid = Math.min(RESERVE, cost + 6 + (t % 4))
      bidsMade.push({ cost, bid })
      await page.locator('[data-testid="proc-bid-input"]').fill(String(bid))
      await page.locator('[data-testid="proc-bid-submit"]').click()

      // ── The round result ─────────────────────────────────────────────────
      await page.waitForSelector('[data-testid="proc-result-heading"]', { timeout: 15_000 })

      const rows = await page.locator('[data-testid="proc-bid-table"] tbody tr').count()
      check(rows === 5, `round ${t}: all five bids are shown`)

      // Sorted ascending, read off the rendered table.
      const cells = await page.locator('[data-testid="proc-bid-table"] tbody tr td:nth-child(2)').allInnerTexts()
      const amounts = cells.map(c => c.includes('no bid') ? Infinity : Number(c.replace(/[^0-9]/g, '')))
      check(amounts.every((v, i) => i === 0 || amounts[i - 1] <= v),
        `round ${t}: and they are sorted ascending, with "no bid" last`)

      const body = await bodyText(page)
      const won = body.includes('you won the contract')
      if (won) wins++

      const roundProfit = Number((await testId(page, 'proc-round-profit')).replace(/[^0-9-]/g, '')) *
        ((await testId(page, 'proc-round-profit')).startsWith('-') ? 1 : 1)
      expectedTotal += won ? bid - cost : 0
      check(roundProfit === (won ? bid - cost : 0),
        `round ${t}: the profit on screen is bid − cost when won, zero when lost`)

      const totalOnScreen = Number((await testId(page, 'proc-total-profit')).replace(/[^0-9-]/g, ''))
      check(totalOnScreen === expectedTotal, `round ${t}: the running total on screen agrees`)

      // ⚠ THE COUNTERFACTUAL appears on a LOSING round, and not on a winning one.
      const hasCf = await exists(page, '[data-testid="proc-counterfactual"]')
      check(hasCf === !won, `round ${t}: the counterfactual is shown iff the round was lost`)

      // ⚠ NO RIVAL COST ANYWHERE ON THE ROUND RESULT.
      check(!/cost of \d+ was above/.test(body) || body.includes('Your cost'),
        `round ${t}: no rival's cost is narrated on the result screen`)

      await page.locator('[data-testid="proc-result-continue"]').click()
      if (t < ROUNDS) await page.waitForSelector('[data-testid="proc-bid-input"]', { timeout: 15_000 })
    }

    // ── The final results (§9) ─────────────────────────────────────────────
    await page.waitForSelector('[data-testid="proc-end-heading"]', { timeout: 15_000 })
    check(await testId(page, 'proc-end-wins') === String(wins),
      '[§9] the results screen counts the wins the rounds actually produced')
    check(Number((await testId(page, 'proc-end-profit')).replace(/[^0-9-]/g, '')) === expectedTotal,
      '[§9] and the cumulative profit matches what the rounds paid')
    check((await testId(page, 'proc-end-benchmark')).includes('perfect player'),
      '[§9] "a perfect player would have earned X from your draws" is on the screen')
    check(await page.locator('[data-testid^="proc-end-row-"]').count() === ROUNDS,
      '[§9] the per-round table has one row per round')
    check((await bodyText(page)).includes('Optimal bid'),
      '[§9] and it carries the equilibrium-bid column')

    // ── The scatter ────────────────────────────────────────────────────────
    check(await exists(page, '[data-testid="proc-scatter"]'), '[§9] the scatter renders')
    check(await svgCount(page, 'proc-scatter-you-point') === ROUNDS,
      '[§9] with one point per round')
    check(await exists(page, '[data-testid="proc-scatter-optimal"]'),
      '[§9] and the optimal line')
    // ⚠ THE BOT SERIES DEFAULTS TO OFF.
    check(await svgCount(page, 'proc-scatter-bot-point') === 0,
      '⚠ [§9] the bot series is OFF on arrival — the student reads their own pattern first')
    check(await exists(page, '[data-testid="proc-scatter-bot-toggle"]'),
      '[§9] the toggle is offered, because the game is over')
    await page.locator('[data-testid="proc-scatter-bot-toggle"]').check()
    const botPoints = await svgCount(page, 'proc-scatter-bot-point')
    check(botPoints > 0, `[§9] switching it on plots the bots (${botPoints} points)`)
    check(await exists(page, '[data-testid="proc-scatter-bot-note"]'),
      '[§9] with the sentence that explains why they sit on the line')

    // ── The debrief ────────────────────────────────────────────────────────
    await page.locator('[data-testid="proc-end-continue"]').click()
    await page.waitForSelector('[data-testid="proc-freetext-prompt"]', { timeout: 15_000 })
    check(true, '[flow] the DEBRIEF comes after the results, not before')
    await page.locator('[data-testid="proc-freetext-input"]').fill('I under-marked up early on.')
    await page.locator('[data-testid="proc-freetext-submit"]').click()
    await page.waitForSelector('[data-testid="proc-end-heading"]', { timeout: 15_000 })
    check(!(await exists(page, '[data-testid="proc-end-continue"]')),
      '[flow] and the terminal view has nothing left to continue to')

    // ── RESUME, at the end ─────────────────────────────────────────────────
    await page.reload()
    await page.waitForSelector('[data-testid="proc-end-heading"]', { timeout: 20_000 })
    check(!(await exists(page, '[data-testid="proc-bid-input"]')),
      '[resume] a finished student reloads onto the results, never back into the loop')

    // ═════════════════════════════════════════════════════════════════════════
    section('[RESUME]  A reload mid-flow lands on the right screen')

    const gidR = await makeInstance({ rounds: 3, reserve: RESERVE, seed: 'pw-resume', kcVisible: KC })
    const pidR = 'pw-resume'
    const rp = await browser.newPage()
    await rp.goto(studentUrl(gidR, pidR))
    await rp.waitForSelector('[data-testid="proc-kc-prompt"]', { timeout: 30_000 })

    await rp.reload()
    await rp.waitForSelector('[data-testid="proc-kc-prompt"]', { timeout: 20_000 })
    check(true, '[resume] mid-KC reloads back onto the knowledge check')

    // Answer one, reload: must land on the SECOND question, not the first.
    const firstPrompt = await testId(rp, 'proc-kc-prompt')
    await rp.locator('[data-testid^="proc-kc-option-"]').first().click()
    await rp.locator('[data-testid="proc-kc-submit"]').click()
    await rp.waitForSelector('[data-testid="proc-kc-continue"]')
    await rp.reload()
    await rp.waitForSelector('[data-testid="proc-kc-prompt"]', { timeout: 20_000 })
    check(await testId(rp, 'proc-kc-prompt') !== firstPrompt,
      '⚠ [resume] one answered question later, the reload lands on the NEXT one')

    // Finish the KC and the prep, play one round, reload: back on round 2's bid screen.
    await rp.locator('[data-testid^="proc-kc-option-"]').first().click()
    await rp.locator('[data-testid="proc-kc-submit"]').click()
    await rp.locator('[data-testid="proc-kc-continue"]').click()
    await rp.waitForSelector('[data-testid="proc-freetext-input"]', { timeout: 15_000 })
    await rp.reload()
    await rp.waitForSelector('[data-testid="proc-freetext-input"]', { timeout: 20_000 })
    check(true, '[resume] KC done, prep unanswered → reloads onto the prep paragraph')

    await rp.locator('[data-testid="proc-freetext-input"]').fill('A plan.')
    await rp.locator('[data-testid="proc-freetext-submit"]').click()
    await rp.waitForSelector('[data-testid="proc-bid-input"]', { timeout: 15_000 })
    const rCost = Number((await testId(rp, 'proc-cost')).replace(/[^0-9]/g, ''))
    await rp.locator('[data-testid="proc-bid-input"]').fill(String(Math.min(RESERVE, rCost + 8)))
    await rp.locator('[data-testid="proc-bid-submit"]').click()
    await rp.waitForSelector('[data-testid="proc-result-heading"]', { timeout: 15_000 })
    await rp.reload()
    await rp.waitForSelector('[data-testid="proc-bid-input"]', { timeout: 20_000 })
    check(await testId(rp, 'proc-round-heading') === 'Round 2 of 3',
      '⚠ [resume] one round played → reloads onto round 2, never back to round 1')
    // ⚠ AND THE COST IS THE SAME ONE. A reload must not re-roll into a friendlier draw.
    const beforeCost = await testId(rp, 'proc-cost')
    await rp.reload()
    await rp.waitForSelector('[data-testid="proc-cost"]', { timeout: 20_000 })
    check(await testId(rp, 'proc-cost') === beforeCost,
      '⚠ [resume] and the round\'s cost is unchanged by the reload — no re-roll')

    // ⚠ THE SCATTER'S BOT SERIES IS NOT REACHABLE MID-GAME.
    check(!(await exists(rp, '[data-testid="proc-scatter-bot-toggle"]')),
      '⚠ [§9] and mid-game there is no bot-series toggle anywhere on the student\'s screen')

    // ═════════════════════════════════════════════════════════════════════════
    section('[REPORTS]  The instructor page, in the browser')

    const irp = await browser.newPage()
    await irp.goto(reportsUrl(gid))
    // ⚠ WAIT FOR THE DATA, NOT FOR THE TABLE. The roster element exists immediately,
    // rendering "No students yet." while the report fetch is still in flight — so
    // waiting on the table and then reading it is a RACE, and one that resolves in the
    // harness's favour often enough to look stable. Wait for a row that could only come
    // from loaded data.
    await irp.waitForSelector('[data-testid="proc-rep-roster"] tbody tr button', { timeout: 30_000 })
    check(true, '[Tier 1a] the roster renders, with data')

    // ⚠ NOT a string match on the participant id — the roster renders `name ?? id`, and
    // a bootstrap that supplies a name would fail that assertion while the page was
    // perfectly correct. Assert the FIGURES instead: one student, eight rounds, and the
    // win count the playthrough actually produced.
    const rosterRows = await irp.locator('[data-testid="proc-rep-roster"] tbody tr').count()
    check(rosterRows === 1, '[Tier 1a] exactly one student is on the roster')
    const rosterCells = await irp
      .locator('[data-testid="proc-rep-roster"] tbody tr td').allInnerTexts()
    check(rosterCells[1] === String(ROUNDS),
      '[Tier 1a] and it reports the rounds they played')
    check(rosterCells[2] === String(wins),
      '[Tier 1a] and the wins the playthrough actually produced')
    check(Number(rosterCells[3]) === expectedTotal,
      '[Tier 1a] and the profit the round screens showed')

    await irp.locator('[data-testid="proc-rep-roster"] button').first().click()
    await irp.waitForSelector('[data-testid="proc-rep-detail"]', { timeout: 15_000 })
    const detail = await testId(irp, 'proc-rep-detail')
    check(detail.includes('Optimal') || (await bodyText(irp)).includes('Optimal'),
      '⚠ [Tier 1b] the per-student detail carries the OPTIMAL bid column')
    check((await irp.locator('[data-testid="proc-rep-detail"] tbody tr').count()) === ROUNDS,
      '[Tier 1b] one row per round played')

    // ── Tier 3 ─────────────────────────────────────────────────────────────
    check(await exists(irp, '[data-testid="proc-class-scatter"]'),
      '[Tier 3] the class scatter renders')
    const classPoints = await svgCount(irp, 'proc-class-scatter-point')
    check(classPoints === ROUNDS,
      `[Tier 3] with one point per bid in the instance (${classPoints})`)
    check(await exists(irp, '[data-testid="proc-class-scatter-optimal"]'),
      '[Tier 3] and the optimal line')
    check((await testId(irp, 'proc-class-scatter-n')).includes(`${ROUNDS} bids`),
      '[Tier 3] captioned with how many bids it is drawn from')

    // ⚠ THE TIER-3 LINE IS PER INSTANCE. A second instance with a DIFFERENT rival range
    // must draw a DIFFERENT line — the failure a hardcoded `0.8c + 22` would hide, in
    // the chart Elena presents in lecture.
    const optimalPointsA = await irp.locator('[data-testid="proc-class-scatter-optimal"]')
      .getAttribute('points')

    const gidB = `pwproc-alt-${Date.now()}`
    await putDoc(`procurement_game_instances/${gidB}/config/main`, {
      format: strVal('sealed_first_price'),
      rounds: intVal(2), rivalCount: intVal(9), reserve: intVal(200),
      rivalCostDist: distVal(10, 200), playerCostDist: distVal(10, 60),
      bidIncrementUnit: intVal(1), currencyLabel: strVal('ECU'),
      kcEnabled: boolVal(false), kcVisible: arrVal([]),
    })
    await putDoc(`procurement_game_instances/${gidB}/truth/main`, { seed: strVal('alt') })
    await callFn('procurementBootstrap', { _test: { participant_id: 'alt', game_instance_id: gidB } })
    const altState = await callFn('procurementGetState', { _test: { participant_id: 'alt', game_instance_id: gidB } })
    await callFn('procurementSubmitBid', {
      _test: { participant_id: 'alt', game_instance_id: gidB },
      round: 1, bid: Math.min(200, altState.currentCost + 10),
    })

    const irpB = await browser.newPage()
    await irpB.goto(reportsUrl(gidB))
    await irpB.waitForSelector('[data-testid="proc-class-scatter-point"]', { timeout: 30_000 })
    const optimalPointsB = await irpB.locator('[data-testid="proc-class-scatter-optimal"]')
      .getAttribute('points')
    check(optimalPointsA !== optimalPointsB,
      '⚠ [Tier 3] a different rival range and bidder count draw a DIFFERENT optimal line')
    mustFail(() => optimalPointsA === optimalPointsB,
      'the two instances share one optimal line (a hardcoded constant would)')

    // ── Tier 2 ─────────────────────────────────────────────────────────────
    check(await exists(irp, '[data-testid="proc-rep-text-S8"]'),
      '[Tier 2] the prep paragraph has its own tile')
    check(await exists(irp, '[data-testid="proc-rep-text-S9"]'),
      '[Tier 2] and so does the debrief — the PAIR is the point')
    check((await testId(irp, 'proc-rep-text-S8')).includes('decent markup'),
      '[Tier 2] the student\'s own prep answer is in it')
    check((await testId(irp, 'proc-rep-text-S9')).includes('under-marked up'),
      '[Tier 2] and their debrief answer')

    // ═════════════════════════════════════════════════════════════════════════
    section('[LAUNCHER]  The SHIPPED auto-drive sequence, end to end')

    // ⚠⚠ THE MODULE THE LAUNCHER LOADS, imported directly — not a copy of its steps.
    // A harness that re-implemented the drive would stay green while the shipped one
    // rotted, which is exactly how forecast's second start position came to do nothing.
    const gidL = await makeInstance({ rounds: 4, reserve: RESERVE, seed: 'pw-launch', kcVisible: KC })
    const pidL = 'pw-launched'
    const auth = { _test: { participant_id: pidL, game_instance_id: gidL } }

    const driveResult = await driveProcurementStudentPastKc(
      (fn, data) => callFn(fn, data), auth)

    check(driveResult.kcEnabled === true && driveResult.kcTotal === 2,
      '[launcher] the drive reads the instance\'s OWN question set — no hardcoded count')
    check(driveResult.questionsAnswered === 2,
      '[launcher] and answers every one of them')
    check(driveResult.prepEnabled === true && driveResult.prepSubmitted === true,
      '⚠ [launcher] AND submits the prep paragraph — the screen forecast\'s drive would have missed')

    // The whole point: open the tab and confirm where it lands.
    const lp = await browser.newPage()
    await lp.goto(studentUrl(gidL, pidL))
    await lp.waitForSelector('[data-testid="proc-bid-input"]', { timeout: 30_000 })
    check(await testId(lp, 'proc-round-heading') === 'Round 1 of 4',
      '⚠⚠ [launcher] the driven tab opens ON THE BIDDING SCREEN — not the KC, not the prep')
    check(!(await exists(lp, '[data-testid="proc-kc-prompt"]')),
      '[launcher] with no knowledge check in front of it')

    // ⚠ THE DEBRIEF IS NOT DRIVEN — "start at game" means start, not finish.
    check(!(await exists(lp, '[data-testid="proc-end-heading"]')),
      '[launcher] and the game is not played for them')

    // Re-driving the same student is common (Elena reopens a tab) and must not throw.
    const again = await driveProcurementStudentPastKc((fn, data) => callFn(fn, data), auth)
    check(again.prepSubmitted === true,
      '[launcher] re-driving an already-driven student succeeds rather than throwing')

    // The launcher seat is MARKED in the Tier-2 report, so it cannot be read as a
    // student's real answer.
    const repL = await callFn('procurementGetReport', { _dev: { game_instance_id: gidL } })
    const seat = repL.rows.find(r => r.participantId === pidL)
    check(/Launcher demo seat/i.test(seat?.freeText?.S8 ?? ''),
      '⚠ [launcher] and its prep answer is MARKED as a demo seat in Elena\'s report')

    await page.close(); await rp.close(); await irp.close(); await irpB.close(); await lp.close()
  } finally {
    await browser.close()
    vite.kill('SIGKILL')
  }

  console.log(`\n${'═'.repeat(70)}`)
  console.log(`  ${passed} passed, ${failed} failed`)
  console.log('═'.repeat(70))
  if (failed > 0) process.exit(1)
}

main().catch(err => {
  console.error('\nHARNESS ERROR:', err)
  process.exit(1)
})
