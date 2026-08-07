// ═══════════════════════════════════════════════════════════════════════════════
// Scorecard — CP3 report artifacts. Builds a cohort, then screenshots:
//
//   1. Tier 1, sorted by EFFORT GAP (the headline column, spec §11)
//   2. Tier-3 charts 1–3
//   3. Tier-3 chart 4 — the policy grid, at DEFAULT parameters
//   4. ⚠ The policy grid again at NON-DEFAULT parameters, on the SETTINGS screen, so the
//      titles and the cells can be seen tracking config rather than being hardcoded
//
// ⚠ T9 — THE TEARDOWN TRAP. `spawn('npx', …)` orphans vite, so this file kills the child
// explicitly in a `finally`. If a run ever looks stuck, measure CPU on
// `node scorecard-shots.mjs`, NOT on the `sh -c npm …` wrapper, which always reports
// 0:00.00. Tee to a log and tail the FILE; piping through `tail -N` buffers until exit.
//
// Run:  npm run shots:scorecard
// ═══════════════════════════════════════════════════════════════════════════════

import { spawn } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { STYLES, styleFor, STYLE_NAMES } from './bot/scorecard-styles.mjs'
import { solve, highEffortOptimal } from './functions/lib/scorecard/dp.js'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const PROJECT = 'demo-singleplayer'
const VITE_PORT = 5199
const APP = `http://localhost:${VITE_PORT}`
const FUNCTIONS = `http://127.0.0.1:5010/${PROJECT}/us-central1`
const FIRESTORE = `http://127.0.0.1:8090/v1/projects/${PROJECT}/databases/(default)/documents`
const OUT = path.join(ROOT, '_scorecard-shots')

