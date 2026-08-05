// ═══════════════════════════════════════════════════════════════════════════════
// PROCUREMENT ROBOT MODE — the browser runner the LAUNCHER SPAWNS.
//
// Populates an instance with N auto-driven students who each play their OWN complete
// game THROUGH THE REAL UI, in headed, tiled Chromium windows Elena can watch.
//
//   node procurement-robot-driver.mjs --instance <id> [--students 8] [--pace watch|fast]
//                                     [--launcher http://localhost:5180] [--screen 1920x1080]
//   dry run:
//   node procurement-robot-driver.mjs --instance demo-1 --emulator --app http://localhost:5189
//                                     --headless --exit-when-done
//
// ⚠⚠ THIS FILE IS A CLI, AND IT MUST STAY ONE. It shipped as a LIBRARY on 08-03 —
// exports only, no `main()`, no argv — so the launcher spawned it, node loaded the module,
// nothing ran, and it exited 0. The launcher printed "spawned robot-driver — 16 seats" and
// then "driver exited (code 0)", which reads like success. The launcher's own guard
// (`robotLoadErrors`) only checks the driver FILE EXISTS; it cannot tell "exists" from
// "does anything". The Playwright harness now spawns this the way the launcher does and
// asserts robots actually finished — see [LAUNCHER] there. Do not remove either.
//
// ⚠ SINGLE-PLAYER: "STUDENTS", NOT "SEATS". There is nothing to seat — no matching, no
// attendance code, no waiting on anybody. Each robot is an independent student bidding
// against its own server-drawn rivals, so "8 students" means eight complete games and
// there is no barrier anywhere in the run. `--seats` is accepted as an alias because the
// launcher spawns every driver with the same flag name; only the MEANING differs.
//
// ⚠⚠ WHAT THIS COHORT IS FOR: generating the §12 lecture chart from the rules it names.
// The styles (procurement-styles.mjs) are the scatter's own features — a cluster on the
// optimal line, a row on the 45° line, a band above it and points below it — so a
// populated instance yields a Tier-3 chart Elena can point at and describe.
//
// ⚠ READ AND ACT ARE BOTH THE UI. Nothing is written to Firestore, and no compute
// function is called: every robot types into the real controls and learns its own cost by
// READING the rendered bidding screen. Even the auction's PARAMETERS are scraped off the
// panel a student reads, rather than fetched — which is also what lets this run against
// production, where the driver has no access to config.
//
// ⚠⚠ THE ROBOT NEVER SEES A RIVAL'S COST. It reads its own cost and the public parameters
// off its own screen. No student response carries a rival cost before the game ends (§4),
// and this driver reaches for none — it does not even open the post-game reveal.
// ═══════════════════════════════════════════════════════════════════════════════

import { createRequire } from 'node:module'
import { assignStyles } from './procurement-styles.mjs'
import { assignOpenStyles } from './procurement-open-styles.mjs'

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

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

// ── Reading the screen ─────────────────────────────────────────────────────────

const visible = async (page, sel) => (await page.locator(sel).count()) > 0
const grab = async (page, sel) => {
  try { return (await page.locator(sel).first().innerText()).trim() } catch { return '' }
}
const num = (s) => Number(String(s).replace(/[^0-9-]/g, ''))

/**
 * The auction's public parameters, SCRAPED OFF THE BIDDING SCREEN.
 *
 * ⚠ Read, not fetched — the same numbers a student reads, and the only ones available in
 * a live run where this process has no access to the instance's config. If the panel's
 * wording changes these regexes must change with it, which is the correct coupling: the
 * robot is reading the screen, so it should break when the screen stops saying it.
 *
 * ⚠ THE PLAYER'S OWN COST RANGE IS NOT AMONG THEM, and must not be — §4 says a student is
 * told the rival distribution only. The styles do not need it: they take the REALIZED
 * cost, which is on screen.
 */
