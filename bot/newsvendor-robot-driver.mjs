// ═══════════════════════════════════════════════════════════════════════════════
// NEWSVENDOR ROBOT MODE — the browser runner. Populates a live Newsvendor instance
// with N auto-driven students who each play their OWN complete game through the REAL
// UI in headed, tiled Chromium windows Elena can watch.
//
// ⚠ HOW THIS DIFFERS FROM THE SAA / CRISIS ROBOTS — NEWSVENDOR IS SINGLE-PLAYER.
// There are no SEATS to fill, no matching, no attendance code, no "start game", and no
// waiting on anybody. Each robot is an INDEPENDENT student playing a private game
// against its own server-drawn demand. So "8 students" means eight complete games, not
// one game with eight players — which is why the CLI flag is --students, and why Phase
// C has no barrier anywhere in it.
//
// PURPOSE: give an instance a realistic, class-sized spread of students so the roster,
// the four report tiles (the order-vs-demand chart and the optimality gap especially)
// and Score & Record's gradebook push can be validated at scale without hand-playing N
// twenty-period games.
//
// ⚠ READ + ACT PATHS ARE BOTH THE UI — the standing false-green rule. Nothing is
// written to Firestore directly and no compute function is called: every robot goes
// through newsvendorBootstrap, newsvendorGetState, newsvendorGetQuestions,
// newsvendorSubmitFreeText, newsvendorSubmitRound and newsvendorSubmitKcAnswer because
// it types into the real controls, and it learns each period's demand by READING the
// rendered results screen. A robot that finished is indistinguishable from a student
// who finished, which is what makes Score & Record over a robot cohort a real
// rehearsal rather than a simulation of one.
//
// ⚠ THE ROBOT NEVER SEES THE BENCHMARK, because no student response carries it (spec
// §9.2). The `optimizer` style computes a critical ratio from the parameters printed
// on its own screen — the same calculation the knowledge check sets. It is reading the
// case, not the answer key.
//
// FLOW each robot walks (spec §7, §8):
//   prep paragraph → place order → results, × the configured periods →
//   final results → the ten-question knowledge check → debrief → done
//
// Usage (PRODUCTION, via the launcher button or by hand):
//   node newsvendor-robot-driver.mjs --instance <id> [--students 8] [--pace watch|fast]
//                                    [--launcher http://localhost:5180] [--screen 1920x1080]
//   Prereq: the launcher running, and an instance that is FRESH — a robot run writes
//   real participants and real gradebook rows, so it SPENDS the instance exactly as a
//   prod smoke does. Use a new instance every run.
//
// Usage (DRY RUN, against the emulator — spends nothing, touches no production):
//   node newsvendor-robot-driver.mjs --instance demo-1 --emulator --app http://localhost:5173 --headless
//   Prereq: the firebase emulators + a vite dev server, as the Playwright harness runs
//   them. In this mode identity comes from the dev ?_pid/_gid params instead of a
//   minted classroom token, so nothing is written outside the emulator.
// ═══════════════════════════════════════════════════════════════════════════════

import { createRequire } from 'node:module'
import { assignStyles } from './newsvendor-styles.mjs'

// Playwright resolves from games/singleplayer/node_modules (installed for the
// harnesses); this bot dir has none of its own, so createRequire walks up to find it.
const require = createRequire(import.meta.url)
const { chromium } = require('playwright')

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
// ⚠ --students, not --seats: there is nothing to seat. Each number is one whole
// independent game. `--seats` is accepted as an alias because the launcher spawns
// every driver with the same flag name (server.mjs keeps the contract uniform and
// documents that only the MEANING differs per family).
const COUNT = Math.max(1, Math.min(16, Number(args.students ?? args.seats) || 8))
const PACE = String(args.pace || 'watch')
const LAUNCHER = String(args.launcher || 'http://localhost:5180').replace(/\/$/, '')
const [SCREEN_W, SCREEN_H] = String(args.screen || '1920x1080').split('x').map(Number)
const COLS_OVERRIDE = args.cols ? Number(args.cols) : null
const HEADLESS = args.headless === true || args.headless === 'true'
const EMULATOR = args.emulator === true || args.emulator === 'true'
const APP = String(args.app || 'http://localhost:5173').replace(/\/$/, '')
// A LIVE run leaves the windows open so Elena can scroll back through what each robot
// did. A dry run is automation with nobody watching, so it tears down and exits —
// otherwise a wrapper script waiting on the child would hang forever.
const KEEP_OPEN = !EMULATOR && args['exit-when-done'] !== true && args['exit-when-done'] !== 'true'

