// ═══════════════════════════════════════════════════════════════════════════════
// PRICING ROBOT MODE — the browser runner. Populates a live Cheyenne Shipping
// instance with N auto-driven students who each play their OWN complete game through
// the REAL UI in headed, tiled Chromium windows Elena can watch.
//
// ⚠ HOW THIS DIFFERS FROM THE SAA / CRISIS ROBOTS — PRICING IS SINGLE-PLAYER.
// There are no SEATS to fill, no matching, no attendance code, no "start game", and
// no waiting on anybody. Each robot is an INDEPENDENT student playing a private game
// against the server-side competitor. So "8 students" means eight complete games, not
// one game with eight players — which is why the CLI flag below is --students, and
// why Phase C has no barrier anywhere in it.
//
// PURPOSE: give an instance a realistic, class-sized spread of students so the
// roster, the three report tiers (the price-by-round chart especially) and Score &
// Record's gradebook push can be validated at scale without hand-playing N games.
//
// READ + ACT PATHS ARE BOTH THE UI. Nothing is written to Firestore directly: every
// robot goes through pricingBootstrap, pricingGetQuestions, pricingSubmitKcAnswer,
// pricingSubmitPrice and pricingSubmitDebrief because it clicks the real controls,
// and it learns the competitor's price by READING the rendered result screen. A robot
// that finished is indistinguishable from a student who finished, which is what makes
// Score & Record over a robot cohort a real rehearsal.
//
// ⚠ THE ROBOT'S STYLE IS NOT THE COMPETITOR'S RULE. --styles below describes how the
// SIMULATED STUDENT prices. The competitor each robot faces is chosen server-side by
// the instance's MODE, and is never visible here.
//
// Usage (PRODUCTION, via the launcher button or by hand):
//   node pricing-robot-driver.mjs --instance <id> [--students 8] [--pace watch|fast]
//                                 [--launcher http://localhost:5180] [--screen 1920x1080]
//   Prereq: the launcher running, and an instance that is FRESH — a robot run writes
//   real participants and real gradebook rows, so it SPENDS the instance exactly as a
//   prod smoke does. Use a new instance every run.
//
// Usage (DRY RUN, against the emulator — spends nothing, touches no production):
//   node pricing-robot-driver.mjs --instance demo-1 --emulator --app http://localhost:5198 --headless
//   Prereq: the firebase emulators + a vite dev server, as the Playwright harness runs
//   them. In this mode identity comes from the dev ?_pid/_gid params instead of a
//   minted classroom token, so nothing is written outside the emulator.
// ═══════════════════════════════════════════════════════════════════════════════

import { createRequire } from 'node:module'
import { assignStyles } from './pricing-styles.mjs'

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
// independent game. `--seats` is accepted as an alias so a launcher button written
// for the multiplayer families does not silently run 8 when it meant 4.
const COUNT = Math.max(1, Math.min(16, Number(args.students ?? args.seats) || 8))
const PACE = String(args.pace || 'watch')
const LAUNCHER = String(args.launcher || 'http://localhost:5180').replace(/\/$/, '')
const [SCREEN_W, SCREEN_H] = String(args.screen || '1920x1080').split('x').map(Number)
const COLS_OVERRIDE = args.cols ? Number(args.cols) : null
const HEADLESS = args.headless === true || args.headless === 'true'
// DRY RUN: drive a local emulator + dev server using the DEV test-identity params
// instead of a classroom-minted token. Nothing outside the emulator is touched, so a
// rehearsal never spends a real instance or writes a real grade.
const EMULATOR = args.emulator === true || args.emulator === 'true'
const APP = String(args.app || 'http://localhost:5198').replace(/\/$/, '')
// A LIVE run leaves the windows open so Elena can scroll back through what each robot
// did (the Crisis driver behaves the same way, and it is why the process does not
// exit on its own). A dry run is automation with nobody watching, so it tears down and
// exits — otherwise a wrapper script waiting on the child would hang forever.
const KEEP_OPEN = !EMULATOR && args['exit-when-done'] !== true && args['exit-when-done'] !== 'true'

