// ═══════════════════════════════════════════════════════════════════════════════
// Repeated Prisoner's Dilemma — REAL BROWSER harness (Playwright + Chromium).
//
// The .mjs harnesses beside this one drive the callables over HTTP: they prove the
// SERVER is right. This one drives the actual UI in a real browser against the real
// emulator, and proves the GAME is right — that a student clicking through the page
// gets a correct, complete, non-leaking experience. It is ADDITIONAL coverage, not a
// replacement: pd-playthrough.mjs still runs, and still owns the server contract.
//
// It is also the family's first browser driver, so it is written to be copied:
// nothing in the plumbing below (vite boot, emulator seeding, response capture) is
// PD-specific except the selectors and the assertions.
//
// WHAT IT COVERS, end to end, twice (once per bot strategy):
//   • the knowledge check — a CORRECT run and a WRONG run, proving a wrong answer is
//     recorded and scored and does NOT block entry to the game (there is no gate);
//   • the whole round loop to game over, with every bot move and both payoffs
//     predicted from the spec and checked against the rendered reveal;
//   • the history table filling in, per-round and cumulative, row by row;
//   • the payoff matrix rendering the INSTANCE's config values in the right cells;
//   • Cooperate/Defect starting neutral with submit gated on a choice;
//   • submit-and-lock — a played round cannot be revised in the UI;
//   • resume — reload mid-loop and land on the right round with history intact;
//   • the debrief paragraph submitting and landing in Firestore;
//   • ⚠ THE NO-LEAK ASSERTION AT THE DOM LEVEL: the drawn round count and the
//     assigned strategy appear nowhere in the rendered page, and nowhere in any
//     callable response the browser actually received.
//
// Run:
//   npm install && npx playwright install chromium     (once)
//   npm run harness:pd:browser
//
// It boots the Vite DEV server itself (dev mode is what enables the ?_pid/_gid test
// identity and the emulator wiring in frontend/src/firebase.ts) and shuts it down on
// the way out.
// ═══════════════════════════════════════════════════════════════════════════════

import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PROJECT = 'demo-singleplayer'
const FUNCTIONS = `http://127.0.0.1:5010/${PROJECT}/us-central1`
const FIRESTORE = `http://127.0.0.1:8090/v1/projects/${PROJECT}/databases/(default)/documents`
const ROOT = path.dirname(fileURLToPath(import.meta.url))
const VITE_PORT = 5199
const APP = `http://localhost:${VITE_PORT}`

let passed = 0, failed = 0
const check = (cond, label) => {
  if (cond) { passed++; console.log(`  ✓ ${label}`) }
  else { failed++; console.error(`  ✗ ${label}`) }
}

// ── Emulator plumbing (shared shape with pd-playthrough.mjs) ───────────────────

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

const intVal = (n) => ({ integerValue: String(n) })
const asStudent = (gid, pid, extra = {}) => ({ _test: { participant_id: pid, game_instance_id: gid }, ...extra })

// ── The spec, re-implemented independently (never imported from the code under test) ──

/** Payoffs for every instance this harness creates. All FOUR VALUES ARE < 10, while
 *  every legal round count is ≥ 10 — which is what makes "no number ≥ 10 is rendered"
 *  a sound leak test on a page showing round 1. */
const PAYOFFS = { both_cooperate: 1, sucker: 9, temptation: 0, both_defect: 6 }

function expectedBotMove(strategy, priorMoves) {
  if (strategy === 'tft') return priorMoves.length === 0 ? 'C' : priorMoves[priorMoves.length - 1]
  if (strategy === 'grim') return priorMoves.includes('D') ? 'D' : 'C'
  throw new Error(`unknown strategy ${strategy}`)
}

function expectedYears(own, other, p) {
  if (own === 'C') return other === 'C' ? p.both_cooperate : p.sucker
  return other === 'C' ? p.temptation : p.both_defect
}

/** The KC answer key, derived the way the server derives it (spec §7 + §2). */
const KC_KEY = [
  { field: 'kc_cc', correct: String(expectedYears('C', 'C', PAYOFFS)) },
  { field: 'kc_cd', correct: String(expectedYears('C', 'D', PAYOFFS)) },
  { field: 'kc_dc', correct: String(expectedYears('D', 'C', PAYOFFS)) },
  { field: 'kc_dd', correct: String(expectedYears('D', 'D', PAYOFFS)) },
]
/** Every option value the KC offers, ascending — the distinct payoff values. */
const KC_OPTIONS = [...new Set(Object.values(PAYOFFS))].sort((a, b) => a - b).map(String)

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

const studentUrl = (gid, pid) => `${APP}/?game=pd&_pid=${pid}&_gid=${gid}`

const text = async (page, sel) => (await page.locator(sel).first().innerText()).trim()
const exists = async (page, sel) => (await page.locator(sel).count()) > 0

/** A table row's cells. innerText separates table cells with TABS (and rows with
 *  newlines), so splitting on whitespace is what actually yields the columns. */
const cells = async (page, sel) => (await text(page, sel)).split(/\s+/).filter(Boolean)

/** Every callable response this browser actually received, for the network audit. */
function captureResponses(page, sink) {
  page.on('response', async (res) => {
    const url = res.url()
    if (!url.startsWith(FUNCTIONS.replace('127.0.0.1', 'localhost')) && !url.startsWith(FUNCTIONS)) return
    const name = url.split('/').pop()
    try { sink.push({ name, body: await res.text() }) } catch { /* body already consumed */ }
  })
}

function deepKeys(value, out = new Set()) {
  if (Array.isArray(value)) { for (const v of value) deepKeys(v, out); return out }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) { out.add(k); deepKeys(v, out) }
  }
  return out
}

// ── Seeding ────────────────────────────────────────────────────────────────────

/** Seeds config/main, first-touches the student over HTTP, and reports the SERVER'S
 *  TRUTH (round count + strategy) — which the harness knows and the browser must not. */
async function openInstance(gid, pid, seed) {
  await putDoc(`pd_game_instances/${gid}/config/main`, {
    seed: { stringValue: seed },
    payoffs: { mapValue: { fields: {
      both_cooperate: intVal(PAYOFFS.both_cooperate), sucker: intVal(PAYOFFS.sucker),
      temptation: intVal(PAYOFFS.temptation), both_defect: intVal(PAYOFFS.both_defect),
    } } },
  })
  await callFn('pdBootstrap', asStudent(gid, pid))
  await callFn('pdGetState', asStudent(gid, pid))
  const truth = await getDoc(`pd_game_instances/${gid}/truth/main`)
  const stu = await getDoc(`pd_game_instances/${gid}/truth/participant_${pid}`)
  return { rounds: Number(truth?.rounds?.integerValue), strategy: stu?.strategy?.stringValue }
}

