// ═══════════════════════════════════════════════════════════════════════════════
// PD ROBOT MODE — the browser runner. Populates a live Repeated Prisoner's Dilemma
// instance with N auto-driven students who each play their OWN complete game through
// the REAL UI in headed, tiled Chromium windows Elena can watch.
//
// ⚠ HOW THIS DIFFERS FROM THE SAA / CRISIS ROBOTS — PD IS SINGLE-PLAYER.
// There are no SEATS to fill, no matching, no attendance code, no "start game", and
// no waiting on anybody. Each robot is an INDEPENDENT student playing a private game
// against the server-side bot. Concretely:
//   • Phase A mints a plain ?token= URL (the launcher already skips its
//     drive-to-ready path for single-player games — there is no lifecycle to drive);
//   • Phase C runs every robot CONCURRENTLY and each finishes on its own schedule.
//     No robot reads another's data or blocks on another's progress — the family's
//     defining constraint, preserved here by construction (nothing is shared between
//     the per-robot tasks but a log prefix).
// So "8 robots" means eight complete games, not one game with eight players.
//
// PURPOSE: give an instance a realistic, class-sized spread of students so the roster,
// the three report tiers (cooperation-over-rounds, first-move outcomes, grouped
// debrief) and Score & Record's gradebook push can be validated at scale without
// hand-playing N games.
//
// READ + ACT PATHS ARE BOTH THE UI. PD ships no window.__state global (Crisis does), so
// the driver reads the rendered reveal (`pd-reveal-their-move`) to learn what the
// opponent just played, and acts by clicking the real controls. Every move therefore
// goes through the same student callables the UI uses — pdGetState, pdSubmitKcAnswer,
// pdSubmitRound, pdSubmitDebrief — with nothing shortcut and no direct Firestore write.
//
// ⚠ THE ROBOT'S STYLE IS NOT THE BOT'S STRATEGY. `--styles` below describes how the
// SIMULATED STUDENT plays. The opponent each robot faces (tit-for-tat or GRIM) is
// drawn server-side per participant, as always, and is never visible here. A
// "grudger" robot may face either — which is exactly the contrast the reports show.
//
// Usage (PRODUCTION, via the launcher button or by hand):
//   node robot-driver.mjs --instance <id> [--seats 8] [--pace watch|fast]
//                         [--launcher http://localhost:5180] [--screen 1920x1080]
//   Prereq: the launcher running, and an instance that is FRESH — a robot run writes
//   real participants and real gradebook rows, so it SPENDS the instance exactly as a
//   prod smoke does. Use a new instance every run.
//
// Usage (DRY RUN, against the emulator — spends nothing, touches no production):
//   node robot-driver.mjs --instance demo-1 --emulator --app http://localhost:5199 --headless
//   Prereq: the firebase emulators + a vite dev server, as the Playwright harness runs
//   them. In this mode identity comes from the dev ?_pid/_gid params instead of a
//   minted classroom token, so nothing is written outside the emulator.
// ═══════════════════════════════════════════════════════════════════════════════

import { createRequire } from 'node:module'

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
const COUNT = Math.max(1, Math.min(16, Number(args.seats) || 8))
const PACE = String(args.pace || 'watch')
const LAUNCHER = String(args.launcher || 'http://localhost:5180').replace(/\/$/, '')
const [SCREEN_W, SCREEN_H] = String(args.screen || '1920x1080').split('x').map(Number)
const COLS_OVERRIDE = args.cols ? Number(args.cols) : null
const HEADLESS = args.headless === true || args.headless === 'true'
// DRY RUN: drive a local emulator + dev server using the DEV test-identity params
// instead of a classroom-minted token. Nothing outside the emulator is touched, so a
// rehearsal never spends a real instance or writes a real grade.
const EMULATOR = args.emulator === true || args.emulator === 'true'
const APP = String(args.app || 'http://localhost:5199').replace(/\/$/, '')
// A LIVE run leaves the windows open so Elena can scroll back through what each robot
// did (the Crisis driver behaves the same way, and it is why the process does not
// exit on its own). A dry run is automation with nobody watching, so it tears down and
// exits — otherwise a wrapper script waiting on the child would hang forever.
const KEEP_OPEN = !EMULATOR && args['exit-when-done'] !== true && args['exit-when-done'] !== 'true'