async function readAuctionParams(page) {
  const panel = await grab(page, 'body')
  const rivals = panel.match(/anywhere from\s+(\d+)\s+to\s+(\d+)/i)
  const bidders = panel.match(/you\s*\+\s*(\d+)\s+other suppliers/i)
  const reserve = num(await grab(page, '[data-testid="proc-reserve"]'))
  if (!rivals || !bidders || !Number.isFinite(reserve) || reserve === 0) {
    throw new Error('could not read the auction panel — has the bidding screen changed?')
  }
  return {
    rivalCostMax: Number(rivals[2]),
    reserve,
    totalBidders: Number(bidders[1]) + 1,
  }
}

// ── Window tiling, so a headed run is watchable ────────────────────────────────

function gridCell(index, count, screenW, screenH, colsOverride) {
  const n = Math.max(1, count | 0)
  const cols = colsOverride ?? Math.ceil(Math.sqrt(n))
  const rows = Math.ceil(n / cols)
  const cellW = Math.floor(screenW / cols), cellH = Math.floor(screenH / rows)
  const GUTTER = 6
  return { x: (index % cols) * cellW, y: Math.floor(index / cols) * cellH, w: cellW - GUTTER, h: cellH - GUTTER }
}

// ── One robot's whole game, entirely through the UI ────────────────────────────

/**
 * @param page   a Playwright page already pointed at this robot's launch URL
 * @param style  one entry from STYLES
 * @param label  stable key for the style's deterministic jitter
 * @param think  () => ms to pause between actions, so a watched run is followable
 */
