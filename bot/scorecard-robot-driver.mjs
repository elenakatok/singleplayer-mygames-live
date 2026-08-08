// ═══════════════════════════════════════════════════════════════════════════════
// SCORECARD ROBOT MODE — the browser runner. Populates a Metalcraft Supplier Scorecard
// instance with N auto-driven students who each play their OWN complete session through
// the REAL UI in headed, tiled Chromium windows Elena can watch.
//
// ⚠ SINGLE-PLAYER: "STUDENTS", NOT "SEATS". Nothing to seat — no matching, no attendance
// code, no "start game", no waiting on anybody. Each robot is an INDEPENDENT student, so
// "7 students" means seven complete sessions and Phase C has no barrier in it.
//
// ⚠⚠ WHAT THIS COHORT IS ACTUALLY FOR: making the treatment visible. The seven styles
// differ in their RESPONSE TO RELIABILITY, not merely in effort level
// (scorecard-styles.mjs) — from two blind controls at a contested gap of 0.000, through a
// weak responder, to one persona ABOVE the DP. A cohort of look-alikes would draw two
// plausible IDENTICAL Tier-3 lines, which is exactly what a CONDITION-PLUMBING BUG draws.
// So this is not "fill the roster with noise"; it is "populate the charts with a spread
// that would expose the one bug nothing else catches".
//
// ⚠⚠ THE ROBOT LEARNS THE CONDITION THE WAY A STUDENT DOES — by reading the reliability
// label off its own screen (`sc-reliability-label`). It is never told the schedule, never
// told there are two conditions, and never handed `startsWith`. A driver that was given
// the treatment would make the cohort's charts say something false about what a student
// could have known.
//
// ⚠ READ + ACT PATHS ARE BOTH THE UI — the standing false-green rule. Nothing is written
// to Firestore directly and no compute function is called: every robot goes through
// scorecardBootstrap, scorecardGetState, scorecardGetQuestions, scorecardSubmitKcAnswer,
// scorecardSubmitPeriod and scorecardSubmitDebrief because it clicks the real controls.
// A robot that finished is indistinguishable from a student who finished, which is what
// makes Score & Record over a robot cohort a real rehearsal.
//
// ⚠ THE SESSION IS LONG — 20 contracts × 10 periods = 200 clicks per robot (spec §2.5).
// `watch` pace is therefore tuned much faster than the negotiation drivers', and `fast`
// is what you want for anything but a demo.
//
// FLOW each robot walks (spec §9 split KC around §10's three ordered steps):
//   pre-play KC (6) → loop(contracts){ loop(periods){ effort } → result }
//   → session summary → noticing → THE REVEAL → post-play KC (4) → linking → done
//
// Usage (PRODUCTION, via the launcher button or by hand):
//   node scorecard-robot-driver.mjs --instance <id> [--students 7] [--pace watch|fast]
//                                   [--launcher http://localhost:5180] [--screen 1920x1080]
//   Prereq: the launcher running, and an instance that is FRESH — a robot run writes real
//   participants and real gradebook rows, so it SPENDS the instance exactly as a prod
//   smoke does. Use a new instance every run.
//
// Usage (DRY RUN, against the emulator — spends nothing, touches no production):
//   node scorecard-robot-driver.mjs --instance demo-1 --emulator \
//        --app http://localhost:5199 --headless --exit-when-done
// ═══════════════════════════════════════════════════════════════════════════════

import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { STYLES, STYLE_NAMES, styleFor } from './scorecard-styles.mjs'

// Playwright resolves from games/singleplayer/node_modules (installed for the harnesses);
// this bot dir has none of its own, so createRequire walks up to find it.
const require = createRequire(import.meta.url)
const { chromium } = require('playwright')

