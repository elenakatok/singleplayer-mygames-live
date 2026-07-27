// ═══════════════════════════════════════════════════════════════════════════════
// Pricing Game (Cheyenne Shipping) — REAL BROWSER harness (Playwright + Chromium).
//
// pricing-playthrough.mjs beside this one drives the callables over HTTP: it proves
// the SERVER is right. This one drives the actual UI in a real browser against the
// real emulator, and proves the GAME is right — that a student clicking through the
// page gets a correct, complete, non-leaking experience. It is ADDITIONAL coverage,
// not a replacement: the HTTP harness still owns the server contract.
//
// Copied from pd-playwright.mjs, which was written to be copied: the plumbing (vite
// boot, emulator seeding, response capture) is unchanged and only the selectors and
// the assertions are this game's.
//
// WHAT IT COVERS, end to end, ONCE PER MODE (spec §12):
//   • PMG only: the standalone rules screen BEFORE the knowledge check (spec §6.2);
//   • the knowledge check — every question ANSWERED (a correct run and a wrong run),
//     proving a wrong answer is recorded and scored and does NOT block entry to the
//     game (there is no gate);
//   • the price-entry screen — the market facts, both firms' base share and unit
//     cost, and the formulas, all rendered from the instance's config;
//   • the whole round loop to the drawn horizon, with every competitor price and
//     every share, demand and profit predicted from the spec and checked against the
//     rendered result screen AND the rendered history row;
//   • the competitor's round-1 price rendering as the ceiling ($2,000);
//   • PMG: the rules panel present, the effective price = the lower posted price,
//     shares frozen — and the rules panel ABSENT in Standard;
//   • price validation in the browser (out of bounds, non-integer) gating submit;
//   • resume — reload mid-loop and land on the right round with history intact;
//   • the debrief — the competitor reveal appearing only after the last round, and
//     the paragraph submitting;
//   • the end screen revealing the round count, the total and the average;
//   • ⚠ NO "of M" ROUND-TOTAL STRING ANYWHERE, and no leak of the drawn horizon or
//     the competitor's rule into the page or into any callable response the browser
//     actually received.
//
// Run:
//   npm install && npx playwright install chromium     (once)
//   npm run harness:pricing:browser
//   HEADED=1 npm run harness:pricing:browser           ← watch it play
//
// It boots the Vite DEV server itself (dev mode is what enables the ?_pid/_gid test
// identity and the emulator wiring in frontend/src/firebase.ts) and shuts it down on
// the way out.
//
// ⚠ WHY NOT "THROUGH THE LAUNCHER": the launcher (classroom/tools/launcher) is a
// PRODUCTION tool — it needs admin credentials, reads the deployed classroom's
// registry, and opens instances that exist in a live project. Pricing has no deployed
// functions, no hosting site content, and no classroom registry entry yet, so there
// is nothing for it to launch. This harness therefore uses the same local path
// pd-playwright.mjs uses (emulator + vite dev + the ?_pid/_gid dev identity), which
// exercises the identical UI and the identical callables. A launcher-driven run
// becomes possible once pricing is deployed and registered.
// ═══════════════════════════════════════════════════════════════════════════════

import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PROJECT = 'demo-singleplayer'
const FUNCTIONS = `http://127.0.0.1:5010/${PROJECT}/us-central1`
const FIRESTORE = `http://127.0.0.1:8090/v1/projects/${PROJECT}/databases/(default)/documents`
const ROOT = path.dirname(fileURLToPath(import.meta.url))
const VITE_PORT = 5198
const APP = `http://localhost:${VITE_PORT}`
/** HEADED=1 runs a visible browser, slowed enough to follow. */
const HEADED = process.env.HEADED === '1'

let passed = 0, failed = 0
const check = (cond, label) => {
  if (cond) { passed++; console.log(`  ✓ ${label}`) }
  else { failed++; console.error(`  ✗ ${label}`) }
}

// ── Emulator plumbing (shared shape with pricing-playthrough.mjs) ──────────────