if (!INSTANCE || INSTANCE === true) {
  console.error('ERROR: --instance <gameInstanceId> is required.')
  process.exit(1)
}

// A PD game is 10–20 rounds of two clicks each, so "watch" is tuned well below
// Crisis's 5–15s — otherwise a single robot would take half an hour.
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

// ── PLAY STYLES — how the simulated STUDENT plays ──────────────────────────────
// A deliberate spread of recognizable human behaviours, so the reports show real
// contrast instead of a flat ~50% band of noise. Each takes the moves the OPPONENT
// has played so far and returns this round's move.
const STYLES = [
  {
    key: 'always-cooperate',
    label: 'always cooperates',
    decide: () => 'C',
    debrief: [
      'I decided at the start that I would just keep cooperating and see what happened. It seemed to work out fine most rounds so I stuck with it.',
      'I cooperated every single round. Partly because it felt like the right thing to do and partly because the numbers looked better when we both stayed quiet.',
    ],
  },
  {
    key: 'always-defect',
    label: 'always defects',
    decide: () => 'D',
    debrief: [
      'I defected every round because confessing is always better for me no matter what they do. It did mean we both ended up serving a lot though.',
      'I defected the whole way through. Looking at the payoffs it is the safe choice, but the totals got ugly fast once the other player started doing it too.',
    ],
  },
  {
    key: 'tit-for-tat',
    label: 'mirrors the opponent',
    // Cooperate first, then copy whatever the opponent did last.
    decide: (opp) => (opp.length === 0 ? 'C' : opp[opp.length - 1]),
    debrief: [
      'I started by cooperating and after that I just copied whatever the other player did in the round before. It felt like the fairest way to respond.',
      'My plan was to mirror them. Cooperate first, then give back exactly what they gave me. When they came back to cooperating so did I.',
    ],
  },
  {
    key: 'grudger',
    label: 'cooperates until betrayed',
    // Cooperate until the opponent defects once, then defect forever.
    decide: (opp) => (opp.includes('D') ? 'D' : 'C'),
    debrief: [
      'I cooperated until they confessed on me, and after that I never trusted them again. Once burned I just defected for the rest of the game.',
      'I was happy to cooperate right up until the first betrayal. After that I stopped giving them the benefit of the doubt.',
    ],
  },
  {
    key: 'random',
    label: 'plays randomly',
    decide: () => (Math.random() < 0.5 ? 'C' : 'D'),
    debrief: [
      'I honestly could not work out what the other player was doing so I mostly went back and forth without a real plan.',
      'I switched between the two fairly randomly. I kept trying to spot a pattern in their choices and never really found one.',
    ],
  },
]

/** Assign styles ROUND-ROBIN over a shuffled list, not independently at random: with
 *  6 robots, independent draws can easily produce five always-defectors and a flat,
 *  useless chart. Round-robin guarantees the spread the reports exist to show. */
function assignStyles(n) {
  const shuffled = [...STYLES].sort(() => Math.random() - 0.5)
  return Array.from({ length: n }, (_, i) => shuffled[i % shuffled.length])
}

// ── launcher reuse — token minting (nothing reimplemented here) ────────────────

/** DRY RUN identity: the dev-only ?_pid/_gid params the Playwright harness uses. Each
 *  robot still goes through pdBootstrap and every student callable — only the identity
 *  source differs, so the play path being rehearsed is the real one. */
