// ═══════════════════════════════════════════════════════════════════════════════
// Jar of Pennies — end-to-end emulator harness. Drives the onCall callables over
// HTTP (SAA-style; no browser). Covers: launch, getScreen (no true_value leak),
// submit + one-shot lock, Score & Record with a clear winner, a random tie with
// idempotent re-run, participation grading including a non-submitter, and the
// gradebook push (against a mock classroom callback).
//
// Run (emulator boots via emulators:exec):
//   firebase emulators:exec --only functions,firestore,auth --project demo-singleplayer \
//     --config firebase.json "node pennies-playthrough.mjs"
// (Build functions first: cd functions && npm run build.)
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
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data }),
  })
  let body = null
  try { body = await res.json() } catch { /* ignore */ }
  if (res.ok && body && 'result' in body) return { ok: true, result: body.result }
  return { ok: false, error: body?.error?.message ?? `http ${res.status}`, status: body?.error?.status }
}

// _test / _dev carry ONLY the auth-bypass ids; business params (estimate, bid,
// true_value, jar_image) travel at the TOP LEVEL of data, exactly as the real
// client sends them. (scoreAndRecord's callback override is the one exception it
// reads from inside _dev — passed explicitly at the call site.)
const asStudent = (gid, pid, extra = {}) => ({ _test: { participant_id: pid, game_instance_id: gid }, ...extra })
const asDev = (gid) => ({ _dev: { game_instance_id: gid } })

// ── Mock classroom callback (counts pushed grade records) ──────────────────────
let pushCount = 0
const pushed = []
const callbackServer = http.createServer((req, res) => {
  let raw = ''
  req.on('data', c => (raw += c))
  req.on('end', () => {
    pushCount++
    try { pushed.push(JSON.parse(raw)) } catch { /* ignore */ }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
  })
})
await new Promise(r => callbackServer.listen(0, r))
const CALLBACK_URL = `http://127.0.0.1:${callbackServer.address().port}/push`
const CALLBACK_SECRET = 'test-secret'

// ── Mock classroom getCourseRoster (returns a configurable roster) ─────────────
let currentRoster = []
const rosterServer = http.createServer((req, res) => {
  let raw = ''
  req.on('data', c => (raw += c))
  req.on('end', () => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true, participants: currentRoster }))
  })
})
await new Promise(r => rosterServer.listen(0, r))
const ROSTER_URL = `http://127.0.0.1:${rosterServer.address().port}/roster`

