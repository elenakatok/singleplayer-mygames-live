// ═══════════════════════════════════════════════════════════════════════════════
// REPRODUCTION — the STUDENT "jwt expired" screen, mid-game, on refresh.
//
// ⚠ THIS SCRIPT DEMONSTRATES AN OPEN BUG. It is NOT part of the harness gate, because
// it currently FAILS on purpose: the fix needs an architectural decision that is
// Elena's to make (see "THE FIX OPTIONS" below). When that lands, this becomes a
// harness section verbatim.
//
// Run:
//   firebase emulators:exec --only functions,firestore,auth --project demo-singleplayer \
//     --config firebase.json "node pd-student-session-repro.mjs"
//
// ── WHAT ELENA SAW ─────────────────────────────────────────────────────────────
// Played several PD rounds, left it past 15 minutes, hit REFRESH, and got a STUDENT
// screen reading "jwt expired / ← Return to classroom" — losing access mid-game.
//
// ── WHY IT IS NOT THE BUG THAT WAS ALREADY FIXED ───────────────────────────────
// The student hook (game-ui useStudentSession) has ALWAYS had a resume guard, and a
// student ON THEIR OWN resumes correctly however stale their token is — case B below
// proves it, landing back on the right round with history intact.
//
// ── THE ACTUAL CAUSE: SESSION CLOBBERING ON A SHARED ORIGIN ────────────────────
// One origin serves every page of the game: pd.mygames.live is both the student route
// and /dashboard. Firebase's default browserLocalPersistence keeps exactly ONE signed-in
// user per origin, per app instance. So when the instructor dashboard is open in the
// same browser — which it always is while Elena is working — the two sessions collide:
//
//   1. the student signs in            → localStorage holds uid = <participant_id>
//   2. the instructor page loads, RESTORES that student, sees a uid mismatch against
//      instructor_<gid>, and calls signOut() → the student's session is destroyed
//   3. the student refreshes           → no session, so the resume guard cannot fire
//   4. it falls back to exchanging the launch JWT, now >15 min old → "jwt expired"
//
// Case C below reproduces exactly that, verbatim screen included.
//
// ── WHAT DOES NOT FIX IT ───────────────────────────────────────────────────────
// Moving the INSTRUCTOR to per-tab sessionStorage — tried, measured, reverted. It
// fails whether setPersistence is called before or after the session is read, because
// two different Firebase users cannot coexist in one app instance on one origin at
// all; switching persistence migrates or clears the existing user either way. It also
// costs instructor multi-tab resume for no benefit.
//
// ── THE FIX OPTIONS (Elena's call — all exceed one game's blast radius) ────────
//   A. SEPARATE FIREBASE APP FOR INSTRUCTOR PAGES — initializeApp(config, 'instructor')
//      gives instructor auth its own persistence namespace, so it can never see or
//      clear a student's session. The complete fix. Cost: instructor callables must go
//      through a functions instance bound to that app, which touches the api.ts of all
//      three single-player games.
//   B. STUDENTS ALWAYS PER-TAB — a one-line change in game-ui's useStudentSession
//      (drop the ?_session=tab gate). Cheap, but it is a SHARED PACKAGE change, and it
//      means a student who reopens the game in a new tab must re-launch.
//   C. STUDENT HOOK STOPS SIGNING OUT ON MISMATCH — also game-ui, and it only narrows
//      the window rather than closing it.
//
// Recommended: A. It is the only one that actually isolates the two audiences, and it
// leaves the shared package alone.
// ═══════════════════════════════════════════════════════════════════════════════

import { chromium } from 'playwright'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const PROJECT = 'demo-singleplayer'
const VITE_PORT = 5202
const APP = `http://localhost:${VITE_PORT}`
const GID = `repro-${Date.now()}`

let passed = 0, failed = 0
const check = (cond, label) => {
  if (cond) { passed++; console.log(`  ✓ ${label}`) }
  else { failed++; console.error(`  ✗ ${label}`) }
}

// Real classroom JWTs. verifyClassroomToken checks the baked-in PUBLIC key, which works
// identically in the emulator — so a genuine, and a genuinely EXPIRED, token can be
// minted from the local private key. The harness's usual ?_pid/_gid dev bypass uses
// inMemoryPersistence and cannot exercise any of this.
const require_ = createRequire(import.meta.url)
const jwtLib = require_(path.join(ROOT, 'functions', 'node_modules', 'jsonwebtoken'))
const KEY = fs.readFileSync(path.resolve(ROOT, '../../classroom/scripts/game-jwt-private.pem'), 'utf8')

function studentToken(pid, ageSeconds = 0) {
  const now = Math.floor(Date.now() / 1000) - ageSeconds
  return jwtLib.sign({
    iss: 'classroom.mygames.live', sub: pid, iat: now, exp: now + 900,
    participant_id: pid, name: 'Repro Student', course_id: 'c1', session_id: 's1',
    game_instance_id: GID, game_config_id: null, role: 'student',
    classroom_callback_url: 'https://classroom.mygames.live/api/game-results',
    callback_secret_id: 'pd_v1',
  }, KEY, { algorithm: 'RS256', keyid: 'classroom-v1' })
}

async function startVite() {
  const child = spawn('npx', ['vite', '--port', String(VITE_PORT), '--strictPort', '--host', '127.0.0.1'], {
    cwd: path.join(ROOT, 'frontend'), stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env,
      VITE_FIREBASE_API_KEY: 'demo-key', VITE_FIREBASE_AUTH_DOMAIN: 'localhost',
      VITE_FIREBASE_PROJECT_ID: PROJECT, VITE_FIREBASE_STORAGE_BUCKET: `${PROJECT}.appspot.com`,
      VITE_FIREBASE_MESSAGING_SENDER_ID: '0', VITE_FIREBASE_APP_ID: 'demo-app' },
  })
  const deadline = Date.now() + 60000
  while (Date.now() < deadline) {
    try { if ((await fetch(APP)).ok) return child } catch { /* not up */ }
    await new Promise(r => setTimeout(r, 250))
  }
  child.kill('SIGKILL'); throw new Error('vite did not start')
}

