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
    const rows = await page.locator('[data-testid^="pd-history-row-"]').count()
    const lastRow = await cells(page, `[data-testid="pd-history-row-${n}"]`)
    if (rows !== n || lastRow[0] !== String(n)
      || lastRow[2] !== String(wantStudentYears) || lastRow[3] !== String(studentTotal)
      || lastRow[5] !== String(wantBotYears) || lastRow[6] !== String(botTotal)) {
      check(false, `${label}: round ${n} history row (want years ${wantStudentYears}/${wantBotYears}, totals ${studentTotal}/${botTotal}) — got ${JSON.stringify(lastRow)} across ${rows} rows`)
      return null
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
    check(row3[3] === String(PAYOFFS.both_cooperate * 3),
      'the cumulative total carried across the reload')

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
      pdGetState: ['ok', 'labels', 'payoffs', 'history', 'gameOver', 'C', 'D',
        'both_cooperate', 'sucker', 'temptation', 'both_defect',
        'round', 'studentMove', 'botMove', 'studentYears', 'botYears', 'studentTotal', 'botTotal'],
      pdSubmitRound: ['ok', 'round', 'history', 'gameOver', 'studentMove', 'botMove',
        'studentYears', 'botYears', 'studentTotal', 'botTotal'],
      pdGetQuestions: ['ok', 'kc', 'field', 'prompt', 'options', 'value', 'label',
        'debrief', 'placeholder', 'kcAnswered', 'debriefSubmitted'],
      pdSubmitKcAnswer: ['ok', 'correct', 'explanation'],
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