export async function playOneRobot({ page, style, openStyle, label, think = () => 0 }) {
  // ⚠⚠ WAIT FOR THE FLOW TO RENDER BEFORE LOOKING AT IT. The first version went straight
  // to `visible('proc-kc-prompt')`, which is a COUNT — it returns false on a page still
  // bootstrapping its session. Every robot therefore skipped the KC it was sitting on and
  // then waited 60s for a bidding screen that could not appear until the KC was answered.
  // Six robots, six timeouts, and the cause looked like the bidding screen.
  await page.waitForSelector(
    '[data-testid="proc-kc-prompt"], [data-testid="proc-freetext-prompt"], ' +
    '[data-testid="proc-bid-input"], [data-testid="proc-open-bid-input"], ' +
    '[data-testid="proc-end-heading"]',
    { timeout: 60_000 })

  // ── The knowledge check, if this instance asks one ───────────────────────────
  // ⚠ Driven through the UI, not through the auto-drive module. In a LIVE run this
  // process holds no `_test` identity and no bearer token — only a launch URL — so
  // clicking is the only honest path, and it is the one a student takes.
  let kcAnswered = 0
  while (await visible(page, '[data-testid="proc-kc-prompt"]')) {
    await sleep(think())
    const options = page.locator('[data-testid^="proc-kc-option-"]')
    const n = await options.count()
    // ⚠ RANDOM, deliberately. A cohort of 100% KC scores would misrepresent the class in
    // the reports; these are demo seats, not model students.
    await options.nth(Math.floor(Math.random() * Math.max(1, n))).click()
    await page.locator('[data-testid="proc-kc-submit"]').click()
    await page.waitForSelector('[data-testid="proc-kc-continue"]', { timeout: 30_000 })
    await page.locator('[data-testid="proc-kc-continue"]').click()
    kcAnswered++
    await page.waitForTimeout(250)
  }

  // ── The prep paragraph (S8), between the KC and round 1 ─────────────────────
  if (await visible(page, '[data-testid="proc-freetext-input"]')) {
    await sleep(think())
    await page.locator('[data-testid="proc-freetext-input"]')
      .fill(`(Robot seat — ${style.name}. Not a student answer.)`)
    await page.locator('[data-testid="proc-freetext-submit"]').click()
  }

  // ── WHICH FORMAT AM I IN? ───────────────────────────────────────────────────
  //
  // ⚠ READ OFF THE SCREEN, not from config. In a live run this process has a launch URL
  // and nothing else — no `_test` identity, no bearer token, no way to ask the instance
  // what format it is. The two bidding screens are structurally different, so which one
  // rendered IS the answer, and it is available exactly when it is needed.
  await page.waitForSelector(
    '[data-testid="proc-bid-input"], [data-testid="proc-open-bid-input"]', { timeout: 60_000 })
  if (await visible(page, '[data-testid="proc-open-bid-input"]')) {
    // ⚠ THE OPEN PERSONA, not the sealed one. Every seat is dealt BOTH, because the
    // format is not knowable until a page has rendered — this process has a launch URL
    // and nothing else in a live run. Dealing both and picking here is cheaper and more
    // honest than a probe request, and it keeps `runCohort` format-agnostic.
    return playOpenRounds({ page, style: openStyle, label, think, kcAnswered })
  }

  // ── The round loop (SEALED) ─────────────────────────────────────────────────
  await page.waitForSelector('[data-testid="proc-bid-input"]', { timeout: 60_000 })
  const params = await readAuctionParams(page)
  // "Round 1 of 8" — the horizon is public in this game (§2), so reading it is fair.
  const totalRounds = num((await grab(page, '[data-testid="proc-round-heading"]')).split(/of/i)[1])

  const bids = []
  for (let t = 1; t <= totalRounds; t++) {
    await sleep(think())
    const cost = num(await grab(page, '[data-testid="proc-cost"]'))
    const bid = style.bid(cost, params, `${label}:${t}`)
    bids.push({ round: t, cost, bid })

    await page.locator('[data-testid="proc-bid-input"]').fill(String(bid))
    await page.locator('[data-testid="proc-bid-submit"]').click()
    await page.waitForSelector('[data-testid="proc-result-heading"]', { timeout: 30_000 })
    await sleep(think())
    await page.locator('[data-testid="proc-result-continue"]').click()
    if (t < totalRounds) await page.waitForSelector('[data-testid="proc-bid-input"]', { timeout: 30_000 })
  }

  // ── Results, then the debrief if this instance asks one ─────────────────────
  await page.waitForSelector('[data-testid="proc-end-heading"]', { timeout: 30_000 })
  const totalProfit = num(await grab(page, '[data-testid="proc-end-profit"]'))

  let debriefSubmitted = false
  if (await visible(page, '[data-testid="proc-end-continue"]')) {
    await sleep(think())
    await page.locator('[data-testid="proc-end-continue"]').click()
    await page.waitForSelector('[data-testid="proc-freetext-input"]', { timeout: 30_000 })
    await page.locator('[data-testid="proc-freetext-input"]')
      .fill(`(Robot seat — ${style.name}. Not a student answer.)`)
    await page.locator('[data-testid="proc-freetext-submit"]').click()
    await page.waitForSelector('[data-testid="proc-end-heading"]', { timeout: 30_000 })
    debriefSubmitted = true
  }

  return { style: style.name, kcAnswered, bids, totalProfit, debriefSubmitted, params, totalRounds }
}

// ── The OPEN format's round loop ───────────────────────────────────────────────

/**
 * One robot's rounds in an OPEN instance.
 *
 * ⚠⚠ THE TRIGGER IS "MINIMUM NEXT BID < threshold", NEVER "price < threshold", and this
 * is the bug the open cohort shipped with. At a standing of 48 with a cost of 47 the
 * PRICE is still above cost — but the next legal bid is 46, already a loss. A robot that
 * waited for the price to fall below its threshold sat there forever: it never bid, never
 * dropped out, and THE ROUND NEVER RESOLVED. No round, no exit price, no Tier-3 data.
 *
 * ⚠ TWO LEGITIMATE ENDINGS AND BOTH MUST BE HANDLED. A robot may drop out, or it may
 * simply WIN — its bid stands, no bot can answer, and the round resolves under it with no
 * drop-out at all. A loop that only looked for its own Drop Out click would hang on every
 * round its robot won, which is the majority of rounds for `exits below cost`.
 *
 * ⚠ IT READS ONLY WHAT THE STUDENT SEES: their own cost, and the screen's own "Minimum
 * next bid". Nothing here can reach a rival's cost, and the styles do not want one.
 */