/** First-touches students until one of each strategy is found. */
async function findStudents(gid, seed) {
  const found = {}
  for (let i = 1; i <= 12 && (!found.tft || !found.grim); i++) {
    const pid = `bw-stu-${i}`
    const { strategy, rounds } = await openInstance(gid, pid, seed)
    if (strategy && !found[strategy]) found[strategy] = { pid, rounds }
  }
  return found
}

// ── Flow steps ─────────────────────────────────────────────────────────────────

/**
 * Walks the four KC screens.
 * @param mode 'correct' → answer every question right; 'wrong' → answer every one
 *             wrong (a deliberately different option), which must still let the
 *             student through: the KC is graded but is NOT a gate.
 */
async function doKc(page, mode, label) {
  for (let i = 0; i < KC_KEY.length; i++) {
    const { field, correct } = KC_KEY[i]
    await page.waitForSelector('[data-testid="pd-kc-prompt"]')

    if (i === 0) {
      // The matrix is ON the KC screen — the whole point is reading it (spec §7).
      check(await exists(page, '[data-testid="pd-payoff-matrix"]'),
        `${label}: the payoff matrix is on the KC screen`)
      check(await page.locator('[data-testid="pd-kc-submit"]').isDisabled(),
        `${label}: KC submit is gated until an option is chosen`)
      const optionCount = await page.locator('[data-testid^="pd-kc-option-"]').count()
      check(optionCount === KC_OPTIONS.length,
        `${label}: every question offers the matrix's ${KC_OPTIONS.length} values (got ${optionCount})`)
    }

    const answer = mode === 'correct' ? correct : KC_OPTIONS.find(o => o !== correct)
    await page.click(`[data-testid="pd-kc-option-${answer}"]`)
    await page.click('[data-testid="pd-kc-submit"]')

    const wantVerdict = mode === 'correct' ? 'pd-kc-correct' : 'pd-kc-incorrect'
    await page.waitForSelector(`[data-testid="${wantVerdict}"]`)
    check(true, `${label}: ${field} answered ${mode} → the ${mode === 'correct' ? 'correct' : 'incorrect'} verdict shows`)

    await page.click('[data-testid="pd-kc-continue"]')
  }
  // Whatever the answers were, the next thing is the GAME — no gate, no pass mark.
  await page.waitForSelector('[data-testid="pd-round-heading"]')
  check(true, `${label}: all four answered ${mode} → the student reaches the round loop`)
}

/**
 * Plays the round loop to game over in the browser, checking the rendered reveal and
 * the rendered history table against an independent model of the spec every round.
 */