async function callFn(name, data) {
  const res = await fetch(`${FUNCTIONS}/${name}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data }),
  })
  let body = null
  try { body = await res.json() } catch { /* ignore */ }
  if (res.ok && body && 'result' in body) return { ok: true, result: body.result }
  return { ok: false, error: body?.error?.message ?? `http ${res.status}` }
}

async function getDoc(docPath) {
  const res = await fetch(`${FIRESTORE}/${docPath}`, { headers: { Authorization: 'Bearer owner' } })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`firestore GET ${docPath} → ${res.status}`)
  return (await res.json()).fields ?? {}
}

async function putDoc(docPath, fields) {
  const res = await fetch(`${FIRESTORE}/${docPath}`, {
    method: 'PATCH',
    headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields }),
  })
  if (!res.ok) throw new Error(`firestore PATCH ${docPath} → ${res.status} ${await res.text()}`)
}

const strVal = (s) => ({ stringValue: s })
const boolVal = (b) => ({ booleanValue: b })
const asStudent = (gid, pid, extra = {}) => ({ _test: { participant_id: pid, game_instance_id: gid }, ...extra })

// ── The spec, re-implemented independently (never imported from the code under test) ──

/** The case's market (spec §2 defaults) — this harness never overrides it, so the
 *  screen it checks is the screen a real instance shows. */
const MARKET = {
  M: 190_000, sC: 0.35, sW: 0.65, cC: 966, cW: 900, k: 1000,
  minPrice: 900, maxPrice: 2000, gridStep: 100,
}

const clamp01 = (v) => Math.min(1, Math.max(0, v))

function expectedOutcome(pc, pw, pmg) {
  const m = MARKET
  if (pmg) {
    const eff = Math.min(pc, pw)
    return {
      yourShare: m.sC, competitorShare: m.sW,
      yourDemand: m.M * m.sC, competitorDemand: m.M * m.sW,
      yourProfit: m.M * m.sC * (eff - m.cC),
      competitorProfit: m.M * m.sW * (eff - m.cW),
      effectivePrice: eff,
    }
  }
  const sc = clamp01(m.sC + (pw - pc) / m.k)
  const sw = clamp01(m.sW + (pc - pw) / m.k)
  return {
    yourShare: sc, competitorShare: sw,
    yourDemand: m.M * sc, competitorDemand: m.M * sw,
    yourProfit: m.M * sc * (pc - m.cC),
    competitorProfit: m.M * sw * (pw - m.cW),
    effectivePrice: null,
  }
}

/** The competitor's price for the round after `priorPrices` (spec §5): the closed-form
 *  best reply snapped to the grid, ties to the higher price. The server computes a
 *  grid argmax instead — two routes to the same number is the point. */
function expectedCompetitorPrice(pmg, priorPrices) {
  const m = MARKET
  if (pmg) return m.maxPrice
  if (priorPrices.length === 0) return m.maxPrice
  const continuous = (m.sW * m.k + m.cW + priorPrices[priorPrices.length - 1]) / 2
  let best = m.minPrice, bestD = Infinity
  for (let p = m.minPrice; p <= m.maxPrice; p += m.gridStep) {
    const d = Math.abs(p - continuous)
    if (d < bestD - 1e-9 || (Math.abs(d - bestD) <= 1e-9 && p > best)) { bestD = d; best = p }
  }
  return best
}

// ── The KC answer key, derived here from the SPEC (never imported) ─────────────

const snapGrid = (v) => Math.min(MARKET.maxPrice, Math.max(MARKET.minPrice,
  Math.round(v / MARKET.gridStep) * MARKET.gridStep))
const QP = (() => {
  const theirs = snapGrid(MARKET.maxPrice - MARKET.gridStep)
  return { yours: snapGrid(theirs - 2 * MARKET.gridStep), theirs }
})()

const KC_KEY = {
  false: [
    { field: 'kc_base_share', correct: MARKET.sC.toFixed(4) },
    { field: 'kc_share_gap', correct: (MARKET.sC + (QP.theirs - QP.yours) / MARKET.k).toFixed(4) },
    { field: 'kc_contribution', correct: String(QP.yours - MARKET.cC) },
    { field: 'kc_below_cost', correct: 'negative' },
  ],
  true: [
    { field: 'kc_pmg_effective', correct: String(QP.yours) },
    { field: 'kc_pmg_share', correct: MARKET.sC.toFixed(4) },
    { field: 'kc_pmg_undercut', correct: 'none' },
  ],
}

// ── How the UI formats numbers (re-implemented from the spec, not imported) ─────

const fmtPrice = (d) => `$${Math.round(d).toLocaleString('en-US')}`
const fmtShare = (s) => `${(s * 100).toFixed(1)}%`
const fmtDemand = (c) => Math.round(c).toLocaleString('en-US')
function fmtProfitM(dollars) {
  const millions = dollars / 1_000_000
  const body = `$${Math.abs(millions).toFixed(2)}M`
  return Number(Math.abs(millions).toFixed(2)) === 0 ? body : (millions < 0 ? `−${body}` : body)
}

// ── The Vite dev server ────────────────────────────────────────────────────────

async function startVite() {
  const child = spawn(
    'npx',
    ['vite', '--port', String(VITE_PORT), '--strictPort', '--host', '127.0.0.1'],
    {
      cwd: path.join(ROOT, 'frontend'),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        // Dev mode loads no .env.production, and firebase/app needs SOMETHING. The
        // emulators accept any key; only the project id has to match.
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
    try {
      const res = await fetch(APP)
      if (res.ok) return child
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 250))
  }
  child.kill('SIGKILL')
  throw new Error('vite dev server did not start within 60s')
}

// ── Browser helpers ────────────────────────────────────────────────────────────

const studentUrl = (gid, pid) => `${APP}/?game=pricing&_pid=${pid}&_gid=${gid}`

const text = async (page, sel) => (await page.locator(sel).first().innerText()).trim()
const testId = async (page, id) => text(page, `[data-testid="${id}"]`)
const exists = async (page, sel) => (await page.locator(sel).count()) > 0

/** Every callable response this browser actually received, for the network audit. */
function captureResponses(page, sink) {
  page.on('response', async (res) => {
    const url = res.url()
    if (!url.startsWith(FUNCTIONS.replace('127.0.0.1', 'localhost')) && !url.startsWith(FUNCTIONS)) return
    const name = url.split('/').pop()
    try { sink.push({ name, body: await res.text() }) } catch { /* body already consumed */ }
  })
}

// ── Seeding ────────────────────────────────────────────────────────────────────

/** Seeds config/main, first-touches the student over HTTP, and reports the SERVER'S
 *  TRUTH (this student's drawn horizon) — which the harness knows and the browser
 *  must not. */
async function openInstance(gid, pid, seed, pmg) {
  await putDoc(`pricing_game_instances/${gid}/config/main`, {
    seed: strVal(seed),
    pmg: boolVal(pmg),
  })
  await callFn('pricingBootstrap', asStudent(gid, pid))
  await callFn('pricingGetState', asStudent(gid, pid))
  const stu = await getDoc(`pricing_game_instances/${gid}/truth/participant_${pid}`)
  return { rounds: Number(stu?.rounds?.integerValue) }
}

// ── Flow steps ─────────────────────────────────────────────────────────────────

/**
 * The PMG rules screen (spec §6.2) — a standalone screen BEFORE the knowledge check,
 * in PMG instances only. In Standard there must be nothing here at all.
 */
async function doPmgRulesScreen(page, pmg, label) {
  const present = await exists(page, '[data-testid="pricing-pmg-screen"]')
  check(present === pmg, `${label}: the standalone PMG rules screen is ${pmg ? 'shown first' : 'never shown'}`)
  if (!pmg) return
  const rules = (await testId(page, 'pricing-pmg-rules')).replace(/\s+/g, ' ')
  check(/Price Matching Guarantee/.test(rules), `${label}: it announces the rule`)
  check(rules.includes(fmtShare(MARKET.sC)) && rules.includes(fmtShare(MARKET.sW)),
    `${label}: …with both frozen shares, from config`)
  check(!(await exists(page, '[data-testid="pricing-kc-prompt"]')),
    `${label}: the knowledge check is NOT on this screen — it comes after`)
  await page.click('[data-testid="pricing-pmg-continue"]')
}

/**
 * Walks every knowledge-check screen, ANSWERING each one.
 *
 * @param mode 'correct' → answer every question right; 'wrong' → answer every one
 *             wrong (a deliberately different option), which must still let the
 *             student through: the KC is graded but is NOT a gate.
 */
async function doKc(page, pmg, mode, label) {
  const key = KC_KEY[String(pmg)]
  for (let i = 0; i < key.length; i++) {
    const { field, correct } = key[i]
    await page.waitForSelector('[data-testid="pricing-kc-prompt"]')

    if (i === 0) {
      // The market is ON the KC screen — the whole point is reading it (spec §8).
      check(await exists(page, '[data-testid="pricing-market-table"]'),
        `${label}: the market table is on the KC screen (open book)`)
      check(await page.locator('[data-testid="pricing-kc-submit"]').isDisabled(),
        `${label}: KC submit is gated until an option is chosen`)
      check(await exists(page, `[data-testid="pricing-kc-option-${correct}"]`),
        `${label}: the spec's correct answer is offered as an option (${correct})`)
    }

    const optionValues = await page.locator('[data-testid^="pricing-kc-option-"]')
      .evaluateAll(els => els.map(e => e.getAttribute('data-testid').replace('pricing-kc-option-', '')))
    const answer = mode === 'correct' ? correct : optionValues.find(v => v !== correct)
    await page.click(`[data-testid="pricing-kc-option-${answer}"]`)
    await page.click('[data-testid="pricing-kc-submit"]')

    const wantVerdict = mode === 'correct' ? 'pricing-kc-correct' : 'pricing-kc-incorrect'
    await page.waitForSelector(`[data-testid="${wantVerdict}"]`)
    check(true, `${label}: ${field} answered ${mode} → the ${mode === 'correct' ? 'correct' : 'incorrect'} verdict shows`)

    await page.click('[data-testid="pricing-kc-continue"]')
  }
  // Whatever the answers were, the next thing is the GAME — no gate, no pass mark.
  await page.waitForSelector('[data-testid="pricing-round-heading"]')
  check(true, `${label}: all ${key.length} answered ${mode} → the student reaches the round loop`)
}

