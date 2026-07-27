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
//     actually received;
//   • a ROBOT COHORT (spec §11) — every shipped play style driven through the real UI
//     to a finished game, in both modes, then Score & Record over the cohort with the
//     gradebook push signature-checked;
//   • the LAUNCHER SPAWN PATH — the shipped driver run as a child process with the
//     exact arguments the launcher's /launch-robots passes it, ending in a scorable
//     cohort;
//   • the INSTRUCTOR dashboard and all three report tiers against a deliberately
//     MIXED population (finished / mid-game / never started, in both modes), with
//     the Tier-1 rows and the Tier-3 per-round averages and denominators checked
//     against the same independent model the student side uses.
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
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
// ⚠ THE SHIPPED STYLES, not a copy: the robot cohort below drives the same list the
// robot driver runs in production. A second copy here would let the tested styles
// drift from the shipped ones, which is the one thing a style test exists to prevent.
import { STANDARD_STYLES, PMG_STYLES, assignStyles, nashStudentPrice } from './bot/pricing-styles.mjs'

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
/** innerText is an HTMLElement API and THROWS on an SVG node, so anything inside the
 *  chart (its <text> labels) has to be read with textContent instead. */
const svgText = async (page, id) =>
  ((await page.locator(`[data-testid="${id}"]`).first().textContent()) ?? '').trim()
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
  // ⚠ The field starts EMPTY, with no placeholder number: a prefilled price anchors,
  // and the one it used to show was the floor — below unit cost at the shipped market.
  check(await page.locator('[data-testid="pricing-price-input"]').inputValue() === '',
    `${label}: the price field starts empty — no default value`)
  check((await page.getAttribute('[data-testid="pricing-price-input"]', 'placeholder') ?? '') === '',
    `${label}: …and offers no placeholder number to anchor on`)

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


    // ── 5. Instructor dashboard + reports, on a MIXED population ───────────────
    // The population is the point: a finisher, a mid-game student, and one who never
    // started — which is what an instructor actually opens mid-week, and the state in
    // which an average is easiest to get wrong.
    console.log('\n[5] Instructor dashboard + reports (mixed population, mid-week)')

    const instrUrl = (path, gid) => `${APP}${path}?game=pricing&_gid=${gid}`

    /** Drives one student through the KC and N rounds over HTTP (fast — the browser
     *  work under test here is the INSTRUCTOR's, not another playthrough). */
    async function seedStudent(gid, pid, pmg, rounds, priceFor) {
      await callFn('pricingBootstrap', asStudent(gid, pid))
      const served = await callFn('pricingGetQuestions', asStudent(gid, pid))
      // Slice 5 split the KC into two sources (derived + the instructor's own); the
      // seeding path answers both, exactly as a student would.
      for (const q of [...served.result.kc.derived, ...served.result.kc.added]) {
        await callFn('pricingSubmitKcAnswer',
          asStudent(gid, pid, { field: q.field, answer: q.options[0].value }))
      }
      const prices = []
      for (let n = 1; n <= rounds; n++) {
        const price = priceFor(n)
        const res = await callFn('pricingSubmitPrice', asStudent(gid, pid, { round: n, price }))
        if (!res.ok) break
        prices.push(price)
      }
      return prices
    }

    /** The independent model of what the Tier-3 chart must show. */
    function expectedChart(games) {
      const maxRounds = Math.max(0, ...games.map(g => g.length))
      const points = []
      for (let round = 1; round <= maxRounds; round++) {
        const played = games.filter(g => g.length >= round)
        if (played.length === 0) continue
        const mine = played.map(g => g[round - 1])
        const theirs = played.map((g, i) => expectedCompetitorPrice(false, g.slice(0, round - 1)))
        points.push({
          round,
          student: mine.reduce((a, b) => a + b, 0) / mine.length,
          competitor: theirs.reduce((a, b) => a + b, 0) / theirs.length,
          n: played.length,
        })
      }
      return points
    }

    const GID_R = `pw-report-${stamp}`
    // A finisher (plays to their own horizon), a mid-game student (4 rounds), and one
    // who is rostered but never launches.
    const finisher = await openInstance(GID_R, 'pw-r-finisher', 'seed-pw-std', false)
    const midgame = await openInstance(GID_R, 'pw-r-midgame', 'seed-pw-std', false)
    const finPrices = await seedStudent(GID_R, 'pw-r-finisher', false, finisher.rounds, n => 1200 + (n % 3) * 200)
    const midPrices = await seedStudent(GID_R, 'pw-r-midgame', false, 4, () => 1800)
    // ⚠ NOT a bootstrap — that stamps launched_at and would make this student read as
    // "in progress (0 rounds)". A never-started student is one the ROSTER SYNC created:
    // identity fields only. This writes exactly what pricingSyncRoster writes.
    await putDoc(`pricing_game_instances/${GID_R}/participants/pw-r-never`, {
      participant_id: strVal('pw-r-never'),
      game_instance_id: strVal(GID_R),
      name: strVal('Never Started'),
    })
    check(finPrices.length === finisher.rounds && midPrices.length === 4,
      `seeded a finisher (${finPrices.length} rounds), a mid-game student (4), and a never-started one`)

    const ctxI = await browser.newContext()
    const pageI = await ctxI.newPage()
    await pageI.goto(instrUrl('/dashboard', GID_R))
    await pageI.waitForSelector('[data-testid="pricing-roster"]', { timeout: 30000 })

    // ── The header: which of the two instances am I looking at? ───────────────
    check((await testId(pageI, 'pricing-mode-name')).includes('Standard'),
      'the dashboard header names the MODE (Standard)')
    const ruleText = await testId(pageI, 'pricing-rule-text')
    check(/programmed to/.test(ruleText) && /best|grid|profit/i.test(ruleText),
      '…and states the competitor rule in plain language (instructor-only, and correct here)')

    // ── The assignment-status view ────────────────────────────────────────────
    const roster = await pageI.locator('[data-testid="pricing-roster"]').innerText()
    check(/Finished/.test(roster), 'the roster marks the finisher Finished')
    check(new RegExp(`In progress \\(4 rounds\\)`).test(roster),
      'the mid-game student shows In progress WITH how far they have got')
    check(/Not started/.test(roster), 'and the never-launched student shows Not started')
    check((await testId(pageI, 'pricing-counts')).includes('1 finished / 2 started / 3 on roster'),
      'the action bar counts finished / started / on roster')

    // ── Tier 1 numbers, against the model ─────────────────────────────────────
    const rosterRows = roster.split('\n')
    const finRow = rosterRows.find(r => /Finished/.test(r)) ?? ''
    const wantAvgPrice = fmtPrice(finPrices.reduce((a, b) => a + b, 0) / finPrices.length)
    check(finRow.includes(wantAvgPrice),
      `Tier 1: the finisher's average posted price is ${wantAvgPrice}`)
    const finProfits = finPrices.map((p, i) =>
      expectedOutcome(p, expectedCompetitorPrice(false, finPrices.slice(0, i)), false).yourProfit)
    const wantAvgProfit = fmtProfitM(finProfits.reduce((a, b) => a + b, 0) / finProfits.length)
    check(finRow.includes(wantAvgProfit),
      `Tier 1: …and their average profit per round is ${wantAvgProfit}`)
    const neverRow = rosterRows.find(r => /Not started/.test(r)) ?? ''
    check((neverRow.match(/—/g) ?? []).length === 2,
      'the never-started student shows a dash for BOTH averages, not zeros')

    // ⚠ THE DASHBOARD IS FIVE COLUMNS. Total profit, KC score and participation were
    // removed from this page on purpose — it answers "who still has not done it", and
    // the grading numbers live on Reports. The data is untouched: the Tier-1 assertions
    // further down read all three out of the same callable.
    const headerRow = rosterRows[0] ?? ''
    for (const gone of ['Total profit', 'KC score', 'Participation']) {
      check(!headerRow.includes(gone), `the dashboard no longer shows a "${gone}" column`)
    }
    for (const kept of ['Name', 'Status', 'Rounds played', 'Avg posted price', 'Avg profit / round']) {
      check(headerRow.includes(kept), `…and still shows "${kept}"`)
    }

    // …and the three removed values are still in the DATA, on the Reports page.
    const reportForCols = await callFn('pricingGetReport', { _dev: { game_instance_id: GID_R } })
    const finRep = reportForCols.result.participants.find(p => p.participant_id === 'pw-r-finisher')
    check(finRep && typeof finRep.total_profit === 'number'
      && finRep.knowledge_check_score !== undefined && 'participation_score' in finRep,
      '⚠ total profit, KC score and participation are STILL in the report data — display-only change')

    // ── The reports page: three tiles, mode-labelled ──────────────────────────
    await pageI.goto(instrUrl('/reports', GID_R))
    await pageI.waitForSelector('[data-testid="pricing-mode-header"]', { timeout: 30000 })
    const board = await pageI.locator('body').innerText()
    check(/Outcomes — all students/.test(board), 'Tier 1 tile is present')
    check(/Debrief paragraphs/.test(board), 'Tier 2 tile is present')
    check(/Average posted price by round/.test(board), 'Tier 3 tile is present')

    // ── Tier 3: the chart, its denominators, and its equilibrium lines ────────
    await pageI.click('text=Average posted price by round')
    await pageI.waitForSelector('[data-testid="pricing-price-chart"]')

    const wantPoints = expectedChart([finPrices, midPrices])
    check(wantPoints.length === Math.max(finPrices.length, midPrices.length),
      `the chart spans the LONGEST game played (${wantPoints.length} rounds)`)
    // The per-round denominator: 2 while both are playing, 1 once the mid-game student
    // has stopped. This is the composition signal the count row exists for.
    for (const p of [wantPoints[0], wantPoints[3], wantPoints[wantPoints.length - 1]]) {
      const shown = await pageI.locator(`[data-testid="pricing-chart-n-${p.round}"]`).count()
      if (shown > 0) {
        check(await svgText(pageI, `pricing-chart-n-${p.round}`) === `n=${p.n}`,
          `round ${p.round} reports its denominator (n=${p.n})`)
      }
    }
    check(wantPoints[0].n === 2 && wantPoints[wantPoints.length - 1].n === 1,
      'the denominator genuinely thins from 2 to 1 across this chart')

    check(await exists(pageI, '[data-testid="pricing-eq-line-student"]')
      && await exists(pageI, '[data-testid="pricing-eq-line-competitor"]'),
      'Standard draws BOTH dashed equilibrium lines')
    check(!(await exists(pageI, '[data-testid="pricing-eq-line-pmg"]')),
      '…and not the PMG single line')
    check(await testId(pageI, 'pricing-summary-equilibrium') === fmtPrice(1394),
      'the summary box states the DERIVED equilibrium ($1,394 at the case market)')
    const allPrices = [...finPrices, ...midPrices]
    check(await testId(pageI, 'pricing-summary-avg-price')
      === fmtPrice(allPrices.reduce((a, b) => a + b, 0) / allPrices.length),
      'and the class average posted price, over every round every student played')
    check(!(await exists(pageI, '[data-testid="pricing-summary-avg-effective"]')),
      'Standard has no average-price-paid stat — there is no single price paid')

    await ctxI.close()

    // ── The PMG instance's reports differ where the mode differs ──────────────
    const ctxIP = await browser.newContext()
    const pageIP = await ctxIP.newPage()
    await pageIP.goto(instrUrl('/reports', GID_P))
    await pageIP.waitForSelector('[data-testid="pricing-mode-header"]', { timeout: 30000 })
    check((await testId(pageIP, 'pricing-mode-name')).includes('PMG'),
      'the PMG instance labels itself PMG')
    await pageIP.click('text=Average posted price by round')
    await pageIP.waitForSelector('[data-testid="pricing-price-chart"]')
    check(await exists(pageIP, '[data-testid="pricing-eq-line-pmg"]'),
      'PMG draws ONE dashed line…')
    check(!(await exists(pageIP, '[data-testid="pricing-eq-line-student"]')),
      '…not the two Standard ones')
    const pmgSummary = await pageIP.locator('[data-testid="pricing-summary-box"]').innerText()
    check(/any equal price/.test(pmgSummary),
      '…and says "any equal price", never implying the ceiling is uniquely optimal')
    check(await exists(pageIP, '[data-testid="pricing-summary-avg-effective"]'),
      'PMG adds the average price PAID to the summary box')
    check(await testId(pageIP, 'pricing-summary-equilibrium') === fmtPrice(MARKET.maxPrice),
      'and its equilibrium stat is the ceiling')

    // Tier 2 carries the paragraph the PMG student wrote, labelled with its context.
    await pageIP.click('button:has-text("Close")')
    await pageIP.click('text=Debrief paragraphs')
    await pageIP.waitForSelector('[data-testid="pricing-report-debrief"]')
    const debriefPanel = await pageIP.locator('[data-testid="pricing-report-debrief"]').innerText()
    check(/I started high/.test(debriefPanel), 'Tier 2 shows the paragraph the student submitted')
    const ctx2 = await testId(pageIP, 'pricing-debrief-context')
    check(/PMG instance/.test(ctx2) && /programmed to/.test(ctx2) && /prompt:/.test(ctx2),
      '…labelled with the mode, the competitor rule and the prompt, so a pasted block carries its context')
    await ctxIP.close()

    // ── Mid-week with NOTHING played: the reports must still open ─────────────
    const GID_EMPTY = `pw-empty-${stamp}`
    await openInstance(GID_EMPTY, 'pw-empty-stu', 'seed-empty', false)
    const ctxE = await browser.newContext()
    const pageE = await ctxE.newPage()
    await pageE.goto(instrUrl('/reports', GID_EMPTY))
    await pageE.waitForSelector('[data-testid="pricing-mode-header"]', { timeout: 30000 })
    const emptyBoard = await pageE.locator('body').innerText()
    check(/No rounds played yet/.test(emptyBoard),
      'an instance where nobody has played says so rather than crashing')
    check(!/NaN|Infinity|undefined/.test(emptyBoard),
      '⚠ …and divides nothing by zero on the way (no NaN/Infinity on screen)')
    await ctxE.close()


    // ── 7. The robot cohort (spec §11) ─────────────────────────────────────────
    // Every shipped play style, driven through the REAL UI to a finished game — then
    // scored like a class. Robots are the tool Elena uses to fill an instance before a
    // dry run, so "a finished robot is indistinguishable from a finished student" is
    // the property that matters, and Score & Record over the cohort is what proves it.
    console.log('\n[7] Robot cohort — every play style, both modes, then Score & Record')

    // A mock classroom for the cohort's push. It CHECKS THE SIGNATURE: a harness that
    // accepted anything would pass while the game pushed unsigned.
    const COHORT_SECRET = 'test-cohort-secret'
    let cohortPushes = 0
    let cohortBadlySigned = 0
    const cohortServer = http.createServer((req, res) => {
      let raw = ''
      req.on('data', c => (raw += c))
      req.on('end', () => {
        if ((req.headers.authorization ?? '') !== `Bearer ${COHORT_SECRET}`) {
          cohortBadlySigned++
          res.writeHead(401).end('{}')
          return
        }
        cohortPushes++
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true }))
      })
    })
    await new Promise(r => cohortServer.listen(0, r))
    const COHORT_URL = `http://127.0.0.1:${cohortServer.address().port}/push`

    /** Drives ONE robot through the whole game in a real browser, exactly as the
     *  shipped driver does: read the market off the screen, price by style, learn the
     *  competitor's price from the rendered result. */
    async function runRobot(page, style, pmg, label) {
      await page.waitForSelector('[data-testid="pricing-pmg-screen"], [data-testid="pricing-kc-prompt"], [data-testid="pricing-round-heading"]', { timeout: 60000 })
      if (await exists(page, '[data-testid="pricing-pmg-screen"]')) {
        await page.click('[data-testid="pricing-pmg-continue"]')
      }
      // KC at random — the robots populate reports, they do not test grading.
      while (await exists(page, '[data-testid="pricing-kc-prompt"]')) {
        const opts = await page.locator('[data-testid^="pricing-kc-option-"]').all()
        if (opts.length === 0) break
        await opts[Math.floor(Math.random() * opts.length)].click()
        await page.click('[data-testid="pricing-kc-submit"]')
        await page.waitForSelector('[data-testid="pricing-kc-correct"], [data-testid="pricing-kc-incorrect"]', { timeout: 30000 })
        await page.click('[data-testid="pricing-kc-continue"]')
        await page.waitForSelector('[data-testid="pricing-kc-prompt"], [data-testid="pricing-round-heading"]', { timeout: 30000 })
      }

      // The market as the ROBOT reads it — off its own screen, never imported.
      const market = { ...MARKET,
        studentBaseShare: MARKET.sC, competitorBaseShare: MARKET.sW,
        studentUnitCost: MARKET.cC, competitorUnitCost: MARKET.cW,
        marketSize: MARKET.M, slope: MARKET.k }

      const theirs = [], mine = []
      let rounds = 0
      while (await exists(page, '[data-testid="pricing-round-heading"]')) {
        rounds++
        if (rounds > 30) { check(false, `${label}: runaway loop`); return null }
        const price = style.decide(market, theirs, mine)
        await page.fill('[data-testid="pricing-price-input"]', String(price))
        await page.click('[data-testid="pricing-submit-round"]')
        await page.waitForSelector('[data-testid="pricing-reveal"]', { timeout: 30000 })
        theirs.push(Number((await testId(page, 'pricing-them-price')).replace(/[^0-9]/g, '')))
        mine.push(price)
        await page.click('[data-testid="pricing-continue"]')
        await page.waitForSelector('[data-testid="pricing-round-heading"], [data-testid="pricing-debrief-heading"], [data-testid="pricing-game-over"]', { timeout: 30000 })
      }
      if (await exists(page, '[data-testid="pricing-debrief-input"]')) {
        await page.fill('[data-testid="pricing-debrief-input"]',
          style.debrief[Math.floor(Math.random() * style.debrief.length)])
        await page.click('[data-testid="pricing-debrief-submit"]')
        await page.waitForSelector('[data-testid="pricing-game-over"]', { timeout: 30000 })
      }
      return { rounds, mine, theirs }
    }

    for (const pmgCohort of [false, true]) {
      const modeName = pmgCohort ? 'PMG' : 'Standard'
      const pool = pmgCohort ? PMG_STYLES : STANDARD_STYLES
      const GID_C = `pw-cohort-${pmgCohort ? 'pmg' : 'std'}-${stamp}`

      // ROUND-ROBIN over a shuffled pool — the shipped assignment, so a cohort can
      // never be five undercutters and a flat chart.
      const styles = assignStyles(pool.length, pmgCohort)
      check(new Set(styles.map(s => s.key)).size === pool.length,
        `${modeName}: round-robin covers every shipped style exactly once (${styles.map(s => s.key).join(', ')})`)

      const results = []
      for (let i = 0; i < styles.length; i++) {
        const pid = `robot-${i + 1}`
        await openInstance(GID_C, pid, `seed-cohort-${pmgCohort}`, pmgCohort)
        const ctx = await browser.newContext()
        const page = await ctx.newPage()
        await page.goto(studentUrl(GID_C, pid))
        const r = await runRobot(page, styles[i], pmgCohort, `${modeName}/${styles[i].key}`)
        results.push({ style: styles[i], r, pid })
        await ctx.close()
      }
      check(results.every(x => x.r && x.r.rounds >= 10),
        `${modeName}: every robot played a full game to its own horizon`)

      // The styles actually did what they claim — spot-checked on real play.
      const byKey = Object.fromEntries(results.map(x => [x.style.key, x.r]))
      if (!pmgCohort) {
        check(byKey['nash-player'].mine.every(p => p === Math.round(nashStudentPrice({
          studentBaseShare: MARKET.sC, competitorBaseShare: MARKET.sW,
          studentUnitCost: MARKET.cC, competitorUnitCost: MARKET.cW, slope: MARKET.k })) ),
          'nash-player posted the derived equilibrium every round ($1,394)')
        check(byKey['cost-skimmer'].mine.every(p => p === MARKET.cC + 50),
          'cost-skimmer priced just above its own unit cost ($1,016)')
        check(byKey['undercutter'].mine.slice(1).every((p, i) => p === Math.max(MARKET.minPrice, byKey['undercutter'].theirs[i] - 100)),
          'undercutter posted $100 under the competitor’s last price, clamped')
        check(byKey['high-pricer'].mine.every(p => p >= MARKET.maxPrice - 100),
          'high-pricer stayed near the ceiling')
      } else {
        check(byKey['ceiling-poster'].mine.every(p => p === MARKET.maxPrice),
          'ceiling-poster posted the ceiling every round')
        const gr = byKey['gradual-raiser'].mine
        check(gr.every((p, i) => i === 0 || p >= gr[i - 1]),
          'gradual-raiser never lowered its price')
        check(gr[gr.length - 1] > gr[0], '…and finished higher than it started')
      }

      // ⚠ A FINISHED ROBOT IS A FINISHED STUDENT. Score & Record over the cohort must
      // grade and push them exactly as it would a real class.
      const before = cohortPushes
      const scored = await callFn('pricingScoreAndRecord', {
        _dev: { game_instance_id: GID_C, callback_url: COHORT_URL, callback_secret: COHORT_SECRET },
      })
      check(scored.ok && scored.result.finishers === styles.length,
        `${modeName}: Score & Record counts every robot as a finisher (${scored.result?.finishers}/${styles.length})`)
      check(cohortPushes - before === styles.length,
        `${modeName}: one gradebook row pushed per robot (${cohortPushes - before})`)
      check(cohortBadlySigned === 0, `${modeName}: every cohort push carried a valid signature`)

      // And the reports they populated are the ones Elena would open.
      const rep = await callFn('pricingGetReport', { _dev: { game_instance_id: GID_C } })
      check(rep.result.participants.length === styles.length
        && rep.result.participants.every(p => p.completed && p.debrief),
        `${modeName}: the roster shows every robot finished, with a debrief paragraph`)
      check(new Set(rep.result.participants.map(p => p.debrief)).size > 1,
        `${modeName}: …and the paragraphs differ — style-matched, not N copies of one sentence`)
      check(rep.result.charts.prices.length >= 10 && rep.result.charts.prices[0].n === styles.length,
        `${modeName}: the class chart has every robot in round 1 (n=${rep.result.charts.prices[0]?.n})`)
    }


    // ── 8. The launcher spawn path ─────────────────────────────────────────────
    // The cohort above drives the styles; this drives the DRIVER — spawned as a child
    // process with the same flags the launcher's /launch-robots hands it
    // (--instance/--seats/--pace/--launcher), so the thing under test is the command
    // Elena's button actually runs. Only the identity source differs: --emulator swaps
    // the classroom-minted token for the dev ?_pid/_gid params, so nothing production
    // is touched.
    console.log('\n[8] Launcher spawn path — the shipped driver, as /launch-robots runs it')

    const GID_L = `pw-launcher-${stamp}`
    const LAUNCH_N = 3
    for (let i = 1; i <= LAUNCH_N; i++) {
      await openInstance(GID_L, `robot-${i}`, 'seed-launcher', false)
    }

    const driverPath = path.join(ROOT, 'bot', 'pricing-robot-driver.mjs')
    const driverExit = await new Promise((resolveExit) => {
      const child = spawn('node', [
        driverPath,
        '--instance', GID_L,
        // --seats is what the launcher passes every driver (the flag name is uniform
        // across the families); the pricing driver accepts it as an alias for
        // --students, which is what it MEANS here.
        '--seats', String(LAUNCH_N),
        '--pace', 'fast',
        '--emulator',
        '--app', APP,
        '--headless',
      ], { cwd: path.dirname(driverPath), stdio: ['ignore', 'pipe', 'pipe'] })
      let out = ''
      child.stdout.on('data', d => { out += d })
      child.stderr.on('data', d => { out += d })
      child.on('exit', code => resolveExit({ code, out }))
      child.on('error', e => resolveExit({ code: -1, out: e.message }))
    })

    check(driverExit.code === 0,
      `the driver the launcher spawns runs to completion (exit ${driverExit.code})`)
    if (driverExit.code !== 0) console.error(driverExit.out.slice(-1500))
    check(/instance mode: Standard/.test(driverExit.out),
      'it read the instance MODE off its own screen (Standard) rather than being told')
    check(/3\/3 robots completed their game/.test(driverExit.out),
      `all ${LAUNCH_N} robots finished their own game`)

    // Scorable exactly like a real class — the property that makes robots useful.
    const beforeL = cohortPushes
    const scoredL = await callFn('pricingScoreAndRecord', {
      _dev: { game_instance_id: GID_L, callback_url: COHORT_URL, callback_secret: COHORT_SECRET },
    })
    check(scoredL.ok && scoredL.result.finishers === LAUNCH_N,
      `Score & Record counts all ${LAUNCH_N} launcher-spawned robots as finishers (${scoredL.result?.finishers})`)
    check(cohortPushes - beforeL === LAUNCH_N,
      `and pushes one gradebook row each (${cohortPushes - beforeL})`)

    const repL = await callFn('pricingGetReport', { _dev: { game_instance_id: GID_L } })
    check(repL.result.participants.every(p => p.completed && p.debrief),
      'every launcher-spawned robot finished WITH a debrief paragraph')
    check(repL.result.charts.prices.length >= 10,
      'and they populated the class chart')

    cohortServer.close()

    // ── 6. The truth is still on the server, denied to the client ──────────────
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