if (!INSTANCE || INSTANCE === true) {
  console.error('ERROR: --instance <gameInstanceId> is required.')
  process.exit(1)
}

// A pricing game is 10–20 rounds of a type-and-click each, so "watch" is tuned well
// below Crisis's 5–15s — otherwise a single robot would take half an hour.
const THINK = PACE === 'watch' ? { min: 900, max: 2200 } : { min: 60, max: 180 }
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const thinkTime = () => THINK.min + Math.floor(Math.random() * (THINK.max - THINK.min))
const pick = (xs) => xs[Math.floor(Math.random() * xs.length)]

// ── grid tiling (same shape as the Crisis driver) ──────────────────────────────
function gridCell(index, count) {
  const n = Math.max(1, count | 0)
  const cols = COLS_OVERRIDE ?? Math.ceil(Math.sqrt(n))
  const rows = Math.ceil(n / cols)
  const cellW = Math.floor(SCREEN_W / cols), cellH = Math.floor(SCREEN_H / rows)
  const GUTTER = 6
  return { x: (index % cols) * cellW, y: Math.floor(index / cols) * cellH, w: cellW - GUTTER, h: cellH - GUTTER }
}

// ── PLAY STYLES ───────────────────────────────────────────────────────────────
// Imported, not defined here: pricing-playwright.mjs runs a cohort through the same
// list as a test, and two copies would let the tested styles drift from the shipped
// ones. See pricing-styles.mjs.

// ── launcher reuse — token minting (nothing reimplemented here) ────────────────

/** DRY RUN identity: the dev-only ?_pid/_gid params the Playwright harness uses. Each
 *  robot still goes through pdBootstrap and every student callable — only the identity
 *  source differs, so the play path being rehearsed is the real one. */
