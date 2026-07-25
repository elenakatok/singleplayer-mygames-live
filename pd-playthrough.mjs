// ═══════════════════════════════════════════════════════════════════════════════
// Repeated Prisoner's Dilemma — SLICE 0 (SCAFFOLD) emulator harness. Drives the
// onCall/onRequest endpoints over HTTP (pennies/poll style; no browser).
//
// Slice 0 has no game logic, so this covers exactly what the scaffold claims:
// the health probe, the student launch (pdBootstrap), the pd_ collection prefix
// landing where it should, cross-GAME isolation against pennies, the instructor
// session, and that the pd student route is present in the shipped bundle.
//
// Later slices extend this file with the round loop, the compute step, the KC,
// and Score & Record.
//
// Run (build both first):
//   cd functions && npm run build && cd ../frontend && npm run build && cd ..
//   firebase emulators:exec --only functions,firestore,auth --project demo-singleplayer \
//     --config firebase.json "node pd-playthrough.mjs"
// ═══════════════════════════════════════════════════════════════════════════════

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PROJECT = 'demo-singleplayer'
const FUNCTIONS = `http://127.0.0.1:5010/${PROJECT}/us-central1`
const FIRESTORE = `http://127.0.0.1:8090/v1/projects/${PROJECT}/databases/(default)/documents`
const ROOT = path.dirname(fileURLToPath(import.meta.url))

let passed = 0, failed = 0
const check = (cond, label) => {
  if (cond) { passed++; console.log(`  ✓ ${label}`) }
  else { failed++; console.error(`  ✗ ${label}`) }
}