async function playOpenRounds({ page, style, label, think, kcAnswered }) {
  const reserve = num(await grab(page, '[data-testid="proc-open-reserve"]'))
  const totalRounds = num((await grab(page, '[data-testid="proc-open-round"]')).split(/of/i)[1])
  if (!Number.isFinite(totalRounds) || totalRounds < 1) {
    throw new Error('could not read the round count — has the open bidding screen changed?')
  }

  const rounds = []
  // ⚠ Reported back so the MARGIN is visible rather than assumed — see `runCohort`'s
  // summary. A budget nobody can see the headroom on is a budget nobody can trust.
  let longestRoundMs = 0
  for (let t = 1; t <= totalRounds; t++) {
    await page.waitForSelector('[data-testid="proc-open-bid-input"]', { timeout: 60_000 })
    const cost = num(await grab(page, '[data-testid="proc-open-cost"]'))
    const threshold = style.threshold(cost, `${label}:${t}`)
    let acted = 0
    let lastMin = null

    // ⚠⚠ BUDGET BY WALL CLOCK, NOT BY ITERATIONS (Elena, 2026-08-04). This loop first read
    // `guard < 400` with a 150 ms wait per pass — roughly 60–80 SECONDS, which is not a
    // number anybody chose. At SHIPPED pacing (800/1200/2500/3000 ms) the opening cascade
    // alone is ~12 s and each duel exchange another ~3 s, so a robot with a long endgame
    // — a low cost, or a threshold well under the halt — ran out mid-round, fell out of
    // the loop, and then waited 60 s for a Continue that was never coming. Two of eight
    // stuck in a launcher run.
    //
    // ⚠ AN ITERATION COUNT IS THE WRONG UNIT ENTIRELY: it measures how often we looked,
    // not how long the auction has had. Halving the poll interval would have halved the
    // budget without a line of it changing.
    const ROUND_BUDGET_MS = 5 * 60_000
    const deadline = Date.now() + ROUND_BUDGET_MS
    let exitReason = 'resolved'

    // Drive until the round ends — by our own Drop Out, by auto-drop, or by winning.
    for (;;) {
      if (await visible(page, '[data-testid="proc-open-continue"]')) break
      if (Date.now() > deadline) { exitReason = 'budget'; break }

      // ⚠ The screen prints "46 ECU — bids must fall by at least 2 ECU"; the FIRST number
      // is the minimum next bid. It is absent once the round has resolved.
      const minText = await grab(page, '[data-testid="proc-open-min"]')
      const minNextBid = minText === '' ? null : num(minText.split('—')[0])

      if (minNextBid === null || !Number.isFinite(minNextBid)) {
        // Either the round just ended, or a bot is mid-answer. Give the tick a moment.
        await page.waitForTimeout(150)
        continue
      }
      lastMin = minNextBid

      if (minNextBid >= threshold) {
        // ⚠ The one-click button is DISABLED while this robot holds the low bid (it may
        // not outbid itself, §4.2). That is not a stall: a bot is answering. Wait.
        const btn = page.locator('[data-testid="proc-open-bid-min"]')
        if (await btn.count() > 0 && await btn.isEnabled()) {
          await sleep(think())
          await btn.click()
          acted++
        } else {
          await page.waitForTimeout(150)
        }
        continue
      }

      // Below threshold — stop. This is the decision the Tier-3 chart plots.
      await sleep(think())
      const out = page.locator('[data-testid="proc-open-dropout"]')
      if (await out.count() > 0 && await out.isEnabled()) {
        await out.click()
      } else {
        await page.waitForTimeout(150)
      }
    }

    // ⚠ LOG WHERE THE LOOP EXITED. A robot that runs out of budget and then times out
    // waiting for Continue reports only "timeout", which says nothing about which of the
    // two happened — and that ambiguity is what made the original stall hard to place.
    if (exitReason === 'budget') {
      console.error(
        `  [${label}] round ${t}: WALL-CLOCK BUDGET EXHAUSTED after ${ROUND_BUDGET_MS}ms `
        + `(cost ${cost}, threshold ${threshold}, ${acted} bids, last minimum ${lastMin}). `
        + 'The auction had not resolved. This is the stall, not a timeout downstream.')
    }
    await page.waitForSelector('[data-testid="proc-open-continue"]', { timeout: 60_000 })
    const elapsedMs = Date.now() - (deadline - ROUND_BUDGET_MS)
    if (elapsedMs > longestRoundMs) longestRoundMs = elapsedMs
    rounds.push({
      round: t,
      cost,
      threshold,
      elapsedMs,
      exitReason,
      bids: acted,
      exitPrice: num(await grab(page, '[data-testid="proc-open-exit"]')),
      finalPrice: num(await grab(page, '[data-testid="proc-open-final-price"]')),
    })
    await page.locator('[data-testid="proc-open-continue"]').click()
  }

  // ── Results, then the debrief if this instance asks one ─────────────────────
  await page.waitForSelector('[data-testid="proc-open-end-heading"]', { timeout: 30_000 })
  const totalProfit = num(await grab(page, '[data-testid="proc-open-end-profit"]'))

  // ⚠⚠ THE CONTINUE BUTTON DOES NOT MEAN THERE IS A DEBRIEF. The results screen is a step
  // in the sequence, so it carries a Continue whether or not a debrief question follows —
  // and an instance with the whole question pool switched off has none. The first version
  // clicked Continue and then waited 30s for a free-text box that was never going to
  // appear, which failed every robot in a KC-disabled instance. Wait for EITHER outcome.
  let debriefSubmitted = false
  if (await visible(page, '[data-testid="proc-open-end-continue"]')) {
    await sleep(think())
    await page.locator('[data-testid="proc-open-end-continue"]').click()
    await page.waitForSelector(
      '[data-testid="proc-freetext-input"], [data-testid="proc-open-end-heading"]',
      { timeout: 30_000 })
    if (await visible(page, '[data-testid="proc-freetext-input"]')) {
      await page.locator('[data-testid="proc-freetext-input"]')
        .fill(`(Robot seat — ${style.name}. Not a student answer.)`)
      await page.locator('[data-testid="proc-freetext-submit"]').click()
      await page.waitForSelector('[data-testid="proc-open-end-heading"]', { timeout: 30_000 })
      debriefSubmitted = true
    }
  }

  return {
    format: 'open_descending',
    style: style.name,
    kcAnswered,
    longestRoundMs,
    rounds,
    // ⚠ `bids` is kept under the same key the sealed path uses so the dry run and the
    // launcher's log do not need to know which format they are summarising.
    bids: rounds.map(r => ({ round: r.round, cost: r.cost, bid: r.exitPrice })),
    totalProfit,
    debriefSubmitted,
    params: { reserve },
    totalRounds,
  }
}