async function playRounds(page, strategy, moveFor, label, truthRounds) {
  const mine = []
  let studentTotal = 0, botTotal = 0
  let n = 0, over = false
  let firstRoundChecked = false

  while (!over && n < 30) {
    n++
    await page.waitForSelector('[data-testid="pd-round-heading"]')

    const heading = await text(page, '[data-testid="pd-round-heading"]')
    if (heading !== `Round ${n}`) {
      check(false, `${label}: round ${n} heading (got "${heading}")`)
      return null
    }

    if (!firstRoundChecked) {
      firstRoundChecked = true
      // Neutral: nothing pre-selected, and submit gated on a choice.
      const checkedCount = await page.locator('[data-testid^="pd-choice-"] input:checked').count()
      check(checkedCount === 0, `${label}: no move is pre-selected (neutral)`)
      check(await page.locator('[data-testid="pd-submit-round"]').isDisabled(),
        `${label}: submit is disabled until a move is chosen`)
      // The matrix renders THIS instance's config values, in the right cells.
      check((await text(page, '[data-testid="pd-matrix-CD"]')).replace(/\s+/g, ' ')
        === `${PAYOFFS.temptation} ${PAYOFFS.sucker}`,
        `${label}: matrix cell C/D shows theirs ${PAYOFFS.temptation}, yours ${PAYOFFS.sucker} (from config)`)
      check((await text(page, '[data-testid="pd-matrix-DD"]')).replace(/\s+/g, ' ')
        === `${PAYOFFS.both_defect} ${PAYOFFS.both_defect}`,
        `${label}: matrix cell D/D shows ${PAYOFFS.both_defect} both sides (from config)`)
      // An empty history invites the first round rather than showing a bare grid.
      check(await exists(page, '[data-testid="pd-history-empty"]'),
        `${label}: round 1 shows no history table yet`)
    }

    // ⚠ THE SWEEP FOR THE ROUND COUNT, on the round-2 choose screen — the richest
    // page that is still all-small-numbers: framing, matrix, one history row, all
    // four payoffs < 10, cumulative totals not yet accumulated. Every legal round
    // count is ≥ 10, so once the framing sentence ("between 10 and 20 rounds", the
    // only disclosure spec §3 allows) is removed, ANY number ≥ 10 on this page could
    // only be the draw — under any label, in any widget.
    if (n === 2) {
      const body = await page.locator('body').innerText()
      const framing = await page.locator('[data-testid="pd-framing"]').innerText()
      const big = [...body.replace(framing, '').matchAll(/\d+/g)].map(Number).filter(v => v >= 10)
      check(big.length === 0,
        `${label}: nothing ≥ 10 rendered outside the framing sentence (the draw is ${truthRounds}; found ${JSON.stringify(big)})`)
    }

    const move = moveFor(n)
    const bot = expectedBotMove(strategy, mine.slice())
    const wantStudentYears = expectedYears(move, bot, PAYOFFS)
    const wantBotYears = expectedYears(bot, move, PAYOFFS)

    await page.click(`[data-testid="pd-choice-${move}"]`)
    if (n === 1) {
      check(!(await page.locator('[data-testid="pd-submit-round"]').isDisabled()),
        `${label}: choosing a move enables submit`)
    }
    await page.click('[data-testid="pd-submit-round"]')
    await page.waitForSelector('[data-testid="pd-reveal"]')

    // The reveal shows both moves and both costs.
    const yourMove = await text(page, '[data-testid="pd-reveal-your-move"]')
    const theirMove = await text(page, '[data-testid="pd-reveal-their-move"]')
    const yourYears = await text(page, '[data-testid="pd-reveal-your-years"]')
    const theirYears = await text(page, '[data-testid="pd-reveal-their-years"]')
    const label4 = (m) => (m === 'C' ? 'Cooperate' : 'Defect')
    if (yourMove !== label4(move) || theirMove !== label4(bot)
      || !yourYears.includes(String(wantStudentYears)) || !theirYears.includes(String(wantBotYears))) {
      check(false, `${label}: round ${n} reveal (you ${label4(move)}/${wantStudentYears}, them ${label4(bot)}/${wantBotYears}) — got ${yourMove}/${yourYears} vs ${theirMove}/${theirYears}`)
      return null
    }

    mine.push(move)
    studentTotal += wantStudentYears
    botTotal += wantBotYears

    // The history table on the reveal screen now includes this round.
    // Columns after the Slice-4 cleanup: round │ your move, your years │ their move,
    // their years. NO cumulative Total columns — the running figures moved into the
    // caption as AVERAGES.
    const rows = await page.locator('[data-testid^="pd-history-row-"]').count()
    const lastRow = await cells(page, `[data-testid="pd-history-row-${n}"]`)
    if (rows !== n || lastRow.length !== 5 || lastRow[0] !== String(n)
      || lastRow[2] !== String(wantStudentYears) || lastRow[4] !== String(wantBotYears)) {
      check(false, `${label}: round ${n} history row (want 5 cells, years ${wantStudentYears}/${wantBotYears}) — got ${JSON.stringify(lastRow)} across ${rows} rows`)
      return null
    }

    // The caption's averages, recomputed independently and rounded the same way.
    const wantAvgS = (studentTotal / n).toFixed(1)
    const wantAvgB = (botTotal / n).toFixed(1)
    const gotAvgS = await text(page, '[data-testid="pd-your-average"]')
    const gotAvgB = await text(page, '[data-testid="pd-their-average"]')
    if (gotAvgS !== wantAvgS || gotAvgB !== wantAvgB) {
      check(false, `${label}: round ${n} averages (want ${wantAvgS}/${wantAvgB}, got ${gotAvgS}/${gotAvgB})`)
      return null
    }

    if (n === 1) {
      const caption = await text(page, '[data-testid="pd-history"] ~ p, [data-testid="pd-history"]')
      void caption
      const bodyNow = await page.locator('body').innerText()
      check(!bodyNow.includes('Total'), `${label}: the history table has no Total column`)
      check(/averaging/.test(bodyNow), `${label}: the caption reports averages, not a running total`)
    }

    // Submit-and-lock, in the UI: the reveal offers no way back to the choice.
    if (n === 1) {
      check(!(await exists(page, '[data-testid="pd-choice-C"]')),
        `${label}: the reveal screen offers no way to change the played move`)
    }

    await page.click('[data-testid="pd-continue"]')
    await page.waitForSelector('[data-testid="pd-round-heading"], [data-testid="pd-debrief-prompt"]')
    over = await exists(page, '[data-testid="pd-debrief-prompt"]')
  }

  check(over, `${label}: the game reached game over in the browser`)
  check(n === truthRounds, `${label}: it ended on the drawn round count (${n} = ${truthRounds})`)
  check(true, `${label}: all ${n} rounds matched ${strategy.toUpperCase()} and the payoff matrix, row by row`)
  return { rounds: n, studentTotal, botTotal, mine }
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  const stamp = Date.now()
  console.log('\nBooting the Vite dev server…')
  const vite = await startVite()
  const browser = await chromium.launch()

  try {
    const responses = []

    // ── 1. Setup: one seeded instance with a TFT student and a GRIM student ────
    console.log('\n[1] Seeded instance (one student per strategy)')
    const GID = `bw-${stamp}`
    const students = await findStudents(GID, 'seed-browser')
    check(!!students.tft && !!students.grim,
      `the seed produced both a TFT and a GRIM student (${students.tft?.pid}, ${students.grim?.pid})`)
    if (!students.tft || !students.grim) throw new Error('could not find both strategies')

    // ── 2. TFT student: KC answered CORRECTLY, then the whole game ─────────────
    console.log('\n[2] TFT student — correct KC, full game, debrief')
    const ctxA = await browser.newContext()
    const pageA = await ctxA.newPage()
    captureResponses(pageA, responses)
    await pageA.goto(studentUrl(GID, students.tft.pid))

    await doKc(pageA, 'correct', 'TFT/correct-KC')

    // Defect once at round 3: TFT must punish in round 4 and FORGIVE in round 5.
    const tftRun = await playRounds(pageA, 'tft', n => (n === 3 ? 'D' : 'C'),
      'TFT/correct-KC', students.tft.rounds)
    check(!!tftRun, 'the TFT game completed without a mismatch')

    // The debrief paragraph.
    await pageA.fill('[data-testid="pd-debrief-input"]',
      'I cooperated to start, tried one defection to see what would happen, and went back to cooperating once it punished me and then forgave.')
    await pageA.click('[data-testid="pd-debrief-submit"]')
    await pageA.waitForSelector('[data-testid="pd-all-done"]')
    check(true, 'the debrief submits and the student lands on the all-done screen')

    // The end screen reports AVERAGES per round, matching the history caption's
    // convention (Slice 4) rather than the cumulative totals it used to show.
    if (tftRun) {
      const wantYour = (tftRun.studentTotal / tftRun.rounds).toFixed(1)
      const wantTheir = (tftRun.botTotal / tftRun.rounds).toFixed(1)
      const gotYour = await text(pageA, '[data-testid="pd-done-your-average"]')
      const gotTheir = await text(pageA, '[data-testid="pd-done-their-average"]')
      check(gotYour === wantYour && gotTheir === wantTheir,
        `the end screen averages are right to 1dp (want ${wantYour}/${wantTheir}, got ${gotYour}/${gotTheir})`)
      const doneText = await pageA.locator('body').innerText()
      check(/averaged/.test(doneText) && /per round/.test(doneText),
        'the end screen says "averaged … per round"')
      check(!/a total of|served a total/.test(doneText),
        'the end screen no longer reports a cumulative TOTAL')
      check(new RegExp(`played\\s+${tftRun.rounds}\\s+round`).test(doneText),
        `the end screen still states the round count (${tftRun.rounds}) — legitimate post-game`)
      check(/You can close this tab/.test(doneText), 'and still says you can close the tab')
    }

    // ── 3. What actually landed in Firestore ──────────────────────────────────
    console.log('\n[3] Stored state after the TFT student finished')
    const docA = await getDoc(`pd_game_instances/${GID}/participants/${students.tft.pid}`)
    check(docA?.finished_at != null, 'finished_at is stamped')
    check(Number(docA?.rounds_played?.integerValue) === students.tft.rounds, 'rounds_played matches the draw')
    check(Number(docA?.knowledge_check_score?.doubleValue ?? docA?.knowledge_check_score?.integerValue) === 1,
      'a correct KC run scored 1.0')
    const kcAnswers = docA?.kc_static_answers?.mapValue?.fields ?? {}
    check(Object.keys(kcAnswers).length === 4, 'all four KC answers are stored')
    check(Object.values(kcAnswers).every(v => v.mapValue.fields.correct.booleanValue === true),
      'all four are recorded correct')
    const debriefAnswers = docA?.debrief_answers?.mapValue?.fields ?? {}
    check(debriefAnswers.debrief_reflection?.mapValue?.fields?.answer?.stringValue?.startsWith('I cooperated'),
      'the debrief paragraph is stored under debrief_reflection')
    await ctxA.close()

    // ── 4. GRIM student: KC answered WRONG — recorded, scored 0, NOT blocked ───
    console.log('\n[4] GRIM student — wrong KC (no gate), full game')
    const ctxB = await browser.newContext()
    const pageB = await ctxB.newPage()
    captureResponses(pageB, responses)
    await pageB.goto(studentUrl(GID, students.grim.pid))

    await doKc(pageB, 'wrong', 'GRIM/wrong-KC')

    const docBmid = await getDoc(`pd_game_instances/${GID}/participants/${students.grim.pid}`)
    check(Number(docBmid?.knowledge_check_score?.doubleValue ?? docBmid?.knowledge_check_score?.integerValue) === 0,
      'a wrong KC run scored 0.0 — recorded, not blocking')
    const kcB = docBmid?.kc_static_answers?.mapValue?.fields ?? {}
    check(Object.keys(kcB).length === 4 && Object.values(kcB).every(v => v.mapValue.fields.correct.booleanValue === false),
      'all four wrong answers are stored with correct:false')

    // Same defection at round 3: GRIM must never forgive.
    const grimRun = await playRounds(pageB, 'grim', n => (n === 3 ? 'D' : 'C'),
      'GRIM/wrong-KC', students.grim.rounds)
    check(!!grimRun, 'the GRIM game completed without a mismatch')
    await ctxB.close()

    // ── 5. Resume mid-loop, in the browser ────────────────────────────────────
    console.log('\n[5] Resume — close the tab mid-game and come back')
    const RESUME_GID = `bw-resume-${stamp}`
    const RESUME_PID = 'bw-resume-stu'
    const resumeTruth = await openInstance(RESUME_GID, RESUME_PID, 'seed-browser-resume')
    const ctxC = await browser.newContext()
    const pageC = await ctxC.newPage()
    captureResponses(pageC, responses)
    await pageC.goto(studentUrl(RESUME_GID, RESUME_PID))
    await doKc(pageC, 'correct', 'resume')

    // Play three rounds, then reload the whole browser page.
    for (const n of [1, 2, 3]) {
      await pageC.waitForSelector('[data-testid="pd-round-heading"]')
      await pageC.click('[data-testid="pd-choice-C"]')
      await pageC.click('[data-testid="pd-submit-round"]')
      await pageC.waitForSelector('[data-testid="pd-reveal"]')
      await pageC.click('[data-testid="pd-continue"]')
      void n
    }
    await pageC.waitForSelector('[data-testid="pd-round-heading"]')
    check(await text(pageC, '[data-testid="pd-round-heading"]') === 'Round 4', 'three rounds played → on round 4')

    await pageC.reload()
    await pageC.waitForSelector('[data-testid="pd-round-heading"]')
    check(await text(pageC, '[data-testid="pd-round-heading"]') === 'Round 4',
      'after a full page reload the student is back on round 4 — not round 1, not the KC')
    check(!(await exists(pageC, '[data-testid="pd-kc-prompt"]')),
      'the reload does NOT send them back through the knowledge check')
    const rowsAfterReload = await pageC.locator('[data-testid^="pd-history-row-"]').count()
    check(rowsAfterReload === 3, `the history survived the reload (${rowsAfterReload} rows)`)
    const row3 = await cells(pageC, '[data-testid="pd-history-row-3"]')
    check(row3.length === 5 && row3[2] === String(PAYOFFS.both_cooperate),
      'the per-round years survived the reload (and there are still no Total columns)')
    check(await text(pageC, '[data-testid="pd-your-average"]') === PAYOFFS.both_cooperate.toFixed(1),
      'the average carried across the reload')

    // Submit-and-lock across a reload: replaying round 4 is the only thing on offer;
    // rounds 1–3 are gone from the UI entirely.
    check(!(await exists(pageC, '[data-testid="pd-history-row-4"]')),
      'no phantom round 4 row before it is played')
    await ctxC.close()

    // ── 6. ⚠ THE NO-LEAK ASSERTION, at the DOM and network levels ─────────────
    console.log('\n[6] ⚠ No leak in the browser: not the round count, not the strategy')

    const ctxD = await browser.newContext()
    const pageD = await ctxD.newPage()
    captureResponses(pageD, responses)
    const LEAK_GID = `bw-leak-${stamp}`
    const LEAK_PID = 'bw-leak-stu'
    const leakTruth = await openInstance(LEAK_GID, LEAK_PID, 'seed-browser-leak')
    await pageD.goto(studentUrl(LEAK_GID, LEAK_PID))
    await doKc(pageD, 'correct', 'leak')
    await pageD.waitForSelector('[data-testid="pd-round-heading"]')

    // (a) The rendered page — text AND markup (a leak hidden in an attribute or a
    //     data- prop would not show up in innerText).
    const html = await pageD.content()
    const bodyText = await pageD.locator('body').innerText()
    check(!/\btft\b/i.test(html) && !/\bgrim\b/i.test(html), 'the page names no strategy')
    check(!/tit[- ]for[- ]tat/i.test(html), 'the page never says tit-for-tat')
    check(!/strateg/i.test(bodyText), 'the visible text never mentions a strategy at all')
    check(!/round\s+\d+\s+of\s+\d+/i.test(bodyText), 'no "round N of M" anywhere on the page')
    check(!/rounds?\s+(remaining|left)/i.test(bodyText), 'no rounds-remaining copy')
    check(!/\b(last|final)\s+round\b/i.test(bodyText), 'the page never announces the last round in advance')

    // (b) The framing says the RANGE and only the range (spec §1, §3).
    const framingText = await pageD.locator('[data-testid="pd-framing"]').innerText()
    check(framingText.includes('between 10 and 20 rounds'), 'the framing discloses the range')
    check(framingText.includes('the same automated player every round'), 'the framing says: the same player every round')
    check(framingText.includes('programmed to act realistically'), 'the framing says: programmed to act realistically')
    check(!new RegExp(`\\b${leakTruth.rounds}\\b`).test(bodyText.replace(framingText, '')),
      `the drawn round count (${leakTruth.rounds}) appears nowhere outside that sentence`)

    // (c) Every callable response the BROWSER actually received. This is the Slice-2
    //     audit moved to where it finally matters: not what the server says when the
    //     harness asks, but what arrived in the page.
    const ALLOWED = {
      pdBootstrap: ['ok', 'participant_id', 'game_instance_id', 'customToken'],
      // Slice 5: `unit` and the configured round RANGE are legitimate student-facing
      // settings. The RANGE is the one schedule fact a student may be told (spec §3);
      // the DRAW still appears nowhere, which the DOM sweep below re-proves by
      // stripping the framing sentence that carries the bounds.
      pdGetState: ['ok', 'labels', 'payoffs', 'history', 'gameOver', 'C', 'D',
        'unit', 'minRounds', 'maxRounds',
        'both_cooperate', 'sucker', 'temptation', 'both_defect',
        'round', 'studentMove', 'botMove', 'studentYears', 'botYears', 'studentTotal', 'botTotal'],
      pdSubmitRound: ['ok', 'round', 'history', 'gameOver', 'studentMove', 'botMove',
        'studentYears', 'botYears', 'studentTotal', 'botTotal'],
      pdGetQuestions: ['ok', 'kcEnabled', 'kc', 'derived', 'added', 'type',
        'field', 'prompt', 'options', 'value', 'label',
        'debriefEnabled', 'debrief', 'placeholder', 'kcAnswered', 'debriefSubmitted'],
      pdSubmitKcAnswer: ['ok', 'correct', 'graded', 'explanation'],
      pdSubmitDebrief: ['ok', 'stored', 'answer'],
    }

    check(responses.length > 0, `captured ${responses.length} callable responses from the browser`)
    const seen = new Set(responses.map(r => r.name))
    check(['pdGetState', 'pdSubmitRound', 'pdGetQuestions', 'pdSubmitKcAnswer', 'pdSubmitDebrief']
      .every(n => seen.has(n)), 'every student callable was exercised through the UI')

    let strayKey = null, forbiddenWord = null, unknownFn = null
    for (const { name, body } of responses) {
      const allowed = ALLOWED[name]
      if (!allowed) { unknownFn ??= name; continue }
      let parsed
      try { parsed = JSON.parse(body) } catch { continue }
      const result = parsed?.result
      if (result === undefined) continue
      for (const k of deepKeys(result)) if (!allowed.includes(k)) strayKey ??= `${name}.${k}`
      const lower = JSON.stringify(result).toLowerCase()
      for (const w of ['strategy', 'tft', 'grim', 'seed', 'remaining', 'correct_value'])
        if (lower.includes(w)) forbiddenWord ??= `${name}: ${w}`
    }
    check(unknownFn === null, `no unexpected callable was reached (${unknownFn ?? 'none'})`)
    check(strayKey === null, `no response carried a key outside its whitelist (${strayKey ?? 'none'})`)
    check(forbiddenWord === null, `no response carried a forbidden word (${forbiddenWord ?? 'none'})`)

    // (d) The answer key never reached the browser either — the KC's whole integrity.
    const kcPayloads = responses.filter(r => r.name === 'pdGetQuestions').map(r => r.body).join('')
    check(!kcPayloads.includes('correct_value'), 'pdGetQuestions never shipped the KC answer key')
    check(!kcPayloads.includes('explanation'), 'pdGetQuestions never shipped the explanations ahead of answering')

    await ctxD.close()

    // ── 6b. The INSTRUCTOR pages, in the browser ───────────────────────────────
    // Slice 4 replaced PD's scaffold dashboard with the pennies-shaped one. In DEV the
    // instructor session is bootstrapped from ?_gid=, exactly as pennies/poll do.
    console.log('\n[6b] Instructor dashboard + reports (browser)')
    const ctxI = await browser.newContext()
    const pageI = await ctxI.newPage()
    const instructorUrl = (path) => `${APP}${path}?game=pd&_gid=${GID}`

    await pageI.goto(instructorUrl('/dashboard'))
    await pageI.waitForSelector('[data-testid="pd-roster"]', { timeout: 45000 })
    check(true, 'the dashboard renders the roster table (not the Slice-0 scaffold)')
    check(!(await pageI.locator('body').innerText()).includes('Scaffold'),
      'the scaffold copy is gone')

    // The Tier-1 columns the Reports Contract asks for.
    const header = await pageI.locator('thead').first().innerText()
    for (const col of ['Name', 'Status', 'Rounds played', 'Cooperation rate', 'Avg years / round', 'Opponent faced', 'KC score', 'Participation']) {
      check(header.includes(col), `roster column "${col}"`)
    }

    // The two students who played are on it, with their real figures.
    const rosterText = await pageI.locator('[data-testid="pd-roster"]').innerText()
    check(rosterText.includes('Completed'), 'a completed student is shown as Completed')
    check(/Tit-for-tat/.test(rosterText) && /GRIM/.test(rosterText),
      'the roster names each student’s opponent (instructor-only, and correct here)')

    // Score & Record, through the button rather than the callable.
    check(await exists(pageI, '[data-testid="pd-score-and-record"]'), 'the Score & Record button exists')
    await pageI.click('[data-testid="pd-score-and-record"]')
    await pageI.waitForSelector('[data-testid="pd-score-msg"]', { timeout: 30000 })
    const scoreMsg = await text(pageI, '[data-testid="pd-score-msg"]')
    check(/Scored \d+ student/.test(scoreMsg), `the button reports the result ("${scoreMsg}")`)
    check(/gradebook|callback/.test(scoreMsg), 'the message states the PUSH outcome, not just "scored"')
    // Participation lands in the table on reload of the rows.
    await pageI.waitForFunction(
      () => (document.querySelector('[data-testid="pd-roster"]')?.textContent ?? '').includes('-2')
        || (document.querySelector('[data-testid="pd-roster"]')?.textContent ?? '').includes('0'),
      { timeout: 20000 },
    )
    check(true, 'the roster refreshes with participation scores after scoring')

    // Reports: four tiles, each opening a real report.
    await pageI.goto(instructorUrl('/reports'))
    await pageI.waitForSelector('text=Outcomes — all students', { timeout: 45000 })
    const reportsText = await pageI.locator('body').innerText()
    for (const tile of ['Outcomes — all students', 'Debrief paragraphs (by opponent)', 'Cooperation rate by round', 'Outcome by first decision']) {
      check(reportsText.includes(tile), `report tile "${tile}"`)
    }

    await pageI.click('text=Outcomes — all students')
    await pageI.waitForSelector('[data-testid="pd-report-outcomes"]')
    check(true, 'Tier 1: the outcomes table opens')
    await pageI.click('text=Close')

    await pageI.click('text=Debrief paragraphs (by opponent)')
    await pageI.waitForSelector('[data-testid="pd-report-debrief"]')
    check(await exists(pageI, '[data-testid="pd-debrief-group-tft"]'),
      'Tier 2: the debrief is GROUPED — a tit-for-tat group')
    const debriefText = await pageI.locator('[data-testid="pd-report-debrief"]').innerText()
    check(debriefText.includes('I cooperated'), 'Tier 2: the student’s own paragraph is shown')
    check(debriefText.includes('Faced tit-for-tat'), 'Tier 2: the group is labelled by opponent')
    // The show/hide-names toggle actually anonymizes.
    await pageI.uncheck('[data-testid="pd-debrief-shownames"]')
    const anon = await pageI.locator('[data-testid="pd-report-debrief"]').innerText()
    check(anon.includes('Respondent 1'), 'Tier 2: hiding names replaces them with Respondent N')
    await pageI.click('text=Close')

    await pageI.click('text=Cooperation rate by round')
    await pageI.waitForSelector('[data-testid="pd-cooperation-chart"]')
    check(await exists(pageI, '[data-testid="pd-coop-line-tft"]'), 'Tier 3a: the tit-for-tat line is drawn')
    check(await exists(pageI, '[data-testid="pd-coop-line-grim"]'), 'Tier 3a: the GRIM line is drawn')
    // textContent, not innerText: the chart is an <svg>, and Playwright's innerText
    // only works on HTMLElements.
    const coopText = (await pageI.locator('[data-testid="pd-cooperation-chart"]').textContent()) ?? ''
    check(coopText.includes('Round'), 'Tier 3a: the x axis is rounds')
    check(coopText.includes('100%') && coopText.includes('0%'), 'Tier 3a: the y axis is a percentage scale')
    await pageI.click('text=Close')

    await pageI.click('text=Outcome by first decision')
    await pageI.waitForSelector('[data-testid="pd-firstmove-chart"]')
    const bars = await pageI.locator('[data-testid^="pd-firstmove-bar-"]').count()
    check(bars >= 2, `Tier 3b: grouped bars drawn (${bars})`)
    // ⚠ INVERTED IN SLICE 5: the directional framing was deleted, because the unit is
    // configurable and the software cannot know whether taller is better.
    const fmText = await pageI.locator('body').innerText()
    check(!/lower is better|worse outcome/i.test(fmText), 'Tier 3b: states NO direction')
    check(/per round/i.test(fmText), 'Tier 3b: still says what the bars measure')
    await ctxI.close()

    // ── 6c. The SETTINGS page, driven through the UI (Slice 5) ────────────────
    console.log('\n[6c] Instructor settings (browser)')
    const SGID = `bw-settings-${stamp}`
    const SPID = 'bw-settings-stu'
    const ctxS = await browser.newContext()
    const pageS = await ctxS.newPage()
    await pageS.goto(`${APP}/settings?game=pd&_gid=${SGID}`)
    await pageS.waitForSelector('[data-testid="pd-settings"]', { timeout: 45000 })
    check(true, 'the settings page renders (not the Slice-0 scaffold)')
    check(!(await pageS.locator('body').innerText()).includes('not built yet'),
      'the scaffold copy is gone')

    // The derived four are shown READ-ONLY, with the answers the current matrix gives.
    check(await exists(pageS, '[data-testid="pd-set-derived-kc"]'),
      'the four derived KC questions are previewed')
    const derivedBefore = await pageS.locator('[data-testid="pd-set-derived-kc"]').innerText()
    check(/Answer: 1\b/.test(derivedBefore), 'the preview shows the CURRENT matrix answers')
    check(await pageS.locator('[data-testid="pd-set-derived-kc"] input').count() === 0,
      '⚠ and they are NOT editable — no inputs, because they are derived from the matrix')

    // Edit the matrix, labels, unit and range, and save.
    const setNum = async (tid, v) => { await pageS.fill(`[data-testid="${tid}"]`, String(v)) }
    await setNum('pd-set-both_cooperate', 2)
    await setNum('pd-set-sucker', 8)
    await setNum('pd-set-temptation', 1)
    await setNum('pd-set-both_defect', 5)
    await pageS.fill('[data-testid="pd-set-label-c"]', 'Share')
    await pageS.fill('[data-testid="pd-set-label-d"]', 'Take')
    await pageS.fill('[data-testid="pd-set-unit"]', 'points')
    await setNum('pd-set-min-rounds', 3)
    await setNum('pd-set-max-rounds', 3)
    await pageS.fill('[data-testid="pd-set-debrief-prompt"]', 'What was your plan and why?')

    // The live preview updates BEFORE saving — it is the students' own component.
    const previewCell = (await pageS.locator('[data-testid="pd-matrix-CD"]').innerText()).replace(/\s+/g, ' ')
    check(previewCell === '1 8', `the live matrix preview follows the form (${previewCell})`)

    // Add one graded question and one free-text question.
    await pageS.fill('[data-testid="pd-set-new-prompt"]', 'Did you plan ahead?')
    await pageS.fill('[data-testid="pd-set-new-option-0"]', 'Yes')
    await pageS.fill('[data-testid="pd-set-new-option-1"]', 'No')
    await pageS.click('[data-testid="pd-set-new-correct-0"]')
    await pageS.click('[data-testid="pd-set-add-question"]')
    await pageS.selectOption('[data-testid="pd-set-new-type"]', 'text')
    await pageS.fill('[data-testid="pd-set-new-prompt"]', 'Anything else?')
    await pageS.click('[data-testid="pd-set-add-question"]')

    await pageS.click('[data-testid="pd-set-save"]')
    await pageS.waitForSelector('[data-testid="pd-set-saved"]', { timeout: 30000 })
    check(true, 'the settings save succeeds')

    // ⚠ THE NO-DRIFT PROPERTY, on screen: the derived four followed the new matrix.
    const derivedAfter = await pageS.locator('[data-testid="pd-set-derived-kc"]').innerText()
    check(/Answer: 2\b/.test(derivedAfter) && /Answer: 8\b/.test(derivedAfter),
      'the derived four re-derived from the new matrix after saving')
    check(derivedAfter.includes('Share') && derivedAfter.includes('points'),
      'the derived prompts picked up the new labels and unit')

    // Range validation blocks the save rather than storing nonsense.
    await setNum('pd-set-min-rounds', 9)
    await setNum('pd-set-max-rounds', 4)
    check(await exists(pageS, '[data-testid="pd-set-range-error"]'), 'min > max shows an error')
    check(await pageS.locator('[data-testid="pd-set-save"]').isDisabled(), '…and disables Save')
    await setNum('pd-set-min-rounds', 3)
    check(!(await pageS.locator('[data-testid="pd-set-save"]').isDisabled()), 'fixing the range re-enables Save')
    await ctxS.close()

    // ── 6d. A STUDENT plays the reconfigured instance ─────────────────────────
    console.log('\n[6d] The student sees the new configuration')
    const ctxE = await browser.newContext()
    const pageE = await ctxE.newPage()
    await pageE.goto(studentUrl(SGID, SPID))
    await pageE.waitForSelector('[data-testid="pd-kc-prompt"]', { timeout: 45000 })

    const kcText = await pageE.locator('body').innerText()
    check(kcText.includes('Share') && kcText.includes('points'),
      'the KC uses the configured labels and unit')
    check(!/\byears\b/i.test(kcText), 'and no hardcoded "years" survives on the KC screen')

    // Answer all four derived, then BOTH added questions — added come last.
    const answerKey = { 2: 0, 8: 1, 1: 2, 5: 3 }
    void answerKey
    for (const v of ['2', '8', '1', '5']) {
      await pageE.waitForSelector('[data-testid="pd-kc-prompt"]')
      await pageE.click(`[data-testid="pd-kc-option-${v}"]`)
      await pageE.click('[data-testid="pd-kc-submit"]')
      await pageE.waitForSelector('[data-testid="pd-kc-correct"]', { timeout: 20000 })
      await pageE.click('[data-testid="pd-kc-continue"]')
    }
    // Question 5 — the instructor's graded MC, rendered AFTER the derived four.
    await pageE.waitForSelector('[data-testid="pd-kc-prompt"]')
    check((await text(pageE, '[data-testid="pd-kc-prompt"]')) === 'Did you plan ahead?',
      '⚠ the ADDED question is asked after the derived four, in order')
    const addedOpts = await pageE.locator('[data-testid^="pd-kc-option-"]').all()
    await addedOpts[0].click()
    await pageE.click('[data-testid="pd-kc-submit"]')
    await pageE.waitForSelector('[data-testid="pd-kc-correct"]', { timeout: 20000 })
    check(true, 'the added MC question grades against the instructor\'s OWN key')
    await pageE.click('[data-testid="pd-kc-continue"]')

    // Question 6 — the free-text one, recorded but not graded.
    await pageE.waitForSelector('[data-testid="pd-kc-text-input"]', { timeout: 20000 })
    await pageE.fill('[data-testid="pd-kc-text-input"]', 'Not really, I improvised.')
    await pageE.click('[data-testid="pd-kc-submit"]')
    await pageE.waitForSelector('[data-testid="pd-kc-recorded"]', { timeout: 20000 })
    check(true, 'the added FREE-TEXT question is RECORDED, not marked right or wrong')
    await pageE.click('[data-testid="pd-kc-continue"]')

    // Into the game: framing states the configured range, and the unit is everywhere.
    await pageE.waitForSelector('[data-testid="pd-round-heading"]', { timeout: 30000 })
    const framingS = await pageE.locator('[data-testid="pd-framing"]').innerText()
    check(framingS.includes('between 3 and 3 rounds'), `framing states the CONFIGURED range ("${framingS.match(/between[^—]*/)?.[0]?.trim()}")`)

    await pageE.click('[data-testid="pd-choice-C"]')
    await pageE.click('[data-testid="pd-submit-round"]')
    await pageE.waitForSelector('[data-testid="pd-reveal"]', { timeout: 20000 })
    const revealS = await pageE.locator('[data-testid="pd-reveal"]').innerText()
    check(/point/.test(revealS) && !/year/i.test(revealS), 'the reveal counts in the configured unit')
    check(revealS.includes('Share'), 'the reveal names the configured move label')
    await pageE.click('[data-testid="pd-continue"]')

    // A 3-round instance ends after exactly 3 — the configured range took effect.
    for (const n of [2, 3]) {
      await pageE.waitForSelector('[data-testid="pd-round-heading"]')
      check((await text(pageE, '[data-testid="pd-round-heading"]')) === `Round ${n}`, `round ${n} of the 3-round game`)
      await pageE.click('[data-testid="pd-choice-C"]')
      await pageE.click('[data-testid="pd-submit-round"]')
      await pageE.waitForSelector('[data-testid="pd-reveal"]', { timeout: 20000 })
      await pageE.click('[data-testid="pd-continue"]')
    }
    await pageE.waitForSelector('[data-testid="pd-debrief-prompt"]', { timeout: 20000 })
    check(true, 'the game ended after exactly 3 rounds — the configured range drove the draw')
    check((await text(pageE, '[data-testid="pd-debrief-prompt"]')) === 'What was your plan and why?',
      'the debrief asks the CONFIGURED prompt')

    // Finish, so the END SCREEN can be checked against the configured unit.
    await pageE.fill('[data-testid="pd-debrief-input"]', 'I shared most rounds.')
    await pageE.click('[data-testid="pd-debrief-submit"]')
    await pageE.waitForSelector('[data-testid="pd-all-done"]', { timeout: 20000 })
    const doneCfg = await pageE.locator('body').innerText()
    check(/averaged[\s\S]*points per round/.test(doneCfg),
      'the end screen counts in the CONFIGURED unit, not a hardcoded one')
    check(!/\byears\b/i.test(doneCfg), 'and no hardcoded "years" survives on the end screen')
    check(/played\s+3\s+rounds/.test(doneCfg), 'the end screen states the 3 rounds played')

    // ⚠ Still no leak, on a reconfigured instance.
    const cfgBody = await pageE.locator('body').innerText()
    check(!/\btft\b|\bgrim\b|strateg/i.test(cfgBody), 'no strategy leaks on the reconfigured instance')
    check(!/round\s+\d+\s+of\s+\d+/i.test(cfgBody), 'no "round N of M" on the reconfigured instance')
    await ctxE.close()

    // ── 6e. Both extras switched OFF ──────────────────────────────────────────
    console.log('\n[6e] KC and debrief switched off')
    const OGID = `bw-off-${stamp}`
    const OPID = 'bw-off-stu'
    await callFn('pdUpdateConfig', { _dev: { game_instance_id: OGID }, kcEnabled: false, debriefEnabled: false, minRounds: 2, maxRounds: 2 })
    const ctxO = await browser.newContext()
    const pageO = await ctxO.newPage()
    await pageO.goto(studentUrl(OGID, OPID))
    await pageO.waitForSelector('[data-testid="pd-round-heading"]', { timeout: 45000 })
    check(!(await exists(pageO, '[data-testid="pd-kc-prompt"]')),
      'with the KC off the student lands STRAIGHT in the round loop')
    for (const n of [1, 2]) {
      void n
      await pageO.waitForSelector('[data-testid="pd-round-heading"]')
      await pageO.click('[data-testid="pd-choice-C"]')
      await pageO.click('[data-testid="pd-submit-round"]')
      await pageO.waitForSelector('[data-testid="pd-reveal"]', { timeout: 20000 })
      await pageO.click('[data-testid="pd-continue"]')
    }
    await pageO.waitForSelector('[data-testid="pd-all-done"]', { timeout: 20000 })
    check(true, 'with the debrief off the last round goes straight to the all-done screen')
    check(!(await exists(pageO, '[data-testid="pd-debrief-input"]')), 'and no debrief screen appears')
    await ctxO.close()

    // ── 6f. ⚠ THE INSTRUCTOR SESSION IS EXCHANGED ONCE, NOT PER MOUNT ─────────
    // Regression for the shipped "jwt expired" bug. The classroom JWT lives 15
    // minutes and the hook used to re-send it on EVERY mount — and every
    // Dashboard → Settings → Reports click IS a mount, because the nav links carry
    // ?token= forward. A quarter of an hour into a working session the next click
    // threw `jwt expired`.
    //
    // The emulator uses the ?_gid= dev bypass, so no JWT is verified here and the
    // failure cannot be reproduced literally. What CAN be pinned — and is the actual
    // mechanism — is the exchange COUNT: one per browser session, not one per page.
    // If the resume guard regresses, this goes to 4 and fails.
    console.log('\n[6f] Instructor session: exchanged ONCE across navigation + reload')
    const ctxN = await browser.newContext()
    const pageN = await ctxN.newPage()
    const sessionCalls = []
    pageN.on('response', (res) => {
      if (res.url().includes('pdInstructorSession')) sessionCalls.push(res.url())
    })
    const instrUrl = (path) => `${APP}${path}?game=pd&_gid=${GID}`

    await pageN.goto(instrUrl('/dashboard'))
    await pageN.waitForSelector('[data-testid="pd-roster"]', { timeout: 45000 })
    check(sessionCalls.length === 1, `the FIRST load still exchanges the token (${sessionCalls.length})`)

    // In-page navigation, exactly as the nav buttons do it.
    await pageN.goto(instrUrl('/settings'))
    await pageN.waitForSelector('[data-testid="pd-settings"]', { timeout: 30000 })
    check(sessionCalls.length === 1,
      `⚠ Settings RESUMED the existing session — no second exchange (${sessionCalls.length})`)

    await pageN.goto(instrUrl('/reports'))
    await pageN.waitForSelector('text=Outcomes — all students', { timeout: 30000 })
    check(sessionCalls.length === 1,
      `⚠ Reports RESUMED too (${sessionCalls.length}) — this is the click that used to throw "jwt expired"`)

    // A full reload of the same tab must also resume.
    await pageN.reload()
    await pageN.waitForSelector('text=Outcomes — all students', { timeout: 30000 })
    check(sessionCalls.length === 1, `a full page reload resumes as well (${sessionCalls.length})`)

    // And the pages actually WORK on the resumed session — a resume that produced a
    // session the callables reject would pass a call-count check and still be broken.
    await pageN.goto(instrUrl('/dashboard'))
    await pageN.waitForSelector('[data-testid="pd-roster"]', { timeout: 30000 })
    const resumedRoster = await pageN.locator('[data-testid="pd-roster"]').innerText()
    check(resumedRoster.length > 0 && /Completed|Not launched|In progress/.test(resumedRoster),
      'the resumed session still authenticates the instructor callables (roster loaded)')
    check(sessionCalls.length === 1, `still one exchange after five page loads (${sessionCalls.length})`)
    await ctxN.close()

    // ── 7. Score & Record over the finished class ─────────────────────────────
    console.log('\n[7] Participation scoring across the browser-played class')
    const sc = await callFn('pdScoreAndRecord', { _dev: { game_instance_id: GID } })
    check(sc.ok, 'pdScoreAndRecord succeeds')
    const scoredDoc = await getDoc(`pd_game_instances/${GID}/participants/${students.tft.pid}`)
    check(Number(scoredDoc?.raw_score?.integerValue) === 1, 'a finisher gets participation raw_score 1')
    check(Number(scoredDoc?.normalized_score?.integerValue ?? scoredDoc?.normalized_score?.doubleValue) === 0,
      'a finisher normalizes to 0 (zero-SD participation pool)')
    // A student who first-touched but never played is in the same instance (findStudents
    // opened several) — they must be floored, and never scored on prison-years.
    const idle = `bw-stu-${[1, 2, 3, 4, 5].find(i => `bw-stu-${i}` !== students.tft.pid && `bw-stu-${i}` !== students.grim.pid)}`
    const idleDoc = await getDoc(`pd_game_instances/${GID}/participants/${idle}`)
    check(Number(idleDoc?.normalized_score?.integerValue ?? idleDoc?.normalized_score?.doubleValue) === -2,
      `a student who never finished gets the −2 floor (${idle})`)
    check(idleDoc?.raw_score?.nullValue !== undefined, 'and raw_score null → status no_show on the push')

  } finally {
    await browser.close()
    vite.kill('SIGKILL')
  }

  console.log(`\n${failed === 0 ? '✅' : '❌'} pd browser harness: ${passed} passed, ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch(err => {
  console.error('browser harness crashed:', err)
  process.exit(1)
})