function emulatorUrl(index) {
  const pid = `robot-${index + 1}`
  return { name: pid, url: `${APP}/?game=pricing&_pid=${pid}&_gid=${INSTANCE}` }
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

// ── the three phases of ONE robot's game, all through the UI ───────────────────

const visible = async (page, sel) => (await page.locator(sel).count()) > 0

/**
 * Reads the MARKET off the robot's own price-entry screen.
 *
 * ⚠ NOT imported from the server and NOT hardcoded. The styles price relative to
 * this instance's unit cost, bounds and equilibrium, so an instructor who edits the
 * market must move the robots with it — a cohort priced against the shipped defaults
 * would produce a chart that says nothing about the market they actually configured.
 * Everything here is parsed from copy this driver's own game renders.
 */
async function readMarket(page) {
  const grab = async (sel) => {
    try { return (await page.locator(sel).first().innerText()).trim() } catch { return '' }
  }
  const money = (s) => { const m = s.match(/\$([\d,]+)/); return m ? Number(m[1].replace(/,/g, '')) : null }
  const allMoney = (s) => [...s.matchAll(/\$([\d,]+)/g)].map(m => Number(m[1].replace(/,/g, '')))
  const pct = (s) => { const m = s.match(/([\d.]+)%/); return m ? Number(m[1]) / 100 : null }

  const sizeLine = await grab('[data-testid="pricing-market-size"]')
  const you = await grab('[data-testid="pricing-market-you"]')
  const them = await grab('[data-testid="pricing-market-competitor"]')
  const formulas = await grab('[data-testid="pricing-formulas-standard"], [data-testid="pricing-formulas-pmg"]')

  const bounds = allMoney(sizeLine)
  const containers = sizeLine.match(/([\d,]+) containers/)
  // The slope appears as "÷ $1,000" in the Standard formula block; under PMG the
  // share does not respond to price at all, so the value is irrelevant there and the
  // fallback is only ever used to keep the equilibrium arithmetic finite.
  const slope = money((formulas.match(/÷\s*\$[\d,]+/) ?? [''])[0]) ?? 1000

  const m = {
    marketSize: containers ? Number(containers[1].replace(/,/g, '')) : 190000,
    studentBaseShare: pct(you) ?? 0.35,
    competitorBaseShare: pct(them) ?? 0.65,
    studentUnitCost: money(you) ?? 966,
    competitorUnitCost: money(them) ?? 900,
    slope,
    minPrice: bounds[0] ?? 900,
    maxPrice: bounds[1] ?? 2000,
  }
  return m
}

/** Is this a PMG instance? Read off the screen, not passed in — the robot should not
 *  need to be told what game it is in. */
async function readPmg(page) {
  return (await page.locator('[data-testid="pricing-pmg-rules"]').count()) > 0
}

/** The PMG rules screen (spec §6.2), when there is one: read it and continue. */
async function doRulesScreen(page, log) {
  if (!(await visible(page, '[data-testid="pricing-pmg-screen"]'))) return
  await sleep(thinkTime())
  await page.click('[data-testid="pricing-pmg-continue"]')
  await page.waitForSelector('[data-testid="pricing-kc-prompt"], [data-testid="pricing-round-heading"]', { timeout: 30000 })
  log('read the price-matching rules screen')
}

/** KC: the mode's graded questions, answered at RANDOM. The robots exist to populate
 *  the reports, not to test grading accuracy — and a random spread of KC scores is
 *  more useful to eyeball than a column of 100%s. Wrong answers do not block. */
async function doKnowledgeCheck(page, log) {
  let answered = 0
  while (await visible(page, '[data-testid="pricing-kc-prompt"]')) {
    await sleep(thinkTime())
    const options = await page.locator('[data-testid^="pricing-kc-option-"]').all()
    if (options.length > 0) {
      await options[Math.floor(Math.random() * options.length)].click()
    } else if (await visible(page, '[data-testid="pricing-kc-text-input"]')) {
      // An instructor-added free-text question — recorded, never graded.
      await page.fill('[data-testid="pricing-kc-text-input"]', 'Not sure yet — I will see how the game goes.')
    } else {
      break
    }
    await page.click('[data-testid="pricing-kc-submit"]')
    await page.waitForSelector('[data-testid="pricing-kc-correct"], [data-testid="pricing-kc-incorrect"], [data-testid="pricing-kc-recorded"]', { timeout: 30000 })
    await page.click('[data-testid="pricing-kc-continue"]')
    await page.waitForSelector('[data-testid="pricing-kc-prompt"], [data-testid="pricing-round-heading"]', { timeout: 30000 })
    answered++
  }
  log(`knowledge check done (${answered} answered at random)`)
}

/** The round loop: play this robot's style to game over, reading the competitor's
 *  price off the rendered result screen after each round. */
async function playRounds(page, style, market, log) {
  const theirs = []   // what the SERVER-SIDE competitor posted, learned round by round
  const mine = []
  let round = 0

  while (await visible(page, '[data-testid="pricing-round-heading"]')) {
    round++
    const price = style.decide(market, theirs, mine)
    await sleep(thinkTime())
    await page.fill('[data-testid="pricing-price-input"]', String(price))
    await page.click('[data-testid="pricing-submit-round"]')
    await page.waitForSelector('[data-testid="pricing-reveal"]', { timeout: 30000 })

    const shown = (await page.locator('[data-testid="pricing-them-price"]').innerText()).trim()
    const theirPrice = Number(shown.replace(/[^0-9]/g, ''))
    theirs.push(theirPrice)
    mine.push(price)

    await page.click('[data-testid="pricing-continue"]')
    await page.waitForSelector('[data-testid="pricing-round-heading"], [data-testid="pricing-debrief-heading"], [data-testid="pricing-game-over"]', { timeout: 30000 })
  }
  log(`played ${round} rounds — me ${mine.join('/')} · competitor ${theirs.join('/')}`)
  return { mine, theirs }
}

/** One canned, human-sounding paragraph, chosen to MATCH the style the robot played —
 *  so the Tier-2 report reads like a real class rather than N copies of one sentence,
 *  and the paragraphs actually correspond to the play they describe. */
async function doDebrief(page, style, log) {
  if (!(await visible(page, '[data-testid="pricing-debrief-input"]'))) return false
  await sleep(thinkTime())
  await page.fill('[data-testid="pricing-debrief-input"]', pick(style.debrief))
  await page.click('[data-testid="pricing-debrief-submit"]')
  await page.waitForSelector('[data-testid="pricing-game-over"]', { timeout: 30000 })
  log('debrief submitted — game complete')
  return true
}

/** ONE robot's whole independent game. Never touches another robot's anything. */
async function runRobot(robot) {
  const { page, label, style } = robot
  const log = (msg) => console.log(`  [${label}] ${msg}`)
  try {
    // A PMG student lands on the rules screen, a Standard one on the KC; a resumed
    // participant may land mid-loop or on the debrief.
    await page.waitForSelector('[data-testid="pricing-pmg-screen"], [data-testid="pricing-kc-prompt"], [data-testid="pricing-round-heading"], [data-testid="pricing-debrief-heading"], [data-testid="pricing-game-over"]', { timeout: 90000 })
    if (await visible(page, '[data-testid="pricing-game-over"]')) { log('already finished — nothing to do'); return { done: true } }

    await doRulesScreen(page, log)
    await doKnowledgeCheck(page, log)
    // The market is only on screen once the loop starts, so it is read here — after
    // the KC, before the first price.
    await page.waitForSelector('[data-testid="pricing-round-heading"], [data-testid="pricing-debrief-heading"]', { timeout: 30000 })
    const market = await readMarket(page)
    await playRounds(page, style, market, log)
    await doDebrief(page, style, log)
    return { done: true }
  } catch (e) {
    console.error(`  [${label}] FAILED: ${e.message}`)
    return { done: false, error: e.message }
  }
}

// ── main ───────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\nPricing robot mode — instance ${INSTANCE}, ${COUNT} independent students, pace=${PACE}`)
  console.log('(single-player: no seats, no matching — each robot plays its own full game)')
  console.log(EMULATOR
    ? `DRY RUN against ${APP} — emulator identity, nothing production is touched.\n`
    : 'LIVE RUN — this writes real participants and real gradebook rows.\n')
  if (!EMULATOR && !(await launcherReachable())) {
    console.error(`Launcher not reachable at ${LAUNCHER}. Start it first.`)
    process.exit(1)
  }

  console.log('Phase A — minting student tokens…')
  // The style pool depends on the instance's MODE, which is not known until a robot
  // has a page open — so styles are assigned in Phase B, once the first window has
  // told us which game this is.
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

  // The MODE decides the style pool (undercutting is the whole story in Standard and
  // a non-event under PMG). Read it off the first robot's own screen rather than
  // asking the instructor to pass a flag that could disagree with the instance.
  await live[0].page.waitForSelector('[data-testid="pricing-pmg-screen"], [data-testid="pricing-kc-prompt"], [data-testid="pricing-round-heading"]', { timeout: 90000 })
  const pmgInstance = (await live[0].page.locator('[data-testid="pricing-pmg-screen"], [data-testid="pricing-pmg-rules"]').count()) > 0
  const styles = assignStyles(live.length, pmgInstance)
  live.forEach((r, i) => { r.style = styles[i] })
  console.log(`\n  instance mode: ${pmgInstance ? 'PMG' : 'Standard'} — styles: ${styles.map(s => s.key).join(', ')}`)

  // Phase C — every robot plays CONCURRENTLY and INDEPENDENTLY. No barrier, no
  // cross-robot read: this is the single-player family's defining constraint, and it
  // is why there is no "wait for everyone" step anywhere in this driver.
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