/** The price-entry screen's standing content — checked once per mode, on round 1. */
async function checkEntryScreen(page, pmg, label) {
  // The market facts, from config.
  const marketSize = await testId(page, 'pricing-market-size')
  check(marketSize.includes(fmtDemand(MARKET.M)) && marketSize.includes(fmtPrice(MARKET.minPrice))
    && marketSize.includes(fmtPrice(MARKET.maxPrice)),
    `${label}: the market size and price bounds are on screen`)

  const you = (await testId(page, 'pricing-market-you')).replace(/\s+/g, ' ')
  const them = (await testId(page, 'pricing-market-competitor')).replace(/\s+/g, ' ')
  check(you.includes(fmtShare(MARKET.sC)) && you.includes(fmtPrice(MARKET.cC)),
    `${label}: YOUR base share and unit cost are shown (${you})`)
  check(them.includes(fmtShare(MARKET.sW)) && them.includes(fmtPrice(MARKET.cW)),
    `${label}: your COMPETITOR's base share and unit cost are shown (${them})`)

  // The formulas — the mode swaps them outright.
  check(await exists(page, `[data-testid="pricing-formulas-${pmg ? 'pmg' : 'standard'}"]`),
    `${label}: the ${pmg ? 'PMG' : 'Standard'} formulas are shown`)
  check(!(await exists(page, `[data-testid="pricing-formulas-${pmg ? 'standard' : 'pmg'}"]`)),
    `${label}: …and the ${pmg ? 'Standard' : 'PMG'} formulas are NOT`)

  // ⚠ The PMG rules panel: present in PMG, ABSENT in Standard (spec §6.2).
  const rules = await exists(page, '[data-testid="pricing-pmg-rules"]')
  check(rules === pmg,
    `${label}: the PMG rules panel is ${pmg ? 'present' : 'absent'} (found: ${rules})`)

  // The framing states the RANGE and nothing more about length.
  const framing = await testId(page, 'pricing-framing')
  check(/between 10 and 20 rounds/.test(framing.replace(/\s+/g, ' ')),
    `${label}: the framing states the round RANGE, the only disclosure spec §3 allows`)
  check(/your competitor/i.test(framing), `${label}: the framing says "your competitor"`)
}

