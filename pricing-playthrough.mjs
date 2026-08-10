// ═══════════════════════════════════════════════════════════════════════════════
// Pricing Game (Cheyenne Shipping) — SLICE 1 emulator harness. Drives the
// onCall/onRequest endpoints over HTTP (pennies/poll/pd style; no browser).
//
// Slice 0 coverage (§1–§5): health, launch, pricing_ prefix + cross-game isolation,
// instructor session, the student route in the shipped bundle.
//
// Slice 1 coverage (§6–§10): the round loop — first-touch init, a full playthrough
// to game over in EACH mode with every competitor price and every share, demand and
// profit predicted independently from the spec, submit-and-lock, resume, price
// validation, and the LEAK ASSERTIONS that are the spec's hard constraint: no
// response may carry the drawn round count or the competitor's rule.
//
// Slice 3 coverage (§11–§13): the knowledge check in BOTH modes (every question
// SUBMITTED, not merely rendered — the answer key never ships, the per-question lock
// holds, a wrong answer is recorded and scored, and the denominator is whatever was
// served), the debrief with its competitor reveal (gated on the game being over), and
// Score & Record — participation scoring, and the gradebook push with a verified
// Bearer signature, including two instances of the SAME game producing two distinct
// entries for one student.
//
// Run (clean start — the emulator boots fresh, runs this, and shuts down):
//   npm run harness:pricing
// which is, expanded (build both first):
//   cd functions && npm run build && cd ../frontend && npm run build && cd ..
//   firebase emulators:exec --only functions,firestore,auth --project demo-singleplayer \
//     --config firebase.json "node pricing-playthrough.mjs"
// ═══════════════════════════════════════════════════════════════════════════════

import fs from 'node:fs'
import http from 'node:http'
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

/** Writes one document into the Firestore emulator as owner (REST). Slice 1 uses
 *  this ONLY to seed config/main — pricing has no instructor-config callable yet,
 *  and the seed is what makes each student's hidden horizon reproducible. */
async function putDoc(docPath, fields) {
  const res = await fetch(`${FIRESTORE}/${docPath}`, {
    method: 'PATCH',
    headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields }),
  })
  if (!res.ok) throw new Error(`firestore PATCH ${docPath} → ${res.status} ${await res.text()}`)
}

const strVal = (s) => ({ stringValue: s })
const boolVal = (b) => ({ booleanValue: b })
const intVal = (n) => ({ integerValue: String(n) })

const asStudent = (gid, pid, extra = {}) => ({ _test: { participant_id: pid, game_instance_id: gid }, ...extra })
const asDev = (gid) => ({ _dev: { game_instance_id: gid } })

/** Every key appearing anywhere in a response tree. */
function deepKeys(value, out = new Set()) {
  if (Array.isArray(value)) { for (const v of value) deepKeys(v, out); return out }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) { out.add(k); deepKeys(v, out) }
  }
  return out
}

/** Every primitive value appearing anywhere in a response tree. */
function deepValues(value, out = []) {
  if (Array.isArray(value)) { for (const v of value) deepValues(v, out); return out }
  if (value && typeof value === 'object') {
    for (const v of Object.values(value)) deepValues(v, out)
    return out
  }
  out.push(value)
  return out
}

// ── Independent models of the server's logic ───────────────────────────────────
// Deliberately re-implemented here rather than imported from functions/lib: a harness
// that imports the code under test can only prove it is self-consistent. These are
// written from the SPEC (§2, §5, §6), so a change in the server that breaks the spec
// fails here instead of quietly agreeing with itself.
//
// Note the competitor model uses the spec's CLOSED FORM — the continuous best reply
// snapped to the grid — while the server computes a grid argmax. Two different routes
// to the same number is exactly what makes this an independent check.

/** The case's market (spec §2 defaults). */
const MARKET = {
  M: 190_000,
  sC: 0.35, sW: 0.65,
  cC: 966, cW: 900,
  k: 1000,
  minPrice: 900, maxPrice: 2000, gridStep: 100,
}

const clamp01 = (v) => Math.min(1, Math.max(0, v))

/** One round of the market, from the spec. */
function expectedOutcome(pc, pw, m, pmg) {
  if (pmg) {
    const eff = Math.min(pc, pw)
    return {
      yourShare: m.sC, competitorShare: m.sW,
      yourDemand: m.M * m.sC, competitorDemand: m.M * m.sW,
      yourProfit: m.M * m.sC * (eff - m.cC),
      competitorProfit: m.M * m.sW * (eff - m.cW),
      effectivePrice: eff,
    }
  }
  const sc = clamp01(m.sC + (pw - pc) / m.k)
  const sw = clamp01(m.sW + (pc - pw) / m.k)
  return {
    yourShare: sc, competitorShare: sw,
    yourDemand: m.M * sc, competitorDemand: m.M * sw,
    yourProfit: m.M * sc * (pc - m.cC),
    competitorProfit: m.M * sw * (pw - m.cW),
    effectivePrice: null,
  }
}

/** The competitor's price for the round after `priorPrices` (spec §5). */
function expectedCompetitorPrice(strategy, priorPrices, m) {
  if (strategy === 'pmg-ceiling') return m.maxPrice
  if (priorPrices.length === 0) return m.maxPrice          // high start
  const last = priorPrices[priorPrices.length - 1]
  const continuous = (m.sW * m.k + m.cW + last) / 2        // the spec's closed form
  // Snap to the grid, ties to the HIGHER price.
  let best = m.minPrice, bestD = Infinity
  for (let p = m.minPrice; p <= m.maxPrice; p += m.gridStep) {
    const d = Math.abs(p - continuous)
    if (d < bestD - 1e-9 || (Math.abs(d - bestD) <= 1e-9 && p > best)) { bestD = d; best = p }
  }
  return best
}

/** Dollars agree to the cent — the server multiplies doubles in a different order. */
const near = (a, b) => Math.abs(a - b) < 0.01

// ── Mock classroom (the gradebook callback + the roster endpoint) ──────────────
// Same shape pennies' and PD's harnesses use. In the emulator both URLs and the
// secret are passed explicitly inside _dev, so nothing here depends on a deployed
// classroom or on PRICING_CALLBACK_SECRET being present.
//
// ⚠ THIS MOCK CHECKS THE SIGNATURE. The real classroom authenticates every push with
// `Authorization: Bearer <the game's callback secret>` (receiveGameResult), so a
// harness that accepted anything would pass while the game pushed unsigned — which is
// exactly how a push fails in production and nowhere else.
const CALLBACK_SECRET = 'test-pricing-secret'
let pushCount = 0
const pushed = []
const badlySigned = []
const callbackServer = http.createServer((req, res) => {
  let raw = ''
  req.on('data', c => (raw += c))
  req.on('end', () => {
    const auth = req.headers.authorization ?? ''
    if (auth !== `Bearer ${CALLBACK_SECRET}`) {
      badlySigned.push(auth)
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'bad signature' }))
      return
    }
    pushCount++
    try { pushed.push(JSON.parse(raw)) } catch { /* ignore */ }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
  })
})
await new Promise(r => callbackServer.listen(0, r))
const CALLBACK_URL = `http://127.0.0.1:${callbackServer.address().port}/push`

/** The roster the mock classroom hands back: the students who play, plus one who
 *  never launches — the −2 floor case only a roster sync can create. */
const ROSTER = [
  { participant_id: 'pricing-finisher', name: 'Fin Isher', external_id: 'ext-1' },
  { participant_id: 'pricing-quitter', name: 'Quinn Itter', external_id: 'ext-2' },
  { participant_id: 'pricing-absent', name: 'Abby Sent', external_id: 'ext-3' },
]
const rosterServer = http.createServer((req, res) => {
  let raw = ''
  req.on('data', c => (raw += c))
  req.on('end', () => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true, participants: ROSTER }))
  })
})
await new Promise(r => rosterServer.listen(0, r))
const ROSTER_URL = `http://127.0.0.1:${rosterServer.address().port}/roster`

// ── The KC answer key, derived here from the SPEC (never imported) ─────────────
// The server derives its questions from the instance's market; these are the same
// derivations written out independently, so agreement means the two agree about the
// spec rather than agreeing with themselves.

const snapGrid = (v) => Math.min(MARKET.maxPrice, Math.max(MARKET.minPrice,
  Math.round(v / MARKET.gridStep) * MARKET.gridStep))
/** The two in-bounds prices the share/contribution questions are posed with. */
const QP = (() => {
  const theirs = snapGrid(MARKET.maxPrice - MARKET.gridStep)
  return { yours: snapGrid(theirs - 2 * MARKET.gridStep), theirs }
})()

/** Standard mode (spec §8.1) — four questions. */
const KC_STANDARD = [
  { field: 'kc_base_share', correct: MARKET.sC.toFixed(4) },
  { field: 'kc_share_gap', correct: (MARKET.sC + (QP.theirs - QP.yours) / MARKET.k).toFixed(4) },
  { field: 'kc_contribution', correct: String(QP.yours - MARKET.cC) },
  { field: 'kc_below_cost', correct: 'negative' },
]

/** PMG mode (spec §8.2) — three questions, and NOT a repeat of the Standard four. */
const KC_PMG = [
  { field: 'kc_pmg_effective', correct: String(QP.yours) },
  { field: 'kc_pmg_share', correct: MARKET.sC.toFixed(4) },
  { field: 'kc_pmg_undercut', correct: 'none' },
]

