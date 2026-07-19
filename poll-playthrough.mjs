// ═══════════════════════════════════════════════════════════════════════════════
// Poll — end-to-end emulator harness. Drives the onCall callables over HTTP.
// Covers: config with 3 defaults + authored questions; a full end-to-end answer;
// RESUME (answer Q1, return, land on Q2); server-side per-question IDEMPOTENCY;
// hidden questions not served + no report tile; an authored mc renders a pie
// (report has slices) with no extra work; roster sync populates non-responders and
// writes NO grade — and its classroom handshake sends a Bearer the endpoint validates.
//
// ⚠ The roster endpoint here is a LOCAL mock that VALIDATES the Bearer (unlike pennies'
// blind mock), so it proves pollSyncRoster's CLIENT handshake. The REAL classroom
// getCourseRoster path for poll is BLOCKED on classroom-side wiring — see the report's
// "classroom secret" flag; it is NOT exercised here.
//
// Run: firebase emulators:exec --only functions,firestore,auth --project demo-singleplayer \
//        --config firebase.json "node poll-playthrough.mjs"   (build functions first)
// ═══════════════════════════════════════════════════════════════════════════════

import http from 'node:http'

const PROJECT = 'demo-singleplayer'
const FUNCTIONS = `http://127.0.0.1:5010/${PROJECT}/us-central1`

let passed = 0, failed = 0
const check = (cond, label) => {
  if (cond) { passed++; console.log(`  ✓ ${label}`) }
  else { failed++; console.error(`  ✗ ${label}`) }
}