// ═══════════════════════════════════════════════════════════════════════════════
// ⚠⚠ THE OPTIMIZER ROBOT IS CONSUMER 3 OF THE ONE SOLVER (spec §16). It imports the
// SHIPPED DP rather than reimplementing "work until you hit the target" — that shortcut
// is wrong at (period 7, score 6), and a second policy implementation is the single
// likeliest way to break this build.
//
// ⚠ IT IS STILL NOT TOLD THE TREATMENT. The driver solves the DP for the reliability IT
// READ OFF ITS OWN SCREEN, using parameters it also read off the screen. It never sees
// the schedule, the other condition, or `startsWith` — solving is arithmetic on public
// information, which is exactly what a diligent student could have done.
//
// ⚠ AN ABSENT `functions/lib` FAILS LOUDLY. `scorecard-styles.mjs` refuses to guess when
// no policy is supplied (it throws rather than falling back), so the only two outcomes
// are "the real DP" or "a clear error naming the fix" — never a quiet heuristic.
// ═══════════════════════════════════════════════════════════════════════════════
const __dir = path.dirname(fileURLToPath(import.meta.url))
const DP_PATH = path.resolve(__dir, '../functions/lib/scorecard/dp.js')
let solve = null
let highEffortOptimal = null
if (existsSync(DP_PATH)) {
  const dp = require(DP_PATH)
  solve = dp.solve
  highEffortOptimal = dp.highEffortOptimal
}

/** The DP policy for one reliability, from the SHIPPED solver. Null if lib is unbuilt. */
function policyFor(rules, reliability) {
  if (!solve) return null
  const sol = solve(rules, reliability)
  return (periodsRemaining, score) => highEffortOptimal(sol, periodsRemaining, score)
}

// ── CLI ────────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const a = {}
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]
    if (k.startsWith('--')) a[k.slice(2)] = argv[i + 1]?.startsWith('--') || argv[i + 1] === undefined ? true : argv[++i]
  }
  return a
}
const args = parseArgs(process.argv.slice(2))
const INSTANCE = args.instance
// ⚠ --students, not --seats. `--seats` is accepted as an alias because the launcher spawns
// every driver with the same flag name; only the MEANING differs per family.
// ⚠ THE DEFAULT IS SEVEN, and it is deliberate: there are exactly seven styles and they
// are assigned round-robin, so seven students covers every response profile exactly once.
// Fewer, and the Tier-3 gap distribution loses either the mass at zero or the tail.
const COUNT = Math.max(1, Math.min(16, Number(args.students ?? args.seats) || STYLE_NAMES.length))
const PACE = String(args.pace || 'watch')
const LAUNCHER = String(args.launcher || 'http://localhost:5180').replace(/\/$/, '')
const [SCREEN_W, SCREEN_H] = String(args.screen || '1920x1080').split('x').map(Number)
const COLS_OVERRIDE = args.cols ? Number(args.cols) : null
const HEADLESS = args.headless === true || args.headless === 'true'
const EMULATOR = args.emulator === true || args.emulator === 'true'
const APP = String(args.app || 'http://localhost:5199').replace(/\/$/, '')
const KEEP_OPEN = !EMULATOR && args['exit-when-done'] !== true && args['exit-when-done'] !== 'true'

if (!INSTANCE || INSTANCE === true) {
  console.error('ERROR: --instance <gameInstanceId> is required.')
  process.exit(1)
}

// ⚠ 200 periods per robot. At forecast's 600–1400ms "watch" think time a single session
// would take eight minutes; at these values a watchable run is ~2 minutes and a `fast`
// run is well under one.
const THINK = PACE === 'watch' ? { min: 120, max: 320 } : { min: 8, max: 25 }
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const thinkTime = () => THINK.min + Math.floor(Math.random() * (THINK.max - THINK.min))

// ── grid tiling (same shape as the forecast / pricing / newsvendor drivers) ────
function gridCell(index, count) {
  const n = Math.max(1, count | 0)
  const cols = COLS_OVERRIDE ?? Math.ceil(Math.sqrt(n))
  const rows = Math.ceil(n / cols)
  const cellW = Math.floor(SCREEN_W / cols), cellH = Math.floor(SCREEN_H / rows)
  const GUTTER = 6
  return { x: (index % cols) * cellW, y: Math.floor(index / cols) * cellH, w: cellW - GUTTER, h: cellH - GUTTER }
}

// ── launcher reuse — token minting (nothing reimplemented here) ────────────────

/** DRY RUN identity: the dev-only ?_pid/_gid params the Playwright harness uses. Each
 *  robot still goes through every student callable — only the identity SOURCE differs. */
function emulatorUrl(index) {
  const pid = `robot-${index + 1}`
  return { name: pid, url: `${APP}/?game=scorecard&_pid=${pid}&_gid=${INSTANCE}` }
}