async function main() {
  const stamp = Date.now()

  // ── 1. Health probes ────────────────────────────────────────────────────────
  // pricing's own probe, plus the three existing games: adding a fourth game to the
  // shared index.ts must not disturb the functions already deployed alongside it.
  console.log('\n[1] Health probes')
  const prH = await getJson('pricingHealth')
  check(prH.status === 200 && prH.body?.ok === true, 'pricingHealth responds 200 ok')
  check(prH.body?.game === 'pricing', 'pricingHealth identifies itself as game "pricing"')

  const penH = await getJson('penniesHealth')
  const polH = await getJson('pollHealth')
  const pdH = await getJson('pdHealth')
  check(penH.body?.game === 'pennies', 'penniesHealth still reports "pennies" (untouched)')
  check(polH.body?.game === 'poll', 'pollHealth still reports "poll" (untouched)')
  check(pdH.body?.game === 'pd', 'pdHealth still reports "pd" (untouched)')

  // ── 2. Student launch ───────────────────────────────────────────────────────
  console.log('\n[2] Student launch (pricingBootstrap)')
  const GID = `pricing-${stamp}`
  const PID = 'pricing-stu-a'

  const boot = await callFn('pricingBootstrap', asStudent(GID, PID))
  check(boot.ok, 'pricingBootstrap succeeds')
  check(boot.result?.participant_id === PID, 'returns the participant_id')
  check(boot.result?.game_instance_id === GID, 'returns the game_instance_id')
  check(typeof boot.result?.customToken === 'string' && boot.result.customToken.length > 0,
    'mints a Firebase custom token (the session the student route needs)')

  // Relaunching is the normal case (student closes the tab and comes back) — and it
  // is the family rule for this game in particular: self-paced, close and resume.
  const boot2 = await callFn('pricingBootstrap', asStudent(GID, PID))
  check(boot2.ok && boot2.result?.participant_id === PID, 'relaunch is idempotent, not an error')

  // A launch with no token and no _test is rejected.
  const bootBad = await callFn('pricingBootstrap', {})
  check(!bootBad.ok, 'pricingBootstrap without a token is rejected')

  // ── 3. Collection prefix + cross-GAME isolation ─────────────────────────────
  // The whole family separates games by prefix, so this is the load-bearing check:
  // the write must land under pricing_game_instances and NOWHERE else.
  console.log('\n[3] pricing_ collection prefix + cross-game isolation')
  const prDoc = await getDoc(`pricing_game_instances/${GID}/participants/${PID}`)
  check(prDoc !== null, 'participant doc exists at pricing_game_instances/{iid}/participants/{pid}')
  check(prDoc?.launched_at != null, 'launch stamped launched_at')

  // The SAME student id and the SAME instance id in pd must be a DIFFERENT doc in a
  // different prefixed collection — never a shared one.
  await callFn('pdBootstrap', asStudent(GID, PID))
  const pdDoc = await getDoc(`pd_game_instances/${GID}/participants/${PID}`)
  check(pdDoc !== null, 'the same ids under pd create a SEPARATE pd_ doc')
  await callFn('penniesBootstrap', asStudent(GID, PID))
  const penDoc = await getDoc(`pennies_game_instances/${GID}/participants/${PID}`)
  check(penDoc !== null, 'the same ids under pennies create a SEPARATE pennies_ doc')
  const prStillThere = await getDoc(`pricing_game_instances/${GID}/participants/${PID}`)
  check(prStillThere !== null, 'the pricing doc is untouched by the other games’ launches')

  // Slice 0 writes no game state at all — no prices, no rounds, no profits yet.
  const scaffoldOnly = ['price', 'rounds', 'submitted_at', 'profit', 'raw_score', 'pmg']
  check(scaffoldOnly.every(f => prStillThere?.[f] === undefined),
    'pricing participant doc carries identity only (no game state in Slice 0)')

  // ── 4. Instructor session ───────────────────────────────────────────────────
  console.log('\n[4] Instructor session (pricingInstructorSession)')
  const sess = await callFn('pricingInstructorSession', asDev(GID))
  check(sess.ok, 'pricingInstructorSession succeeds')
  check(typeof sess.result?.customToken === 'string' && sess.result.customToken.length > 0,
    'mints an instructor custom token (the dashboard/settings/reports shell needs it)')

  const sessBad = await callFn('pricingInstructorSession', {})
  check(!sessBad.ok, 'pricingInstructorSession without a token is rejected')

  // ── 5. The pricing student route ships in the bundle ────────────────────────
  // One Vite bundle serves every game and picks by hostname, so "the pricing route is
  // built and shipped" is what can be asserted here. This is a BUILD-ARTIFACT check,
  // not a DOM render — the repo has no jsdom/testing-library, and Slice 0 does not
  // add one. `npm run build` in frontend/ must have run first.
  console.log('\n[5] pricing route present in the shipped bundle')
  const distDir = path.join(ROOT, 'frontend', 'dist', 'assets')
  if (!fs.existsSync(distDir)) {
    check(false, 'frontend/dist/assets missing — run `npm run build` in frontend/ first')
  } else {
    const js = fs.readdirSync(distDir).filter(f => f.endsWith('.js'))
      .map(f => fs.readFileSync(path.join(distDir, f), 'utf8')).join('')
    check(js.includes('Cheyenne Shipping'), 'bundle contains the pricing student shell')
    check(js.includes('pricingBootstrap'), 'bundle wires pricingBootstrap')
    check(js.includes('pricingInstructorSession'), 'bundle wires pricingInstructorSession')
    check(js.includes('Jar of Pennies') && js.includes('pollBootstrap') && js.includes('pdBootstrap'),
      'pennies + poll + pd are still in the same bundle (shared artifact intact)')
    // Spec §1 content rule, enforced from Slice 0: the opponent is "your competitor",
    // never "the bot". Nothing student-facing may say otherwise.
    check(!/the bot\b/i.test(js), 'no student-facing copy calls the competitor "the bot"')
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SLICE 1 — the round loop
  // ═══════════════════════════════════════════════════════════════════════════

  /** Seeds an instance's config, first-touches one student, and reads back the
   *  horizon that was drawn for them (as owner — no client can do this). */
  async function openInstance(gid, pid, seed, { pmg = false, extraConfig = {} } = {}) {
    await putDoc(`pricing_game_instances/${gid}/config/main`, {
      seed: strVal(seed),
      pmg: boolVal(pmg),
      ...extraConfig,
    })
    await callFn('pricingBootstrap', asStudent(gid, pid))
    const state = await callFn('pricingGetState', asStudent(gid, pid))
    const truth = await getDoc(`pricing_game_instances/${gid}/truth/participant_${pid}`)
    return { state, rounds: Number(truth?.rounds?.integerValue) }
  }

  /** Plays one full game to the drawn horizon, checking EVERY round against the
   *  independent model: the competitor's price, both shares, both demands, both
   *  profits, the effective price, and the running total/average. */
  async function playThrough(gid, pid, horizon, prices, pmg, strategy) {
    const priorPrices = []
    let runningTotal = 0
    let allRoundsAgree = true
    let lastResponse = null

    for (let n = 1; n <= horizon; n++) {
      const myPrice = prices[(n - 1) % prices.length]
      const rivalExpected = expectedCompetitorPrice(strategy, priorPrices, MARKET)
      const expected = expectedOutcome(myPrice, rivalExpected, MARKET, pmg)

      const res = await callFn('pricingSubmitPrice', asStudent(gid, pid, { round: n, price: myPrice }))
      if (!res.ok) { check(false, `round ${n} submit failed: ${res.error}`); return null }
      const r = res.result.round

      runningTotal += expected.yourProfit
      const agrees =
        r.round === n &&
        r.yourPrice === myPrice &&
        r.competitorPrice === rivalExpected &&
        r.effectivePrice === expected.effectivePrice &&
        near(r.yourShare, expected.yourShare) &&
        near(r.competitorShare, expected.competitorShare) &&
        near(r.yourDemand, expected.yourDemand) &&
        near(r.competitorDemand, expected.competitorDemand) &&
        near(r.yourProfit, expected.yourProfit) &&
        near(r.competitorProfit, expected.competitorProfit) &&
        near(res.result.totalProfit, runningTotal) &&
        near(res.result.averageProfit, runningTotal / n)
      if (!agrees) {
        console.error(`    round ${n}: expected competitor ${rivalExpected}, got ${r.competitorPrice}; ` +
          `expected profit ${expected.yourProfit}, got ${r.yourProfit}`)
        allRoundsAgree = false
      }

      priorPrices.push(myPrice)
      lastResponse = res.result
    }
    return { allRoundsAgree, lastResponse, priorPrices }
  }

  // ── 6. First touch: pricingGetState draws the horizon and returns none of it ──
  console.log('\n[6] pricingGetState — first touch draws the horizon, returns none of it')
  const GID_S = `pricing-std-${stamp}`
  const SPID = 'pricing-std-stu'
  const std = await openInstance(GID_S, SPID, 'seed-std')

  check(std.state.ok, 'pricingGetState succeeds')
  check(Number.isInteger(std.rounds) && std.rounds >= 10 && std.rounds <= 20,
    `drew a horizon in [10,20] (${std.rounds})`)
  check(std.state.result.history.length === 0, 'a new student has played nothing')
  check(std.state.result.phase === 'play' && std.state.result.gameOver === false,
    'and starts in the play phase')
  check(std.state.result.pmg === false, 'a fresh instance is Standard mode')
  check(std.state.result.minRounds === 10 && std.state.result.maxRounds === 20,
    'the RANGE is served (students are told it) …')
  check(std.state.result.market.marketSize === 190_000
    && std.state.result.market.studentBaseShare === 0.35
    && std.state.result.market.competitorBaseShare === 0.65
    && std.state.result.market.studentUnitCost === 966
    && std.state.result.market.competitorUnitCost === 900
    && std.state.result.market.minPrice === 900
    && std.state.result.market.maxPrice === 2000,
    'the price-entry screen’s market values are served (spec §4)')
  check(std.state.result.market.gridStep === undefined,
    'but NOT gridStep — it only parameterises the competitor’s rule')
  check(std.state.result.labels?.student === 'CSC' && std.state.result.labels?.competitor === 'WNS',
    'the two firm labels are served')

  // The horizon is drawn PER STUDENT (spec §3 as amended): a second student in the
  // SAME instance gets their own, so the first to finish cannot tell the class how
  // long the game is.
  const horizons = new Set()
  for (let i = 0; i < 10; i++) {
    const pid = `pricing-horizon-${i}`
    await callFn('pricingGetState', asStudent(GID_S, pid))
    const t = await getDoc(`pricing_game_instances/${GID_S}/truth/participant_${pid}`)
    horizons.add(Number(t?.rounds?.integerValue))
  }
  check(horizons.size > 1, `students in one instance get DIFFERENT horizons (${[...horizons].join(', ')})`)

  // ── 7. A full Standard playthrough, every round predicted independently ──────
  console.log('\n[7] Standard mode — full playthrough to game over (spec §2, §5)')

  // The competitor's round-1 opening is the ceiling, deterministically, for everyone.
  const r1 = await callFn('pricingSubmitPrice', asStudent(GID_S, SPID, { round: 1, price: 2000 }))
  check(r1.ok && r1.result.round.competitorPrice === 2000,
    'round 1: the competitor opens at the price ceiling ($2,000), always')
  check(near(r1.result.round.yourShare, 0.35) && near(r1.result.round.competitorShare, 0.65),
    'equal prices ⇒ the base shares (35% / 65%)')

  // The two spec §5 spot checks, in the live loop: undercut a high price, price above
  // a low one. Round 2's competitor price answers round 1's $2,000.
  const r2 = await callFn('pricingSubmitPrice', asStudent(GID_S, SPID, { round: 2, price: 900 }))
  check(r2.ok && r2.result.round.competitorPrice === 1800,
    'student posted $2,000 ⇒ the competitor UNDERCUTS to $1,800')
  const r3 = await callFn('pricingSubmitPrice', asStudent(GID_S, SPID, { round: 3, price: 1400 }))
  check(r3.ok && r3.result.round.competitorPrice === 1200,
    'student posted $900 ⇒ the competitor prices ABOVE, at $1,200')
  const r4 = await callFn('pricingSubmitPrice', asStudent(GID_S, SPID, { round: 4, price: 1400 }))
  check(r4.ok && r4.result.round.competitorPrice === 1500,
    'student posted $1,400 ⇒ the competitor posts $1,500')

  // The case's own published row, played for real: CSC $1,800 vs WNS $2,000.
  const GID_CASE = `pricing-case-${stamp}`
  await openInstance(GID_CASE, 'case-stu', 'seed-case')
  const caseRound = await callFn('pricingSubmitPrice', asStudent(GID_CASE, 'case-stu', { round: 1, price: 1800 }))
  check(caseRound.ok
    && caseRound.result.round.competitorPrice === 2000
    && near(caseRound.result.round.yourShare, 0.55)
    && near(caseRound.result.round.competitorShare, 0.45)
    && near(caseRound.result.round.yourProfit, 87_153_000)
    && near(caseRound.result.round.competitorProfit, 94_050_000),
    'the case table’s row reproduces exactly: 55%/45%, $87.15M/$94.05M')
  check(caseRound.result.round.effectivePrice === null,
    'and Standard mode reports no effective price')

  // Now finish the game, checking every remaining round.
  const GID_FULL = `pricing-full-${stamp}`
  const FPID = 'pricing-full-stu'
  const full = await openInstance(GID_FULL, FPID, 'seed-full')
  const played = await playThrough(GID_FULL, FPID, full.rounds,
    [2000, 1700, 1400, 900, 1500, 1250, 1800, 1394], false, 'standard-highstart-bestreply')
  check(played?.allRoundsAgree === true,
    `every one of ${full.rounds} rounds matches the independent model (prices, shares, demands, profits, totals)`)
  check(played?.lastResponse?.gameOver === true, 'the drawn horizon ends the game')
  check(played?.lastResponse?.phase === 'debrief', 'and the phase transitions to the debrief')
  check(played?.lastResponse?.history.length === full.rounds, 'the final history holds every round played')

  // The participant doc records the terminal phase (what a later slice's screens and
  // Score & Record will read).
  const finishedDoc = await getDoc(`pricing_game_instances/${GID_FULL}/participants/${FPID}`)
  check(finishedDoc?.phase?.stringValue === 'debrief', 'the participant doc is stamped phase=debrief')
  check(finishedDoc?.finished_at != null, 'and carries a finish stamp')
  check(Number(finishedDoc?.rounds_played?.integerValue) === full.rounds, 'and the rounds-played count')

  // ── 8. A full PMG playthrough ────────────────────────────────────────────────
  console.log('\n[8] PMG mode — full playthrough (spec §6)')
  const GID_P = `pricing-pmg-${stamp}`
  const PPID = 'pricing-pmg-stu'
  const pmg = await openInstance(GID_P, PPID, 'seed-pmg', { pmg: true })

  check(pmg.state.result.pmg === true, 'the instance reports PMG rules in force')

  const pmgRound = await callFn('pricingSubmitPrice', asStudent(GID_P, PPID, { round: 1, price: 1600 }))
  check(pmgRound.ok && pmgRound.result.round.competitorPrice === 2000,
    'the competitor posts the ceiling …')
  check(pmgRound.result.round.effectivePrice === 1600,
    '… and the EFFECTIVE price is the lower of the two — the student’s own')
  check(near(pmgRound.result.round.yourShare, 0.35) && near(pmgRound.result.round.competitorShare, 0.65),
    'shares are FROZEN at base, whatever the gap')
  check(near(pmgRound.result.round.yourProfit, 190_000 * 0.35 * (1600 - 966)),
    'profit is M × base share × (effective price − unit cost)')

  const pmgPlayed = await playThrough(GID_P, PPID, pmg.rounds,
    [1600, 900, 2000, 1200, 1900, 1394], true, 'pmg-ceiling')
  check(pmgPlayed?.allRoundsAgree === true,
    `every one of ${pmg.rounds} PMG rounds matches the independent model`)
  check(pmgPlayed?.lastResponse?.gameOver === true, 'the PMG game reaches its own drawn horizon')

  // The discovery the mode exists for, asserted on real responses: raising your price
  // raises your profit with ZERO share loss, right up to the ceiling.
  const pmgHistory = pmgPlayed?.lastResponse?.history ?? []
  const sharesConstant = pmgHistory.every(h => near(h.yourShare, 0.35))
  check(sharesConstant, 'across the whole PMG game the student’s share never moves')
  const ceilingRow = pmgHistory.find(h => h.yourPrice === 2000)
  const lowRow = pmgHistory.find(h => h.yourPrice === 900)
  check(ceilingRow && lowRow && ceilingRow.yourProfit > lowRow.yourProfit,
    'and posting the ceiling beats posting the floor, with the same share')

  // ── 9. Submit-and-lock, resume, and price validation ─────────────────────────
  console.log('\n[9] Lock, resume, and validation')
  const GID_L = `pricing-lock-${stamp}`
  const LPID = 'pricing-lock-stu'
  await openInstance(GID_L, LPID, 'seed-lock')

  const first = await callFn('pricingSubmitPrice', asStudent(GID_L, LPID, { round: 1, price: 1500 }))
  const resubmit = await callFn('pricingSubmitPrice', asStudent(GID_L, LPID, { round: 1, price: 900 }))
  check(resubmit.ok && resubmit.result.round.yourPrice === 1500,
    'a resubmit for a played round returns the STORED price, not the new one')
  check(resubmit.result.round.competitorPrice === first.result.round.competitorPrice,
    'and the stored outcome is untouched')
  const afterResubmit = await callFn('pricingGetState', asStudent(GID_L, LPID))
  check(afterResubmit.result.history.length === 1, 'the resubmit wrote nothing — still one round played')

  const skipped = await callFn('pricingSubmitPrice', asStudent(GID_L, LPID, { round: 5, price: 1500 }))
  check(!skipped.ok, 'a skipped-ahead round is rejected (rounds are played in order)')

  const resumed = await callFn('pricingGetState', asStudent(GID_L, LPID))
  check(resumed.ok && resumed.result.history.length === 1 && resumed.result.history[0].yourPrice === 1500,
    'closing the tab and coming back resumes exactly where the student was')
  check(near(resumed.result.totalProfit, first.result.round.yourProfit)
    && near(resumed.result.averageProfit, first.result.round.yourProfit),
    'and the running total/average survive the resume')

  for (const [price, why] of [[899, 'below the floor'], [2001, 'above the ceiling'],
    [1400.5, 'not a whole dollar'], ['1400', 'not a number'], [null, 'missing']]) {
    const bad = await callFn('pricingSubmitPrice', asStudent(GID_L, LPID, { round: 2, price }))
    check(!bad.ok, `a price ${why} is rejected (${JSON.stringify(price)})`)
  }
  const badRound = await callFn('pricingSubmitPrice', asStudent(GID_L, LPID, { round: 0, price: 1500 }))
  check(!badRound.ok, 'a round number below 1 is rejected')
  const stillOne = await callFn('pricingGetState', asStudent(GID_L, LPID))
  check(stillOne.result.history.length === 1, 'and no rejected submit wrote a round')

  // Playing past the end is refused outright.
  const pastEnd = await callFn('pricingSubmitPrice',
    asStudent(GID_FULL, FPID, { round: full.rounds + 1, price: 1500 }))
  check(!pastEnd.ok, 'a finished student cannot play another round')

  // An edited ceiling moves the competitor's opening — config, not code.
  const GID_E = `pricing-edit-${stamp}`
  await openInstance(GID_E, 'edit-stu', 'seed-edit', {
    extraConfig: { market: { mapValue: { fields: { max_price: intVal(1800) } } } },
  })
  const edited = await callFn('pricingSubmitPrice', asStudent(GID_E, 'edit-stu', { round: 1, price: 1500 }))
  check(edited.ok && edited.result.round.competitorPrice === 1800,
    'an edited price ceiling moves the competitor’s opening to $1,800')
  const tooHigh = await callFn('pricingSubmitPrice', asStudent(GID_E, 'edit-stu', { round: 2, price: 1900 }))
  check(!tooHigh.ok, 'and the edited ceiling is enforced on the student’s own entry')

  // ── 10. ⚠ THE LEAK ASSERTIONS — the spec's hard constraint ───────────────────
  // The drawn round count and the competitor's rule are server-side truth. If either
  // can be recovered from any response, the pedagogy is broken: the student would know
  // when the last round is (and price accordingly), or know what the competitor is
  // doing instead of inferring it. These checks are why the callables return
  // hand-built whitelists.
  console.log('\n[10] ⚠ No leak: not the horizon, not the competitor’s rule, ever')

  const GID_K = `pricing-leak-${stamp}`
  const KPID = 'pricing-leak-stu'
  const leak = await openInstance(GID_K, KPID, 'seed-leak')

  const ROUND_KEYS = ['round', 'yourPrice', 'competitorPrice', 'effectivePrice',
    'yourShare', 'competitorShare', 'yourDemand', 'competitorDemand',
    'yourProfit', 'competitorProfit', 'yourTotal', 'yourAverage']
  const ALLOWED_STATE_KEYS = ['ok', 'pmg', 'labels', 'student', 'competitor', 'market',
    'marketSize', 'studentBaseShare', 'competitorBaseShare', 'studentUnitCost',
    'competitorUnitCost', 'slope', 'minPrice', 'maxPrice',
    'minRounds', 'maxRounds', 'history', 'totalProfit', 'averageProfit', 'phase', 'gameOver',
    ...ROUND_KEYS]
  const ALLOWED_SUBMIT_KEYS = ['ok', 'round', 'history', 'totalProfit', 'averageProfit',
    'phase', 'gameOver', ...ROUND_KEYS]

  /** The whole-tree audit: exact key allowlist, no forbidden word anywhere in the
   *  serialized payload, and no number that could be the drawn horizon. */
  function auditNoLeak(payload, allowedKeys, where, { checkNumbers = true } = {}) {
    const extra = [...deepKeys(payload)].filter(k => !allowedKeys.includes(k))
    check(extra.length === 0, `${where}: no key outside the whitelist (extra: ${JSON.stringify(extra)})`)

    const json = JSON.stringify(payload).toLowerCase()
    // Every word that would name the competitor's rule, the horizon, or the seed the
    // horizon derives from.
    const forbidden = ['strategy', 'bestreply', 'best-reply', 'highstart', 'ceiling',
      'grid', 'seed', 'remaining', 'total_rounds', 'roundcount', 'horizon',
      'finished_at', 'the bot']
    const hit = forbidden.filter(w => json.includes(w))
    check(hit.length === 0, `${where}: no forbidden word in the payload (found: ${JSON.stringify(hit)})`)

    if (!checkNumbers) return
    // The horizon is an integer in [10, 20]. Once the two DECLARED range bounds are
    // stripped, every legitimate number left is either a price (≥ 900), a share
    // (≤ 1), a demand or profit (≫ 20), or a round number — and this audit runs
    // early, when at most one round has been played. So any survivor inside [10, 20]
    // could only be the draw, under ANY key name. Stripping minRounds/maxRounds is
    // sound precisely because the key allowlist above proves the range cannot appear
    // anywhere else.
    const stripped = JSON.parse(JSON.stringify(payload))
    delete stripped.minRounds
    delete stripped.maxRounds
    const suspicious = deepValues(stripped)
      .filter(v => typeof v === 'number' && v >= 10 && v <= 20)
    check(suspicious.length === 0,
      `${where}: no number inside the horizon range (the draw is ${leak.rounds}; found: ${JSON.stringify(suspicious)})`)
  }

  auditNoLeak(leak.state.result, ALLOWED_STATE_KEYS, 'pricingGetState (before any round)')

  const leakRound = await callFn('pricingSubmitPrice', asStudent(GID_K, KPID, { round: 1, price: 1500 }))
  auditNoLeak(leakRound.result, ALLOWED_SUBMIT_KEYS, 'pricingSubmitPrice (round 1)')
  const leakState = await callFn('pricingGetState', asStudent(GID_K, KPID))
  auditNoLeak(leakState.result, ALLOWED_STATE_KEYS, 'pricingGetState (mid-game)')

  // The same audit on the LAST round, where the server does know the game is ending —
  // the one response most at risk of leaking "…because that was round 13". The number
  // sweep is dropped here only because round numbers have legitimately grown into the
  // horizon range by now; the key allowlist and the word sweep still apply.
  for (let n = 2; n < leak.rounds; n++) {
    await callFn('pricingSubmitPrice', asStudent(GID_K, KPID, { round: n, price: 1500 }))
  }
  const finalRound = await callFn('pricingSubmitPrice',
    asStudent(GID_K, KPID, { round: leak.rounds, price: 1500 }))
  check(finalRound.result.gameOver === true, 'the final round reports gameOver')
  check(typeof finalRound.result.gameOver === 'boolean',
    'gameOver is a BOOLEAN, not a round number — it says the game ended, not how long it was')
  auditNoLeak(finalRound.result, ALLOWED_SUBMIT_KEYS, 'pricingSubmitPrice (FINAL round)',
    { checkNumbers: false })

  // The truth itself must still be there to be denied — the rules suite proves the
  // denial, this proves the data lives where the denial covers.
  const leakTruth = await getDoc(`pricing_game_instances/${GID_K}/truth/participant_${KPID}`)
  check(Number(leakTruth?.rounds?.integerValue) === leak.rounds,
    'the horizon lives in the rules-denied truth/ doc')
  const leakParticipant = await getDoc(`pricing_game_instances/${GID_K}/participants/${KPID}`)
  check(leakParticipant?.rounds_total === undefined && leakParticipant?.strategy === undefined,
    'the participant doc carries neither the horizon nor the competitor’s rule')

  // The competitor's rule is not in the student-READABLE config doc either — it lives
  // in truth/, which is the whole reason it is stored there rather than beside the
  // market parameters.
  const leakConfig = await getDoc(`pricing_game_instances/${GID_K}/config/main`)
  check(leakConfig?.standard_strategy === undefined && leakConfig?.pmg_strategy === undefined,
    'and the competitor rule ids are NOT in the student-readable config doc')

  // ── 10b. Grep-level check: the whitelist is upheld in the SOURCE ─────────────
  // A response audit can only test the paths the harness happens to walk. These two
  // greps pin the shape of the code that builds those responses, so a future edit that
  // widens them fails here even before a new response exists to audit.
  console.log('\n[10b] Grep-level: the callables never destructure or return the truth')
  const getStateSrc = fs.readFileSync(path.join(ROOT, 'functions/src/pricing/getState.ts'), 'utf8')
  const submitSrc = fs.readFileSync(path.join(ROOT, 'functions/src/pricing/submitPrice.ts'), 'utf8')

  const destructure = getStateSrc.match(/const\s*\{([^}]*)\}\s*=\s*await initPricingParticipant/)
  check(destructure != null && destructure[1].trim() === 'config',
    'pricingGetState destructures ONLY `config` out of the init result (not rounds, not strategy)')

  // Everything from the callable's final `return {` to the end of the file is the
  // response literal. Nothing in it may name the truth.
  // Word-boundary matches, deliberately: `minRounds:` and `maxRounds:` ARE returned
  // (the range is the one thing about the schedule a student may be told), and a
  // bare substring test would flag them while missing nothing extra.
  const TRUTH_TOKENS = [/\bstrategy\b/, /\btotalrounds\b/, /\brounds:/, /\bseed\b/]
  for (const [name, src] of [['pricingGetState', getStateSrc], ['pricingSubmitPrice', submitSrc]]) {
    const literal = src.slice(src.lastIndexOf('  return {')).toLowerCase()
    const named = TRUTH_TOKENS.filter(re => re.test(literal)).map(String)
    check(named.length === 0,
      `${name}'s returned object names none of the truth (found: ${JSON.stringify(named)})`)
  }
  // …and the guard itself is live: the same sweep DOES fire on a literal that names
  // the horizon, so a green result above means something.
  check(TRUTH_TOKENS.some(re => re.test('return { rounds: totalRounds }'.toLowerCase())),
    'the sweep would catch a returned `rounds:` (the guard is not vacuous)')


  // ═══════════════════════════════════════════════════════════════════════════
  // SLICE 3 — knowledge check, debrief, scoring, gradebook
  // ═══════════════════════════════════════════════════════════════════════════

  /** Answers every KC question the server SERVES, in order. `mode` picks whether the
   *  answers are right or wrong. Returns what the server said each time.
   *
   *  ⚠ IT SUBMITS EVERY QUESTION, not just the first. A harness that renders the set
   *  and answers one proves nothing about the grader knowing the rest — which is
   *  precisely the failure this whole section exists to catch. */
  async function answerKc(gid, pid, key, mode, label) {
    const served = await callFn('pricingGetQuestions', asStudent(gid, pid))
    if (!served.ok) { check(false, `${label}: pricingGetQuestions failed: ${served.error}`); return null }
    const qs = served.result.kc.derived
    check(qs.length === key.length,
      `${label}: serves ${key.length} questions (got ${qs.length})`)
    check(qs.map(q => q.field).join() === key.map(k => k.field).join(),
      `${label}: …the right ones, in order (${qs.map(q => q.field).join(', ')})`)

    const json = JSON.stringify(served.result)
    check(!json.includes('correct_value'), `${label}: ⚠ the answer key is NOT served`)
    check(!json.includes('explanation'), `${label}: ⚠ the explanations are NOT served ahead of answering`)

    const verdicts = []
    for (const q of qs) {
      const want = key.find(k => k.field === q.field)
      check(q.options.some(o => o.value === want.correct),
        `${label}: ${q.field} offers the spec's correct answer as an option (${want.correct})`)
      const answer = mode === 'correct'
        ? want.correct
        : q.options.find(o => o.value !== want.correct).value
      const res = await callFn('pricingSubmitKcAnswer', asStudent(gid, pid, { field: q.field, answer }))
      if (!res.ok) { check(false, `${label}: ${q.field} submit failed: ${res.error}`); return null }
      check(res.result.correct === (mode === 'correct'),
        `${label}: ${q.field} answered ${mode} → graded ${res.result.correct}`)
      check(typeof res.result.explanation === 'string' && res.result.explanation.length > 0,
        `${label}: ${q.field} returns its explanation, AFTER answering`)
      verdicts.push(res.result)
    }
    return { qs, verdicts }
  }

  // ── 11. The knowledge check, both modes (spec §8) ────────────────────────────
  console.log('\n[11] Knowledge check — every question served AND submitted')

  const GID_KS = `pricing-kc-std-${stamp}`
  const KSPID = 'pricing-kc-std-stu'
  await openInstance(GID_KS, KSPID, 'seed-kc-std')
  const stdKc = await answerKc(GID_KS, KSPID, KC_STANDARD, 'correct', 'Standard KC')
  check(!!stdKc, 'the Standard knowledge check completed')

  const kcDoc = await getDoc(`pricing_game_instances/${GID_KS}/participants/${KSPID}`)
  const kcScore = Number(kcDoc?.knowledge_check_score?.doubleValue ?? kcDoc?.knowledge_check_score?.integerValue)
  check(kcScore === 1, `all four correct scores 1.0 (got ${kcScore})`)
  check(kcDoc?.knowledge_check_completed_at != null, 'and stamps knowledge_check_completed_at')

  // The per-question lock: a resubmit with a DIFFERENT VALID option returns the
  // STORED verdict, never a second bite. (A resubmit with an option that does not
  // exist is rejected by the same argument check every answer passes — the lock is
  // about not re-grading, not about accepting nonsense.)
  const firstQ = stdKc.qs[0]
  const otherOption = firstQ.options.find(o => o.value !== KC_STANDARD[0].correct).value
  const relock = await callFn('pricingSubmitKcAnswer',
    asStudent(GID_KS, KSPID, { field: firstQ.field, answer: otherOption }))
  check(relock.ok && relock.result.correct === true,
    'a resubmit for an answered question returns the STORED verdict — a wrong answer cannot overwrite a right one')
  const relockDoc = await getDoc(`pricing_game_instances/${GID_KS}/participants/${KSPID}`)
  check(Number(relockDoc?.knowledge_check_score?.doubleValue ?? relockDoc?.knowledge_check_score?.integerValue) === 1,
    '…and the score is unchanged by the attempt')
  const bogus = await callFn('pricingSubmitKcAnswer',
    asStudent(GID_KS, KSPID, { field: firstQ.field, answer: 'not-an-option' }))
  check(!bogus.ok, 'an answer that is not one of the offered options is rejected')

  // A WRONG run: recorded, scored, and NOT a gate — the student still reaches the game.
  const GID_KW = `pricing-kc-wrong-${stamp}`
  const KWPID = 'pricing-kc-wrong-stu'
  await openInstance(GID_KW, KWPID, 'seed-kc-wrong')
  await answerKc(GID_KW, KWPID, KC_STANDARD, 'wrong', 'Standard KC (wrong)')
  const wrongDoc = await getDoc(`pricing_game_instances/${GID_KW}/participants/${KWPID}`)
  const wrongScore = Number(wrongDoc?.knowledge_check_score?.doubleValue ?? wrongDoc?.knowledge_check_score?.integerValue)
  check(wrongScore === 0, `all four wrong scores 0.0 (got ${wrongScore})`)
  const afterWrong = await callFn('pricingSubmitPrice', asStudent(GID_KW, KWPID, { round: 1, price: 1500 }))
  check(afterWrong.ok, '⚠ a student who got every question wrong still plays — the KC is no gate')

  // ⚠ THE DENOMINATOR IS WHATEVER WAS SERVED, never a hardcoded /4. A market whose
  // floor sits above unit cost makes the below-cost question meaningless, so it is
  // not served — and must not sit in anyone's denominator either.
  const GID_KD = `pricing-kc-denom-${stamp}`
  const KDPID = 'pricing-kc-denom-stu'
  await openInstance(GID_KD, KDPID, 'seed-kc-denom', {
    extraConfig: { market: { mapValue: { fields: { min_price: intVal(1200) } } } },
  })
  const denomServed = await callFn('pricingGetQuestions', asStudent(GID_KD, KDPID))
  check(denomServed.result.kc.derived.length === 3,
    `a floor above unit cost drops the below-cost question (${denomServed.result.kc.derived.length} served)`)
  check(!denomServed.result.kc.derived.some(q => q.field === 'kc_below_cost'),
    '…and it is that question specifically that is gone')
  for (const q of denomServed.result.kc.derived) {
    const want = KC_STANDARD.find(k => k.field === q.field)
    await callFn('pricingSubmitKcAnswer', asStudent(GID_KD, KDPID, { field: q.field, answer: want.correct }))
  }
  const denomDoc = await getDoc(`pricing_game_instances/${GID_KD}/participants/${KDPID}`)
  check(Number(denomDoc?.knowledge_check_score?.doubleValue ?? denomDoc?.knowledge_check_score?.integerValue) === 1,
    'three of three correct still scores 1.0 — the denominator followed the served set')
  const notServed = await callFn('pricingSubmitKcAnswer',
    asStudent(GID_KD, KDPID, { field: 'kc_below_cost', answer: 'negative' }))
  check(!notServed.ok, 'and a question this instance never served cannot be answered at all')

  // ── The PMG set: three questions, and NOT a repeat of the Standard four ──────
  const GID_KP = `pricing-kc-pmg-${stamp}`
  const KPPID = 'pricing-kc-pmg-stu'
  await openInstance(GID_KP, KPPID, 'seed-kc-pmg', { pmg: true })
  const pmgServed = await callFn('pricingGetQuestions', asStudent(GID_KP, KPPID))
  check(pmgServed.result.pmg === true, 'a PMG instance says so, so the client can open with the rules screen')
  check(!pmgServed.result.kc.derived.some(q => KC_STANDARD.some(k => k.field === q.field)),
    '⚠ the PMG set repeats NONE of the Standard four (students did those in instance 1)')
  const pmgKc = await answerKc(GID_KP, KPPID, KC_PMG, 'correct', 'PMG KC')
  check(!!pmgKc, 'the PMG knowledge check completed')

  // The diagnostic distractor (spec §8.2): the Standard formula's impossible answer
  // must be ON the share question, or a student carrying the wrong model has nothing
  // to reveal it with.
  const shareQ = pmgKc?.qs.find(q => q.field === 'kc_pmg_share')
  check(shareQ?.options.some(o => Number(o.value) > 1),
    'the PMG share question offers the >100% diagnostic distractor')

  // A Standard field is not a question in a PMG instance, and vice versa.
  const crossMode = await callFn('pricingSubmitKcAnswer',
    asStudent(GID_KP, KPPID, { field: 'kc_contribution', answer: '734' }))
  check(!crossMode.ok, 'a Standard question cannot be answered in a PMG instance')

  // ── 12. The debrief + the competitor reveal (spec §9) ────────────────────────
  console.log('\n[12] Debrief — the prompt per mode, and the reveal gated on the game being over')

  const GID_D = `pricing-debrief-${stamp}`
  const DPID = 'pricing-debrief-stu'
  const dbrief = await openInstance(GID_D, DPID, 'seed-debrief')

  const midQs = await callFn('pricingGetQuestions', asStudent(GID_D, DPID))
  check(midQs.result.debrief?.prompt.startsWith('In a few sentences, explain your pricing strategy'),
    'Standard mode serves the STANDARD debrief prompt (spec §9)')
  check(midQs.result.competitorReveal === null,
    '⚠ mid-game, the competitor reveal is NULL — the rule is not sent before the game ends')
  check(!JSON.stringify(midQs.result).toLowerCase().includes('best'),
    '⚠ …and no part of the mid-game payload describes the rule either')

  const pmgQs = await callFn('pricingGetQuestions', asStudent(GID_KP, KPPID))
  check(pmgQs.result.debrief?.prompt.startsWith('In a few sentences, explain how you set prices under the Price Matching'),
    'PMG mode serves the PMG debrief prompt (spec §9)')

  // Play the game out, then ask again.
  for (let n = 1; n <= dbrief.rounds; n++) {
    await callFn('pricingSubmitPrice', asStudent(GID_D, DPID, { round: n, price: 1500 }))
  }
  const endQs = await callFn('pricingGetQuestions', asStudent(GID_D, DPID))
  check(typeof endQs.result.competitorReveal === 'string'
    && endQs.result.competitorReveal.startsWith('Your competitor was programmed to'),
    `⚠ once the game is over the reveal arrives ("${String(endQs.result.competitorReveal).slice(0, 48)}…")`)
  check(/best|grid|profit/i.test(endQs.result.competitorReveal),
    '…and it actually describes the Standard rule in plain language')
  check(!/the bot/i.test(endQs.result.competitorReveal),
    '…without ever calling it "the bot" (spec §1)')

  const badDebrief = await callFn('pricingSubmitDebrief', asStudent(GID_D, DPID, { answer: '   ' }))
  check(!badDebrief.ok, 'an empty debrief is rejected')

  const wrote = await callFn('pricingSubmitDebrief',
    asStudent(GID_D, DPID, { answer: 'I opened high, watched it undercut me, and settled near the middle.' }))
  check(wrote.ok && wrote.result.stored === false, 'the debrief paragraph submits')
  const again = await callFn('pricingSubmitDebrief', asStudent(GID_D, DPID, { answer: 'Something else entirely.' }))
  check(again.ok && again.result.stored === true && again.result.answer.startsWith('I opened high'),
    'and is one-shot: a second submit returns the stored paragraph, unchanged')
  const debriefDoc = await getDoc(`pricing_game_instances/${GID_D}/participants/${DPID}`)
  check(debriefDoc?.debrief_answers != null && debriefDoc?.debrief_completed_at != null,
    'the paragraph is stored where the Tier-2 report will read it')
  check(debriefDoc?.knowledge_check_score === undefined,
    '⚠ the ungraded debrief did NOT touch the knowledge-check score')

  // ── 13. Score & Record → the classroom gradebook (spec §7) ───────────────────
  console.log('\n[13] Participation scoring + the gradebook push')

  const GID_S1 = `pricing-score-${stamp}`
  const finisher = 'pricing-finisher'
  const quitter = 'pricing-quitter'
  const scoreInst = await openInstance(GID_S1, finisher, 'seed-score')
  await openInstance(GID_S1, quitter, 'seed-score')

  for (let n = 1; n <= scoreInst.rounds; n++) {
    await callFn('pricingSubmitPrice', asStudent(GID_S1, finisher, { round: n, price: 1500 }))
  }
  await callFn('pricingSubmitPrice', asStudent(GID_S1, quitter, { round: 1, price: 1800 }))
  await callFn('pricingSubmitPrice', asStudent(GID_S1, quitter, { round: 2, price: 1800 }))

  // A third student is enrolled by the roster sync but never launches at all.
  const sync = await callFn('pricingSyncRoster', {
    _dev: { game_instance_id: GID_S1, roster_url: ROSTER_URL, callback_secret: CALLBACK_SECRET },
  })
  check(sync.ok && sync.result.synced === 3, `pricingSyncRoster pre-created the roster (${sync.result?.synced})`)
  const absentDoc = await getDoc(`pricing_game_instances/${GID_S1}/participants/pricing-absent`)
  check(absentDoc !== null && absentDoc.finished_at === undefined,
    'a rostered student who never launched has an identity-only doc')
  const quitterAfterSync = await getDoc(`pricing_game_instances/${GID_S1}/participants/${quitter}`)
  check(quitterAfterSync?.rounds?.arrayValue?.values?.length === 2,
    'the roster sync did NOT clobber a student who had already played (safe identity-only merge)')

  const pushBefore = pushCount
  const score = await callFn('pricingScoreAndRecord', {
    _dev: { game_instance_id: GID_S1, callback_url: CALLBACK_URL, callback_secret: CALLBACK_SECRET },
  })
  check(score.ok, 'pricingScoreAndRecord succeeds')
  check(score.result.scored === 3 && score.result.finishers === 1,
    `scored 3 students, 1 finisher (got ${score.result?.scored}/${score.result?.finishers})`)
  check(pushCount - pushBefore === 3, `pushed 3 grade records (got ${pushCount - pushBefore})`)
  check(badlySigned.length === 0,
    `⚠ every push carried a VALID Bearer signature (rejected: ${badlySigned.length})`)

  const finDoc = await getDoc(`pricing_game_instances/${GID_S1}/participants/${finisher}`)
  const quitDoc = await getDoc(`pricing_game_instances/${GID_S1}/participants/${quitter}`)
  const absDoc = await getDoc(`pricing_game_instances/${GID_S1}/participants/pricing-absent`)
  const norm = (d) => Number(d?.normalized_score?.doubleValue ?? d?.normalized_score?.integerValue)
  check(Number(finDoc?.raw_score?.integerValue) === 1 && norm(finDoc) === 0,
    'a finisher gets participation raw_score 1, normalizing to 0 (zero-SD pool)')
  check(quitDoc?.raw_score?.nullValue !== undefined && norm(quitDoc) === -2,
    'a student who played but never finished gets the −2 floor')
  check(absDoc?.raw_score?.nullValue !== undefined && norm(absDoc) === -2,
    'and so does one who never launched')

  // ⚠ PROFITS ARE NEVER GRADED (spec §7) — they are report fields only.
  check(finDoc?.profit_total != null && finDoc?.average_price != null,
    'profit and average price are written for the reports…')
  const pushedForFinisher = pushed.slice(-3).find(r => JSON.stringify(r).includes(finisher))
  check(pushedForFinisher != null, 'the finisher is in the pushed batch')
  check(!JSON.stringify(pushedForFinisher).includes('profit'),
    '⚠ …and NO profit figure reaches the gradebook payload')
  check(JSON.stringify(pushedForFinisher).includes('normalized_score'),
    'the payload carries normalized_score')

  // ── TWO INSTANCES, TWO ENTRIES (spec §14) ───────────────────────────────────
  // The same student plays a Standard instance and a PMG instance of the SAME game.
  // Nothing in the code knows about the pairing; the entries are distinct because the
  // instances are, and this asserts that end to end.
  const GID_TWO_STD = `pricing-two-std-${stamp}`
  const GID_TWO_PMG = `pricing-two-pmg-${stamp}`
  const BOTH = 'pricing-plays-both'
  const twoStd = await openInstance(GID_TWO_STD, BOTH, 'seed-two-a')
  const twoPmg = await openInstance(GID_TWO_PMG, BOTH, 'seed-two-b', { pmg: true })
  for (let n = 1; n <= twoStd.rounds; n++) {
    await callFn('pricingSubmitPrice', asStudent(GID_TWO_STD, BOTH, { round: n, price: 1600 }))
  }
  for (let n = 1; n <= twoPmg.rounds; n++) {
    await callFn('pricingSubmitPrice', asStudent(GID_TWO_PMG, BOTH, { round: n, price: 1900 }))
  }

  const twoBefore = pushCount
  await callFn('pricingScoreAndRecord', {
    _dev: { game_instance_id: GID_TWO_STD, callback_url: CALLBACK_URL, callback_secret: CALLBACK_SECRET },
  })
  await callFn('pricingScoreAndRecord', {
    _dev: { game_instance_id: GID_TWO_PMG, callback_url: CALLBACK_URL, callback_secret: CALLBACK_SECRET },
  })
  check(pushCount - twoBefore === 2, `two instances pushed two records (got ${pushCount - twoBefore})`)

  const twoRecords = pushed.slice(-2)
  const flat = twoRecords.map(r => JSON.stringify(r))
  check(flat.every(j => j.includes(BOTH)), 'both records are for the same student')
  check(flat[0] !== flat[1], '⚠ …and they are DISTINCT entries, not one overwriting the other')
  check(flat.some(j => j.includes(GID_TWO_STD)) && flat.some(j => j.includes(GID_TWO_PMG)),
    'each carries its own game_instance_id — which is what makes them two gradebook rows')


  // ── 14. Instructor settings (spec §3) ────────────────────────────────────────
  console.log('\n[14] Instructor settings — round trip, and the never-stale chain')

  const GID_SET = `pricing-settings-${stamp}`
  const SETPID = 'pricing-settings-stu'

  const cfg0 = await callFn('pricingGetConfig', asDev(GID_SET))
  check(cfg0.ok, 'pricingGetConfig succeeds on an untouched instance')
  check(cfg0.result.pmg === false, 'a fresh instance is Standard')
  check(cfg0.result.market.marketSize === 190_000 && cfg0.result.market.studentUnitCost === 966,
    'and carries the shipped case market')
  check(cfg0.result.minRounds === 10 && cfg0.result.maxRounds === 20, 'and the shipped [10,20] range')
  check(cfg0.result.anyRoundsDrawn === false && cfg0.result.anyRoundsPlayed === false,
    'nobody has launched or played yet')
  check(cfg0.result.derivedKcPreview.length === 4, 'previews the four derived Standard questions')
  check(cfg0.result.competitorRule.id === 'standard-highstart-bestreply',
    'and names the rule this mode runs (display only)')
  check(Math.round(cfg0.result.equilibrium.student) === 1394,
    'and the equilibrium the current market implies ($1,394)')
  check(!JSON.stringify(cfg0.result).includes('"rounds"'),
    '⚠ the instructor settings page never receives any student’s drawn count')

  // ── Validation ────────────────────────────────────────────────────────────
  const badShares = await callFn('pricingUpdateConfig', {
    ...asDev(GID_SET),
    market: { ...cfg0.result.market, studentBaseShare: 0.4, competitorBaseShare: 0.5 },
  })
  check(!badShares.ok && /add up to 1/.test(badShares.error), 'rejects base shares that do not sum to 1')
  const zeroShare = await callFn('pricingUpdateConfig', {
    ...asDev(GID_SET), market: { ...cfg0.result.market, studentBaseShare: 0, competitorBaseShare: 1 },
  })
  check(!zeroShare.ok, 'rejects a zero base share')
  const badBounds = await callFn('pricingUpdateConfig', {
    ...asDev(GID_SET), market: { ...cfg0.result.market, minPrice: 2000, maxPrice: 900 },
  })
  check(!badBounds.ok, 'rejects an inverted price band')
  const badCost = await callFn('pricingUpdateConfig', {
    ...asDev(GID_SET), market: { ...cfg0.result.market, studentUnitCost: 2500 },
  })
  check(!badCost.ok && /below the maximum price/.test(badCost.error),
    'rejects a unit cost at or above the ceiling — no price could ever be profitable')
  const badSlope = await callFn('pricingUpdateConfig', {
    ...asDev(GID_SET), market: { ...cfg0.result.market, slope: 0 },
  })
  check(!badSlope.ok, 'rejects a zero share slope')
  const badRange = await callFn('pricingUpdateConfig', { ...asDev(GID_SET), minRounds: 9, maxRounds: 4 })
  check(!badRange.ok, 'rejects min > max on the round range')
  const badLabels = await callFn('pricingUpdateConfig', { ...asDev(GID_SET), labels: { student: '', competitor: 'W' } })
  check(!badLabels.ok, 'rejects an empty firm name')
  const reservedId = await callFn('pricingUpdateConfig', {
    ...asDev(GID_SET),
    addedKcQuestions: [{ id: 'kc_base_share', type: 'mc', prompt: 'Sneaky',
      options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }], correct_value: 'a' }],
  })
  check(!reservedId.ok, '⚠ rejects an added question claiming a reserved kc_ id')

  // ── A real edit, and THE NEVER-STALE CHAIN ────────────────────────────────
  // One market edit must move, in one flow: the KC's numbers AND answers, the
  // competitor's best reply, the student's screen, and the Tier-3 reference.
  const EDITED = {
    marketSize: 250_000,
    studentBaseShare: 0.4,
    competitorBaseShare: 0.6,
    studentUnitCost: 1000,
    competitorUnitCost: 950,
    slope: 800,
    minPrice: 1000,
    maxPrice: 2400,
    gridStep: 100,
  }
  const saved = await callFn('pricingUpdateConfig', {
    ...asDev(GID_SET),
    market: EDITED,
    labels: { student: 'Cheyenne', competitor: 'Western' },
    minRounds: 3,
    maxRounds: 4,
    debriefPrompt: 'What was your pricing plan?',
  })
  check(saved.ok, 'a valid settings save succeeds')
  check(saved.result.market.marketSize === 250_000 && saved.result.market.slope === 800,
    'the save returns the STORED market')
  check(saved.result.labels.student === 'Cheyenne', 'and the new firm labels')

  // The equilibrium the settings page shows follows the edit.
  const wantEq = (2 * (EDITED.studentBaseShare * EDITED.slope + EDITED.studentUnitCost)
    + (EDITED.competitorBaseShare * EDITED.slope + EDITED.competitorUnitCost)) / 3
  check(Math.abs(saved.result.equilibrium.student - wantEq) < 1e-6,
    `⚠ the equilibrium reference moved with the market (${saved.result.equilibrium.student.toFixed(2)})`)

  // The KC's derived questions and ANSWERS followed too.
  const editedTheirs = EDITED.maxPrice - EDITED.gridStep          // 2300
  const editedYours = editedTheirs - 2 * EDITED.gridStep          // 2100
  const preview = saved.result.derivedKcPreview
  check(preview.find(q => q.field === 'kc_base_share')?.correct_value === '0.4000',
    '⚠ the base-share question’s ANSWER followed the new base share (40%)')
  check(preview.find(q => q.field === 'kc_contribution')?.correct_value === String(editedYours - EDITED.studentUnitCost),
    `⚠ the contribution answer followed the new unit cost (${editedYours - EDITED.studentUnitCost})`)
  check(preview.find(q => q.field === 'kc_share_gap')?.prompt.includes('$2,100'),
    '⚠ and the questions are posed at prices INSIDE the new band')

  // The STUDENT sees the same thing, and is graded against it.
  await callFn('pricingBootstrap', asStudent(GID_SET, SETPID))
  const sState = await callFn('pricingGetState', asStudent(GID_SET, SETPID))
  check(sState.result.market.marketSize === 250_000 && sState.result.market.minPrice === 1000,
    'the student is served the new market')
  check(sState.result.labels.student === 'Cheyenne', 'and the new firm labels')
  check(sState.result.minRounds === 3 && sState.result.maxRounds === 4, 'and the new round RANGE')
  const sQs = await callFn('pricingGetQuestions', asStudent(GID_SET, SETPID))
  check(sQs.result.kc.derived.find(q => q.field === 'kc_share_gap')?.prompt.includes('$2,100'),
    'the student’s KC is posed at the new prices')
  check(sQs.result.debrief.prompt === 'What was your pricing plan?', 'and the edited debrief prompt')
  const gradeNew = await callFn('pricingSubmitKcAnswer',
    asStudent(GID_SET, SETPID, { field: 'kc_base_share', answer: '0.4000' }))
  check(gradeNew.ok && gradeNew.result.correct === true,
    '⚠ and the GRADER marks the new market’s answer correct — serve and grade moved together')
  const gradeOld = await callFn('pricingSubmitKcAnswer',
    asStudent(GID_SET, SETPID, { field: 'kc_contribution', answer: '734' }))
  check(!gradeOld.ok || gradeOld.result.correct === false,
    '…and the OLD market’s answer is no longer correct')

  // The COMPETITOR's best reply moved too: round 1 is the new ceiling.
  const editedRound = await callFn('pricingSubmitPrice', asStudent(GID_SET, SETPID, { round: 1, price: 2000 }))
  check(editedRound.ok && editedRound.result.round.competitorPrice === EDITED.maxPrice,
    `⚠ the competitor opens at the NEW ceiling (${EDITED.maxPrice})`)
  check(near(editedRound.result.round.yourShare, 0.4 + (EDITED.maxPrice - 2000) / EDITED.slope),
    '…and the round is computed in the new market (new base share, new slope)')

  // The REPORT's reference line moved as well — one edit, the whole chain.
  const editedReport = await callFn('pricingGetReport', asDev(GID_SET))
  check(Math.abs(editedReport.result.summary.equilibrium.student - wantEq) < 1e-6,
    '⚠ and the Tier-3 dashed line is the same moved equilibrium')

  // ── ⚠ A RANGE EDIT MUST NOT REDRAW AN ALREADY-LAUNCHED STUDENT ────────────
  const drawnTruth = await getDoc(`pricing_game_instances/${GID_SET}/truth/participant_${SETPID}`)
  const drawn = Number(drawnTruth?.rounds?.integerValue)
  check(drawn >= 3 && drawn <= 4, `the draw used the configured range (${drawn} ∈ [3,4])`)
  const cfgAfter = await callFn('pricingGetConfig', asDev(GID_SET))
  check(cfgAfter.result.anyRoundsDrawn === true, 'settings now reports that someone has started')
  check(cfgAfter.result.anyRoundsPlayed === true, '…and that someone has actually played')

  await callFn('pricingUpdateConfig', { ...asDev(GID_SET), minRounds: 15, maxRounds: 20 })
  await callFn('pricingGetState', asStudent(GID_SET, SETPID))   // a touch that could have redrawn
  const truthAfter = await getDoc(`pricing_game_instances/${GID_SET}/truth/participant_${SETPID}`)
  check(Number(truthAfter?.rounds?.integerValue) === drawn,
    `⚠ widening the range did NOT redraw the launched student (still ${drawn}) — they keep their horizon`)
  const LATE = 'pricing-settings-latecomer'
  await callFn('pricingBootstrap', asStudent(GID_SET, LATE))
  await callFn('pricingGetState', asStudent(GID_SET, LATE))
  const lateDrawn = Number((await getDoc(`pricing_game_instances/${GID_SET}/truth/participant_${LATE}`))?.rounds?.integerValue)
  check(lateDrawn >= 15 && lateDrawn <= 20,
    `a student who launches AFTER the edit draws in the new range (${lateDrawn} ∈ [15,20])`)

  // ── THE PMG TOGGLE, flipped on a fresh instance ───────────────────────────
  // Everything downstream is already config-driven (Slices 1–4); this asserts the one
  // flag actually reaches all of it, rather than rebuilding any of it.
  const GID_TOG = `pricing-toggle-${stamp}`
  const TOGPID = 'pricing-toggle-stu'
  const beforeToggle = await callFn('pricingGetConfig', asDev(GID_TOG))
  check(beforeToggle.result.competitorRule.id === 'standard-highstart-bestreply',
    'before the toggle: the Standard rule')
  const toggled = await callFn('pricingUpdateConfig', { ...asDev(GID_TOG), pmg: true })
  check(toggled.ok && toggled.result.pmg === true, 'the PMG toggle saves')
  check(toggled.result.competitorRule.id === 'pmg-ceiling', '⚠ …the competitor rule switched')
  check(toggled.result.derivedKcPreview.length === 3
    && toggled.result.derivedKcPreview[0].field === 'kc_pmg_effective',
    '⚠ …the KC set switched to the PMG three')
  check(toggled.result.equilibrium.student === toggled.result.market.maxPrice,
    '⚠ …the Tier-3 reference became the ceiling')
  await callFn('pricingBootstrap', asStudent(GID_TOG, TOGPID))
  const togQs = await callFn('pricingGetQuestions', asStudent(GID_TOG, TOGPID))
  check(togQs.result.pmg === true, '⚠ …the student is told to show the PMG rules screen')
  check(togQs.result.debrief.prompt.startsWith('In a few sentences, explain how you set prices under'),
    '⚠ …and gets the PMG debrief prompt')
  const togRound = await callFn('pricingSubmitPrice', asStudent(GID_TOG, TOGPID, { round: 1, price: 1500 }))
  check(togRound.result.round.effectivePrice === 1500 && near(togRound.result.round.yourShare, 0.35),
    '⚠ …and the round is computed under PMG rules (effective price, frozen share)')

  // ── Instructor-added KC questions (PD's pattern, mirrored) ────────────────
  const GID_ADD = `pricing-added-${stamp}`
  const ADDPID = 'pricing-added-stu'
  const addedMc = { id: 'akc_one', type: 'mc', prompt: 'Which price did you plan to open with?',
    options: [{ value: 'a', label: 'High' }, { value: 'b', label: 'Low' }], correct_value: 'b' }
  const addedText = { id: 'akc_two', type: 'text', prompt: 'Why?' }
  const addSave = await callFn('pricingUpdateConfig', { ...asDev(GID_ADD), addedKcQuestions: [addedMc, addedText] })
  check(addSave.ok && addSave.result.addedKcQuestions.length === 2, 'two added questions saved')

  await callFn('pricingBootstrap', asStudent(GID_ADD, ADDPID))
  const aQs = await callFn('pricingGetQuestions', asStudent(GID_ADD, ADDPID))
  check(aQs.result.kc.derived.length === 4 && aQs.result.kc.added.length === 2,
    '⚠ the two sources arrive SEPARATELY (4 derived + 2 added), never flattened')
  check(!JSON.stringify(aQs.result.kc.added).includes('correct_value'),
    '…and the added questions ship no answer key either')

  for (const q of aQs.result.kc.derived) {
    const want = KC_STANDARD.find(k => k.field === q.field)
    await callFn('pricingSubmitKcAnswer', asStudent(GID_ADD, ADDPID, { field: q.field, answer: want.correct }))
  }
  const mcRes = await callFn('pricingSubmitKcAnswer', asStudent(GID_ADD, ADDPID, { field: 'akc_one', answer: 'b' }))
  check(mcRes.ok && mcRes.result.correct === true && mcRes.result.graded === true,
    'an added multiple-choice question is graded against the instructor’s own key')
  const textRes = await callFn('pricingSubmitKcAnswer',
    asStudent(GID_ADD, ADDPID, { field: 'akc_two', answer: 'I wanted the volume.' }))
  check(textRes.ok && textRes.result.graded === false,
    '⚠ an added FREE-TEXT question is recorded, never graded')
  const addDoc = await getDoc(`pricing_game_instances/${GID_ADD}/participants/${ADDPID}`)
  const addScore = Number(addDoc?.knowledge_check_score?.doubleValue ?? addDoc?.knowledge_check_score?.integerValue)
  check(addScore === 1,
    `⚠ the score is 5/5 over the four derived + the graded added one — the free-text one is in NEITHER numerator nor denominator (got ${addScore})`)

  // ── ⚠⚠ The shared KC surface, AT THE CALLABLES ──────────────────────────────
  //
  // ⚠⚠ TESTS WHAT THE CALLABLE SERVES, NOT THE HELPER. The unit suite passes stage and
  // mode explicitly, so a mutation that drops an argument at the call site is invisible to
  // it. That class of mutant survived first calibration in BOTH previous passes; this
  // section is what catches it here.
  console.log('\n[KC] The shared KC surface, at the callables')
  {
    const GIDK = `pricing-kc-${Date.now()}`
    const KPID = 'pricing-kc-stu'

    const inv0 = await callFn('pricingGetConfig', asDev(GIDK))
    check(inv0.ok && inv0.result.kc != null, 'pricingGetConfig returns the kc inventory')
    const kc0 = inv0.result.kc
    check(kc0.builtIn.length === 4, `⚠ the STANDARD set is listed — four questions (${kc0.builtIn.length})`)
    check(kc0.builtIn.every(q => q.locked), '⚠⚠ ALL FOUR are LOCKED — every one is built from the market')
    check(kc0.builtIn.every(q => (q.lockReason ?? '').length > 0),
      '⚠ …and every locked row carries a REASON')
    check(kc0.debrief != null && kc0.debrief.id === 'debrief_reflection'
      && kc0.debrief.stage === 'post' && kc0.debrief.graded === false,
    '⚠⚠ THE DEBRIEF IS A ROW in the post stage, and never graded')
    check(kc0.gradedCount === 4 && kc0.poolTotal === 5,
      `the count line reads 5 in the pool, 4 graded (${kc0.poolTotal}/${kc0.gradedCount})`)

    // ── Overrides refused on a locked question, AT THE CALLABLE ────────────
    const ovLocked = await callFn('pricingUpdateConfig',
      { ...asDev(GIDK), kcOverrides: { kc_base_share: { prompt: 'mine' } } })
    check(!ovLocked.ok && (ovLocked.error ?? '').includes('cannot be edited'),
      '⚠⚠ an override on a LOCKED question is REFUSED, with a reason')
    const ovDebrief = await callFn('pricingUpdateConfig',
      { ...asDev(GIDK), kcOverrides: { debrief_reflection: { prompt: 'x' } } })
    check(!ovDebrief.ok, '⚠ an override aimed at the DEBRIEF row is refused')

    // ── Hidden: not served, and out of the denominator ─────────────────────
    const hid = await callFn('pricingUpdateConfig', { ...asDev(GIDK), kcHidden: { kc_contribution: true } })
    check(hid.ok && hid.result.kc.gradedCount === 3,
      `⚠ hiding one question moves the count line to 3 graded (${hid.result?.kc?.gradedCount})`)

    await callFn('pricingBootstrap', asStudent(GIDK, KPID))
    const qs = await callFn('pricingGetQuestions', asStudent(GIDK, KPID))
    check(!qs.result.kc.derived.some(q => q.field === 'kc_contribution'),
      '⚠⚠ a hidden question is NOT SERVED to the student')
    check(qs.result.kc.derived.length === 3, `three derived questions remain (${qs.result.kc.derived.length})`)
    const hidSubmit = await callFn('pricingSubmitKcAnswer',
      asStudent(GIDK, KPID, { field: 'kc_contribution', answer: '0' }))
    check(!hidSubmit.ok, '⚠⚠ …and SUBMITTING it is refused')

    // ── ⚠ THE `ordered` FLAG, through the callable ─────────────────────────
    const firstOf = {}
    for (let i = 0; i < 25; i++) {
      const r = await callFn('pricingGetQuestions', asStudent(GIDK, `pricing-ord-${i}`))
      for (const q of r.result.kc.derived) {
        firstOf[q.field] = firstOf[q.field] ?? new Set()
        firstOf[q.field].add(q.options[0].value)
      }
    }
    check(firstOf.kc_base_share.size === 1,
      '⚠⚠ kc_base_share is a numeric ladder and does NOT shuffle — one order for everyone')
    check(firstOf.kc_share_gap.size === 1, '⚠ …nor does kc_share_gap')
    check(firstOf.kc_below_cost.size > 1,
      '⚠⚠ …while the CATEGORICAL kc_below_cost DOES shuffle')

    // ── ⚠ THE MODE SWAP, through the callable ──────────────────────────────
    const toPmg = await callFn('pricingUpdateConfig', { ...asDev(GIDK), pmg: true })
    check(toPmg.ok, 'flipping to PMG saves')
    check(toPmg.result.kc.builtIn.length === 3
      && toPmg.result.kc.builtIn.every(q => q.id.startsWith('kc_pmg')),
    '⚠ the PMG set replaces the Standard one entirely')
    check(toPmg.result.kc.gradedCount === 3,
      `⚠⚠ …and the Standard HIDE does not apply here — 3 graded, not 2 (${toPmg.result.kc.gradedCount})`)

    const backToStd = await callFn('pricingUpdateConfig', { ...asDev(GIDK), pmg: false })
    check(backToStd.ok && backToStd.result.kc.gradedCount === 3,
      '⚠⚠ …and flipping BACK restores the Standard hide — the edit was never lost')
    check(backToStd.result.kcHidden.kc_contribution === true,
      'the stored hide survived the round trip through PMG')

    // ── The debrief row writes to the EXISTING key ─────────────────────────
    const dbSave = await callFn('pricingUpdateConfig',
      { ...asDev(GIDK), debriefPrompt: 'Rewritten by the row.' })
    check(dbSave.ok, 'the debrief row\'s prompt saves')
    const dbDoc = await getDoc(`pricing_game_instances/${GIDK}/config/main`)
    check(dbDoc?.debrief_prompt?.stringValue === 'Rewritten by the row.',
      '⚠⚠ …to the EXISTING `debrief_prompt` key — NO storage migration')
    check(dbDoc?.kc_overrides == null || !JSON.stringify(dbDoc.kc_overrides).includes('debrief_reflection'),
      '⚠ …and NOT into kc_overrides')

    // ── ⚠ A POST-STAGE ADDITION is served after the results and IS graded ──
    const staged = await callFn('pricingUpdateConfig', {
      ...asDev(GIDK),
      addedKcQuestions: [
        { id: 'akc_pre', type: 'mc', prompt: 'Before play?', stage: 'pre',
          options: [{ value: 'p0', label: 'P0' }, { value: 'p1', label: 'P1' }], correct_value: 'p0' },
        { id: 'akc_post', type: 'mc', prompt: 'After the results?', stage: 'post',
          options: [{ value: 'a0', label: 'A0' }, { value: 'a1', label: 'A1' },
            { value: 'a2', label: 'A2' }, { value: 'a3', label: 'A3' }], correct_value: 'a0' },
        { id: 'akc_legacy', type: 'mc', prompt: 'No stage — must stay BEFORE play.',
          options: [{ value: 'l0', label: 'L0' }, { value: 'l1', label: 'L1' }], correct_value: 'l0' },
      ],
    })
    check(staged.ok, 'added questions with an explicit stage save')
    check(staged.result.kc.added.find(q => q.id === 'akc_legacy').stage === 'pre',
      '⚠⚠ a stage-less addition stays BEFORE play — nothing already stored moves')

    const sq = await callFn('pricingGetQuestions', asStudent(GIDK, 'pricing-stage-stu'))
    const preIds = sq.result.kc.added.map(q => q.field)
    const postIds = sq.result.postStage.map(q => q.field)
    check(preIds.includes('akc_pre') && preIds.includes('akc_legacy') && !preIds.includes('akc_post'),
      '⚠⚠ the pre list holds the pre + legacy questions and NOT the post one')
    check(postIds.includes('akc_post') && postIds[0] === 'debrief_reflection',
      '⚠ the post stage leads with the debrief row and carries the after-results question')
    check(!JSON.stringify(sq.result.postStage).includes('correct_value'),
      '⚠ the post payload ships no answer key')
  }

  console.log(`\n${failed === 0 ? '✅' : '❌'} pricing harness: ${passed} passed, ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch(err => {
  console.error('harness crashed:', err)
  process.exit(1)
})