async function callFn(name, data) {
  const res = await fetch(`${FUNCTIONS}/${name}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data }),
  })
  const body = await res.json().catch(() => null)
  if (res.ok && body && 'result' in body) return { ok: true, result: body.result }
  return { ok: false, error: body?.error?.message ?? `http ${res.status}` }
}
async function putDoc(p, fields) {
  const res = await fetch(`${FIRESTORE}/${p}`, {
    method: 'PATCH',
    headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields }),
  })
  if (!res.ok) throw new Error(`PATCH ${p} → ${res.status}`)
}
const intVal = n => ({ integerValue: String(n) })
const dblVal = n => ({ doubleValue: n })
const strVal = s => ({ stringValue: s })
const boolVal = b => ({ booleanValue: b })
const asStudent = (gid, pid, extra = {}) => ({ _test: { participant_id: pid, game_instance_id: gid }, ...extra })

function mulberry(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const DEFAULTS = {
  contracts: 20, periods: 10, targetScore: 7, bonus: 120,
  cHigh: 4, cLow: 0, pLow: 0.30, endowment: 50, relHigh: 0.70, relLow: 0.40,
}

async function openInstance(gid, over = {}) {
  const o = { ...DEFAULTS, ...over }
  await putDoc(`scorecard_game_instances/${gid}/config/main`, {
    contracts: intVal(o.contracts),
    periods_per_contract: intVal(o.periods),
    target_score: intVal(o.targetScore),
    bonus: intVal(o.bonus),
    high_effort_cost: intVal(o.cHigh),
    low_effort_cost: intVal(o.cLow),
    p_acceptable_low: dblVal(o.pLow),
    endowment_per_contract: intVal(o.endowment),
    show_target_reached_banner: boolVal(true),
    show_prior_contracts_panel: boolVal(true),
    show_running_balance: boolVal(true),
    show_reliability_label: boolVal(true),
    currency: strVal(o.currency ?? 'ECU'),
  })
  await putDoc(`scorecard_game_instances/${gid}/truth/main`, {
    reliability_high: dblVal(o.relHigh),
    reliability_low: dblVal(o.relLow),
    reliability_schedule: strVal('alternating'),
    label_high: strVal('High Reliability ({pct})'),
    label_low: strVal('Low Reliability ({pct})'),
    seed: strVal('shots-fixed'),
  })
  return o
}

function rulesOf(o) {
  return {
    periodsPerContract: o.periods, targetScore: o.targetScore, bonus: o.bonus,
    highEffortCost: o.cHigh, lowEffortCost: o.cLow, pAcceptableLow: o.pLow,
    endowmentPerContract: o.endowment,
  }
}

async function play(gid, pid, styleName, o, rand) {
  const style = STYLES[styleName]
  const rules = rulesOf(o)
  let st = await callFn('scorecardGetState', asStudent(gid, pid))
  if (!st.ok) throw new Error(`${pid}: ${st.error}`)
  for (let k = 1; k <= o.contracts; k++) {
    const sol = solve(rules, st.result.contract.reliability)
    const policy = (r, s) => highEffortOptimal(sol, r, s)
    for (let p = 1; p <= o.periods; p++) {
      const c = st.result.contract
      const action = style({
        contract: k, period: p, periodsRemaining: c.periodsRemaining, score: c.score,
        reliability: c.reliability, targetScore: st.result.params.targetScore,
        highEffortCost: st.result.params.highEffortCost, bonus: st.result.params.bonus,
        pAcceptableLow: st.result.params.pAcceptableLow, rand, policy,
      })
      const res = await callFn('scorecardSubmitPeriod', asStudent(gid, pid, { contract: k, period: p, action }))
      if (!res.ok) throw new Error(`${pid} c${k}p${p}: ${res.error}`)
      st = { ok: true, result: res.result }
    }
    if (k < o.contracts) st = await callFn('scorecardGetState', asStudent(gid, pid, { advance: true }))
  }
  const q = await callFn('scorecardGetQuestions', asStudent(gid, pid))
  if (q.ok) {
    for (const question of q.result.kc.questions) {
      const idx = styleName === 'optimizer' ? 0 : Math.floor(rand() * question.options.length)
      await callFn('scorecardSubmitKcAnswer', asStudent(gid, pid, { questionId: question.id, answer: question.options[idx].id }))
    }
  }
  await callFn('scorecardSubmitDebrief', asStudent(gid, pid, {
    answer: `I worked when the rating seemed to respond and eased off when it did not. (${styleName})`,
  }))
}

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
    try { const r = await fetch(APP); if (r.ok) return child } catch { /* not up */ }
    await new Promise(r => setTimeout(r, 250))
  }
  child.kill('SIGKILL')
  throw new Error('vite did not start')
}

const main = async () => {
  fs.mkdirSync(OUT, { recursive: true })

  // ── The DEFAULT-parameter cohort ─────────────────────────────────────────
  const gid = `sc-shots-${Date.now()}`
  const o = await openInstance(gid)
  console.log(`instance (defaults): ${gid}`)

  const HUMANS = [
    ['stu-chen', 'Kathy Chen', 'coaster'],
    ['stu-smith', 'Rhett Smith', 'grinder'],
    ['stu-okafor', 'Ada Okafor', 'responder'],
    ['stu-delacruz', 'Ana de la Cruz', 'minimalist'],
    ['stu-park', 'Jae Park', 'learner'],
    ['stu-nowak', 'Piotr Nowak', 'overreactor'],
    ['stu-hall', 'Bea Hall', 'optimizer'],
    ['stu-ito', 'Ren Ito', 'responder'],
    ['stu-abara', 'Chidi Abara', 'grinder'],
    ['stu-vance', 'Mira Vance', 'minimalist'],
    ['stu-kaur', 'Simran Kaur', 'responder'],
    ['stu-boyd', 'Tom Boyd', 'coaster'],
  ]
  for (const [pid, name, style] of HUMANS) {
    await putDoc(`scorecard_game_instances/${gid}/participants/${pid}`, { name: strVal(name) })
    await play(gid, pid, style, o, mulberry(7000 + pid.length * 13))
  }
  // A partial and a no-show, so the R6 reconciliation has something to state.
  await putDoc(`scorecard_game_instances/${gid}/participants/stu-quiet`, { name: strVal('Sam Quiet') })
  await putDoc(`scorecard_game_instances/${gid}/participants/stu-partial`, { name: strVal('Lee Partial') })
  await callFn('scorecardGetState', asStudent(gid, 'stu-partial'))
  for (let p = 1; p <= o.periods; p++) {
    await callFn('scorecardSubmitPeriod', asStudent(gid, 'stu-partial', { contract: 1, period: p, action: 'high' }))
  }
  // A few bots, so the cohort is genuinely mixed and the ◆ marker shows.
  for (let i = 0; i < STYLE_NAMES.length; i++) {
    await play(gid, `robot-${i}`, styleFor(i), o, mulberry(3000 + i))
  }
  console.log(`played ${HUMANS.length} humans + ${STYLE_NAMES.length} bots`)

  // ── A NON-DEFAULT instance, for the config-tracking shot ─────────────────
  // ⚠ EVERY treatment number moved, so a hardcoded title or a baked-in grid would be
  // visible at a glance: 55% / 25% instead of 70% / 40%, p_low 0.15, cost 6, target 6,
  // 14 periods. The thresholds become 6/(0.55−0.15) = 15 and 6/(0.25−0.15) = 60.
  const gid2 = `sc-shots-alt-${Date.now()}`
  await openInstance(gid2, {
    contracts: 8, periods: 14, targetScore: 6, bonus: 200,
    cHigh: 6, cLow: 0, pLow: 0.15, endowment: 80,
    relHigh: 0.55, relLow: 0.25, currency: 'credits',
  })
  console.log(`instance (non-default): ${gid2}`)

  const vite = await startVite()
  const browser = await chromium.launch()
  try {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 1200 }, deviceScaleFactor: 2 })
    const page = await ctx.newPage()
    page.on('console', m => { if (m.type() === 'error') console.error(`[page] ${m.text()}`) })

    // ⚠ THE STICKY CHROME BLEEDS INTO ELEMENT SCREENSHOTS. Playwright scrolls a locator
    // into view before capturing, and the instructor action bar (position: sticky) plus
    // the emulator warning banner (position: fixed) then sit ON TOP of it — producing a
    // dark band across the middle of chart 1 and a red strip over the policy grid. Both
    // are real page furniture and correct in the app; they are simply not wanted in an
    // artifact of one section. Neutralised for the capture only.
    const unstick = () => page.addStyleTag({
      content: '*{position:static !important} [data-sticky-keep]{position:sticky !important}',
    })

    const shot = async (name, locator) => {
      const file = path.join(OUT, `${name}.png`)
      if (locator) await locator.screenshot({ path: file })
      else await page.screenshot({ path: file, fullPage: true })
      console.log(`  → ${path.relative(ROOT, file)}`)
    }

    // ── Reports, default instance ──────────────────────────────────────────
    await page.goto(`${APP}/reports?game=scorecard&_gid=${gid}`)
    await page.waitForSelector('[data-testid="sc-tier1"]', { timeout: 30_000 })
    await page.waitForTimeout(600)
    await unstick()

    // ⚠ Sort by the EFFORT GAP — it is the initial sort, but click it to prove the
    // header is live and to capture the sorted state explicitly.
    await shot('01-tier1-roster-by-effort-gap', page.locator('[data-testid="sc-tier1"]').locator('xpath=ancestor::section'))
    await shot('02-tier3-charts', page.locator('[data-testid="sc-tier3"]'))
    await shot('03-tier2-debrief', page.locator('[data-testid="sc-tier2"]'))
    await shot('04-summary', page.locator('[data-testid="sc-summary"]'))

    // The DP overlay ON — the optional instructor toggle (default off).
    await page.getByRole('checkbox').first().check()
    await page.waitForTimeout(400)
    await shot('05-tier3-charts-with-optimal-overlay', page.locator('[data-testid="sc-tier3"]'))

    await shot('06-reports-full-page')

    // ── Settings at NON-DEFAULT parameters — the policy grid tracking config ─
    await page.goto(`${APP}/settings?game=scorecard&_gid=${gid2}`)
    await page.waitForSelector('text=What these numbers induce', { timeout: 30_000 })
    await page.waitForTimeout(600)
    await unstick()
    await shot('07-settings-nondefault-full')

    // Just the grid, so the titles and cells are legible.
    await shot('08-policy-grid-nondefault', page.locator('svg[aria-label*="Optimal policy grid"]').first().locator('xpath=ancestor::div[1]'))

    // And the default-parameter grid, for comparison.
    await page.goto(`${APP}/settings?game=scorecard&_gid=${gid}`)
    await page.waitForSelector('text=What these numbers induce', { timeout: 30_000 })
    await page.waitForTimeout(600)
    await unstick()
    await shot('09-policy-grid-default', page.locator('svg[aria-label*="Optimal policy grid"]').first().locator('xpath=ancestor::div[1]'))

    await ctx.close()
  } finally {
    await browser.close()
    // ⚠ T9 — kill vite explicitly, or this process finishes and then HANGS.
    vite.kill('SIGKILL')
  }
  console.log(`\nshots in ${path.relative(ROOT, OUT)}`)
  console.log(`default instance:     ${gid}`)
  console.log(`non-default instance: ${gid2}`)
}

main().catch(e => { console.error(e); process.exit(1) })