async function mintUrl(index) {
  if (EMULATOR) return emulatorUrl(index)
  const res = await fetch(`${LAUNCHER}/api/student-url`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    // NO mode:'ready' — single-player has no lifecycle to drive; the launcher skips its
    // drive-to-ready path for this family and the plain ?token= URL is all we need.
    body: JSON.stringify({ game_instance_id: INSTANCE, index }),
  })
  const text = await res.text()
  let json
  try { json = JSON.parse(text) } catch { throw new Error(`launcher → ${res.status}: ${text.slice(0, 160)}`) }
  if (json.error) throw new Error(json.error)
  return json // { name, url }
}
const launcherReachable = async () => { try { return (await fetch(`${LAUNCHER}/api/games`)).ok } catch { return false } }

// ── reading the screen, exactly as a student does ─────────────────────────────

const visible = async (page, sel) => (await page.locator(sel).count()) > 0

/**
 * ⚠⚠ WAIT FOR THE NEXT SCREEN TO BE ACTIONABLE — not merely for a fixed delay.
 *
 * THE BUG THIS EXISTS TO FIX (found running this driver, 08-08): the effort buttons carry
 * a LOCAL LATCH (spec §4 guard 2) that disables both on click until the next period
 * remounts. The driver polled on the button being PRESENT — and after a click it is
 * present but DISABLED, so Playwright waited the full 30s for actionability and the robot
 * died mid-session. It was a RACE, so only some robots hit it.
 *
 * ⚠ A human never triggers this: they cannot click again inside the paint. An automated
 * clicker can, which is exactly what guard 2 is for — so the right fix is for the DRIVER
 * to wait properly, NOT for the UI to drop the latch.
 */
async function waitForNextScreen(page, timeout = 30_000) {
  await page.waitForFunction(() => {
    // ⚠⚠ EVERY BUTTON CONDITION CHECKS `disabled`, and missing that on the CONTINUE button
    // is a second, worse version of the same bug: after clicking Continue the button is
    // still PRESENT (it renders "Loading…" while `advance` is in flight), so a presence
    // check returned true instantly, the loop clicked it again, and every robot stalled on
    // a disabled control. Presence is not readiness for ANY of these.
    const enabled = (sel) => {
      const el = document.querySelector(sel)
      return Boolean(el) && !el.disabled
    }
    if (enabled('[data-testid="sc-effort-high"]')) return true
    if (enabled('[data-testid="sc-contract-continue"]')) return true
    // These are not buttons, so presence IS readiness.
    return Boolean(
      document.querySelector('[data-testid="sc-session-summary"]')
      || document.querySelector('[data-testid="sc-freetext"]')
      || document.querySelector('[data-testid="sc-kc-prompt"]'),
    )
  }, { timeout })
}

/** Is an effort button present AND enabled — i.e. is this period actually playable? */
const effortReady = async (page) =>
  await page.locator('[data-testid="sc-effort-high"]:not([disabled])').count() > 0
const grab = async (page, sel) => {
  try { return (await page.locator(sel).first().innerText()).trim() } catch { return '' }
}
const intOf = (s) => { const m = String(s).replace(/,/g, '').match(/-?\d+/); return m ? Number(m[0]) : null }

/**
 * The robot's whole view of its situation — read off the rendered screen.
 *
 * ⚠⚠ `reliability` COMES FROM THE LABEL THE STUDENT SEES. There is no other source, and
 * that is the point: a persona's response to reliability has to be a response to what was
 * ON SCREEN, or the cohort proves nothing about what a student could have done.
 *
 * ⚠ If the label is hidden (`showReliabilityLabel: false` — spec §2.3's noticing variant)
 * the percentage still appears in the Your Information block, which is what a student in
 * that variant reads. `null` only if neither is present, and the caller then plays low
 * rather than guessing.
 */
async function readState(page, params) {
  const progress = await grab(page, '[data-testid="sc-progress"]')
  const m = progress.match(/(\d+)\s+of\s+(\d+).*?(\d+)\s+of\s+(\d+)/s)
  const label = await grab(page, '[data-testid="sc-reliability-label"]')
  let reliability = null
  const pctFromLabel = label.match(/(\d+)\s*%/)
  if (pctFromLabel) reliability = Number(pctFromLabel[1]) / 100
  else {
    // Label hidden — read the probability out of the parameter block instead.
    const info = await grab(page, 'table')
    const pm = info.match(/(\d+)\s*%/)
    if (pm) reliability = Number(pm[1]) / 100
  }
  return {
    contract: m ? Number(m[1]) : null,
    contracts: m ? Number(m[2]) : null,
    period: m ? Number(m[3]) : null,
    periodsRemaining: intOf(await grab(page, '[data-testid="sc-periods-remaining"]')),
    score: intOf(await grab(page, '[data-testid="sc-score"]')),
    reliability,
    ...params,
  }
}