async function main() {
  const stamp = Date.now()

  // ── Scenario 1 — clear winner + non-submitter + one-shot lock ───────────────
  console.log('\n[1] Clear winner, non-submitter, one-shot lock')
  const GID = `pt-${stamp}`

  // Instructor sets the true value ($5.00) — written to the rules-denied truth/main.
  const upd = await callFn('penniesUpdateConfig', { ...asDev(GID), true_value: 5.0, jar_image: '/jarofpennies.jpg' })
  check(upd.ok, 'penniesUpdateConfig set true value')

  // Four students launch (idempotent participant upsert). stu-d never submits.
  for (const pid of ['stu-a', 'stu-b', 'stu-c', 'stu-d']) {
    const b = await callFn('penniesBootstrap', { _test: { participant_id: pid, game_instance_id: GID } })
    check(b.ok, `bootstrap ${pid}`)
  }

  // getScreen must NOT leak the true value.
  const scr = await callFn('penniesGetScreen', asStudent(GID, 'stu-a'))
  check(scr.ok && scr.result.jar_image === '/jarofpennies.jpg', 'getScreen returns jar image')
  check(scr.ok && !('true_value' in scr.result), 'getScreen does NOT leak true_value')
  check(scr.ok && scr.result.already_submitted === false, 'getScreen already_submitted=false pre-submit')
  check(scr.ok && Array.isArray(scr.result.questions) && scr.result.questions.length === 2, 'getScreen returns 2 questions')

  // Submissions: bids a=4, b=6 (winner), c=3.
  check((await callFn('penniesSubmit', asStudent(GID, 'stu-a', { estimate: 4.5, bid: 4.0 }))).ok, 'stu-a submit accepted')
  check((await callFn('penniesSubmit', asStudent(GID, 'stu-b', { estimate: 5.5, bid: 6.0 }))).ok, 'stu-b submit accepted')
  check((await callFn('penniesSubmit', asStudent(GID, 'stu-c', { estimate: 3.5, bid: 3.0 }))).ok, 'stu-c submit accepted')

  // One-shot lock: second submit by stu-a rejected.
  const dup = await callFn('penniesSubmit', asStudent(GID, 'stu-a', { estimate: 1, bid: 1 }))
  check(!dup.ok && /already submitted/i.test(dup.error ?? ''), 'stu-a SECOND submit rejected (one-shot lock)')

  // getScreen now reports already_submitted true for stu-a.
  const scr2 = await callFn('penniesGetScreen', asStudent(GID, 'stu-a'))
  check(scr2.ok && scr2.result.already_submitted === true, 'getScreen already_submitted=true post-submit')

  // Score & Record — pushes to the mock callback.
  const before = pushCount
  const sc = await callFn('penniesScoreAndRecord', { _dev: { game_instance_id: GID, callback_url: CALLBACK_URL, callback_secret: CALLBACK_SECRET } })
  check(sc.ok && sc.result.winner === 'stu-b', 'winner is stu-b (highest bid $6)')
  check(sc.ok && sc.result.scored === 4, 'scored 4 participants (incl. non-submitter)')
  check(pushCount - before === 4, `gradebook push delivered 4 records (got ${pushCount - before})`)

  // Report: profit, grades, stats.
  const rep = await callFn('penniesGetReport', asDev(GID))
  const byId = Object.fromEntries((rep.result?.participants ?? []).map(p => [p.participant_id, p]))
  check(rep.ok && rep.result.scored === true, 'report scored=true')
  check(Math.abs(byId['stu-b'].profit - (5.0 - 6.0)) < 1e-9, 'winner profit = true_value − bid = −1.00 (winner\'s curse)')
  check(byId['stu-a'].profit === 0 && byId['stu-c'].profit === 0, 'non-winning submitters profit 0')
  check(byId['stu-d'].submitted === false, 'stu-d recorded as non-submitter')
  check(rep.result.stats.responses === 3, 'stats responses = 3 submitters')
  check(Math.abs(rep.result.stats.winningBid - 6.0) < 1e-9, 'stats winningBid = 6.00')

  // Participation grading via the pushed records: submitters normalized 0, non-submitter −2.
  const pushById = Object.fromEntries(pushed.map(r => [r.participant_id, r]))
  check(pushById['stu-a'].normalized_score === 0, 'submitter normalized_score = 0 (zero-SD)')
  check(pushById['stu-d'].normalized_score === -2, 'non-submitter normalized_score = −2')
  check(pushById['stu-d'].status === 'no_show', 'non-submitter status = no_show')
  check(pushById['stu-b'].status === 'completed', 'submitter status = completed')
  check(!('raw_score' in pushById['stu-b']), 'push omits raw_score (gradebook contract)')

  // ── Scenario 2 — random tie + idempotent re-run ─────────────────────────────
  console.log('\n[2] Tie broken randomly, idempotent re-run')
  const GID2 = `pt-tie-${stamp}`
  await callFn('penniesUpdateConfig', { ...asDev(GID2), true_value: 5.0 })
  for (const pid of ['tie-x', 'tie-y']) {
    await callFn('penniesBootstrap', { _test: { participant_id: pid, game_instance_id: GID2 } })
  }
  await callFn('penniesSubmit', asStudent(GID2, 'tie-x', { estimate: 5, bid: 6.0 }))
  await callFn('penniesSubmit', asStudent(GID2, 'tie-y', { estimate: 5, bid: 6.0 }))
  const t1 = await callFn('penniesScoreAndRecord', asDev(GID2))
  check(t1.ok && ['tie-x', 'tie-y'].includes(t1.result.winner), `tie winner is one of the tied bidders (${t1.result?.winner})`)
  const t2 = await callFn('penniesScoreAndRecord', asDev(GID2))
  check(t2.ok && t2.result.winner === t1.result.winner, 'idempotent: re-run keeps the SAME tie winner')

  // ── Scenario 3 — no submitters ──────────────────────────────────────────────
  console.log('\n[3] No submitters')
  const GID3 = `pt-empty-${stamp}`
  await callFn('penniesBootstrap', { _test: { participant_id: 'lonely', game_instance_id: GID3 } })
  const e1 = await callFn('penniesScoreAndRecord', asDev(GID3))
  check(e1.ok && e1.result.winner === null, 'no submitters → winner null')

  // ── Scenario 4 — roster sync + never-launched grading (Item 1) ──────────────
  console.log('\n[4] Roster sync: submitted / launched-no-bid / never-launched all graded')
  const GID4 = `pt-roster-${stamp}`
  await callFn('penniesUpdateConfig', { ...asDev(GID4), true_value: 5.0 })
  // Course roster of 5; only r1 + r2 will launch.
  currentRoster = ['r1', 'r2', 'r3', 'r4', 'r5'].map(id => ({ participant_id: id, name: `Student ${id}`, external_id: null }))

  // r1 launches + submits; r2 launches but never submits; r3/r4/r5 never launch.
  await callFn('penniesBootstrap', { _test: { participant_id: 'r1', game_instance_id: GID4 } })
  await callFn('penniesBootstrap', { _test: { participant_id: 'r2', game_instance_id: GID4 } })
  await callFn('penniesSubmit', asStudent(GID4, 'r1', { estimate: 4, bid: 4.5 }))

  // Instructor opens dashboard → syncRoster pulls the full class (mock getCourseRoster).
  const sync = await callFn('penniesSyncRoster', { _dev: { game_instance_id: GID4, roster_url: ROSTER_URL, callback_secret: 'x' } })
  check(sync.ok && sync.result.synced === 5, `syncRoster pulled all 5 rostered students (got ${sync.result?.synced})`)

  // Report reflects all three states.
  const rr = await callFn('penniesGetReport', asDev(GID4))
  const rb = Object.fromEntries((rr.result?.participants ?? []).map(p => [p.participant_id, p]))
  check((rr.result?.participants?.length ?? 0) === 5, 'report shows all 5 on roster (incl. never-launched)')
  check(rb['r1'].submitted === true, 'r1 submitted')
  check(rb['r2'].launched === true && rb['r2'].submitted === false, 'r2 launched but did not submit')
  check(rb['r3'].launched === false && rb['r3'].submitted === false, 'r3 never launched (roster-only)')

  // Score & Record grades EVERYONE on the roster.
  const before4 = pushCount
  const sc4 = await callFn('penniesScoreAndRecord', { _dev: { game_instance_id: GID4, callback_url: CALLBACK_URL, callback_secret: CALLBACK_SECRET } })
  check(sc4.ok && sc4.result.scored === 5, `scored all 5 rostered students (got ${sc4.result?.scored})`)
  check(pushCount - before4 === 5, `pushed 5 grade records (got ${pushCount - before4})`)
  const p4 = Object.fromEntries(pushed.slice(-5).map(r => [r.participant_id, r]))
  check(p4['r1'].normalized_score === 0 && p4['r1'].status === 'completed', 'r1 (submitted) → normalized 0, completed')
  check(p4['r2'].normalized_score === -2 && p4['r2'].status === 'no_show', 'r2 (launched, no bid) → normalized −2, no_show')
  check(p4['r3'].normalized_score === -2 && p4['r3'].status === 'no_show', 'r3 (NEVER launched) → normalized −2, no_show')

  // Idempotent merge: re-syncing must not wipe r1's submission.
  await callFn('penniesSyncRoster', { _dev: { game_instance_id: GID4, roster_url: ROSTER_URL, callback_secret: 'x' } })
  const rr2 = await callFn('penniesGetReport', asDev(GID4))
  const r1b = (rr2.result?.participants ?? []).find(p => p.participant_id === 'r1')
  check(r1b?.submitted === true && r1b?.bid === 4.5, 're-sync did NOT clobber r1 submitted_at/bid (safe merge)')

  console.log(`\n${failed === 0 ? '✅' : '❌'} pennies harness: ${passed} passed, ${failed} failed`)
  callbackServer.close(); rosterServer.close()
  process.exit(failed === 0 ? 0 : 1)
}

main().catch(err => {
  console.error('harness crashed:', err)
  callbackServer.close(); rosterServer.close()
  process.exit(1)
})
