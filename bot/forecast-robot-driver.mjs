// ═══════════════════════════════════════════════════════════════════════════════
// FORECAST ROBOT MODE (spec §11) — the browser runner. Populates a Forecasting Game
// instance with N auto-driven students who each play their OWN complete game through
// the REAL UI in headed, tiled Chromium windows Elena can watch.
//
// ⚠ SINGLE-PLAYER: "STUDENTS", NOT "SEATS". There is nothing to seat — no matching, no
// attendance code, no "start game", no waiting on anybody. Each robot is an INDEPENDENT
// student playing a private game against its own server-drawn futures (spec §2.2). So
// "8 students" means eight complete games, which is why the CLI flag is --students and
// why Phase C has no barrier anywhere in it.
//
// ⚠⚠ WHAT THIS COHORT IS ACTUALLY FOR: reproducing the §2.3 comparison. The seven
// styles are the seven benchmark rules (forecast-styles.mjs), so a populated instance
// yields a Tier-3 histogram whose spread lands ON the reference lines drawn beside it,
// and a class chart with a real gap between the average forecast and the true
// systematic component. It is not "fill the roster with plausible noise" — it is
// "generate the debrief slide from the rules it names".
//
// ⚠ READ + ACT PATHS ARE BOTH THE UI — the standing false-green rule. Nothing is
// written to Firestore directly and no compute function is called: every robot goes
// through forecastBootstrap, forecastGetState, forecastGetQuestions,
// forecastSubmitKcAnswer, forecastSubmitRound and forecastSubmitDebrief because it
// types into the real controls, and it learns each month's demand by READING the
// rendered results screen. A robot that finished is indistinguishable from a student
// who finished, which is what makes Score & Record over a robot cohort a real rehearsal.
//
// ⚠ THE ROBOT NEVER SEES THE MODEL. It reads the demand series out of the rendered
// month-by-year grid — the same table a student reads — and the regression style FITS
// it. No student response carries a, b, H or σ before the debrief (spec §4, §12), and
// this driver reaches for none of them.
//
// FLOW each robot walks:
//   the nine-question knowledge check → forecast → results, × the configured months
//   → final results → debrief → the reveal → done
//
// Usage (PRODUCTION, via the launcher button or by hand):
//   node forecast-robot-driver.mjs --instance <id> [--students 7] [--pace watch|fast]
//                                  [--launcher http://localhost:5180] [--screen 1920x1080]
//   Prereq: the launcher running, and an instance that is FRESH — a robot run writes
//   real participants and real gradebook rows, so it SPENDS the instance exactly as a
//   prod smoke does. Use a new instance every run.
//
// Usage (DRY RUN, against the emulator — spends nothing, touches no production):
//   node forecast-robot-driver.mjs --instance demo-1 --emulator --app http://localhost:5173 --headless --exit-when-done
//   Prereq: the firebase emulators + a vite dev server, as the Playwright harness runs
//   them. Identity comes from the dev ?_pid/_gid params instead of a minted classroom
//   token, so nothing is written outside the emulator.
// ═══════════════════════════════════════════════════════════════════════════════

import { createRequire } from 'node:module'
import { assignStyles } from './forecast-styles.mjs'

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
// ⚠ --students, not --seats. `--seats` is accepted as an alias because the launcher
// spawns every driver with the same flag name; only the MEANING differs per family.
const COUNT = Math.max(1, Math.min(16, Number(args.students ?? args.seats) || 7))
const PACE = String(args.pace || 'watch')
const LAUNCHER = String(args.launcher || 'http://localhost:5180').replace(/\/$/, '')
const [SCREEN_W, SCREEN_H] = String(args.screen || '1920x1080').split('x').map(Number)
const COLS_OVERRIDE = args.cols ? Number(args.cols) : null
const HEADLESS = args.headless === true || args.headless === 'true'
const EMULATOR = args.emulator === true || args.emulator === 'true'
const APP = String(args.app || 'http://localhost:5173').replace(/\/$/, '')
// A LIVE run leaves the windows open so Elena can scroll back through what each robot
// did. A dry run tears down and exits, or a wrapper waiting on the child would hang.
const KEEP_OPEN = !EMULATOR && args['exit-when-done'] !== true && args['exit-when-done'] !== 'true'

if (!INSTANCE || INSTANCE === true) {
  console.error('ERROR: --instance <gameInstanceId> is required.')
  process.exit(1)
}

// A forecast game is one number typed per month across (by default) 24 months, plus a
// nine-question KC — so "watch" is tuned faster than pricing's or a single robot would
// take twenty minutes.
const THINK = PACE === 'watch' ? { min: 600, max: 1400 } : { min: 40, max: 120 }
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const thinkTime = () => THINK.min + Math.floor(Math.random() * (THINK.max - THINK.min))
const pick = (xs) => xs[Math.floor(Math.random() * xs.length)]