/**
 * The instance's student-facing PARAMETERS, off the robot's own first screen.
 *
 * ⚠ NOT imported from the server and NOT hardcoded. An instructor who edits the settings
 * must move the robots with them.
 */
async function readParams(page) {
  const body = await grab(page, 'table')
  const progress = await grab(page, '[data-testid="sc-progress"]')
  const pm = progress.match(/of\s+(\d+)\D+\d+\s+of\s+(\d+)/s)
  // "High effort costs 4 ECU" / "target for the bonus 7" / "Bonus if you reach it 120"
  const cost = body.match(/High effort costs\s*([\d.]+)/i)
  const target = body.match(/target for the bonus\s*(\d+)/i)
  const bonus = body.match(/Bonus if you reach it\s*([\d.]+)/i)
  const low = body.match(/Low effort → an [^\n]*?\s(\d+)\s*%/i)
  return {
    highEffortCost: cost ? Number(cost[1]) : 4,
    targetScore: target ? Number(target[1]) : 7,
    bonus: bonus ? Number(bonus[1]) : 120,
    pAcceptableLow: low ? Number(low[1]) / 100 : 0.3,
    // ⚠ Read off the progress line — "Contract 1 of 3 · Period 1 of 4" — because the DP
    // needs the horizon and nothing may hand it to the robot.
    periodsPerContract: pm ? Number(pm[2]) : 10,
    lowEffortCost: 0,
    endowmentPerContract: 50,
  }
}

// ── the phases of ONE robot's session, all through the UI ─────────────────────

/**
 * A knowledge-check block — answered at RANDOM.
 *
 * The robots exist to populate the reports, not to test grading accuracy, and a random
 * spread of KC scores is more useful on the Tier-1 table than a column of 100%s. Wrong
 * answers do not block: the KC is graded but is not a gate (spec §9).
 *
 * ⚠ Used for BOTH stages (spec §9's split). The pre block runs before any contract; the
 * post block only after the reveal — the driver does not decide that ordering, the app
 * does, and this function simply answers whatever KC screen it is shown.
 */
async function doKnowledgeCheck(page, log, cap = 40) {
  let answered = 0
  while (await visible(page, '[data-testid="sc-kc-prompt"]')) {
    if (answered > cap) throw new Error(`knowledge check did not terminate after ${cap} questions`)
    await sleep(thinkTime())
    const options = await page.locator('[data-testid^="sc-kc-option-"] input').all()
    if (options.length === 0) break
    await options[Math.floor(Math.random() * options.length)].check()
    await page.locator('[data-testid="sc-kc-submit"]').click()
    // The verdict + explanation screen, then Continue.
    await page.locator('[data-testid="sc-kc-continue"]').waitFor({ timeout: 20_000 })
    await sleep(thinkTime())
    await page.locator('[data-testid="sc-kc-continue"]').click()
    answered++
  }
  if (answered > 0) log(`answered ${answered} knowledge-check questions`)
  return answered
}

/** One free-text step. Both §10 steps use the same control. */
async function doFreeText(page, text, log, what) {
  if (!(await visible(page, '[data-testid="sc-freetext"]'))) return false
  await sleep(thinkTime())
  await page.locator('[data-testid="sc-freetext"]').fill(text)
  await page.locator('[data-testid="sc-freetext-submit"]').click()
  log(`submitted the ${what} answer`)
  return true
}

