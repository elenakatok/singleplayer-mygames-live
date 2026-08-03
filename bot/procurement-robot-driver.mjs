// ═══════════════════════════════════════════════════════════════════════════════
// PROCUREMENT ROBOT MODE — the browser runner. Populates an instance with N auto-driven
// students who each play their OWN complete game THROUGH THE REAL UI, in headed, tiled
// Chromium windows Elena can watch.
//
// ⚠ SINGLE-PLAYER: "STUDENTS", NOT "SEATS". There is nothing to seat — no matching, no
// attendance code, no waiting on anybody. Each robot is an independent student bidding
// against its own server-drawn rivals, so "6 students" means six complete games and
// there is no barrier anywhere in the run.
//
// ⚠⚠ WHAT THIS COHORT IS ACTUALLY FOR: generating the §12 lecture chart from the rules
// it names. The styles (procurement-styles.mjs) are the scatter's own features — a
// cluster on the optimal line, a row on the 45° line, a band above it and points below
// it — so a populated instance yields a Tier-3 chart Elena can point at and describe. It
// is not "fill the roster with plausible noise".
//
// ⚠ READ AND ACT ARE BOTH THE UI — the standing false-green rule. Nothing is written to
// Firestore directly and no compute function is called: every robot goes through
// procurementBootstrap, GetQuestions, SubmitKcAnswer, SubmitFreeText and SubmitBid
// because it types into the real controls, and it learns its own cost by READING the
// rendered bidding screen. A robot that finished is indistinguishable from a student who
// finished, which is what makes Score & Record over a robot cohort a real rehearsal.
//
// ⚠⚠ THE ROBOT NEVER SEES A RIVAL'S COST. It reads its own cost off its own screen and
// the auction parameters off the same panel a student reads. No student response carries
// a rival cost before the game ends (§4), and this driver reaches for none — it does not
// even read the post-game reveal.
//
// ⚠ THE KC AND PREP ARE DRIVEN THROUGH THE SHIPPED AUTO-DRIVE, not re-implemented here.
// Same module the launcher loads. Two copies of that sequence is how forecast's start
// position came to be offered while doing nothing.
// ═══════════════════════════════════════════════════════════════════════════════

import { chromium } from 'playwright'
import { assignStyles } from './procurement-styles.mjs'
import { driveProcurementStudentPastKc } from './procurement-autodrive.mjs'

/** Tiled window positions, so a headed run is watchable rather than a stack. */
function tile(i, n, w = 1280, h = 900) {
  const cols = Math.ceil(Math.sqrt(n))
  const cw = Math.floor(w / cols)
  const ch = Math.floor(h / Math.ceil(n / cols))
  return { x: (i % cols) * cw, y: Math.floor(i / cols) * ch, width: cw, height: ch }
}

const testId = async (page, id) =>
  (await page.locator(`[data-testid="${id}"]`).first().innerText()).trim()
const num = (s) => Number(String(s).replace(/[^0-9-]/g, ''))

/**
 * Play ONE robot's whole game through the browser.
 *
 * @param page     a Playwright page, already pointed at the student URL
 * @param style    one entry from STYLES
 * @param params   the auction's public parameters (reserve, rivalCostMax, totalBidders)
 * @param rounds   how many rounds this instance runs
 * @param label    stable key for the style's deterministic jitter
 */
export async function playOneRobot({ page, style, params, rounds, label }) {
  await page.waitForSelector('[data-testid="proc-bid-input"]', { timeout: 60_000 })

  const bids = []
  for (let t = 1; t <= rounds; t++) {
    // ⚠ THE COST IS READ OFF THE SCREEN, not fetched. This is what makes the run a real
    // exercise of the bidding screen rather than of the callable behind it.
    const cost = num(await testId(page, 'proc-cost'))
    const bid = style.bid(cost, params, `${label}:${t}`)
    bids.push({ cost, bid })

    await page.locator('[data-testid="proc-bid-input"]').fill(String(bid))
    await page.locator('[data-testid="proc-bid-submit"]').click()
    await page.waitForSelector('[data-testid="proc-result-heading"]', { timeout: 30_000 })
    await page.locator('[data-testid="proc-result-continue"]').click()

    if (t < rounds) {
      await page.waitForSelector('[data-testid="proc-bid-input"]', { timeout: 30_000 })
    }
  }

  // The final results screen, then the debrief paragraph if this instance asks one.
  await page.waitForSelector('[data-testid="proc-end-heading"]', { timeout: 30_000 })
  const totalProfit = num(await testId(page, 'proc-end-profit'))

  let debriefSubmitted = false
  if (await page.locator('[data-testid="proc-end-continue"]').count() > 0) {
    await page.locator('[data-testid="proc-end-continue"]').click()
    await page.waitForSelector('[data-testid="proc-freetext-input"]', { timeout: 30_000 })
    await page.locator('[data-testid="proc-freetext-input"]')
      .fill(`(Robot seat — ${style.name}. Not a student answer.)`)
    await page.locator('[data-testid="proc-freetext-submit"]').click()
    await page.waitForSelector('[data-testid="proc-end-heading"]', { timeout: 30_000 })
    debriefSubmitted = true
  }

  return { style: style.name, bids, totalProfit, debriefSubmitted }
}

/**
 * Run a whole cohort.
 *
 * @param call        async (fnName, data) => result, for the auto-drive only
 * @param studentUrl  (pid) => url
 * @param authFor     (pid) => the auth payload the callables accept
 */
export async function runCohort({
  call, studentUrl, authFor, params, rounds, students, headed = false,
}) {
  const styles = assignStyles(students)
  const browser = await chromium.launch(
    headed ? { headless: false, args: ['--window-position=0,0'] } : {})

  try {
    // ⚠ NO BARRIER. Each robot is a private game; they run concurrently because nothing
    // any of them does can affect another.
    return await Promise.all(styles.map(async (style, i) => {
      const pid = `robot-${i + 1}-${style.name}`
      const ctx = await browser.newContext(headed ? { viewport: tile(i, students) } : {})
      const page = await ctx.newPage()
      try {
        // The KC and the prep, through the SHIPPED sequence.
        await driveProcurementStudentPastKc(call, authFor(pid))
        await page.goto(studentUrl(pid))
        const r = await playOneRobot({ page, style, params, rounds, label: pid })
        return { pid, ...r }
      } finally {
        if (!headed) await ctx.close()
      }
    }))
  } finally {
    if (!headed) await browser.close()
  }
}