if (!INSTANCE || INSTANCE === true) {
  console.error('ERROR: --instance <gameInstanceId> is required.')
  process.exit(1)
}

// A newsvendor game is one number typed per period across (by default) twenty periods,
// plus a ten-question KC — appreciably more clicks than pricing's, so "watch" is tuned
// a little faster or a single robot would take twenty minutes.
const THINK = PACE === 'watch' ? { min: 700, max: 1700 } : { min: 50, max: 150 }
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const thinkTime = () => THINK.min + Math.floor(Math.random() * (THINK.max - THINK.min))
const pick = (xs) => xs[Math.floor(Math.random() * xs.length)]

// ── grid tiling (same shape as the pricing / Crisis drivers) ───────────────────
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
 *  robot still goes through newsvendorBootstrap and every student callable — only the
 *  identity source differs, so the play path being rehearsed is the real one. */
function emulatorUrl(index) {
  const pid = `robot-${index + 1}`
  return { name: pid, url: `${APP}/?game=newsvendor&_pid=${pid}&_gid=${INSTANCE}` }
}

async function mintUrl(index) {
  if (EMULATOR) return emulatorUrl(index)
  const res = await fetch(`${LAUNCHER}/api/student-url`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    // NO mode:'ready' — single-player has no lifecycle to drive; the launcher skips
    // its drive-to-ready path for this family and the plain ?token= URL is all we need.
    body: JSON.stringify({ game_instance_id: INSTANCE, index }),
  })
  const text = await res.text()
  let json; try { json = JSON.parse(text) } catch { throw new Error(`launcher → ${res.status}: ${text.slice(0, 160)}`) }
  if (json.error) throw new Error(json.error)
  return json // { name, url }
}
const launcherReachable = async () => { try { return (await fetch(`${LAUNCHER}/api/games`)).ok } catch { return false } }

// ── the phases of ONE robot's game, all through the UI ─────────────────────────

const visible = async (page, sel) => (await page.locator(sel).count()) > 0
const grab = async (page, sel) => {
  try { return (await page.locator(sel).first().innerText()).trim() } catch { return '' }
}
const digits = (s) => { const m = s.replace(/,/g, '').match(/-?\d+(\.\d+)?/); return m ? Number(m[0]) : null }

/**
 * Reads this instance's PARAMETERS off the robot's own place-order screen.
 *
 * ⚠ NOT imported from the server and NOT hardcoded. The styles order relative to this
 * instance's demand distribution and its cost structure, so an instructor who edits the
 * settings must move the robots with them — a cohort ordering against the shipped
 * defaults would produce a chart that says nothing about the market actually
 * configured. Everything here is parsed from copy this driver's own game renders
 * (spec §7a prints all of it).
 *
 * A suppressed line means the value is ZERO, not missing (spec §7a hides a zero-valued
 * cost rather than printing "$0"), so the fallbacks below are 0 rather than a guess.
 */
