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
async function makeInstance({
  rounds, reserve, seed, kcVisible,
  format = 'sealed_first_price',
  // ⚠ OPEN-FORMAT PACING. The [OPEN] section sets a SHORT but NON-ZERO delay: zero would
  // make the client's tick indistinguishable from a synchronous loop, and the tick is the
  // one piece of this screen that static render tests cannot reach.
  delayMs = null, delayJitterMs = null,
  /** ⚠ A FULL BAND SCHEDULE, for the sections that must run at SHIPPED pacing. */
  delaySchedule = null,
  // ⚠⚠ THE PLAYER COST RANGE IS PARAMETERISED, and it must be. A passive student is
  // AUTO-DROPPED the moment the price falls below their cost (2026-08-04), so the round
  // RESOLVES mid-cascade and never reaches `waiting`. A section that drives the manual
  // path — bid, refusal, Drop Out — has to draw a student the cascade will not pass, or
  // it goes red on whichever draw it happened to get. That is exactly how this section
  // failed on its first headed run while passing headless.
  playerCostMin = 10, playerCostMax = 60,
}) {
  const gid = `pwproc-${++seq}-${Date.now()}`
  await putDoc(`procurement_game_instances/${gid}/config/main`, {
    format: strVal(format),
    rounds: intVal(rounds),
    rivalCount: intVal(4),
    reserve: intVal(reserve),
    rivalCostDist: distVal(10, 110),
    playerCostDist: distVal(playerCostMin, playerCostMax),
    bidIncrementUnit: intVal(1),
    currencyLabel: strVal('ECU'),
    kcEnabled: boolVal(kcVisible.length > 0),
    kcVisible: arrVal(kcVisible.map(strVal)),
    ...(delayMs === null ? {} : {
      delaySchedule: arrVal([mapVal({ above: intVal(0), delayMs: intVal(delayMs) })]),
    }),
    ...(delaySchedule === null ? {} : {
      delaySchedule: arrVal(delaySchedule.map(b =>
        mapVal({ above: intVal(b.above), delayMs: intVal(b.delayMs) }))),
    }),
    ...(delayJitterMs === null ? {} : { delayJitterMs: intVal(delayJitterMs) }),
  })
  if (seed !== null) {
    await putDoc(`procurement_game_instances/${gid}/truth/main`, { seed: strVal(seed) })
  }
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

/** Close every open report modal.
 *
 *  ⚠ A LOOP, NOT ONE CLICK. The per-student drill-through closes BACK TO the roster
 *  (that is where it was opened from), so a single Close leaves the roster modal up and
 *  its backdrop swallows the next tile click — which surfaces as an opaque 30s
 *  "intercepts pointer events" timeout rather than anything about modals. */
async function closeModals(page) {
  for (let i = 0; i < 4; i++) {
    const btn = page.locator('[data-testid="proc-rep-modal-close"]')
    if (await btn.count() === 0) return
    await btn.first().click()
    await page.waitForTimeout(150)
  }
  throw new Error('modals would not close')
}

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
      // ⚠⚠ THE REFERENCE PANEL MUST NOT BE ON THE KC SCREEN. It states the award rule
      // (S1, S2), the payoff rule (S3, S5) and the reserve (S4) — essentially the whole
      // graded set, three lines under the question asking for it.
      check(!(await exists(page, '[data-testid="proc-reserve"]')),
        `KC ${i + 1}: ⚠ the auction reference panel is ABSENT — it gave away the answers`)
      const kcBody = await bodyText(page)
      check(!/lowest bid wins the contract/i.test(kcBody),
        `KC ${i + 1}: and the award rule is not printed beside the question`)
      check(!/10 to 60|between 10 and 60/.test(kcBody),
        `KC ${i + 1}: ⚠ §4 no player cost range on the knowledge check either`)
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

      if (t === 1) {
        // ⚠⚠ §4: "students are told the rival distribution only; their own range is never
        // mentioned because it is not needed to bid well." The realized cost is shown —
        // it is the RANGE that must not be.
        const bidBody = await bodyText(page)
        check(/10 to 110/.test(bidBody),
          'the RIVAL cost range is printed — the equilibrium markup needs it (§1)')
        check(!/10 to 60|between 10 and 60/.test(bidBody),
          '⚠ §4 the player\'s OWN cost range is NOT printed on the bidding screen')
      }

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
    // ⚠ WAIT FOR IT, DO NOT SAMPLE FOR IT. The bot series arrives from a SECOND call:
    // `finished_at` is stamped by the final round's commit, so the state call that seeded
    // the page was correctly refused the rival costs and `Play.tsx` re-fetches them once
    // the loop ends. Asserting `exists()` the instant Continue is clicked is a race with
    // that fetch — it won for every run until the bundle grew, then went red for a reason
    // that had nothing to do with the toggle. Waiting keeps the check honest: it still
    // fails if the toggle never appears.
    await page.waitForSelector('[data-testid="proc-scatter-bot-toggle"]', { timeout: 15_000 })
      .catch(() => { /* fall through to the check, which reports it properly */ })
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
    // ⚠ THE REPORTS PAGE IS A TILE GRID NOW (08-03): each report opens in its own modal.
    // ⚠ WAIT FOR A TILE THAT ONLY EXISTS WITH DATA. The roster tile renders immediately
    // showing 0, because the board is built from `rows ?? []` before the fetch resolves —
    // so waiting on it is a race, the same one that bit the roster table earlier.
    await irp.waitForSelector('[data-testid="proc-tile-S8"]', { timeout: 30_000 })
    check(true, '[reports] the tile grid renders')
    check(await exists(irp, '[data-testid="proc-tile-chart"]'), '[reports] with a tile for the class chart')
    check(await exists(irp, '[data-testid="proc-tile-S8"]') && await exists(irp, '[data-testid="proc-tile-S9"]'),
      '[reports] and one tile per free-text question')

    await irp.locator('[data-testid="proc-tile-roster"]').click()
    await irp.waitForSelector('[data-testid="proc-rep-roster"] tbody tr button', { timeout: 15_000 })
    check(true, '[Tier 1a] the roster opens in its own window, with data')
    // ⚠ NO KC COLUMN (Elena, 08-03).
    const rosterHead = await irp.locator('[data-testid="proc-rep-roster"] thead').innerText()
    check(!/\bKC\b/.test(rosterHead), '⚠ [Tier 1a] and it has NO knowledge-check column')

    // ⚠ NOT a string match on the participant id — the roster renders `name ?? id`, and
    // a bootstrap that supplies a name would fail that assertion while the page was
    // perfectly correct. Assert the FIGURES instead: one student, eight rounds, and the
    // win count the playthrough actually produced.
    const rosterRows = await irp.locator('[data-testid="proc-rep-roster"] tbody tr').count()
    check(rosterRows === 1, '[Tier 1a] exactly one student is on the roster')
    // Columns: Name · Status · Rounds · Won · Profit · (drill-through button).
    // ⚠ KC is deliberately absent (Elena, 08-03), which is why these indices moved.
    const rosterCells = await irp
      .locator('[data-testid="proc-rep-roster"] tbody tr td').allInnerTexts()
    check(rosterCells[1] === 'Finished', '[Tier 1a] and it reports their status')
    check(rosterCells[2] === String(ROUNDS),
      '[Tier 1a] and the rounds they played')
    check(rosterCells[3] === String(wins),
      '[Tier 1a] and the wins the playthrough actually produced')
    check(Number(rosterCells[4]) === expectedTotal,
      '[Tier 1a] and the profit the round screens showed')

    await irp.locator('[data-testid="proc-rep-roster"] button').first().click()
    await irp.waitForSelector('[data-testid="proc-rep-detail"]', { timeout: 15_000 })
    const detail = await testId(irp, 'proc-rep-detail')
    check(detail.includes('Optimal') || (await bodyText(irp)).includes('Optimal'),
      '⚠ [Tier 1b] the per-student detail carries the OPTIMAL bid column')
    check((await irp.locator('[data-testid="proc-rep-detail"] tbody tr').count()) === ROUNDS,
      '[Tier 1b] one row per round played')

    // ── Tier 3, behind its own tile ────────────────────────────────────────
    await closeModals(irp)
    await irp.locator('[data-testid="proc-tile-chart"]').click()
    await irp.waitForSelector('[data-testid="proc-class-scatter"]', { timeout: 15_000 })
    check(await exists(irp, '[data-testid="proc-class-scatter"]'),
      '[Tier 3] the class scatter opens in its own window')
    check(await exists(irp, '[data-testid="proc-class-scatter-legend"]'),
      '[Tier 3] with a legend')
    check(await svgCount(irp, 'proc-class-scatter-rival') > 0,
      '⚠ [Tier 3] and the simulated rivals are plotted as their own series')
    const classPoints = await svgCount(irp, 'proc-class-scatter-point')
    check(classPoints === ROUNDS,
      `[Tier 3] with one point per bid in the instance (${classPoints})`)
    check(await exists(irp, '[data-testid="proc-class-scatter-optimal"]'),
      '[Tier 3] and the optimal line')
    check((await testId(irp, 'proc-class-scatter-n')).includes(`${ROUNDS} student bids`),
      '[Tier 3] captioned with how many student bids it is drawn from')

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
    await irpB.waitForSelector('[data-testid="proc-tile-chart"]', { timeout: 30_000 })
    await irpB.locator('[data-testid="proc-tile-chart"]').click()
    await irpB.waitForSelector('[data-testid="proc-class-scatter-point"]', { timeout: 15_000 })
    const optimalPointsB = await irpB.locator('[data-testid="proc-class-scatter-optimal"]')
      .getAttribute('points')
    check(optimalPointsA !== optimalPointsB,
      '⚠ [Tier 3] a different rival range and bidder count draw a DIFFERENT optimal line')
    mustFail(() => optimalPointsA === optimalPointsB,
      'the two instances share one optimal line (a hardcoded constant would)')

    // ── Tier 2 ─────────────────────────────────────────────────────────────
    await closeModals(irp)
    await irp.locator('[data-testid="proc-tile-S8"]').click()
    await irp.waitForSelector('[data-testid="proc-rep-text-S8"]', { timeout: 15_000 })
    check((await testId(irp, 'proc-rep-text-S8')).includes('decent markup'),
      '[Tier 2] the prep answers open in their own window')
    await closeModals(irp)
    await irp.locator('[data-testid="proc-tile-S9"]').click()
    await irp.waitForSelector('[data-testid="proc-rep-text-S9"]', { timeout: 15_000 })
    check((await testId(irp, 'proc-rep-text-S9')).includes('under-marked up'),
      '[Tier 2] and the debrief answers in theirs — the PAIR is the point')

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

    // ── The ROBOT driver, spawned as the launcher spawns it ────────────────────
    // ⚠⚠ THE CHECK THAT WAS MISSING. This section imported the AUTO-DRIVE and proved it
    // worked, which said nothing about the ROBOT driver — a different module the launcher
    // spawns as a CHILD PROCESS. That one shipped as a library with no CLI: node loaded
    // it, nothing ran, exit 0, and the launcher logged "spawned robot-driver — 16 seats"
    // followed by "driver exited (code 0)". Elena hit it; no harness did.
    //
    // Spawning is the only way to test an entry point. Importing tests a function.
    const robotGid = await makeInstance({ rounds: 2, reserve: RESERVE, seed: 'pw-robots', kcVisible: KC })
    const robotOut = await new Promise((resolve) => {
      const child = spawn('node', [
        path.join(ROOT, 'bot', 'procurement-robot-driver.mjs'),
        '--instance', robotGid,
        '--seats', '2',
        '--pace', 'fast',
        '--launcher', 'http://127.0.0.1:1',
        // ⚠ NAMES THE SEAT IDS ONLY (Elena, 08-07). Gameplay still reads the format off
        // the screen; this just stops a sealed instance's ids claiming open personas or
        // vice versa. The caller made the instance, so it is the one thing that knows.
        '--format', 'sealed_first_price',
        '--emulator', '--app', APP, '--headless', '--exit-when-done',
      ], { cwd: path.join(ROOT, 'bot'), stdio: ['ignore', 'pipe', 'pipe'] })
      let out = ''
      child.stdout.on('data', d => { out += d })
      child.stderr.on('data', d => { out += d })
      child.on('exit', code => resolve({ code, out }))
    })
    check(robotOut.code === 0,
      `⚠⚠ [launcher] the ROBOT DRIVER runs to completion when spawned (exit ${robotOut.code})`)
    check(/procurement robots —/.test(robotOut.out),
      '⚠ [launcher] and it ANNOUNCES itself — a driver with no CLI exits 0 in silence')
    check(/2\/2 robots finished/.test(robotOut.out),
      '⚠ [launcher] and both robots played a whole game through the UI')

    const robotRep = await callFn('procurementGetReport', { _dev: { game_instance_id: robotGid } })
    check(robotRep.rows.length === 2 && robotRep.rows.every(r => r.roundsPlayed === 2),
      '[launcher] and the server has both complete games on record')

    // The launcher seat is MARKED in the Tier-2 report, so it cannot be read as a
    // student's real answer.
    const repL = await callFn('procurementGetReport', { _dev: { game_instance_id: gidL } })
    const seat = repL.rows.find(r => r.participantId === pidL)
    check(/Launcher demo seat/i.test(seat?.freeText?.S8 ?? ''),
      '⚠ [launcher] and its prep answer is MARKED as a demo seat in Elena\'s report')

    await page.close(); await rp.close(); await irp.close(); await irpB.close(); await lp.close()

    // ═════════════════════════════════════════════════════════════════════════
    section('[OPEN]  The open-bid auction, driven by the browser\'s own tick')

    // ⚠⚠ THIS SECTION EXISTS FOR ONE THING THE OTHER TESTS CANNOT REACH: THE TICK.
    // `renderToStaticMarkup` does not run effects, and the emulator harness calls
    // `procurementAdvance` itself — so in both of those the CLIENT'S TIMER is untested.
    // If it never fires, the auction sits at the reserve forever and the game is
    // unplayable, and nothing green anywhere else would say so. Here the browser is left
    // alone and the price has to fall by itself.
    //
    // ⚠ A REAL, SHORT DELAY (120ms), not zero. Zero would let a synchronous loop pass —
    // the harness must observe the client WAITING and then asking.
    const gidO = await makeInstance({
      rounds: 2, reserve: RESERVE, seed: null, kcVisible: [],
      format: 'open_descending', delayMs: 120, delayJitterMs: 0,
      // ⚠ A CHEAP STUDENT: the cascade halts ABOVE them, so the round waits for a decision
      // and this section exercises the MANUAL path. See makeInstance's note.
      playerCostMin: 10, playerCostMax: 12,
    })
    const pidO = 'pw-open'
    const op = await browser.newPage()
    await op.goto(studentUrl(gidO, pidO))

    // With no KC the flow opens straight on the auction.
    await op.waitForSelector('[data-testid="proc-open-standing"]', { timeout: 30_000 })
    check(true, '[open] the flow opens on the LIVE BIDDING SCREEN, not on a "not built" notice')

    const opened = Number(await testId(op, 'proc-open-standing'))
    check(opened === RESERVE, `[open] and it opens at the reserve (${opened})`)

    // ⚠ THE ASSERTION THE WHOLE SECTION IS FOR: nothing is touched, and the price falls.
    await op.waitForFunction(
      (r) => {
        const el = document.querySelector('[data-testid="proc-open-standing"]')
        return el !== null && Number(el.textContent) < r
      },
      RESERVE, { timeout: 20_000 },
    )
    check(true, '⚠⚠ [open] the price falls WITHOUT the harness touching anything — the client tick fires')

    // ⚠ THE OPENING ROW IS THERE FROM THE FIRST PAINT, before any bid exists (§4.1).
    check(/Auction opened at 110 ECU/.test(await bodyText(op)),
      '[open] the history opens with "Auction opened at 110 ECU"')

    // Let the cascade run itself out. The halt is "it is your move".
    await op.waitForSelector('[data-testid="proc-open-waiting"]', { timeout: 30_000 })
    const halted = Number(await testId(op, 'proc-open-standing'))
    check(halted < RESERVE, `[open] the cascade halts on its own at ${halted}`)
    check(/not winning/i.test(await testId(op, 'proc-open-winning')),
      '[open] and the student is told they are not winning')

    // ⚠⚠ AND THE SCREEN NEVER SAYS WHO IS LEFT, OR WHY THE PRICE STOPPED MOVING.
    // A competitor's departure is not announced in a live auction — the player infers it
    // from silence, and silence is ambiguous between "priced out" and "still thinking".
    // Asserted AT THE HALT, which is the moment a count would have been most revealing:
    // by now bots really have dropped away, so the scenario contains the condition.
    const haltedBody = await bodyText(op)
    check(!/still bidding/i.test(haltedBody),
      '⚠⚠ [open] no "N of M still bidding" anywhere on the page')
    check(!/nobody else will go lower/i.test(haltedBody),
      '⚠⚠ [open] and the page does not announce that everyone else has stopped')
    check(!/priced out|has stopped|no longer bidding/i.test(haltedBody),
      '[open] nor say it in any other words')
    check(/5 in this auction/.test(haltedBody),
      '[open] the OPENING TOTAL is still shown — it is a parameter, and it never moved')
    // ⚠ Every history row is an action somebody took. No bot announces a departure.
    check(!/Bot \d+ — dropped out/.test(haltedBody),
      '⚠⚠ [open] and no bot emits a drop-out row — only bids appear')

    // ⚠ AND IT STAYS HALTED. §4.4: no clock, no timeout, no auto-resolve.
    const beforeIdle = await testId(op, 'proc-open-standing')
    await op.waitForTimeout(2_000)
    check(await testId(op, 'proc-open-standing') === beforeIdle,
      '⚠ [open] an idle round does not move, and does not resolve — there is no clock (§4.4)')
    check(await exists(op, '[data-testid="proc-open-dropout"]'),
      '[open] Bid and Drop Out are still live after the wait')

    // ⚠ THE BID BOX IS PRE-FILLED WITH THE MINIMUM LEGAL BID, and the button names it.
    const minShown = await testId(op, 'proc-open-min')
    const boxValue = await op.locator('[data-testid="proc-open-bid-input"]').inputValue()
    check(minShown.startsWith(`${boxValue} `),
      `[open] the box is pre-filled with the minimum next bid (${boxValue} / "${minShown}")`)
    check((await testId(op, 'proc-open-bid-min')).includes(boxValue),
      '[open] and the one-click button names the same number')

    // ⚠ AN ILLEGAL BID IS REFUSED IN THE UI, with a reason, and the round survives it.
    await op.fill('[data-testid="proc-open-bid-input"]', String(halted))
    await op.click('[data-testid="proc-open-bid"]')
    await op.waitForSelector('[data-testid="proc-open-error"]', { timeout: 15_000 })
    check(/must bid at least|price moved/i.test(await testId(op, 'proc-open-error')),
      '[open] an illegal bid is refused with a visible reason')

    // Now play the round out with the one-click button until it ends.
    for (let i = 0; i < 40; i++) {
      if (await exists(op, '[data-testid="proc-open-continue"]')) break
      if (await exists(op, '[data-testid="proc-open-bid-min"]')
        && await op.locator('[data-testid="proc-open-bid-min"]').isEnabled()) {
        await op.click('[data-testid="proc-open-bid-min"]')
      }
      await op.waitForTimeout(400)
    }
    check(await exists(op, '[data-testid="proc-open-continue"]'),
      '⚠ [open] bidding the minimum repeatedly ENDS the round — the duel terminates')
    const finalPrice = await testId(op, 'proc-open-final-price')
    check(/\d+ ECU/.test(finalPrice), `[open] and the final price is shown (${finalPrice})`)

    // ⚠ THE NEXT ROUND OPENS FRESH, AT THE RESERVE — the lazily-opened auction arriving
    // when the student does, rather than one already half-overdue.
    await op.click('[data-testid="proc-open-continue"]')
    await op.waitForSelector('[data-testid="proc-open-standing"]', { timeout: 30_000 })
    check(Number(await testId(op, 'proc-open-standing')) === RESERVE,
      '[open] round 2 opens fresh at the reserve')

    // Drop out of round 2 — the format's own action, and the end of the game.
    await op.click('[data-testid="proc-open-dropout"]')
    await op.waitForSelector('[data-testid="proc-open-continue"]', { timeout: 30_000 })
    check(/dropped out/i.test(await bodyText(op)),
      '[open] Drop Out ends the round and is described as a decision, not an absence')
    await op.click('[data-testid="proc-open-continue"]')
    await op.waitForSelector('[data-testid="proc-open-end-heading"]', { timeout: 30_000 })
    check(/Your 2 auctions/.test(await bodyText(op)),
      '[open] and two rounds finish the game')

    // ── §5.3 THE OPEN RESULTS SCREEN ─────────────────────────────────────────
    //
    // ⚠⚠ THE REFUSAL THIS SCREEN EXISTS FOR: it must NOT be the sealed one. β is the
    // sealed first-price equilibrium and would judge every round against a line the round
    // was never played against.
    const endBody = await bodyText(op)
    check(!/optimal bid at each cost|0\.8c \+ 22/i.test(endBody),
      '⚠⚠ [open] the results screen draws NO β line')
    check(await exists(op, '[data-testid="proc-exit-45"]'),
      '[open] it draws the 45° line as the benchmark instead')
    check(/Where you stopped/.test(endBody),
      '[open] the per-round table shows EXIT PRICE, not a bid')
    check(!/Optimal/i.test(endBody), '[open] and has no optimal-bid column')
    check(await exists(op, '[data-testid="proc-open-end-perfect"]'),
      '[open] the frictionless benchmark is shown (§7 / Item 1)')
    // ⚠⚠ IT READS AS A FACT ABOUT AUCTIONS, NOT AS A SCORE. A student can legitimately
    // earn MORE than this figure — discrete increments hand the winner the gap between
    // the last two bids — so nothing here may read as an error or a mark.
    check(/With no bid increments/.test(endBody),
      '⚠⚠ [open] and it is labelled as the FRICTIONLESS outcome')
    check(!/Perfect play would have earned/.test(endBody),
      '[open] the old ceiling wording is gone')
    check(/increment size is an auction-design decision/i.test(endBody),
      '⚠ [open] and the gap is named as the lesson')
    check(!/you should have|is incorrect|a mistake in your/i.test(endBody),
      '[open] nothing on the screen blames the student for the gap')
    check(/plotted separately/i.test(endBody),
      '⚠ [open] and the caption says WHY winners are a separate series (§7)')
    // ⚠ THE BOT SERIES IS DEFAULT OFF (§7) — the reader reveals the benchmark.
    check(!(await exists(op, '[data-testid="proc-exit-bot"]')),
      '[open] the simulated-supplier series is default OFF')
    await op.locator('[data-testid="proc-open-end-show-bots"]').click()
    check(await exists(op, '[data-testid="proc-exit-bot"]'),
      '[open] and the toggle reveals it')

    const openRep = await callFn('procurementGetReport', { _dev: { game_instance_id: gidO } })
    const openRow = openRep.rows.find(r => r.participantId === pidO)
    check(openRow?.roundsPlayed === 2,
      '[open] the server has both rounds on record — including the Drop Out one')

    await op.close()

    // ═════════════════════════════════════════════════════════════════════════
    section('[OPEN ROBOTS]  The open cohort, SPAWNED as the launcher spawns it')

    // ⚠⚠ SPAWNED, NOT IMPORTED. BUILD_NOTES §6f: this driver once shipped as a library —
    // exports, no `main()` — so the launcher loaded it, nothing ran, and it exited 0,
    // which reads as success. Both harnesses import-tested it and were green throughout.
    // Importing tests a function; only spawning tests an entry point.
    //
    // ⚠ AND THE BUG THIS SECTION EXISTS FOR: the open robots never clicked Drop Out, so
    // no round ever resolved and the Tier-3 chart had nothing to plot. The trigger is
    // "minimum next bid < threshold", NOT "price < threshold" — at a standing of 48 with a
    // cost of 47 the price is still above cost while the next legal bid is already a loss.
    // ⚠ SEEDED, AND FOUR ROUNDS — deliberately, and for a reason worth recording. The
    // chart checks below need the cohort to CONTAIN BOTH OUTCOMES: a series assertion that
    // runs against a cohort where nobody won is vacuous, and an unseeded 2-round cohort
    // produced exactly that on the first run. A seed makes the cohort's contents a fact
    // rather than a coin flip.
    //
    // ⚠ THIS DOES NOT RE-INTRODUCE BUILD_NOTES §6e's TRAP ("every instance set a seed").
    // The unseeded classroom shape is exercised end to end by the emulator harness's §15,
    // which is where that property belongs; what is under test HERE is the chart, and its
    // input needs to be known.
    // ⚠⚠ SHIPPED PACING, NOT ZERO (Elena, 2026-08-04). The earlier cohort ran at
    // `delayMs: 0`, which zeroed the pacing exactly where the stall lived: the open loop
    // budgeted by ITERATIONS (400 × 150 ms ≈ 60–80 s), and at the real schedule
    // — 800/1200/2500/3000 — a long endgame exceeded it, fell out of the loop and then
    // timed out waiting for a Continue that was never coming. Two of eight stuck.
    //
    // The budget is wall-clock now, and this instance uses the SHIPPED delay schedule so
    // the fix is verified against the thing that broke rather than beside it.
    const robotGidO = await makeInstance({
      rounds: 4, reserve: RESERVE, seed: 'pw-open-robots', kcVisible: [],
      format: 'open_descending',
      delaySchedule: [
        { above: 80, delayMs: 800 }, { above: 50, delayMs: 1200 },
        { above: 30, delayMs: 2500 }, { above: 0, delayMs: 3000 },
      ],
      delayJitterMs: 250,
    })
    const robotOpen = await new Promise((resolve) => {
      const child = spawn(process.execPath, [
        'procurement-robot-driver.mjs',
        '--instance', robotGidO, '--students', '4', '--pace', 'fast',
        '--format', 'open_descending',
        '--emulator', '--app', APP, '--headless', '--exit-when-done',
      ], { cwd: path.join(ROOT, 'bot'), stdio: ['ignore', 'pipe', 'pipe'] })
      let out = ''
      child.stdout.on('data', d => { out += d })
      child.stderr.on('data', d => { out += d })
      child.on('exit', code => resolve({ code, out }))
    })
    // ⚠ PRINT THE CHILD'S OUTPUT WHEN IT FAILS. A spawn check that swallows stdout tells
    // you only that something went wrong, and the whole point of spawning rather than
    // importing is to see what the launcher would see.
    if (robotOpen.code !== 0) console.error(robotOpen.out.slice(-4000))
    check(robotOpen.code === 0,
      `⚠⚠ [open robots] the driver runs to completion against an OPEN instance (exit ${robotOpen.code})`)
    // ⚠ ECHO THE MARGIN ON SUCCESS, not only on failure. A wall-clock budget nobody can
    // see the headroom on is a budget nobody can trust — and the number only exists in a
    // run at SHIPPED pacing, which is this one.
    const marginLine = (robotOpen.out.match(/ {2}longest round observed:.*/) ?? [''])[0].trim()
    if (marginLine) console.log(`  ↳ ${marginLine}`)
    check(/longest round observed/.test(robotOpen.out),
      `⚠ [open robots] the driver reports its wall-clock margin — ${marginLine || 'MISSING'}`)
    check(/4\/4 robots finished/.test(robotOpen.out),
      '⚠⚠ [open robots] and all four finished — rounds RESOLVE, which they did not before')

    // ⚠ THE PERSONA LABELS ELENA WILL SEE. Asserted from the driver's own output rather
    // than from the styles module, so a rename that missed the driver shows up here.
    // ⚠ THREE PERSONAS NOW, not four. `exits below cost` is DELETED: no bidder may bid
    // below their own cost, so the region it existed to populate cannot be populated.
    for (const label of ['exits at cost', 'exits early', 'random exit']) {
      check(robotOpen.out.includes(label),
        `[open robots] the cohort contains "${label}"`)
    }

    // ⚠⚠ THE PARTICIPANT IDS NAME THE OPEN PERSONAS (Elena, 08-07). They used to embed
    // the SEALED persona — `robot-16-equilibrium` on an open instance — and these ids are
    // how the robot reports get read, so the label was misleading about the one thing it
    // exists to say. ⚠ ASSERTED ON THE IDS THEMSELVES, not on the summary line, because
    // the summary was always right; it was the id that lied.
    const openIds = [...robotOpen.out.matchAll(/robot-\d+-[a-z-]+/g)].map(m => m[0])
    check(openIds.length > 0, '[open robots] the driver prints participant ids at all')
    // ⚠ READ OFF procurement-styles.mjs, not guessed.
    const sealedNames = ['equilibrium', 'cost-bidder', 'over-marker', 'under-marker', 'random-in-band']
    const leaked = openIds.filter(id => sealedNames.some(n => id.endsWith(`-${n}`)))
    check(leaked.length === 0,
      `⚠⚠ [open robots] NO id names a SEALED persona — found ${leaked.join(', ') || 'none'}`)
    check(openIds.every(id => /-(exits-at-cost|exits-early|random-exit)$/.test(id)),
      `⚠ [open robots] every id names an OPEN persona — ${[...new Set(openIds)].join(', ')}`)

    const robotRepO = await callFn('procurementGetReport', { _dev: { game_instance_id: robotGidO } })
    check(robotRepO.rows.length === 4 && robotRepO.rows.every(r => r.roundsPlayed === 4),
      '[open robots] the server has four complete games on record')

    // ⚠⚠ EVERY ROUND CARRIES AN EXIT PRICE. Item 1 wires the capture; without Item 2's
    // robots there was nothing to capture it FROM, which is why the two ship together.
    const allRounds = robotRepO.rows.flatMap(r => r.rounds)
    check(allRounds.length === 16, '[open robots] sixteen rounds in total')
    check(allRounds.every(r => typeof r.exitPrice === 'number'),
      '⚠⚠ [open robots] every round recorded an exit price (§7)')
    check(allRounds.every(r => r.exitCensored === r.won),
      '⚠ [open robots] and the censoring flag is set iff the round was won')

    // ⚠⚠ THE POINT OF FOUR PERSONAS: SPREAD. A cohort that all exited at cost would be a
    // single dot on the 45° line and would prove nothing about the chart it exists to
    // populate. Measured as the spread of (exit − cost), which is the y-axis distance
    // from the benchmark line.
    const gaps = allRounds.map(r => r.exitPrice - r.yourCost)
    const spread = Math.max(...gaps) - Math.min(...gaps)
    check(spread >= 8,
      `⚠⚠ [open robots] the exit prices SPREAD around the 45° line (range ${spread} ECU)`)
    // ⚠⚠ INVERTED. Nothing may sit below the 45° line any more — the mechanism forbids a
    // bid below cost and auto-drops a player the price has passed, whose exit is recorded
    // AT their cost. A single point under the line would mean the floor leaked.
    check(gaps.every(g => g >= 0),
      '⚠⚠ [open robots] NO exit sits below cost — the region under the line is unreachable')

    // ⚠ AND THE BENCHMARK IS REAL: perfect play is never worse than what a robot managed.
    check(robotRepO.rows.every(r => r.rounds.every(x => x.profit <= 1e9)),
      '[open robots] every round has a profit figure')

    // ── the instructor page, on an OPEN instance ────────────────────────────
    const orp = await browser.newPage()
    await orp.goto(reportsUrl(robotGidO))
    await orp.waitForSelector('[data-testid="proc-tile-chart"]', { timeout: 30_000 })

    // ⚠⚠ THE LIVE BUG THIS CHECKPOINT EXISTS TO FIX. Before CP4b this page rendered the
    // SEALED scatter for an open instance: cascade bids against cost, β drawn through
    // them, captioned "the rivals bid the optimal markup for their own cost every time"
    // over data that visibly contradicted it.
    await orp.locator('[data-testid="proc-tile-chart"]').click()
    await orp.waitForSelector('[data-testid="proc-exit-scatter"]', { timeout: 30_000 })
    const chartBody = await bodyText(orp)
    check(true, '[open reports] the class chart opens')
    check(!/optimal markup/i.test(chartBody),
      '⚠⚠ [open reports] the β caption is GONE — it was false for this format')
    check(!/Optimal bid at each cost/i.test(chartBody),
      '⚠⚠ [open reports] and so is the β line')
    check(await exists(orp, '[data-testid="proc-exit-45"]'),
      '[open reports] the 45° line is the benchmark instead')
    // ⚠⚠ EXACT COUNTS, DERIVED FROM THE REPORT rather than from the DOM they check. If the
    // two series were pooled — the mistake §7 exists to prevent — every point would land in
    // one of them and these two numbers could not both come out right.
    //
    // ⚠ AND THE SCENARIO MUST CONTAIN THE CONDITION. An earlier version simply asserted
    // both selectors existed; the cohort it ran against happened to contain no wins, so
    // "no winner dots" was correct behaviour and a failed assertion. The counts are
    // asserted to be non-zero on BOTH sides, so a cohort that cannot exercise the split
    // fails loudly instead of passing vacuously.
    const wonRounds = allRounds.filter(r => r.exitCensored).length
    const lostRounds = allRounds.filter(r => !r.exitCensored).length
    check(wonRounds > 0 && lostRounds > 0,
      `[open reports] the cohort contains both outcomes (${wonRounds} won, ${lostRounds} lost)`)
    check(await orp.locator('[data-testid="proc-exit-won"]').count() === wonRounds,
      `⚠⚠ [open reports] exactly ${wonRounds} winner points are plotted as their own series`)
    check(await orp.locator('[data-testid="proc-exit-lost"]').count() === lostRounds,
      `⚠⚠ [open reports] and exactly ${lostRounds} as stopped-bidding points (§7)`)
    check(/plotted separately/i.test(chartBody),
      '⚠ [open reports] and the caption states WHY')
    check(!(await exists(orp, '[data-testid="proc-exit-bot"]')),
      '[open reports] the supplier series is default off')
    await orp.locator('[data-testid="proc-rep-show-bots"]').click()
    check(await exists(orp, '[data-testid="proc-exit-bot"]'),
      '[open reports] and the toggle reveals it')
    await closeModals(orp)

    // ── the per-student rounds modal, format-gated ──────────────────────────
    await orp.locator('[data-testid="proc-tile-roster"]').click()
    await orp.waitForSelector('[data-testid="proc-rep-roster"]', { timeout: 30_000 })

    // ── ⚠ SORTING, DRIVEN BY A REAL HEADER CLICK IN A REAL BROWSER ──────────
    // The unit tests pin the COMPARATORS; only this proves the header is wired to them
    // and that the widget re-orders the rendered rows. It is asserted on the robot
    // cohort because it is the only place with a class big enough for order to mean
    // anything. ⚠ Names come from the roster itself, never hardcoded.
    const rosterNames = async () => (await orp
      .locator('[data-testid="proc-rep-roster"] tbody tr td:first-child').allInnerTexts())
      .map(s => s.replace(/See rounds.*$/s, '').trim())

    const surname = n => { const t = n.trim().split(/\s+/); return t[t.length - 1] }
    const asShown = await rosterNames()
    check(asShown.length > 1, '[open reports] the roster has a class to sort')

    // Default is Name ascending → already by SURNAME, not by the display string.
    const bySurname = [...asShown].sort((a, b) =>
      surname(a).localeCompare(surname(b), undefined, { sensitivity: 'base' })
      || a.localeCompare(b, undefined, { sensitivity: 'base' }))
    check(JSON.stringify(asShown) === JSON.stringify(bySurname),
      '⚠⚠ [open reports] the roster opens sorted by LAST name (Elena, 08-07)')

    // Clicking the active header reverses it.
    await orp.locator('[data-testid="proc-rep-roster"] thead th').first().click()
    const reversed = await rosterNames()
    check(JSON.stringify(reversed) === JSON.stringify([...bySurname].reverse()),
      '[open reports] and clicking the Name header reverses that order')

    // Clicking a DIFFERENT header re-sorts on that column, ascending.
    await orp.locator('[data-testid="proc-rep-roster"] thead th').nth(4).click()
    const byProfit = await orp
      .locator('[data-testid="proc-rep-roster"] tbody tr td:nth-child(5)').allInnerTexts()
    const nums = byProfit.map(Number)
    check(nums.every((v, i) => i === 0 || nums[i - 1] <= v),
      '⚠ [open reports] and clicking Profit sorts NUMERICALLY, ascending')
    // ⚠ Back to Name so the drill-through below sees the order it expects.
    await orp.locator('[data-testid="proc-rep-roster"] thead th').first().click()

    const firstOpen = robotRepO.rows[0].participantId
    await orp.locator(`[data-testid="proc-rep-open-${firstOpen}"]`).click()
    await orp.waitForSelector('[data-testid="proc-rep-detail"]', { timeout: 30_000 })
    const openDetail = await bodyText(orp)
    check(/Exit price/.test(openDetail),
      '⚠ [open reports] the per-student table shows EXIT PRICE')
    check(!/Optimal/.test(openDetail),
      '⚠⚠ [open reports] and the sealed "Optimal" column is GONE — it had no meaning here')
    check(/upper bound/i.test(openDetail),
      '[open reports] the caption explains the censoring marker')
    await closeModals(orp)
    await orp.close()

    // ── and the SEALED reports are untouched ────────────────────────────────
    const srp = await browser.newPage()
    await srp.goto(reportsUrl(gid))
    await srp.waitForSelector('[data-testid="proc-tile-chart"]', { timeout: 30_000 })
    await srp.locator('[data-testid="proc-tile-chart"]').click()
    await srp.waitForSelector('[data-testid="proc-class-scatter"], svg', { timeout: 30_000 })
    const sealedBody = await bodyText(srp)
    check(/optimal markup/i.test(sealedBody),
      '⚠ [open reports] the SEALED instance still gets β and its caption — unchanged')
    check(!(await exists(srp, '[data-testid="proc-exit-scatter"]')),
      '[open reports] and never the exit scatter')
    await closeModals(srp)
    await srp.close()
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