const exists = async (p, s) => (await p.locator(s).count()) > 0
const text = async (p, s) => (await p.locator(s).first().innerText()).trim()

/** Wait for a SETTLED outcome — either back in the game, or the failsafe screen.
 *  Sampling before this resolves catches the "Loading…" frame and reports nonsense. */
async function settled(page) {
  await page.waitForFunction(() => {
    const b = document.body?.innerText ?? ''
    return !!document.querySelector('[data-testid="pd-round-heading"]')
      || !!document.querySelector('[data-testid="pd-debrief-prompt"]')
      || /jwt expired|Return to my classroom|Return to classroom/i.test(b)
  }, null, { timeout: 45000 })
}

/** KC (answers do not matter) then `rounds` rounds. */
async function playInto(page, rounds) {
  while (await exists(page, '[data-testid="pd-kc-prompt"]')) {
    const opts = await page.locator('[data-testid^="pd-kc-option-"]').all()
    await opts[0].click()
    await page.click('[data-testid="pd-kc-submit"]')
    await page.waitForSelector('[data-testid="pd-kc-correct"], [data-testid="pd-kc-incorrect"]', { timeout: 20000 })
    await page.click('[data-testid="pd-kc-continue"]')
    await page.waitForSelector('[data-testid="pd-kc-prompt"], [data-testid="pd-round-heading"]', { timeout: 20000 })
  }
  for (let i = 0; i < rounds; i++) {
    await page.waitForSelector('[data-testid="pd-round-heading"]', { timeout: 20000 })
    await page.click('[data-testid="pd-choice-C"]')
    await page.click('[data-testid="pd-submit-round"]')
    await page.waitForSelector('[data-testid="pd-reveal"]', { timeout: 20000 })
    await page.click('[data-testid="pd-continue"]')
  }
  await page.waitForSelector('[data-testid="pd-round-heading"], [data-testid="pd-debrief-prompt"]', { timeout: 20000 })
}

const vite = await startVite()
const browser = await chromium.launch()

try {
  // ── B. CONTROL: a student ALONE resumes fine, however stale the token ────────
  console.log('\n[B] Student alone — refresh with an EXPIRED token')
  const ctxB = await browser.newContext()
  const pageB = await ctxB.newPage()
  const PID_B = 'repro-alone'
  await pageB.goto(`${APP}/?game=pd&token=${studentToken(PID_B, 0)}`, { waitUntil: 'domcontentloaded' })
  await pageB.waitForSelector('[data-testid="pd-kc-prompt"], [data-testid="pd-round-heading"]', { timeout: 45000 })
  await playInto(pageB, 2)
  check(await text(pageB, '[data-testid="pd-round-heading"]') === 'Round 3', 'played two rounds')

  await pageB.goto(`${APP}/?game=pd&token=${studentToken(PID_B, 1000)}`, { waitUntil: 'domcontentloaded' })
  await settled(pageB)
  const bodyB = await pageB.locator('body').innerText()
  check(!/jwt expired/i.test(bodyB), 'no "jwt expired" — the resume guard works when the student is alone')
  check(await text(pageB, '[data-testid="pd-round-heading"]') === 'Round 3', 'resumed at the correct round')
  await ctxB.close()

  // ── C. THE BUG: the same refresh, with the instructor dashboard open ─────────
  console.log('\n[C] Student + instructor dashboard in ONE browser — the reported bug')
  const ctxC = await browser.newContext()
  const pageC = await ctxC.newPage()
  const PID_C = 'repro-clobbered'
  await pageC.goto(`${APP}/?game=pd&token=${studentToken(PID_C, 0)}`, { waitUntil: 'domcontentloaded' })
  await pageC.waitForSelector('[data-testid="pd-kc-prompt"], [data-testid="pd-round-heading"]', { timeout: 45000 })
  await playInto(pageC, 2)
  check(await text(pageC, '[data-testid="pd-round-heading"]') === 'Round 3', 'played two rounds')

  const pageCI = await ctxC.newPage()
  await pageCI.goto(`${APP}/dashboard?game=pd&_gid=${GID}`)
  await pageCI.waitForSelector('[data-testid="pd-roster"]', { timeout: 45000 })
  console.log('  · the instructor dashboard has now signed in on the same origin')

  await pageC.goto(`${APP}/?game=pd&token=${studentToken(PID_C, 1000)}`, { waitUntil: 'domcontentloaded' })
  await settled(pageC)
  const bodyC = await pageC.locator('body').innerText()
  console.log(`  · student screen now reads: "${bodyC.replace(/\n/g, ' | ').slice(0, 90)}"`)
  check(!/jwt expired/i.test(bodyC), 'EXPECTED TO FAIL TODAY — student sees no "jwt expired"')
  check(await exists(pageC, '[data-testid="pd-round-heading"]'), 'EXPECTED TO FAIL TODAY — student is back in the game')
  await ctxC.close()
} finally {
  await browser.close()
  vite.kill('SIGKILL')
}

console.log(`\n${failed === 0 ? '✅ FIXED' : '❌ REPRODUCED'} — ${passed} passed, ${failed} failed`)
console.log(failed === 0
  ? 'The clobbering bug is gone; fold case C into pd-playwright.mjs as a harness section.'
  : 'Case C failing is the open bug. Case B passing shows the student guard itself is sound.')
process.exit(0)