async function readParams(page) {
  const heading = await grab(page, '[data-testid="nv-period-heading"]')
  const demandBox = await grab(page, '[data-testid="nv-demand-box"]')
  const boundsLine = await grab(page, '[data-testid="nv-parameters"]')
  void boundsLine

  const P = digits(await grab(page, '[data-testid="nv-param-P"]'))
  const c = digits(await grab(page, '[data-testid="nv-param-c"]'))
  // Absent ⇒ suppressed ⇒ zero (see the note above).
  const v = (await visible(page, '[data-testid="nv-param-v"]')) ? digits(await grab(page, '[data-testid="nv-param-v"]')) : 0
  const h = (await visible(page, '[data-testid="nv-param-h"]')) ? digits(await grab(page, '[data-testid="nv-param-h"]')) : 0
  const g = (await visible(page, '[data-testid="nv-param-g"]')) ? digits(await grab(page, '[data-testid="nv-param-g"]')) : 0

  const isNormal = /Normal/i.test(demandBox)
  const nums = [...demandBox.replace(/,/g, '').matchAll(/(\d+(?:\.\d+)?)/g)].map(m => Number(m[1]))

  // The bounds are stated under the input, and are also the min/max attributes the
  // server enforces. Read the attributes: they are exact where the sentence is prose.
  const orderMin = Number(await page.getAttribute('[data-testid="nv-order-input"]', 'min'))
  const orderMax = Number(await page.getAttribute('[data-testid="nv-order-input"]', 'max'))

  // "Period k of N" — the total is public in this game (spec §7a), unlike pricing's.
  const periodsMatch = heading.match(/of\s+(\d+)/)

  return {
    P: P ?? 0, c: c ?? 0, v: v ?? 0, g: g ?? 0, h: h ?? 0,
    isNormal,
    mean: isNormal ? (nums[0] ?? 0) : 0,
    sd: isNormal ? (nums[1] ?? 1) : 1,
    minD: isNormal ? 0 : (nums[0] ?? 0),
    maxD: isNormal ? 0 : (nums[1] ?? 0),
    orderMin: Number.isFinite(orderMin) ? orderMin : 0,
    orderMax: Number.isFinite(orderMax) ? orderMax : 1_000_000,
    periods: periodsMatch ? Number(periodsMatch[1]) : null,
  }
}

/** The prep paragraph (spec §8), asked before the first period. Style-matched, so the
 *  Tier-2 prep report reads like a class rather than N copies of one sentence — and so
 *  it actually corresponds to the play that follows it. */
async function doPrep(page, style, log) {
  if (!(await visible(page, '[data-testid="nv-freetext-input"]'))) return
  await sleep(thinkTime())
  await page.fill('[data-testid="nv-freetext-input"]', pick(style.prep))
  await page.click('[data-testid="nv-freetext-submit"]')
  await page.waitForSelector('[data-testid="nv-period-heading"], [data-testid="nv-final-heading"]', { timeout: 30000 })
  log('prep paragraph submitted')
}

/** The period loop: play this robot's style to the last period, reading each period's
 *  realized demand off the rendered results screen. */
async function playPeriods(page, style, params, log) {
  const history = []
  let guard = 0

  while (await visible(page, '[data-testid="nv-period-heading"]')) {
    // A hard stop well above any legal period count, so a UI regression that never
    // leaves the loop fails the robot instead of spinning forever.
    if (++guard > 200) throw new Error('period loop did not terminate after 200 iterations')

    const order = style.decide(params, history)
    await sleep(thinkTime())
    await page.fill('[data-testid="nv-order-input"]', String(order))
    await page.click('[data-testid="nv-submit-order"]')
    await page.waitForSelector('[data-testid="nv-results"]', { timeout: 30000 })

    const demand = digits(await grab(page, '[data-testid="nv-result-demand"]'))
    const unitsOver = digits(await grab(page, '[data-testid="nv-result-over"]'))
    const unitsShort = digits(await grab(page, '[data-testid="nv-result-short"]'))
    const profit = digits(await grab(page, '[data-testid="nv-result-profit"]'))
    history.push({ order, demand, unitsOver, unitsShort, profit })

    await page.click('[data-testid="nv-continue"]')
    await page.waitForSelector('[data-testid="nv-period-heading"], [data-testid="nv-final-heading"]', { timeout: 30000 })
  }

  const avgOrder = history.reduce((a, r) => a + r.order, 0) / Math.max(1, history.length)
  log(`played ${history.length} periods — avg order ${avgOrder.toFixed(0)}, `
    + `orders ${history.slice(0, 6).map(r => r.order).join('/')}${history.length > 6 ? '/…' : ''}`)
  return history
}