/**
 * Run a whole cohort.
 *
 * ⚠ NO BARRIER. Each robot is a private game; they run concurrently because nothing any
 * of them does can affect another.
 */
export async function runCohort({ urlFor, students, headed = false, think = () => 0, screen, cols }) {
  const styles = assignStyles(students)
  // ⚠ BOTH SETS, dealt in parallel. The sealed personas vary by markup relative to β and
  // the open ones by exit threshold; they are not the same list under two names, and
  // neither ports to the other format (procurement-open-styles.mjs's header says why).
  const openStyles = assignOpenStyles(students)

  // ⚠⚠ ONE BROWSER PER ROBOT WHEN HEADED, NOT ONE BROWSER WITH N CONTEXTS.
  //
  // Window POSITION is an OS-level property of a browser process, set through Chromium's
  // `--window-position` launch flag. A `viewport` on a context sizes the PAGE inside a
  // window; it cannot move the window. The first version of this file computed `gridCell`
  // correctly and then passed only `{ width, height }` as a viewport — so every window
  // opened at Chromium's default position, stacked exactly on top of the last, and the
  // tiling arithmetic ran with its result discarded.
  //
  // Every other driver in this fleet (forecast, pricing, newsvendor) launches per robot
  // with `--window-position` + `--window-size` for exactly this reason. This now matches
  // them. `viewport: null` is required too: without it Playwright overrides the window
  // size with its own default and the cells stop matching the grid.
  //
  // HEADLESS keeps ONE browser and N contexts — cheaper, and there is no window to place.
  const perRobot = headed
  const shared = perRobot ? null : await chromium.launch({ headless: true })
  const browsers = []

  try {
    return await Promise.all(styles.map(async (style, i) => {
      const pid = `robot-${i + 1}-${style.name}`
      let ctx
      if (perRobot) {
        const cell = gridCell(i, students, screen?.[0] ?? 1920, screen?.[1] ?? 1080, cols)
        const b = await chromium.launch({
          headless: false,
          args: [`--window-position=${cell.x},${cell.y}`, `--window-size=${cell.w},${cell.h}`],
        })
        browsers.push(b)
        ctx = await b.newContext({ viewport: null })
      } else {
        ctx = await shared.newContext()
      }
      const page = await ctx.newPage()
      const { name, url } = await urlFor(i, pid)
      await page.goto(url, { waitUntil: 'domcontentloaded' })
      try {
        const r = await playOneRobot({ page, style, openStyle: openStyles[i], label: pid, think })
        console.log(`  ✓ ${name} [${style.name}] — ${r.bids.length} rounds, ${r.totalProfit} total`)
        return { pid: name, ...r }
      } catch (err) {
        console.error(`  ✗ ${name} [${style.name}] — ${err.message}`)
        return { pid: name, style: style.name, bids: [], totalProfit: 0, debriefSubmitted: false, error: String(err.message) }
      }
    }))
  } finally {
    // ⚠ A LIVE run leaves the windows open so Elena can scroll back through what each
    // robot did. A dry run tears down, or a wrapper waiting on the child would hang.
    if (shared) await shared.close()
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// THE CLI — what the launcher spawns.
// ═══════════════════════════════════════════════════════════════════════════════

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const INSTANCE = args.instance
  const COUNT = Math.max(1, Math.min(16, Number(args.students ?? args.seats) || 8))
  const PACE = String(args.pace || 'watch')
  const LAUNCHER = String(args.launcher || 'http://localhost:5180').replace(/\/$/, '')
  const [SCREEN_W, SCREEN_H] = String(args.screen || '1920x1080').split('x').map(Number)
  const COLS = args.cols ? Number(args.cols) : null
  const HEADLESS = args.headless === true || args.headless === 'true'
  const EMULATOR = args.emulator === true || args.emulator === 'true'
  const APP = String(args.app || 'http://localhost:5173').replace(/\/$/, '')
  const EXIT_WHEN_DONE = args['exit-when-done'] === true || args['exit-when-done'] === 'true'

  if (!INSTANCE || INSTANCE === true) {
    console.error('ERROR: --instance <gameInstanceId> is required.')
    process.exit(1)
  }

  // A procurement game is one number typed per round across (by default) 8 rounds plus a
  // short KC, so "watch" can be brisker than pricing's without becoming unfollowable.
  const THINK = PACE === 'watch' ? { min: 500, max: 1200 } : { min: 30, max: 90 }
  const think = () => THINK.min + Math.floor(Math.random() * (THINK.max - THINK.min))

  /** DRY RUN identity: the dev-only ?_pid/_gid params. Each robot still goes through
   *  procurementBootstrap and every student callable — only the identity SOURCE differs,
   *  so the play path being rehearsed is the real one. */
  const emulatorUrl = (index, pid) => ({
    name: pid, url: `${APP}/?game=procurement&_pid=${pid}&_gid=${INSTANCE}`,
  })

  /** LIVE identity: the launcher mints a real classroom token. Nothing is reimplemented
   *  here — this driver has no signing key and should not have one. */
  async function mintUrl(index) {
    const res = await fetch(`${LAUNCHER}/api/student-url`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      // NO mode:'ready' — single-player has no lifecycle to drive; the plain ?token= URL
      // is all this family needs.
      body: JSON.stringify({ game_instance_id: INSTANCE, index }),
    })
    const text = await res.text()
    let json; try { json = JSON.parse(text) } catch { throw new Error(`launcher → ${res.status}: ${text.slice(0, 160)}`) }
    if (json.error) throw new Error(json.error)
    return json
  }

  if (!EMULATOR) {
    const reachable = await fetch(`${LAUNCHER}/api/games`).then(r => r.ok).catch(() => false)
    if (!reachable) {
      console.error(`ERROR: the launcher is not reachable at ${LAUNCHER}. Robots mint their launch URLs through it.`)
      process.exit(1)
    }
  }

  console.log(`procurement robots — ${COUNT} students, pace ${PACE}, instance ${INSTANCE}`)
  const results = await runCohort({
    urlFor: (i, pid) => (EMULATOR ? emulatorUrl(i, pid) : mintUrl(i)),
    students: COUNT,
    headed: !HEADLESS,
    think,
    screen: [SCREEN_W, SCREEN_H],
    cols: COLS,
  })

  const done = results.filter(r => !r.error)
  console.log(`\n${done.length}/${results.length} robots finished their game.`)

  // ⚠ NAME THE PERSONAS THAT ACTUALLY RAN. Two audiences need this and neither can get it
  // anywhere else: Elena, reading the launcher log while deciding what the chart she is
  // about to project will contain, and the browser harness, which asserts the cohort
  // really was dealt all four open styles rather than trusting the assignment code it
  // would otherwise be re-reading rather than testing.
  const byStyle = new Map()
  for (const r of done) byStyle.set(r.style, (byStyle.get(r.style) ?? 0) + 1)
  for (const [name, n] of byStyle) console.log(`  ${n} × ${name}`)

  // ⚠ THE MARGIN, PRINTED. The open loop budgets each round by WALL CLOCK; the number
  // that matters is not the budget but how close the slowest round came to it, and that
  // is only knowable from a run at shipped pacing.
  const longest = Math.max(0, ...done.map(r => r.longestRoundMs ?? 0))
  if (longest > 0) {
    console.log(`  longest round observed: ${(longest / 1000).toFixed(1)}s `
      + `(budget 300.0s — ${((1 - longest / 300_000) * 100).toFixed(0)}% headroom)`)
  }

  if (done.length === 0) process.exitCode = 1

  // Live runs keep the windows up until Elena closes them; a dry run must exit or its
  // wrapper hangs.
  if (!EXIT_WHEN_DONE && !HEADLESS) {
    console.log('Windows left open — close them, or Ctrl-C here, when you are done looking.')
    await new Promise(() => {})
  }
}

// ⚠ RUN ONLY WHEN EXECUTED, not when imported — the dry run imports `runCohort` from
// here. `process.argv[1]` is the spawned path; comparing against import.meta.url is the
// standard "am I the entry point" check.
const invokedDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())
if (invokedDirectly) {
  main().catch(err => { console.error('robot driver crashed:', err); process.exit(1) })
}