async function callFn(name, data) {
  const res = await fetch(`${FUNCTIONS}/${name}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data }),
  })
  let body = null
  try { body = await res.json() } catch { /* ignore */ }
  if (res.ok && body && 'result' in body) return { ok: true, result: body.result }
  return { ok: false, error: body?.error?.message ?? `http ${res.status}`, status: body?.error?.status }
}

/** GETs an onRequest health probe (not a callable — plain JSON, no envelope). */
async function getJson(name) {
  const res = await fetch(`${FUNCTIONS}/${name}`)
  try { return { status: res.status, body: await res.json() } } catch { return { status: res.status, body: null } }
}

/** Reads one document straight out of the Firestore emulator (REST). Returns the
 *  raw field map, or null on 404. Used to assert WHICH collection a write landed in —
 *  Slice 0 has no read callable to ask instead. */
async function getDoc(docPath) {
  const res = await fetch(`${FIRESTORE}/${docPath}`, { headers: { Authorization: 'Bearer owner' } })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`firestore GET ${docPath} → ${res.status}`)
  const body = await res.json()
  return body.fields ?? {}
}

const asStudent = (gid, pid, extra = {}) => ({ _test: { participant_id: pid, game_instance_id: gid }, ...extra })
const asDev = (gid) => ({ _dev: { game_instance_id: gid } })

async function main() {
  const stamp = Date.now()

  // ── 1. Health probes ────────────────────────────────────────────────────────
  // pd's own probe, plus the two existing games: adding a third game to the shared
  // index.ts must not disturb the functions already deployed alongside it.
  console.log('\n[1] Health probes')
  const pdH = await getJson('pdHealth')
  check(pdH.status === 200 && pdH.body?.ok === true, 'pdHealth responds 200 ok')
  check(pdH.body?.game === 'pd', 'pdHealth identifies itself as game "pd"')

  const penH = await getJson('penniesHealth')
  const polH = await getJson('pollHealth')
  check(penH.body?.game === 'pennies', 'penniesHealth still reports "pennies" (untouched)')
  check(polH.body?.game === 'poll', 'pollHealth still reports "poll" (untouched)')

  // ── 2. Student launch ───────────────────────────────────────────────────────
  console.log('\n[2] Student launch (pdBootstrap)')
  const GID = `pd-${stamp}`
  const PID = 'pd-stu-a'

  const boot = await callFn('pdBootstrap', asStudent(GID, PID))
  check(boot.ok, 'pdBootstrap succeeds')
  check(boot.result?.participant_id === PID, 'returns the participant_id')
  check(boot.result?.game_instance_id === GID, 'returns the game_instance_id')
  check(typeof boot.result?.customToken === 'string' && boot.result.customToken.length > 0,
    'mints a Firebase custom token (the session the student route needs)')

  // Relaunching is the normal case (student closes the tab and comes back).
  const boot2 = await callFn('pdBootstrap', asStudent(GID, PID))
  check(boot2.ok && boot2.result?.participant_id === PID, 'relaunch is idempotent, not an error')

  // A launch with no token and no _test is rejected.
  const bootBad = await callFn('pdBootstrap', {})
  check(!bootBad.ok, 'pdBootstrap without a token is rejected')

  // ── 3. Collection prefix + cross-GAME isolation ─────────────────────────────
  // The whole family separates games by prefix, so this is the load-bearing check:
  // the write must land under pd_game_instances and NOWHERE else.
  console.log('\n[3] pd_ collection prefix + cross-game isolation')
  const pdDoc = await getDoc(`pd_game_instances/${GID}/participants/${PID}`)
  check(pdDoc !== null, 'participant doc exists at pd_game_instances/{iid}/participants/{pid}')
  check(pdDoc?.launched_at != null, 'launch stamped launched_at')

  // The SAME student id and the SAME instance id in pennies must be a DIFFERENT doc
  // in a different prefixed collection — never a shared one.
  await callFn('penniesBootstrap', asStudent(GID, PID))
  const penDoc = await getDoc(`pennies_game_instances/${GID}/participants/${PID}`)
  check(penDoc !== null, 'the same ids under pennies create a SEPARATE pennies_ doc')
  const pdStillThere = await getDoc(`pd_game_instances/${GID}/participants/${PID}`)
  check(pdStillThere !== null, 'the pd doc is untouched by the pennies launch')

  // Slice 0 writes no game state at all — no strategy, no rounds, no scores yet.
  const scaffoldOnly = ['estimate', 'bid', 'submitted_at', 'strategy', 'rounds', 'raw_score']
  check(scaffoldOnly.every(f => pdStillThere?.[f] === undefined),
    'pd participant doc carries identity only (no game state in Slice 0)')

  // ── 4. Instructor session ───────────────────────────────────────────────────
  console.log('\n[4] Instructor session (pdInstructorSession)')
  const sess = await callFn('pdInstructorSession', asDev(GID))
  check(sess.ok, 'pdInstructorSession succeeds')
  check(typeof sess.result?.customToken === 'string' && sess.result.customToken.length > 0,
    'mints an instructor custom token (the dashboard/settings/reports shell needs it)')

  const sessBad = await callFn('pdInstructorSession', {})
  check(!sessBad.ok, 'pdInstructorSession without a token is rejected')

  // ── 5. The pd student route ships in the bundle ─────────────────────────────
  // One Vite bundle serves every game and picks by hostname, so "the pd route is
  // built and shipped" is what can be asserted here. This is a BUILD-ARTIFACT check,
  // not a DOM render — the repo has no jsdom/testing-library, and Slice 0 does not
  // add one. `npm run build` in frontend/ must have run first.
  console.log('\n[5] pd route present in the shipped bundle')
  const distDir = path.join(ROOT, 'frontend', 'dist', 'assets')
  if (!fs.existsSync(distDir)) {
    check(false, `frontend/dist/assets missing — run \`npm run build\` in frontend/ first`)
  } else {
    const js = fs.readdirSync(distDir).filter(f => f.endsWith('.js'))
      .map(f => fs.readFileSync(path.join(distDir, f), 'utf8')).join('')
    check(js.includes('Repeated Prisoner'), 'bundle contains the pd student shell')
    check(js.includes('pdBootstrap'), 'bundle wires pdBootstrap')
    check(js.includes('pdInstructorSession'), 'bundle wires pdInstructorSession')
    check(js.includes('Jar of Pennies') && js.includes('pollBootstrap'),
      'pennies + poll are still in the same bundle (shared artifact intact)')
  }

  console.log(`\n${failed === 0 ? '✅' : '❌'} pd harness: ${passed} passed, ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch(err => {
  console.error('harness crashed:', err)
  process.exit(1)
})