/** The final-results screen (spec §7d) — a display screen with a Continue button, sat
 *  between the last period and the knowledge check. */
async function readFinal(page, log) {
  if (!(await visible(page, '[data-testid="nv-final-continue"]'))) return
  const total = await grab(page, '[data-testid="nv-final-total"]')
  const avgOrder = await grab(page, '[data-testid="nv-final-avg-order"]')
  await sleep(thinkTime())
  await page.click('[data-testid="nv-final-continue"]')
  await page.waitForSelector('[data-testid="nv-kc-prompt"], [data-testid="nv-freetext-input"], [data-testid="nv-all-done"]', { timeout: 30000 })
  log(`final results: total ${total}, average order ${avgOrder}`)
}

/**
 * The knowledge check — the ten graded questions, answered at RANDOM.
 *
 * The robots exist to populate the reports, not to test grading accuracy, and a random
 * spread of KC scores is more useful to eyeball on the Tier-1 table than a column of
 * 100%s. Wrong answers do not block (there is no gate).
 */
async function doKnowledgeCheck(page, log) {
  let answered = 0
  while (await visible(page, '[data-testid="nv-kc-prompt"]')) {
    if (answered > 50) throw new Error('knowledge check did not terminate after 50 questions')
    await sleep(thinkTime())
    const options = await page.locator('[data-testid^="nv-kc-option-"]').all()
    if (options.length > 0) {
      await options[Math.floor(Math.random() * options.length)].click()
    } else if (await visible(page, '[data-testid="nv-kc-text-input"]')) {
      // An instructor-added free-text question — recorded, never graded.
      await page.fill('[data-testid="nv-kc-text-input"]', 'I would work it out from the cost of being short against the cost of a leftover unit.')
    } else {
      break
    }
    await page.click('[data-testid="nv-kc-submit"]')
    await page.waitForSelector('[data-testid="nv-kc-correct"], [data-testid="nv-kc-incorrect"], [data-testid="nv-kc-recorded"]', { timeout: 30000 })
    await page.click('[data-testid="nv-kc-continue"]')
    await page.waitForSelector('[data-testid="nv-kc-prompt"], [data-testid="nv-freetext-input"], [data-testid="nv-all-done"]', { timeout: 30000 })
    answered++
  }
  log(`knowledge check done (${answered} answered at random)`)
}

/** The debrief paragraph (spec §8) — style-matched, like the prep, so the two Tier-2
 *  tiles can be read side by side and actually describe the same student. */
async function doDebrief(page, style, log) {
  if (!(await visible(page, '[data-testid="nv-freetext-input"]'))) return false
  await sleep(thinkTime())
  await page.fill('[data-testid="nv-freetext-input"]', pick(style.debrief))
  await page.click('[data-testid="nv-freetext-submit"]')
  await page.waitForSelector('[data-testid="nv-all-done"]', { timeout: 30000 })
  log('debrief submitted — game complete')
  return true
}

/** ONE robot's whole independent game. Never touches another robot's anything. */
async function runRobot(robot) {
  const { page, label, style } = robot
  const log = (msg) => console.log(`  [${label}] ${msg}`)
  try {
    // A fresh student lands on the prep; a resumed participant may land mid-loop, on
    // the final screen, in the KC, on the debrief, or already finished.
    await page.waitForSelector(
      '[data-testid="nv-freetext-input"], [data-testid="nv-period-heading"], [data-testid="nv-final-heading"], [data-testid="nv-kc-prompt"], [data-testid="nv-all-done"]',
      { timeout: 90000 })
    if (await visible(page, '[data-testid="nv-all-done"]')) { log('already finished — nothing to do'); return { done: true } }

    // ⚠ The prep and the debrief render the SAME component, so "is a free-text box on
    // screen" is not enough to tell them apart. The prep is identified by its own
    // field-scoped test id; anything else free-text at this point is the debrief, which
    // the tail of this function handles.
    if (await visible(page, '[data-testid="nv-freetext-prompt-prep_strategy"]')) {
      await doPrep(page, style, log)
    }

    if (await visible(page, '[data-testid="nv-period-heading"]')) {
      const params = await readParams(page)
      log(`market: P ${params.P} / c ${params.c} / v ${params.v} / h ${params.h} / g ${params.g} · `
        + (params.isNormal ? `Normal(${params.mean}, ${params.sd})` : `Uniform[${params.minD}, ${params.maxD}]`)
        + ` · ${params.periods ?? '?'} periods · order ${params.orderMin}–${params.orderMax} · style ${style.key}`)
      await playPeriods(page, style, params, log)
    }

    await readFinal(page, log)
    await doKnowledgeCheck(page, log)
    await doDebrief(page, style, log)
    return { done: true }
  } catch (e) {
    console.error(`  [${label}] FAILED: ${e.message}`)
    return { done: false, error: e.message }
  }
}