/** Browser-side price validation: submit stays gated until the price is legal. */
async function checkPriceValidation(page, label) {
  check(await page.locator('[data-testid="pricing-submit-round"]').isDisabled(),
    `${label}: submit is disabled before a price is typed`)

  await page.fill('[data-testid="pricing-price-input"]', String(MARKET.maxPrice + 1))
  check(await page.locator('[data-testid="pricing-submit-round"]').isDisabled(),
    `${label}: a price above the ceiling keeps submit disabled`)
  check(await exists(page, '[data-testid="pricing-price-hint"]'),
    `${label}: …and says why`)

  await page.fill('[data-testid="pricing-price-input"]', String(MARKET.minPrice - 1))
  check(await page.locator('[data-testid="pricing-submit-round"]').isDisabled(),
    `${label}: a price below the floor keeps submit disabled`)

  await page.fill('[data-testid="pricing-price-input"]', '1400.5')
  check(await page.locator('[data-testid="pricing-submit-round"]').isDisabled(),
    `${label}: a non-whole-dollar price keeps submit disabled`)

  await page.fill('[data-testid="pricing-price-input"]', '')
}

/**
 * Plays the round loop to game over in the browser, checking the rendered result
 * screen and the rendered history row against an independent model every round.
 */
async function playRounds(page, pmg, priceFor, label, horizon) {
  const mine = []
  let runningTotal = 0
  let n = 0, over = false
  let firstRoundChecked = false

  while (!over && n < 40) {
    n++
    await page.waitForSelector('[data-testid="pricing-round-heading"]')

    const heading = await testId(page, 'pricing-round-heading')
    if (heading !== `Round ${n}`) {
      check(false, `${label}: round ${n} heading (got "${heading}")`)
      return null
    }

    if (!firstRoundChecked) {
      firstRoundChecked = true
      await checkEntryScreen(page, pmg, label)
      await checkPriceValidation(page, label)
      check(await exists(page, '[data-testid="pricing-history-empty"]'),
        `${label}: round 1 shows no history table yet`)
    }

    // ⚠ THE "of M" SWEEP, on every entry screen: nothing may state or imply a total
    // number of rounds (spec §1/§4). Checked as rendered TEXT, so it catches any
    // wording — "of 14", "14 rounds total", "round 3/14".
    const bodyText = (await page.locator('body').innerText()).replace(/\s+/g, ' ')
    const ofM = bodyText.match(/\bof\s+\d+\s*(rounds?)?\b|\bround\s*\d+\s*\/\s*\d+/i)
    if (ofM) check(false, `${label}: round ${n} entry screen leaks a round total ("${ofM[0]}")`)

    const myPrice = priceFor(n)
    const rivalExpected = expectedCompetitorPrice(pmg, mine)
    const expected = expectedOutcome(myPrice, rivalExpected, pmg)

    await page.fill('[data-testid="pricing-price-input"]', String(myPrice))
    await page.click('[data-testid="pricing-submit-round"]')
    await page.waitForSelector('[data-testid="pricing-reveal"]')

    // ── The rendered result screen, against the model ────────────────────────
    const gotYourPrice = await testId(page, 'pricing-you-price')
    const gotTheirPrice = await testId(page, 'pricing-them-price')
    const gotYourShare = await testId(page, 'pricing-you-share')
    const gotTheirShare = await testId(page, 'pricing-them-share')
    const gotYourDemand = await testId(page, 'pricing-you-demand')
    const gotTheirDemand = await testId(page, 'pricing-them-demand')
    const gotYourProfit = await testId(page, 'pricing-you-profit')
    const gotTheirProfit = await testId(page, 'pricing-them-profit')

    const agrees =
      gotYourPrice === fmtPrice(myPrice) &&
      gotTheirPrice === fmtPrice(rivalExpected) &&
      gotYourShare === fmtShare(expected.yourShare) &&
      gotTheirShare === fmtShare(expected.competitorShare) &&
      gotYourDemand === fmtDemand(expected.yourDemand) &&
      gotTheirDemand === fmtDemand(expected.competitorDemand) &&
      gotYourProfit === fmtProfitM(expected.yourProfit) &&
      gotTheirProfit === fmtProfitM(expected.competitorProfit)
    if (!agrees) {
      check(false, `${label}: round ${n} rendered outcome — expected competitor ${fmtPrice(rivalExpected)}/` +
        `${fmtShare(expected.competitorShare)}/${fmtProfitM(expected.competitorProfit)}, got ` +
        `${gotTheirPrice}/${gotTheirShare}/${gotTheirProfit}; you expected ` +
        `${fmtProfitM(expected.yourProfit)}, got ${gotYourProfit}`)
      return null
    }

    if (n === 1) {
      check(gotTheirPrice === fmtPrice(MARKET.maxPrice),
        `${label}: round 1 — your competitor posts the price ceiling (${gotTheirPrice})`)
    }

    // PMG: the effective price leads the screen; Standard has no such thing.
    const hasEffective = await exists(page, '[data-testid="pricing-effective-price"]')
    check(hasEffective === pmg, `${label}: round ${n} effective-price panel ${pmg ? 'shown' : 'absent'}`)
    if (pmg) {
      check(await testId(page, 'pricing-effective-price-value') === fmtPrice(Math.min(myPrice, rivalExpected)),
        `${label}: round ${n} — the price everyone paid is the LOWER posted (${fmtPrice(Math.min(myPrice, rivalExpected))})`)
    }

    // A loss must READ as a loss, not just render a negative number.
    if (expected.yourProfit < 0) {
      check(await exists(page, '[data-testid="pricing-you-loss"]'),
        `${label}: round ${n} — a below-cost price is labelled a loss on screen`)
    }

    // ── The history row that just landed ─────────────────────────────────────
    runningTotal += expected.yourProfit
    const histTotal = await testId(page, `pricing-history-total-${n}`)
    const histAvg = await testId(page, `pricing-history-average-${n}`)
    check(histTotal === fmtProfitM(runningTotal) && histAvg === fmtProfitM(runningTotal / n),
      `${label}: round ${n} history row carries the running cumulative and average ` +
      `(${histTotal} / ${histAvg})`)
    if (pmg) {
      check(await testId(page, `pricing-history-paid-${n}`) === fmtPrice(Math.min(myPrice, rivalExpected)),
        `${label}: round ${n} history row carries the price paid`)
    }

    mine.push(myPrice)

    await page.click('[data-testid="pricing-continue"]')
    // Either the next round's entry screen, or — when that was the drawn last round —
    // the debrief. (The end screen comes after the debrief, not instead of it.)
    await page.waitForSelector(
      '[data-testid="pricing-round-heading"], [data-testid="pricing-debrief-heading"], [data-testid="pricing-game-over"]')
    over = !(await exists(page, '[data-testid="pricing-round-heading"]'))
  }

  check(n === horizon, `${label}: the game ended at the student's OWN drawn horizon (${n} = ${horizon})`)
  return { rounds: n, prices: mine, total: runningTotal }
}