/** Play every period of every contract, deciding from the screen alone. */
async function playContracts(page, styleName, log) {
  const style = STYLES[styleName]
  const params = await readParams(page)
  const rules = {
    periodsPerContract: params.periodsPerContract,
    targetScore: params.targetScore,
    bonus: params.bonus,
    highEffortCost: params.highEffortCost,
    lowEffortCost: params.lowEffortCost,
    pAcceptableLow: params.pAcceptableLow,
    endowmentPerContract: params.endowmentPerContract,
  }
  if (styleName === 'optimizer' && !solve) {
    throw new Error(
      'the optimizer robot needs the compiled solver at functions/lib/scorecard/dp.js — '
      + 'run `npm --prefix functions run build` in games/singleplayer first. '
      + '(It will NOT fall back to a heuristic: spec §16 allows exactly one policy.)')
  }
  // ⚠ Cached per reliability, not per period — solving 200 times would be pointless work,
  // and there are only ever two distinct values in a session.
  const policyCache = new Map()
  const policyAt = (rel) => {
    if (!policyCache.has(rel)) policyCache.set(rel, policyFor(rules, rel))
    return policyCache.get(rel)
  }
  let periods = 0
  let contractsCompleted = 0
  // Generous cap: 40 contracts × 30 periods is the config's hard maximum.
  const CAP = 40 * 30 + 100

  while (periods < CAP) {
    // ⚠ ENABLED, not merely present — see waitForNextScreen.
    if (await effortReady(page)) {
      const st = await readState(page, params)
      // ⚠ If the screen could not be read, play LOW rather than guessing — a robot that
      // invented a state would put fiction into the charts.
      const action = st.reliability === null || st.score === null || st.periodsRemaining === null
        ? 'low'
        // ⚠ `policy` is bound to the reliability READ OFF THIS SCREEN.
        : style({ ...st, rand: Math.random, policy: policyAt(st.reliability) })
      await sleep(thinkTime())
      await page.locator(`[data-testid="sc-effort-${action}"]`).click()
      periods++
      // ⚠ Wait for the next screen to be ACTIONABLE. Clicking before the next period
      // paints is exactly the mis-click guard 2 exists to stop — the driver must not
      // manufacture it, and must not stall on the latch either.
      await waitForNextScreen(page)
      continue
    }
    // ⚠ ENABLED, not merely present — same reason as the effort button.
    if (await page.locator('[data-testid="sc-contract-continue"]:not([disabled])').count() > 0) {
      contractsCompleted++
      if (contractsCompleted % 5 === 0) log(`finished contract ${contractsCompleted}`)
      await sleep(thinkTime())
      await page.locator('[data-testid="sc-contract-continue"]').click()
      await waitForNextScreen(page)
      continue
    }
    // Session summary, or anything past it — the contract loop is done.
    break
  }
  // ⚠ +1: the LAST contract goes to the session summary rather than to a Continue button,
  // so counting clicks under-reports it by exactly one. Reporting "2 contracts" for a
  // 3-contract session was cosmetic but misleading in the run log.
  const contracts = periods > 0 ? contractsCompleted + 1 : 0
  log(`played ${periods} periods across ${contracts} contracts`)
  return { periods, contracts }
}

/**
 * One robot's entire session, in ITS OWN BROWSER.
 *
 * ⚠⚠ ONE BROWSER PER ROBOT, NOT ONE BROWSER WITH N CONTEXTS. Window POSITION is a
 * browser-launch argument in Chromium (`--window-position`), not a context property — so
 * sharing one browser and setting each context's `viewport` sized the pages correctly but
 * left every window stacked at the default position, full-screen, one on top of another.
 * That is what forecast, pricing and newsvendor all do, and this driver was the odd one
 * out.
 *
 * ⚠ `viewport: null` is required with it: a viewport override would re-clamp the page to
 * a fixed size and defeat `--window-size`.
 */