// ── grid tiling (same shape as the pricing / newsvendor / Crisis drivers) ──────
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
 *  robot still goes through forecastBootstrap and every student callable — only the
 *  identity SOURCE differs, so the play path being rehearsed is the real one. */
function emulatorUrl(index) {
  const pid = `robot-${index + 1}`
  return { name: pid, url: `${APP}/?game=forecast&_pid=${pid}&_gid=${INSTANCE}` }
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
 * Reads this instance's student-facing PARAMETERS off the robot's own entry screen.
 *
 * ⚠ NOT imported from the server and NOT hardcoded. An instructor who edits the
 * settings must move the robots with them. Everything here is parsed from copy this
 * driver's own game renders.
 */
async function readParams(page) {
  const progress = await grab(page, '[data-testid="fc-round-progress"]')
  const forecastMin = Number(await page.getAttribute('[data-testid="fc-forecast-input"]', 'min'))
  const forecastMax = Number(await page.getAttribute('[data-testid="fc-forecast-input"]', 'max'))
  const roundsMatch = progress.match(/of\s+(\d+)/)
  return {
    forecastMin: Number.isFinite(forecastMin) ? forecastMin : 0,
    forecastMax: Number.isFinite(forecastMax) ? forecastMax : 3000,
    rounds: roundsMatch ? Number(roundsMatch[1]) : null,
  }
}

/**
 * Reads the whole visible demand series out of the MONTH-BY-YEAR GRID.
 *
 * ⚠ THIS IS THE ROBOT'S ONLY SOURCE OF DATA, and it is the same table a student reads
 * (spec §4: "this is how a student spots seasonality by eye"). Every cell carries
 * data-testid="fc-grid-cell-<period>", so the series comes back keyed by the continuous
 * period axis — which is exactly what the regression style needs and what the lag
 * styles index into.
 *
 * The grid GROWS as months are revealed, so re-reading it each month is what keeps the
 * lag rules ("repeat last month") honest: they see the revealed month because the grid
 * shows it, not because anything was handed to them.
 */
async function readSeries(page) {
  const cells = await page.locator('[data-testid^="fc-grid-cell-"]').all()
  const series = []
  for (const cell of cells) {
    const id = await cell.getAttribute('data-testid')
    const period = Number(id.replace('fc-grid-cell-', ''))
    const text = (await cell.innerText()).trim()
    if (!text) continue                       // an unplayed month renders an empty cell
    const demand = digits(text)
    if (demand !== null) series.push({ period, demand })
  }
  return series.sort((a, b) => a.period - b.period)
}

/**
 * The knowledge check — the nine graded questions, answered at RANDOM (spec §11).
 *
 * The robots exist to populate the reports, not to test grading accuracy, and a random
 * spread of KC scores is more useful to eyeball on the Tier-1 table than a column of
 * 100%s. Wrong answers do not block — there is no gate (spec §8).
 */
async function doKnowledgeCheck(page, log) {
  let answered = 0
  while (await visible(page, '[data-testid="fc-kc-prompt"]')) {
    if (answered > 50) throw new Error('knowledge check did not terminate after 50 questions')
    await sleep(thinkTime())
    const options = await page.locator('[data-testid^="fc-kc-option-"] input').all()
    if (options.length > 0) {
      await options[Math.floor(Math.random() * options.length)].check()
    } else if (await visible(page, '[data-testid="fc-kc-text"]')) {
      // An instructor-added free-text question — recorded, never graded.
      await page.fill('[data-testid="fc-kc-text"]', 'I would look for a trend and a repeating seasonal pattern, and fit both.')
    } else {
      break
    }
    await page.click('[data-testid="fc-kc-submit"]')
    await page.waitForSelector('[data-testid="fc-kc-verdict"]', { timeout: 30000 })
    await page.click('[data-testid="fc-kc-continue"]')
    await page.waitForSelector(
      '[data-testid="fc-kc-prompt"], [data-testid="fc-round-heading"], [data-testid="fc-final-heading"], [data-testid="fc-reveal"]',
      { timeout: 30000 })
    answered++
  }
  if (answered > 0) log(`knowledge check done (${answered} answered at random)`)
}

/** The month loop: play this robot's style to the last month, re-reading the grid each
 *  time so the lag rules see what a student would see. */
async function playMonths(page, style, params, log) {
  const forecasts = []
  let guard = 0

  while (await visible(page, '[data-testid="fc-round-heading"]')) {
    if (++guard > 200) throw new Error('month loop did not terminate after 200 iterations')

    const series = await readSeries(page)
    // The period about to be forecast is one past the last month the grid shows.
    const period = (series.length > 0 ? series[series.length - 1].period : 60) + 1

    const forecast = style.decide(params, series, period)
    await sleep(thinkTime())
    await page.fill('[data-testid="fc-forecast-input"]', String(forecast))
    await page.click('[data-testid="fc-submit-forecast"]')
    await page.waitForSelector('[data-testid="fc-month-card"]', { timeout: 30000 })

    const actual = digits(await grab(page, '[data-testid="fc-result-actual"]'))
    forecasts.push({ period, forecast, actual })

    await page.click('[data-testid="fc-continue"]')
    await page.waitForSelector(
      '[data-testid="fc-round-heading"], [data-testid="fc-final-heading"]', { timeout: 30000 })
  }

  const errors = forecasts.filter(f => f.actual !== null).map(f => f.actual - f.forecast)
  const mse = errors.length ? errors.reduce((a, e) => a + e * e, 0) / errors.length : 0
  log(`played ${forecasts.length} months — MSE ≈ ${Math.round(mse).toLocaleString()}, `
    + `forecasts ${forecasts.slice(0, 5).map(f => f.forecast).join('/')}${forecasts.length > 5 ? '/…' : ''}`)
  return { forecasts, mse }
}

/** The final-results screen (spec §5) — a display screen with a Continue button, sat
 *  between the last month and the debrief. */
async function readFinal(page, log) {
  if (!(await visible(page, '[data-testid="fc-final-continue"]'))) return
  const mse = await grab(page, '[data-testid="fc-final-scorecard-mse"]')
  const bonus = await grab(page, '[data-testid="fc-final-bonus"]')
  await sleep(thinkTime())
  await page.click('[data-testid="fc-final-continue"]')
  await page.waitForSelector('[data-testid="fc-debrief-text"], [data-testid="fc-reveal"]', { timeout: 30000 })
  log(`final results: MSE ${mse}, bonus ${bonus}`)
}

/**
 * The debrief paragraph (spec §9) — STYLE-MATCHED, so the Tier-2 export reads like a
 * class rather than N copies of one sentence, and so each paragraph actually describes
 * the play that produced it. A regression-fitter that wrote "I was guessing" would make
 * the Tier-2 report useless for the thing Elena uses it for.
 */
async function doDebrief(page, style, log) {
  if (!(await visible(page, '[data-testid="fc-debrief-text"]'))) return false
  await sleep(thinkTime())
  await page.fill('[data-testid="fc-debrief-text"]', pick(style.debrief))
  await page.click('[data-testid="fc-debrief-submit"]')
  // ⚠ The reveal is what follows — it is the proof the debrief was accepted AND that
  // the gate opened (spec §9). A robot that never reached it would mean the gate is
  // refusing a student who has genuinely earned it.
  await page.waitForSelector('[data-testid="fc-reveal"]', { timeout: 30000 })
  log('debrief submitted — the process was revealed')
  return true
}

/** ONE robot's whole independent game. Never touches another robot's anything. */
async function runRobot(robot) {
  const { page, label, style } = robot
  const log = (msg) => console.log(`  [${label}] ${msg}`)
  try {
    // A fresh student lands on the KC; a resumed participant may land mid-loop, on the
    // final screen, on the debrief, or already at the reveal.
    await page.waitForSelector(
      '[data-testid="fc-kc-prompt"], [data-testid="fc-round-heading"], [data-testid="fc-final-heading"], [data-testid="fc-debrief-text"], [data-testid="fc-reveal"]',
      { timeout: 90000 })

    // Handled defensively rather than positionally, so a resumed robot that is already
    // past a step simply skips it — the driver follows the screens it finds.
    await doKnowledgeCheck(page, log)

    if (await visible(page, '[data-testid="fc-round-heading"]')) {
      const params = await readParams(page)
      log(`${params.rounds ?? '?'} months · forecast ${params.forecastMin}–${params.forecastMax} · style ${style.key}`)
      await playMonths(page, style, params, log)
    }

    await readFinal(page, log)
    await doDebrief(page, style, log)

    if (await visible(page, '[data-testid="fc-reveal"]')) {
      log('game complete — sitting on the reveal')
      return { done: true }
    }
    log('game complete')
    return { done: true }
  } catch (e) {
    console.error(`  [${label}] FAILED: ${e.message}`)
    return { done: false, error: e.message }
  }
}

// ── main ───────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\nForecast robot mode — instance ${INSTANCE}, ${COUNT} independent students, pace=${PACE}`)
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

  // ⚠ Round-robin over a SHUFFLED pool (forecast-styles.mjs), so a seven-student run
  // covers every rule in the §2.3 table exactly once — which is what makes the Tier-3
  // histogram land on its own reference lines.
  const styles = assignStyles(live.length)
  live.forEach((r, i) => { r.style = styles[i] })
  console.log(`\n  styles: ${styles.map(s => s.key).join(', ')}`)

  // Phase C — every robot plays CONCURRENTLY and INDEPENDENTLY. No barrier, no
  // cross-robot read: the single-player family's defining constraint.
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
