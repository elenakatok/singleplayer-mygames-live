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
// Later slices extend this file with the KC, the debrief, and Score & Record.
//
// Run (clean start — the emulator boots fresh, runs this, and shuts down):
//   npm run harness:pricing
// which is, expanded (build both first):
//   cd functions && npm run build && cd ../frontend && npm run build && cd ..
//   firebase emulators:exec --only functions,firestore,auth --project demo-singleplayer \
//     --config firebase.json "node pricing-playthrough.mjs"
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

  console.log(`\n${failed === 0 ? '✅' : '❌'} pricing harness: ${passed} passed, ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch(err => {
  console.error('harness crashed:', err)
  process.exit(1)
})