// ── main ───────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\nNewsvendor robot mode — instance ${INSTANCE}, ${COUNT} independent students, pace=${PACE}`)
  console.log('(single-player: no seats, no matching — each robot plays its own full game)')
  console.log(EMULATOR
    ? `DRY RUN against ${APP} — emulator identity, nothing production is touched.\n`
    : 'LIVE RUN — this writes real participants and real gradebook rows.\n')
  if (!EMULATOR && !(await launcherReachable())) {
    console.error(`Launcher not reachable at ${LAUNCHER}. Start it first.`)
    process.exit(1)
  }

  console.log('Phase A — minting student tokens…')
  const robots = []
  for (let i = 0; i < COUNT; i++) {
    try {
      const { name, url } = await mintUrl(i)
      robots.push({ index: i, name, url, label: `${i + 1}/${name}` })
      console.log(`  ✓ ${name}`)
    } catch (e) {
      console.error(`  ✗ student ${i + 1} token failed: ${e.message}`)
    }
  }
  if (!robots.length) { console.error('\nNo students could be minted.'); process.exit(1) }

  console.log('\nPhase B — opening windows…')
  for (const robot of robots) {
    try {
      const cell = gridCell(robot.index, robots.length)
      const browser = await chromium.launch({
        headless: HEADLESS,
        args: [`--window-position=${cell.x},${cell.y}`, `--window-size=${cell.w},${cell.h}`],
      })
      const page = await (await browser.newContext({ viewport: null })).newPage()
      await page.goto(robot.url, { waitUntil: 'domcontentloaded' })
      robot.browser = browser; robot.page = page
      console.log(`  ✓ window open — ${robot.name}`)
    } catch (e) {
      console.error(`  ✗ window for ${robot.name} failed: ${e.message}`)
    }
  }
  const live = robots.filter(r => r.page)
  if (!live.length) { console.error('\nNo windows opened.'); process.exit(1) }

  // ⚠ Styles are assigned round-robin over a SHUFFLED pool (newsvendor-styles.mjs), so
  // N robots never all order identically — a cohort that did would draw one flat line
  // and an optimality gap that says nothing.
  const styles = assignStyles(live.length)
  live.forEach((r, i) => { r.style = styles[i] })
  console.log(`\n  styles: ${styles.map(s => s.key).join(', ')}`)

  // Phase C — every robot plays CONCURRENTLY and INDEPENDENTLY. No barrier, no
  // cross-robot read: this is the single-player family's defining constraint, and it is
  // why there is no "wait for everyone" step anywhere in this driver.
  console.log(`\nPhase C — ${live.length} students playing their own games…\n`)
  const results = await Promise.all(live.map(runRobot))

  const done = results.filter(r => r.done).length
  console.log(`\n${done}/${live.length} robots completed their game.`)
  console.log('Style spread: ' + live.map(r => r.style.key).join(', '))

  if (KEEP_OPEN) {
    console.log('\nWindows stay open so you can inspect them. Ctrl-C to close.')
    console.log('Next: open the instructor dashboard → Score & Record, then Reports.')
    return
  }
  for (const r of live) { try { await r.browser.close() } catch { /* already gone */ } }
  console.log('\nWindows closed (dry run).')
  if (done !== live.length) process.exitCode = 1
}

main().catch(err => { console.error('robot driver crashed:', err); process.exit(1) })