function emulatorUrl(index) {
  const pid = `robot-${index + 1}`
  return { name: pid, url: `${APP}/?game=pd&_pid=${pid}&_gid=${INSTANCE}` }
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

/** KC: four graded questions, answered at RANDOM. The robots exist to populate the
 *  reports, not to test grading accuracy — and a random spread of KC scores is more
 *  useful to eyeball than a column of 100%s. Wrong answers do not block (no gate). */
async function doKnowledgeCheck(page, log) {
  let answered = 0
  while (await visible(page, '[data-testid="pd-kc-prompt"]')) {
    const options = await page.locator('[data-testid^="pd-kc-option-"]').all()
    if (options.length === 0) break
    await sleep(thinkTime())
    await options[Math.floor(Math.random() * options.length)].click()
    await page.click('[data-testid="pd-kc-submit"]')
    await page.waitForSelector('[data-testid="pd-kc-correct"], [data-testid="pd-kc-incorrect"]', { timeout: 30000 })
    await page.click('[data-testid="pd-kc-continue"]')
    await page.waitForSelector('[data-testid="pd-kc-prompt"], [data-testid="pd-round-heading"]', { timeout: 30000 })
    answered++
  }
  log(`knowledge check done (${answered} answered at random)`)
}

/** The round loop: play this robot's style to game over, reading the opponent's move
 *  off the rendered reveal after each round. */
async function playRounds(page, style, log) {
  const opponent = []   // what the SERVER-SIDE bot played, learned round by round
  const mine = []
  let round = 0

  while (await visible(page, '[data-testid="pd-round-heading"]')) {
    round++
    const move = style.decide(opponent, mine)
    await sleep(thinkTime())
    await page.click(`[data-testid="pd-choice-${move}"]`)
    await page.click('[data-testid="pd-submit-round"]')
    await page.waitForSelector('[data-testid="pd-reveal"]', { timeout: 30000 })

    const theirs = (await page.locator('[data-testid="pd-reveal-their-move"]').innerText()).trim()
    const theirMove = /cooperate/i.test(theirs) ? 'C' : 'D'
    opponent.push(theirMove)
    mine.push(move)

    await page.click('[data-testid="pd-continue"]')
    await page.waitForSelector('[data-testid="pd-round-heading"], [data-testid="pd-debrief-prompt"]', { timeout: 30000 })
  }
  log(`played ${round} rounds — me ${mine.join('')} / opponent ${opponent.join('')}`)
  return { mine, opponent }
}

/** One canned, human-sounding paragraph, chosen to MATCH the style the robot played —
 *  so the grouped Tier-2 report reads like a real class rather than N copies of one
 *  sentence, and the paragraphs actually correspond to the play they describe. */
async function doDebrief(page, style, log) {
  if (!(await visible(page, '[data-testid="pd-debrief-prompt"]'))) return false
  await sleep(thinkTime())
  await page.fill('[data-testid="pd-debrief-input"]', pick(style.debrief))
  await page.click('[data-testid="pd-debrief-submit"]')
  await page.waitForSelector('[data-testid="pd-all-done"]', { timeout: 30000 })
  log('debrief submitted — game complete')
  return true
}

/** ONE robot's whole independent game. Never touches another robot's anything. */
async function runRobot(robot) {
  const { page, label, style } = robot
  const log = (msg) => console.log(`  [${label}] ${msg}`)
  try {
    // The student lands on the KC first; a resumed participant may land mid-loop.
    await page.waitForSelector('[data-testid="pd-kc-prompt"], [data-testid="pd-round-heading"], [data-testid="pd-debrief-prompt"], [data-testid="pd-all-done"]', { timeout: 90000 })
    if (await visible(page, '[data-testid="pd-all-done"]')) { log('already finished — nothing to do'); return { done: true } }

    await doKnowledgeCheck(page, log)
    await playRounds(page, style, log)
    await doDebrief(page, style, log)
    return { done: true }
  } catch (e) {
    console.error(`  [${label}] FAILED: ${e.message}`)
    return { done: false, error: e.message }
  }
}

// ── main ───────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\nPD robot mode — instance ${INSTANCE}, ${COUNT} independent students, pace=${PACE}`)
  console.log('(single-player: no seats, no matching — each robot plays its own full game)')
  console.log(EMULATOR
    ? `DRY RUN against ${APP} — emulator identity, nothing production is touched.\n`
    : 'LIVE RUN — this writes real participants and real gradebook rows.\n')
  if (!EMULATOR && !(await launcherReachable())) {
    console.error(`Launcher not reachable at ${LAUNCHER}. Start it first.`)
    process.exit(1)
  }

  console.log('Phase A — minting student tokens…')
  const styles = assignStyles(COUNT)
  const robots = []
  for (let i = 0; i < COUNT; i++) {
    try {
      const { name, url } = await mintUrl(i)
      robots.push({ index: i, name, url, style: styles[i], label: `${i + 1}/${name}` })
      console.log(`  ✓ ${name} — will play "${styles[i].label}"`)
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