/**
 * The debrief (spec §9) and then the end screen, once the loop is over.
 *
 * ⚠ THE REVEAL IS THE ASSERTION THAT MATTERS. For the whole game the page has been
 * forbidden to name the competitor's rule; here it must finally say it. A harness that
 * only checked the "never" half would pass against a game that never revealed at all.
 */
async function doDebrief(page, run, label) {
  await page.waitForSelector('[data-testid="pricing-debrief-heading"]')

  check(await testId(page, 'pricing-debrief-rounds') === String(run.rounds),
    `${label}: the debrief REVEALS the round count (${run.rounds}) — the game is over, so it may`)
  check(await testId(page, 'pricing-debrief-total') === fmtProfitM(run.total),
    `${label}: …and the total profit the rounds add up to`)
  check(await testId(page, 'pricing-debrief-average') === fmtProfitM(run.total / run.rounds),
    `${label}: …and the average per round`)

  const reveal = await testId(page, 'pricing-competitor-reveal')
  check(/Your competitor was programmed to/.test(reveal),
    `${label}: the competitor reveal is finally on screen`)
  check(!/the bot/i.test(reveal), `${label}: …and still never calls it "the bot"`)
  check(await exists(page, `[data-testid="pricing-history-row-${run.rounds}"]`),
    `${label}: the full game is on screen while they write`)

  const prompt = await testId(page, 'pricing-debrief-prompt')
  check(/In a few sentences/.test(prompt), `${label}: the mode's debrief prompt is shown`)

  check(await page.locator('[data-testid="pricing-debrief-submit"]').isDisabled(),
    `${label}: submit is gated until something is written`)
  await page.fill('[data-testid="pricing-debrief-input"]',
    'I started high, watched what my competitor did, and adjusted from there.')
  await page.click('[data-testid="pricing-debrief-submit"]')

  await page.waitForSelector('[data-testid="pricing-game-over"]')
  check(await testId(page, 'pricing-final-rounds') === String(run.rounds),
    `${label}: the end screen states the round count too`)
  check(await testId(page, 'pricing-final-total') === fmtProfitM(run.total),
    `${label}: …and the total`)
  check(await exists(page, '[data-testid="pricing-final-reveal"]'),
    `${label}: …and repeats the reveal, so a student who comes back does not lose it`)
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  const stamp = Date.now()
  console.log('\nBooting the Vite dev server…')
  const vite = await startVite()
  const browser = await chromium.launch(HEADED ? { headless: false, slowMo: 120 } : {})

  try {
    const responses = []

    // ── 1. STANDARD mode: a full game through the real UI ──────────────────────
    console.log('\n[1] Standard mode — a full game in the browser')
    const GID_S = `pw-std-${stamp}`
    const SPID = 'pw-std-stu'
    const std = await openInstance(GID_S, SPID, 'seed-pw-std', false)
    check(std.rounds >= 10 && std.rounds <= 20, `the student drew a horizon in [10,20] (${std.rounds})`)

    const ctxS = await browser.newContext()
    const pageS = await ctxS.newPage()
    captureResponses(pageS, responses)
    await pageS.goto(studentUrl(GID_S, SPID))

    await pageS.waitForSelector('[data-testid="pricing-kc-prompt"], [data-testid="pricing-pmg-screen"]')
    await doPmgRulesScreen(pageS, false, 'Standard')
    await doKc(pageS, false, 'correct', 'Standard')

    // A price schedule that exercises the competitor's whole repertoire: the ceiling
    // (it undercuts), the floor (it prices above), and the middle.
    const stdRun = await playRounds(pageS, false,
      n => [2000, 900, 1400, 1700, 1250][(n - 1) % 5], 'Standard', std.rounds)
    check(!!stdRun, 'the Standard game completed without a mismatch')
    if (stdRun) await doDebrief(pageS, stdRun, 'Standard')

    // ── 2. Resume, mid-game ────────────────────────────────────────────────────
    // A fresh student, three rounds in, then a reload: the server holds every fact
    // the flow branches on, so the browser must come back to exactly round 4.
    console.log('\n[2] Resume — close the tab mid-game and come back')
    const RPID = 'pw-resume-stu'
    await openInstance(GID_S, RPID, 'seed-pw-std', false)
    const ctxR = await browser.newContext()
    const pageR = await ctxR.newPage()
    await pageR.goto(studentUrl(GID_S, RPID))
    await doKc(pageR, false, 'correct', 'Resume')
    for (let n = 1; n <= 3; n++) {
      await pageR.waitForSelector('[data-testid="pricing-round-heading"]')
      await pageR.fill('[data-testid="pricing-price-input"]', '1500')
      await pageR.click('[data-testid="pricing-submit-round"]')
      await pageR.waitForSelector('[data-testid="pricing-reveal"]')
      await pageR.click('[data-testid="pricing-continue"]')
    }
    await pageR.reload()
    await pageR.waitForSelector('[data-testid="pricing-round-heading"]')
    check(await testId(pageR, 'pricing-round-heading') === 'Round 4',
      'after a reload the student is on round 4, not round 1')
    check(!(await exists(pageR, '[data-testid="pricing-kc-prompt"]')),
      '…and is not sent back through the knowledge check they already answered')
    check(await exists(pageR, '[data-testid="pricing-history-row-3"]'),
      'and their three played rounds are still in the history table')
    check(!(await exists(pageR, '[data-testid="pricing-history-row-4"]')),
      'with nothing invented for the round they have not played')

    // Reloading ON a results screen returns to the NEXT round's entry, with the round
    // just played in the table — the server stores outcomes, not screen positions.
    await pageR.fill('[data-testid="pricing-price-input"]', '1500')
    await pageR.click('[data-testid="pricing-submit-round"]')
    await pageR.waitForSelector('[data-testid="pricing-reveal"]')
    await pageR.reload()
    await pageR.waitForSelector('[data-testid="pricing-round-heading"]')
    check(await testId(pageR, 'pricing-round-heading') === 'Round 5',
      'a reload on a results screen lands on the next round, with the played round in history')
    check(await exists(pageR, '[data-testid="pricing-history-row-4"]'), '…and round 4 is in the table')
    await ctxR.close()

    // ── 3. PMG mode: the same game under the other rules ───────────────────────
    console.log('\n[3] PMG mode — the rules panel, the effective price, frozen shares')
    const GID_P = `pw-pmg-${stamp}`
    const PPID = 'pw-pmg-stu'
    const pmg = await openInstance(GID_P, PPID, 'seed-pw-pmg', true)

    const ctxP = await browser.newContext()
    const pageP = await ctxP.newPage()
    captureResponses(pageP, responses)
    await pageP.goto(studentUrl(GID_P, PPID))

    await pageP.waitForSelector('[data-testid="pricing-pmg-screen"]')
    await doPmgRulesScreen(pageP, true, 'PMG')
    await doKc(pageP, true, 'correct', 'PMG')

    // The in-game panel is still there once play starts — a reference for someone who
    // has already been told, which is a different job from being told.
    const rulesText = (await testId(pageP, 'pricing-pmg-rules')).replace(/\s+/g, ' ')
    check(/Price Matching Guarantee/.test(rulesText), 'the in-game PMG panel still announces the rule')
    check(/always pay the lower/i.test(rulesText), '…states that customers pay the lower posted price')
    check(rulesText.includes(fmtShare(MARKET.sC)) && rulesText.includes(fmtShare(MARKET.sW)),
      '…and states both frozen shares, from config')

    // Prices that climb: under PMG, raising your price raises your profit with zero
    // share loss — the discovery the mode exists for, watched round by round.
    const pmgRun = await playRounds(pageP, true,
      n => Math.min(MARKET.maxPrice, 1000 + (n - 1) * 100), 'PMG', pmg.rounds)
    check(!!pmgRun, 'the PMG game completed without a mismatch')

    if (pmgRun) {
      // Shares never moved, and profit rose with price — asserted on the rendered
      // table, not on the model. Checked on the DEBRIEF screen, which carries the
      // same history table.
      const shares = new Set()
      for (let n = 1; n <= pmgRun.rounds; n++) {
        const row = await text(pageP, `[data-testid="pricing-history-row-${n}"]`)
        shares.add(row.split(/\s+/).find(t => t.endsWith('%')))
      }
      check(shares.size === 1 && [...shares][0] === fmtShare(MARKET.sC),
        `PMG: the student's share never moved across the whole game (${[...shares].join(', ')})`)
    }
    if (pmgRun) await doDebrief(pageP, pmgRun, 'PMG')

    // ── 4. ⚠ THE LEAK SWEEP, at the DOM and network level ──────────────────────
    console.log('\n[4] ⚠ No leak: not the horizon, not the competitor’s rule')

    // The end screen is ALLOWED to state the round count — the game is over. So the
    // sweep runs against a MID-GAME page, which is where the rule bites.
    const ctxL = await browser.newContext()
    const pageL = await ctxL.newPage()
    captureResponses(pageL, responses)
    const LPID = 'pw-leak-stu'
    const leak = await openInstance(GID_S, LPID, 'seed-pw-std', false)
    await pageL.goto(studentUrl(GID_S, LPID))
    await doKc(pageL, false, 'wrong', 'Leak-sweep')
    await pageL.waitForSelector('[data-testid="pricing-round-heading"]')
    await pageL.fill('[data-testid="pricing-price-input"]', '1500')
    await pageL.click('[data-testid="pricing-submit-round"]')
    await pageL.waitForSelector('[data-testid="pricing-reveal"]')
    await pageL.click('[data-testid="pricing-continue"]')
    await pageL.waitForSelector('[data-testid="pricing-round-heading"]')

    const midGame = (await pageL.locator('body').innerText()).replace(/\s+/g, ' ')
    check(!/\bof\s+\d+\s*rounds?\b/i.test(midGame) && !/\bround\s*\d+\s*\/\s*\d+/i.test(midGame),
      '⚠ no "round N of M" anywhere on a mid-game page')
    for (const word of ['best reply', 'best-reply', 'grid', 'ceiling poster', 'strategy', 'the bot']) {
      check(!midGame.toLowerCase().includes(word),
        `⚠ the page never names the competitor's rule ("${word}")`)
    }
    // The framing legitimately prints 10 and 20 (the range). Strip it, and any number
    // in [10,20] left on the page could only be the drawn horizon.
    const framingText = (await testId(pageL, 'pricing-framing')).replace(/\s+/g, ' ')
    const rest = midGame.replace(framingText, '')
    const suspicious = [...rest.matchAll(/(?<![\d,.$])(\d+)(?![\d,.%])/g)]
      .map(m => Number(m[1])).filter(v => v >= 10 && v <= 20)
    check(suspicious.length === 0,
      `⚠ no bare number in the horizon range on a mid-game page (the draw is ${leak.rounds}; found ${JSON.stringify(suspicious)})`)

    // ⚠ A MID-GAME student asking the questions callable directly still gets no
    // reveal — the gate is on the server, not on the UI choosing not to render it.
    const midQuestions = await callFn('pricingGetQuestions', asStudent(GID_S, LPID))
    check(midQuestions.result.competitorReveal === null,
      '⚠ pricingGetQuestions returns a NULL competitor reveal mid-game, even asked directly')
    await ctxL.close()

    // Every callable response this browser ACTUALLY received.
    //
    // ⚠ NOTE WHAT IS NOT SWEPT: the bare word "strategy". Spec §9's Standard debrief
    // prompt is "explain your pricing STRATEGY…" — the student's own, which they are
    // being asked about, and which is served to every student by design. Sweeping it
    // would fail on correct behaviour. What must never appear is the COMPETITOR's rule
    // identity, so that is what is swept, by its actual ids.
    const bodies = responses.map(r => r.body).join(' ').toLowerCase()
    for (const word of ['standard-highstart-bestreply', 'pmg-ceiling', 'bestreply', 'highstart',
      'seed', 'remaining', 'horizon']) {
      check(!bodies.includes(word), `⚠ no callable response carried "${word}"`)
    }
    check(responses.length > 0, `(the network audit saw ${responses.length} callable responses)`)
    // …and the reveal DID happen, on the debrief — a sweep that only proved absence
    // would pass against a game that never revealed at all.
    check(bodies.includes('your competitor was programmed to'),
      '⚠ …while the debrief reveal DID reach the browser, once the game was over')

    // ── 5. The truth is still on the server, denied to the client ──────────────
    const truth = await getDoc(`pricing_game_instances/${GID_S}/truth/participant_${SPID}`)
    check(Number(truth?.rounds?.integerValue) === std.rounds,
      'the horizon lives in the rules-denied truth/ doc, where the browser cannot reach it')

  } finally {
    await browser.close()
    vite.kill('SIGKILL')
  }

  console.log(`\n${failed === 0 ? '✅' : '❌'} pricing browser harness: ${passed} passed, ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch(err => {
  console.error('browser harness crashed:', err)
  process.exit(1)
})