async function runRobot(index, log) {
  const styleName = styleFor(index)
  const { name, url } = await mintUrl(index)
  const cell = gridCell(index, COUNT)
  const browser = await chromium.launch({
    headless: HEADLESS,
    args: [`--window-position=${cell.x},${cell.y}`, `--window-size=${cell.w},${cell.h}`],
  })
  const ctx = await browser.newContext({ viewport: null })
  const page = await ctx.newPage()

  log(`[${name}] style=${styleName}`)
  await page.goto(url, { waitUntil: 'domcontentloaded' })

  // ── §9.1 — the PRE-PLAY knowledge check ────────────────────────────────
  await page.waitForSelector(
    '[data-testid="sc-kc-prompt"], [data-testid="sc-effort-high"]', { timeout: 60_000 })
  await doKnowledgeCheck(page, m => log(`[${name}] ${m}`))

  // ── The contract loop ──────────────────────────────────────────────────
  await page.waitForSelector('[data-testid="sc-effort-high"]', { timeout: 60_000 })
  const played = await playContracts(page, styleName, m => log(`[${name}] ${m}`))

  // ── Session summary → §10 step 1 ───────────────────────────────────────
  if (await visible(page, '[data-testid="sc-summary-continue"]')) {
    await sleep(thinkTime())
    await page.locator('[data-testid="sc-summary-continue"]').click()
  }
  await page.waitForSelector('[data-testid="sc-freetext"]', { timeout: 60_000 })
  await doFreeText(
    page,
    `[${styleName}] I worked harder on some of them. It felt like effort was worth more on `
    + `certain contracts than others, so I eased off on the ones where it did not seem to land.`,
    m => log(`[${name}] ${m}`), 'noticing',
  )

  // ── §10 step 2 — the reveal ────────────────────────────────────────────
  await page.waitForSelector('[data-testid="sc-reveal"]', { timeout: 60_000 })
  log(`[${name}] reached the reveal`)
  if (await visible(page, '[data-testid="sc-reveal-continue"]')) {
    await sleep(thinkTime())
    await page.locator('[data-testid="sc-reveal-continue"]').click()
  }

  // ── §9.2 — the POST-PLAY knowledge check ───────────────────────────────
  await doKnowledgeCheck(page, m => log(`[${name}] ${m}`))

  // ── §10 step 3 — the linking answer ────────────────────────────────────
  await page.waitForSelector('[data-testid="sc-freetext"]', { timeout: 60_000 })
  await doFreeText(
    page,
    `[${styleName}] Looking at the two curves, the difference is smaller than I expected. `
    + `At Metalcraft the score stops depending on the supplier when rejects get negotiated or `
    + `miscoded — I would tie the rating to things the plant actually controls, and I would `
    + `expect suppliers to stop chasing a number they cannot move.`,
    m => log(`[${name}] ${m}`), 'linking',
  )

  await page.waitForSelector('[data-testid="sc-done"], [data-testid="sc-reveal"]', { timeout: 60_000 })
  log(`[${name}] DONE — ${played.periods} periods, ${played.contracts} contracts`)

  // ⚠ The WINDOW is what Elena scrolls back through, so a live run closes neither the
  // context nor the browser. A dry run tears both down, or a wrapper waiting on the child
  // hangs (T9's cousin: an un-closed browser keeps the process alive).
  if (!KEEP_OPEN) { await ctx.close(); await browser.close() }
  return { name, styleName, browser, ...played }
}

// ── main ───────────────────────────────────────────────────────────────────────

const main = async () => {
  console.log('═'.repeat(70))
  console.log(`Scorecard robots — ${COUNT} students, instance ${INSTANCE}`)
  console.log(`pace=${PACE} ${EMULATOR ? '(EMULATOR DRY RUN)' : '(PRODUCTION — spends this instance)'}`)
  console.log('═'.repeat(70))

  if (!EMULATOR && !(await launcherReachable())) {
    console.error(`ERROR: the launcher is not reachable at ${LAUNCHER}. Start it first.`)
    process.exit(1)
  }

  const log = (m) => console.log(`  ${m}`)
  const results = []
  const opened = []
  // ⚠ NO BARRIER ANYWHERE. Each robot is an independent student; one that finishes early
  // must not wait, and one that fails must not take the cohort with it.
  const settled = await Promise.allSettled(
    Array.from({ length: COUNT }, (_, i) => runRobot(i, log)),
  )
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') { results.push(r.value); opened.push(r.value.browser) }
    else console.error(`  ✗ robot ${i + 1} failed: ${r.reason?.message ?? r.reason}`)
  })
  // ⚠ A robot that THREW may still have left a browser running; without this the process
  // never exits on a partial failure.
  if (!KEEP_OPEN) {
    for (const b of opened) { try { await b.close() } catch { /* already gone */ } }
  }

  console.log('\n' + '─'.repeat(70))
  console.log(`  ${results.length}/${COUNT} robots finished`)
  for (const r of results) console.log(`    ${r.name.padEnd(14)} ${r.styleName.padEnd(14)} ${r.periods} periods`)
  console.log('─'.repeat(70))
  if (KEEP_OPEN) {
    console.log('  Windows left open so you can scroll back. Ctrl-C when done.')
  } else {
    process.exit(results.length === COUNT ? 0 : 1)
  }
}

main().catch(err => { console.error(err); process.exit(1) })