async function callFn(name, data) {
  const res = await fetch(`${FUNCTIONS}/${name}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data }),
  })
  let body = null
  try { body = await res.json() } catch { /* ignore */ }
  if (res.ok && body && 'result' in body) return { ok: true, result: body.result }
  return { ok: false, error: body?.error?.message ?? `http ${res.status}`, status: body?.error?.status }
}

const asStudent = (gid, pid, extra = {}) => ({ _test: { participant_id: pid, game_instance_id: gid }, ...extra })
const asDev = (gid) => ({ _dev: { game_instance_id: gid } })

// Mock classroom getCourseRoster that VALIDATES the Bearer secret.
const ROSTER_SECRET = 'poll-secret'
let currentRoster = []
const rosterServer = http.createServer((req, res) => {
  const auth = req.headers.authorization ?? ''
  let raw = ''
  req.on('data', c => (raw += c))
  req.on('end', () => {
    if (auth !== `Bearer ${ROSTER_SECRET}`) {
      res.writeHead(403, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Invalid callback secret.' }))
      return
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true, participants: currentRoster }))
  })
})
await new Promise(r => rosterServer.listen(0, r))
const ROSTER_URL = `http://127.0.0.1:${rosterServer.address().port}/roster`

async function main() {
  const stamp = Date.now()
  const GID = `poll-${stamp}`

  // ── Scenario 1 — configure (3 defaults visible + authored mc + authored HIDDEN text) ──
  console.log('\n[1] Configure + full answer + hidden not served')
  const cfg = await callFn('pollGetConfig', asDev(GID))
  check(cfg.ok && cfg.result.questions.length === 3, `pollGetConfig returns 3 shipped defaults (got ${cfg.result?.questions?.length})`)
  check(cfg.result.questions.every(q => q.visible === false), 'all defaults ship HIDDEN')

  const questions = cfg.result.questions.map(q => ({ ...q, visible: true }))
  questions.push({ id: 'auth_mc', type: 'mc', prompt: 'Which deal type interests you most?', visible: true, order: 10, system: false,
    options: [{ value: 'ma', label: 'M&A' }, { value: 'jv', label: 'Joint venture' }, { value: 'lic', label: 'Licensing' }] })
  questions.push({ id: 'auth_hidden', type: 'text', prompt: 'A hidden question', visible: false, order: 11, system: false })
  const upd = await callFn('pollUpdateConfig', { ...asDev(GID), questions })
  check(upd.ok, 'pollUpdateConfig saved (defaults visible + authored mc + hidden text)')

  await callFn('pollBootstrap', { _test: { participant_id: 's1', game_instance_id: GID } })
  const q1 = await callFn('pollGetQuestions', asStudent(GID, 's1'))
  const visible = q1.result.questions
  check(visible.length === 4, `getQuestions returns 4 VISIBLE questions (got ${visible.length})`)
  check(!visible.some(q => q.id === 'auth_hidden'), 'the HIDDEN question is NOT served to the student')
  check(q1.result.answered.length === 0, 's1 has answered nothing yet')

  for (const q of visible) {
    const value = q.type === 'mc' ? q.options[0].value : `s1's answer to ${q.id}`
    const r = await callFn('pollSubmitAnswer', asStudent(GID, 's1', { question_id: q.id, value }))
    check(r.ok && r.result.stored === false, `s1 answered ${q.id}`)
  }
  const q1done = await callFn('pollGetQuestions', asStudent(GID, 's1'))
  check(q1done.result.answered.length === 4, 's1 now shows all 4 answered (→ confirmation)')

  // ── Scenario 2 — RESUME ─────────────────────────────────────────────────────
  console.log('\n[2] Resume — answer Q1, return, land on Q2')
  await callFn('pollBootstrap', { _test: { participant_id: 's2', game_instance_id: GID } })
  const first = visible[0], second = visible[1]
  await callFn('pollSubmitAnswer', asStudent(GID, 's2', { question_id: first.id, value: first.type === 'mc' ? first.options[0].value : 's2 first' }))
  const q2 = await callFn('pollGetQuestions', asStudent(GID, 's2'))
  const answeredSet = new Set(q2.result.answered)
  const resumeIdx = q2.result.questions.findIndex(q => !answeredSet.has(q.id))
  check(q2.result.answered.length === 1 && q2.result.answered[0] === first.id, 's2 has answered exactly Q1')
  check(resumeIdx === 1 && q2.result.questions[resumeIdx].id === second.id, `RESUME lands on Q2 (${second.id})`)

  // ── Scenario 3 — server-side IDEMPOTENCY ────────────────────────────────────
  console.log('\n[3] Idempotency — re-answering Q1 is discarded')
  const original = first.type === 'mc' ? first.options[0].value : 's2 first'
  const dupValue = first.type === 'mc' ? first.options[1].value : 's2 CHANGED'
  const dup = await callFn('pollSubmitAnswer', asStudent(GID, 's2', { question_id: first.id, value: dupValue }))
  check(dup.ok && dup.result.stored === true, 're-submit reports stored=true (discarded)')
  check(dup.result.value === original, `re-submit returns the STORED answer, not the new one (${dup.result.value})`)

  // ── Scenario 4 — type-derived report: authored mc → pie, hidden → no tile ────
  console.log('\n[4] Type-derived report — authored mc has slices; hidden has no tile')
  const rep = await callFn('pollGetReport', asDev(GID))
  const reportIds = rep.result.reports.map(r => r.id)
  check(rep.result.reports.length === 4, `one report per VISIBLE question (got ${rep.result.reports.length})`)
  check(!reportIds.includes('auth_hidden'), 'the hidden question has NO report tile')
  const mc = rep.result.reports.find(r => r.id === 'auth_mc')
  check(mc && mc.type === 'mc' && Array.isArray(mc.slices) && mc.slices.length === 3, 'authored mc report is a pie with 3 slices')
  const mcVotes = mc.slices.reduce((s, x) => s + x.count, 0)
  check(mc.total === mcVotes && mc.total >= 1, `authored mc tallies votes (total ${mc?.total})`)

  // ── Scenario 5 — roster sync populates non-responders, writes NO grade ──────
  console.log('\n[5] Roster sync — non-responders appear, no grade, Bearer validated')
  currentRoster = ['s1', 's2', 'n3', 'n4', 'n5'].map(id => ({ participant_id: id, name: `Student ${id}`, external_id: null }))
  const sync = await callFn('pollSyncRoster', { _dev: { game_instance_id: GID, roster_url: ROSTER_URL, callback_secret: ROSTER_SECRET } })
  check(sync.ok && sync.result.synced === 5, `syncRoster pulled 5 rostered students (got ${sync.result?.synced})`)

  const rep2 = await callFn('pollGetReport', asDev(GID))
  const status = Object.fromEntries(rep2.result.responseStatus.map(s => [s.participant_id, s]))
  check(rep2.result.responseStatus.length === 5, 'response status now lists all 5 on roster')
  check(status['n3'] && status['n3'].answered === 0, 'never-responded student n3 appears with 0 answers')
  check(status['s1'] && status['s1'].answered === 4, 's1 shows 4 answers')
  // No grade fields exist anywhere in poll — the response rows carry only counts.
  check(!('raw_score' in status['n3']) && !('normalized_score' in status['n3']), 'response rows carry NO grade fields (poll is ungraded)')

  // The classroom handshake: a WRONG secret is rejected by the (validating) endpoint.
  const badSync = await callFn('pollSyncRoster', { _dev: { game_instance_id: GID, roster_url: ROSTER_URL, callback_secret: 'wrong' } })
  check(!badSync.ok, 'syncRoster with a WRONG callback secret is rejected (Bearer is really sent + checked)')

  // ── Scenario 6 — CROSS-INSTANCE ISOLATION with a SHARED question id ──────────
  // The same student answers a poll, then a SECOND poll instance ships the same
  // default question ids (the normal case). In the second poll they must be ASKED that
  // question again — not skipped past it because they answered it in the first.
  console.log('\n[6] Cross-instance: same student, two polls sharing a question id')
  const PA = `poll-isoA-${stamp}`, PB = `poll-isoB-${stamp}`
  const SHARED = 'deals_experience' // a shipped default → present in BOTH polls

  // Poll A: make the default visible, student answers it.
  const cfgA = await callFn('pollGetConfig', asDev(PA))
  await callFn('pollUpdateConfig', { ...asDev(PA), questions: cfgA.result.questions.map(q => (q.id === SHARED ? { ...q, visible: true } : q)) })
  await callFn('pollBootstrap', { _test: { participant_id: 'poll-iso', game_instance_id: PA } })
  await callFn('pollSubmitAnswer', asStudent(PA, 'poll-iso', { question_id: SHARED, value: 'answered in poll A' }))
  const qA = await callFn('pollGetQuestions', asStudent(PA, 'poll-iso'))
  check(qA.result.answered.includes(SHARED), 'poll A: student has answered the shared question')

  // Poll B: the SAME default id is visible; the SAME student.
  const cfgB = await callFn('pollGetConfig', asDev(PB))
  await callFn('pollUpdateConfig', { ...asDev(PB), questions: cfgB.result.questions.map(q => (q.id === SHARED ? { ...q, visible: true } : q)) })
  await callFn('pollBootstrap', { _test: { participant_id: 'poll-iso', game_instance_id: PB } })
  const qB = await callFn('pollGetQuestions', asStudent(PB, 'poll-iso'))
  check(qB.result.questions.some(q => q.id === SHARED), 'poll B: the shared question is served')
  check(qB.result.answered.length === 0 && !qB.result.answered.includes(SHARED), 'poll B: the shared question is ASKED AGAIN (not skipped from poll A)')

  // Answering it in B does not disturb A.
  await callFn('pollSubmitAnswer', asStudent(PB, 'poll-iso', { question_id: SHARED, value: 'answered in poll B' }))
  const repPA = await callFn('pollGetReport', asDev(PA))
  const aAns = repPA.result.reports.find(r => r.id === SHARED)?.answers ?? []
  check(aAns.length === 1 && aAns[0].value === 'answered in poll A', 'poll A report still shows only its own answer')

  console.log(`\n${failed === 0 ? '✅' : '❌'} poll harness: ${passed} passed, ${failed} failed`)
  rosterServer.close()
  process.exit(failed === 0 ? 0 : 1)
}

main().catch(err => {
  console.error('harness crashed:', err)
  rosterServer.close()
  process.exit(1)
})
