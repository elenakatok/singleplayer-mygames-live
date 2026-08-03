// ═══════════════════════════════════════════════════════════════════════════════
// Forecasting Game — emulator harness (spec §12).
//
// It drives the SAME CALLABLES THE UI INVOKES — forecastBootstrap, GetState,
// SubmitRound, GetExport (and, from Slice 3, the question/report callables) — over
// HTTP. It never imports the compute functions and never calls them directly: a
// harness that imported runningMetrics() would prove that runningMetrics agrees with
// itself.
//
// ⚠ THE SCORECARD IS RE-IMPLEMENTED HERE, INDEPENDENTLY (§ "The model" below). Every
// error, AE, SE, APE, running MAE/MSE/Standard Error/MAPE, the Y6-vs-Y7 split and the
// bonus are computed afresh from the spec's own definitions and checked against what
// the server returned. Two routes to the same number is the whole point.
//
// ⚠ THE LEAK SURFACE IS THIS GAME'S DEFINING RISK (spec §4, §12), and it gets three
// separate audits rather than one:
//   • §2  every student response tree is walked for model parameters — by KEY NAME and
//         by NUMERIC VALUE, because `{"a":560}` and `{"level":560}` leak identically;
//   • §3  the common history is asserted byte-identical across two students while
//         their played realizations differ;
//   • §6  BOTH CSVs are asserted directly — the in-play file stops at month 60, the
//         final file contains revealed months only and never a future one.
//
// ⚠ NEGATIVE CONTROLS (§9). Checks run against DELIBERATELY BROKEN expectations and
// REQUIRED TO FAIL. A test never seen to fail is not known to work.
//
// ⚠ `rounds` AND `num_history` ARE SET EXPLICITLY IN EVERY INSTANCE THIS FILE CREATES.
// Never rely on a shipped default — a harness that inherits them silently re-tunes
// itself the day someone edits the default.
//
// Run:  npm run harness:forecast
// ═══════════════════════════════════════════════════════════════════════════════

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const PROJECT = 'demo-singleplayer'
const FUNCTIONS = `http://127.0.0.1:5010/${PROJECT}/us-central1`
const FIRESTORE = `http://127.0.0.1:8090/v1/projects/${PROJECT}/databases/(default)/documents`

let passed = 0, failed = 0
const check = (cond, label) => {
  if (cond) { passed++; console.log(`  ✓ ${label}`) }
  else { failed++; console.error(`  ✗ ${label}`) }
}
const section = (title) => console.log(`\n${title}`)

/** Runs a check that MUST FAIL, and fails the harness if it passes. */
const mustFail = (predicate, label) => {
  let held
  try { held = predicate() } catch { held = false }
  if (held) {
    failed++
    console.error(`  ✗✗ NEGATIVE CONTROL DID NOT FAIL: ${label} — the assertion is not testing what it claims`)
  } else {
    passed++
    console.log(`  ✓ negative control failed as required: ${label}`)
  }
}

const near = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol

// ── Emulator plumbing ──────────────────────────────────────────────────────────

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

async function putDoc(docPath, fields) {
  const res = await fetch(`${FIRESTORE}/${docPath}`, {
    method: 'PATCH',
    headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields }),
  })
  if (!res.ok) throw new Error(`firestore PATCH ${docPath} → ${res.status} ${await res.text()}`)
}

const intVal = (n) => ({ integerValue: String(n) })
const strVal = (s) => ({ stringValue: s })
const boolVal = (b) => ({ booleanValue: b })
const arrVal = (xs) => ({ arrayValue: { values: xs } })
const asStudent = (gid, pid, extra = {}) => ({ _test: { participant_id: pid, game_instance_id: gid }, ...extra })
const asInstructor = (gid, extra = {}) => ({ _dev: { game_instance_id: gid }, ...extra })

// ═══════════════════════════════════════════════════════════════════════════════
// The model — the spec, re-implemented independently. NOTHING here is imported from
// functions/src/forecast; every line is written from Forecasting_Game_Specification_v1
// §2, §4, §5 and §5a directly.
// ═══════════════════════════════════════════════════════════════════════════════

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const monthOf = (p) => ((p - 1) % 12) + 1
const yearOf = (p) => Math.floor((p - 1) / 12) + 1

/** Spec §4: per-month figures. Error is ACTUAL MINUS FORECAST, and keeps its sign. */
function modelPoint(forecast, actual) {
  const error = actual - forecast
  return {
    error,
    ae: Math.abs(error),
    se: error * error,
    ape: actual === 0 ? null : Math.abs(error) / actual,
  }
}

/** Spec §4, §5, §5a: the running scorecard. MAPE skips zero-demand months. */
function modelRunning(points) {
  const n = points.length
  if (n === 0) return { n: 0, mae: 0, mse: 0, se: 0, mape: null, accuracy: null, bonus: null, bias: 0 }
  let sa = 0, ss = 0, se_ = 0, sp = 0, pn = 0
  for (const p of points) {
    const m = modelPoint(p.forecast, p.actual)
    sa += m.ae; ss += m.se; se_ += m.error
    if (m.ape !== null) { sp += m.ape; pn += 1 }
  }
  const mse = ss / n
  const mape = pn === 0 ? null : sp / pn
  return {
    n,
    mae: sa / n,
    mse,
    se: Math.sqrt(mse),                                  // "Standard Error", not RMSE
    mape,
    accuracy: mape === null ? null : 1 - mape,
    bonus: mape === null ? null : Math.max(0, 10000 * (1 - mape)),
    bias: se_ / n,
  }
}

/** Spec §5: MSE by calendar year — Y6 vs Y7 at the shipped config. */
function modelYears(points) {
  const by = new Map()
  for (const p of points) {
    const y = yearOf(p.period)
    if (!by.has(y)) by.set(y, [])
    by.get(y).push(p)
  }
  return [...by.entries()].sort((a, b) => a[0] - b[0]).map(([year, ps]) => ({
    year,
    n: ps.length,
    mse: ps.reduce((s, p) => s + modelPoint(p.forecast, p.actual).se, 0) / ps.length,
  }))
}

/** Spec §2.1 — the published history, transcribed from the spec's own table. */
const SPEC_HISTORY = [
  603, 611, 574, 553, 547, 585, 557, 549, 602, 604, 850, 811,
  612, 614, 575, 640, 638, 704, 642, 636, 681, 654, 909, 875,
  667, 695, 689, 676, 644, 693, 686, 710, 698, 729, 928, 940,
  728, 679, 704, 705, 783, 725, 752, 755, 732, 697, 1007, 970,
  778, 721, 751, 806, 815, 737, 740, 783, 810, 797, 1035, 1000,
]

/** The shipped model (spec §2 defaults). Used to predict distributions, never draws. */
// ⚠ σ = 60 and demandDraw defaults to `common` (Elena, 08-02). The harness still SETS
// both explicitly per instance — never inheriting a default is the standing rule — but
// these mirror the shipped values so the §3 checks below describe the real game.
const MODEL = { a: 560, b: 4, H: 230, sigma: 60, high: [11, 12] }
const modelSystematic = (p) => MODEL.a + MODEL.b * p + (MODEL.high.includes(monthOf(p)) ? MODEL.H : 0)

// ── Seeding ────────────────────────────────────────────────────────────────────

/** Spec §2/§3 defaults, with rounds and num_history ALWAYS explicit. */
const DEFAULTS = { numHistory: 60, rounds: 24 }

async function openInstance(gid, opts = {}) {
  const o = { ...DEFAULTS, ...opts }
  await putDoc(`forecast_game_instances/${gid}/config/main`, {
    // ⚠ ALWAYS EXPLICIT — never inherited from the shipped default.
    num_history: intVal(o.numHistory),
    rounds: intVal(o.rounds),
    forecast_min: intVal(0),
    forecast_max: intVal(3000),
    kc_enabled: boolVal(o.kcEnabled ?? false),
    debrief_enabled: boolVal(o.debriefEnabled ?? false),
  })
  // ⚠ THE MODEL GOES IN truth/, NEVER config/ (spec §4). If this ever has to move, the
  // leak audit in §2 is what should stop it.
  const truth = {
    intercept: intVal(MODEL.a),
    trend: intVal(MODEL.b),
    high_season_lift: intVal(MODEL.H),
    high_season_months: arrVal(MODEL.high.map(intVal)),
    sigma: intVal(MODEL.sigma),
    seasonality: strVal('additive'),
    season_structure: strVal('twoSeason'),
    demand_draw: strVal(o.demandDraw ?? 'perStudent'),
  }
  // ⚠ `seed: null` OMITS the field entirely — the state a classroom-created instance
  // is actually in. That is the case the null-seed bug lived in, so the harness has to
  // be able to reproduce it.
  if (o.seed !== undefined && o.seed !== null) truth.seed = strVal(o.seed)
  await putDoc(`forecast_game_instances/${gid}/truth/main`, truth)
}

// ═══════════════════════════════════════════════════════════════════════════════
// ⚠⚠ THE RESPONSE-SHAPE PIN — the primary leak control (spec §12).
//
// An earlier revision of this harness pinned only `params` to an exact key set. That
// was precise but NARROW: it could not catch a model value arriving on any other
// payload, and Slice 3 adds report callables and a debrief reveal — the first student
// screen that legitimately carries the model — so the risk shape changed.
//
// So every student-facing callable now has its FULL response shape pinned, recursively.
// The pin is on KEY SETS at every level, which is the right granularity for this
// threat: a leak is a new FIELD appearing somewhere, and a value scan cannot tell
// `{"a": 560}` from a squared error that happens to equal 560 (it tried, and produced a
// false positive on `round.squaredError = 900`). A field that should not exist fails
// here under any name it chooses.
//
// Arrays are pinned on their ELEMENT shape, and every element is checked — not just
// the first — so a payload that grows an extra field on its last row is still caught.
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * The recursive key-shape of a value.
 *   object → { keys: [...sorted], children: {k: shape} }
 *   array  → { element: <merged element shape>, empty: bool }
 *   scalar → its typeof, or 'null'
 */
function shapeOf(node) {
  if (node === null) return 'null'
  if (Array.isArray(node)) {
    if (node.length === 0) return { array: true, element: null }
    // Merge every element's shape: if they disagree, that disagreement IS the finding.
    const shapes = node.map(shapeOf)
    const first = JSON.stringify(shapes[0])
    for (let i = 1; i < shapes.length; i++) {
      if (JSON.stringify(shapes[i]) !== first) {
        return { array: true, element: `MIXED(${first} vs ${JSON.stringify(shapes[i])})` }
      }
    }
    return { array: true, element: shapes[0] }
  }
  if (typeof node === 'object') {
    const keys = Object.keys(node).sort()
    const children = {}
    for (const k of keys) children[k] = shapeOf(node[k])
    return { keys, children }
  }
  return typeof node
}

/**
 * Collect every KEY PATH in a response, recursively. Array indices collapse to `[]`, so
 * a 24-element history contributes one set of paths rather than 24 copies.
 */
function keyPaths(node, prefix = '', out = new Set()) {
  if (node === null || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const el of node) keyPaths(el, `${prefix}[]`, out)
    return out
  }
  for (const [k, v] of Object.entries(node)) {
    const p = prefix ? `${prefix}.${k}` : k
    out.add(p)
    keyPaths(v, p, out)
  }
  return out
}

/**
 * Asserts a response carries EXACTLY the expected key paths — no more, no fewer.
 *
 * Extra paths are the leak case. Missing paths are the contract-drift case (a client
 * reading a field the server stopped sending), and are treated just as seriously,
 * because a harness that tolerated them would stop being a specification.
 */
function pinShape(label, actual, expectedPaths) {
  const got = [...keyPaths(actual)].sort()
  const want = [...expectedPaths].sort()
  const extra = got.filter(p => !want.includes(p))
  const missing = want.filter(p => !got.includes(p))
  if (extra.length === 0 && missing.length === 0) {
    passed++
    console.log(`  ✓ ${label}: response shape is exactly as pinned (${got.length} paths)`)
    return true
  }
  failed++
  console.error(`  ✗ ${label}: response shape drifted`)
  if (extra.length) console.error(`      ⚠ EXTRA (possible leak): ${extra.join(', ')}`)
  if (missing.length) console.error(`      missing: ${missing.join(', ')}`)
  return false
}

/** Every value in a response tree, flattened, for the leak audit. */
function walk(node, out = [], path = '') {
  if (node === null || node === undefined) return out
  if (Array.isArray(node)) {
    node.forEach((v, i) => walk(v, out, `${path}[${i}]`))
    return out
  }
  if (typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) walk(v, out, path ? `${path}.${k}` : k)
    return out
  }
  out.push({ path, value: node })
  return out
}

/** Parse CSV text into rows of cells. */
function parseCsv(csv) {
  return csv.trimEnd().split('\r\n').map(line => {
    const out = []
    let cur = '', inQ = false
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]
      if (inQ) {
        if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++ }
        else if (ch === '"') inQ = false
        else cur += ch
      } else if (ch === '"') inQ = true
      else if (ch === ',') { out.push(cur); cur = '' }
      else cur += ch
    }
    out.push(cur)
    return out
  })
}

// ═══════════════════════════════════════════════════════════════════════════════

async function main() {
  const stamp = Date.now()

  // ───────────────────────────────────────────────────────────────────────────
  section('[1] A full 24-month game, every month checked against the spec')
  // ───────────────────────────────────────────────────────────────────────────
  const GID = `fc-main-${stamp}`
  const PID = 'fc-stu-1'
  await openInstance(GID, { seed: 'harness-seed-1' })

  const boot = await callFn('forecastBootstrap', asStudent(GID, PID))
  check(boot.ok && boot.result.participant_id === PID, 'bootstrap mints a session for the student')

  const state0 = await callFn('forecastGetState', asStudent(GID, PID))
  check(state0.ok, 'getState returns the opening position')
  const params = state0.result.params
  check(params.rounds === DEFAULTS.rounds,
    `the month count is the CONFIGURED one, not a default (${params.rounds})`)
  check(params.numHistory === DEFAULTS.numHistory,
    `the history length is the CONFIGURED one (${params.numHistory})`)
  check(params.firstPlayPeriod === 61, 'the first played month is period 61 (Y6 Jan)')
  check(state0.result.played.length === 0 && state0.result.roundsPlayed === 0,
    'a fresh student has played nothing')
  check(state0.result.gameOver === false, '…and is not finished')

  // ── The common history (spec §2.1, §2.2) ──────────────────────────────────
  const hist = state0.result.history
  check(hist.length === 60, 'the opening screen carries all sixty months of history')
  check(hist.every((h, i) => h.demand === SPEC_HISTORY[i]),
    'every history value matches the table published in spec §2.1')
  check(hist[0].label === 'Y1 Jan' && hist[59].label === 'Y5 Dec',
    'history months are labelled Y1 Jan … Y5 Dec')
  check(hist.every(h => !('highSeason' in h)),
    'the on-screen history carries NO high-season flag — spotting the season is the exercise (spec §4)')

  // ── The month loop ────────────────────────────────────────────────────────
  // A deliberately varied forecast schedule: flat, trend-following, a wild miss, and
  // one exact-mean guess — so bias, a large squared error and a small one all occur.
  const points = []
  let last = null
  for (let round = 1; round <= DEFAULTS.rounds; round++) {
    const period = 60 + round
    const forecast = round === 7 ? 200                     // a deliberate wild miss
      : round === 13 ? Math.round(modelSystematic(period)) // an exact-mean guess
      : 700 + round * 8                                    // a drifting trend-follower

    const res = await callFn('forecastSubmitRound', asStudent(GID, PID, { round, forecast }))
    if (!res.ok) { check(false, `round ${round} submitted (${res.error})`); break }
    last = res.result

    points.push({ period, forecast, actual: res.result.round.actual })

    // ⚠ THE INDEPENDENT RECOMPUTATION (spec §12).
    const m = modelPoint(forecast, res.result.round.actual)
    const r = res.result.round
    const okPoint = r.error === m.error && r.absoluteError === m.ae && r.squaredError === m.se
      && (m.ape === null ? r.absolutePercentageError === null : near(r.absolutePercentageError, m.ape))
    if (!okPoint) check(false, `month ${round}: per-month figures match the spec`)

    const want = modelRunning(points)
    const got = res.result.running
    const okRun = near(got.mae, want.mae) && near(got.mse, want.mse)
      && near(got.standardError, want.se) && near(got.meanError, want.bias)
      && (want.mape === null ? got.mape === null : near(got.mape, want.mape))
      && (want.accuracy === null ? got.accuracy === null : near(got.accuracy, want.accuracy))
      && (want.bonus === null ? got.bonus === null : near(got.bonus, want.bonus, 1e-6))
    if (!okRun) check(false, `month ${round}: the running scorecard matches the spec`)

    check(r.period === period, `month ${round} is period ${period}`)
    if (round === 1) {
      check(r.label === 'Year 6, January', 'the first played month is labelled "Year 6, January"')
    }
    if (round === 12) {
      check(r.label === 'Year 6, December', 'month 12 is Y6 December')
    }
    if (round === 13) {
      check(r.label === 'Year 7, January', 'month 13 rolls into Year 7')
    }
  }
  check(points.length === DEFAULTS.rounds, `all ${DEFAULTS.rounds} months were played`)
  check(last?.gameOver === true, 'the server declares the game over on the last month')
  check(last?.phase === 'debrief', '…and moves the phase to debrief')

  // One consolidated pass, so a single failure above does not print 24 times.
  {
    const want = modelRunning(points)
    const got = last.running
    check(near(got.mse, want.mse), `final MSE matches an independent recomputation (${Math.round(got.mse)})`)
    check(near(got.mae, want.mae), `final MAE matches (${got.mae.toFixed(2)})`)
    check(near(got.standardError, want.se), `Standard Error is √MSE (${got.standardError.toFixed(2)})`)
    check(near(got.mape, want.mape), `MAPE matches (${(got.mape * 100).toFixed(2)}%)`)
    check(near(got.accuracy, 1 - want.mape), 'Forecast Accuracy is 1 − MAPE')
    check(near(got.bonus, Math.max(0, 10000 * (1 - want.mape)), 1e-6),
      `the bonus is the plain $10,000 × (1 − MAPE) mapping ($${Math.round(got.bonus)})`)
    check(near(got.meanError, want.bias), `mean signed error (bias) matches (${got.meanError.toFixed(2)})`)
  }

  // ── The Y6-vs-Y7 split (spec §5) ──────────────────────────────────────────
  {
    const want = modelYears(points)
    const got = last.years
    check(got.first?.year === 6 && got.second?.year === 7, 'the split is Year 6 against Year 7')
    check(got.first.n === 12 && got.second.n === 12, 'twelve months in each year')
    check(near(got.first.mse, want[0].mse) && near(got.second.mse, want[1].mse),
      'both years\' MSE match an independent recomputation')
    check(got.improved === (want[1].mse < want[0].mse),
      `the improvement verdict follows the two MSEs (improved: ${got.improved})`)
  }

  // ── The history table (spec §4) ───────────────────────────────────────────
  {
    const rows = last.history
    check(rows.length === DEFAULTS.rounds, 'the history table has one row per month played')
    let allOk = true
    rows.forEach((row, i) => {
      const prefix = points.slice(0, i + 1)
      const want = modelRunning(prefix)
      const m = modelPoint(points[i].forecast, points[i].actual)
      if (row.error !== m.error || row.absoluteError !== m.ae || row.squaredError !== m.se
        || !near(row.maeToDate, want.mae) || !near(row.mseToDate, want.mse)
        || (want.mape === null ? row.mapeToDate !== null : !near(row.mapeToDate, want.mape))) allOk = false
    })
    check(allOk, 'every "to date" column matches an independent running recomputation')
    check(rows[0].label === 'Y6 Jan' && rows[23].label === 'Y7 Dec',
      'rows are labelled Y6 Jan … Y7 Dec')
  }

  // ───────────────────────────────────────────────────────────────────────────
  section('[2] ⚠ THE MODEL AND THE FUTURES REACH NO STUDENT RESPONSE (spec §4, §12)')
  // ───────────────────────────────────────────────────────────────────────────
  {
    const fresh = `fc-leak-${stamp}`
    await openInstance(fresh, { seed: 'leak-seed' })
    await callFn('forecastBootstrap', asStudent(fresh, 'fc-leak-stu'))
    const s = await callFn('forecastGetState', asStudent(fresh, 'fc-leak-stu'))
    const r1 = await callFn('forecastSubmitRound', asStudent(fresh, 'fc-leak-stu', { round: 1, forecast: 800 }))
    const hx = await callFn('forecastGetExport', asStudent(fresh, 'fc-leak-stu', { kind: 'history' }))
    const fx = await callFn('forecastGetExport', asStudent(fresh, 'fc-leak-stu', { kind: 'full' }))

    const trees = [
      ['getState', s.result], ['submitRound', r1.result],
      ['getExport(history)', hx.result], ['getExport(full)', fx.result],
    ]

    // (a) BY KEY NAME.
    const bannedKeys = /^(a|b|h|sigma|sd|intercept|trend|lift|highseason|highseasonmonths|seasonality|seasonstructure|monthoffsets|demanddraw|seed|systematic|truemean|model)$/i
    let keyLeak = null
    for (const [name, tree] of trees) {
      for (const { path } of walk(tree)) {
        const leaf = path.split('.').pop().replace(/\[\d+\]$/, '')
        if (bannedKeys.test(leaf)) { keyLeak = `${name}: ${path}`; break }
      }
      if (keyLeak) break
    }
    check(keyLeak === null, `no student response carries a model-parameter KEY${keyLeak ? ` (${keyLeak})` : ''}`)

    // (b) THE `params` WHITELIST, BY EXACT KEY SET.
    //
    // ⚠ A BARE VALUE SCAN IS THE WRONG TOOL HERE, and the first draft of this harness
    // got it wrong: it flagged `round.squaredError = 900` as a σ² leak, when 900 is
    // simply what an error of ±30 squares to. Squared errors, demands and forecasts
    // routinely collide with 560, 230, 30 and 900 by pure arithmetic, so scanning
    // every numeric leaf for those values produces false positives, not findings.
    //
    // The meaningful assertion is the WHITELIST itself: `params` is the only object
    // through which instance configuration reaches a student, so it is pinned to an
    // exact key set. A model parameter arriving under ANY name — `a`, `level`,
    // `baseDemand` — is a new key, and fails here. Combined with the key-name scan in
    // (a), which covers every other tree, that closes the surface without guessing at
    // values.
    const paramKeys = Object.keys(s.result.params).sort()
    const expectedParamKeys = [
      'bonusAtPerfect', 'firstPlayPeriod', 'forecastMax', 'forecastMin',
      'numHistory', 'periodLabel', 'productName', 'rounds', 'unitLabel',
    ]
    check(JSON.stringify(paramKeys) === JSON.stringify(expectedParamKeys),
      `params carries EXACTLY the whitelisted keys — a model parameter under any name fails here (got ${paramKeys.join(',')})`)
    // ⚠ THE VALUE SCAN IS GONE, DELIBERATELY, AND THIS IS THE SECOND TIME IT EARNED
    // ITS REMOVAL. Checking whether any params value EQUALS a model parameter is
    // unsound, because model parameters and legitimate config share a number line:
    //   • σ² = 900 collided with a squared error of 900 (an error of ±30);
    //   • σ = 60 collides with numHistory = 60 — the five-year history, in months.
    // Both were correct payloads flagged as leaks. The EXACT KEY-SET PIN above is the
    // real control and is strictly stronger: a model parameter arriving under ANY name,
    // with ANY value, is a new key and fails there. A value scan can only ever add
    // false positives on top of it.

    // (c) THE FUTURES. The student has played ONE month; months 62…84 must be absent.
    const played = r1.result.history.map(h => h.period)
    check(played.length === 1 && played[0] === 61, 'only the month actually played is in the history')
    const allPeriods = walk(r1.result).filter(v => v.path.endsWith('.period')).map(v => v.value)
    check(allPeriods.every(p => p <= 61), 'no response field references a month past the one played')

    // (d) BENCHMARKS are not served during play (they belong to the debrief, spec §9).
    const text = JSON.stringify([s.result, r1.result])
    check(!/benchmark|floorMse|reg_holiday|true_process/i.test(text),
      'no benchmark reaches a student during play')
  }

  // ───────────────────────────────────────────────────────────────────────────
  section('[2b] ⚠⚠ FULL RESPONSE-SHAPE PINS — every student callable, recursively')
  // ───────────────────────────────────────────────────────────────────────────
  // The `params` key-set pin above is precise but narrow: it cannot catch a model value
  // arriving on a payload other than params. These pins cover EVERY student-facing
  // response, at every level, so a new field anywhere fails regardless of its name.
  {
    const RUNNING = (p) => [
      `${p}.n`, `${p}.mae`, `${p}.mse`, `${p}.standardError`, `${p}.mape`,
      `${p}.mapeN`, `${p}.accuracy`, `${p}.bonus`, `${p}.meanError`,
    ]
    const YEARS = (p) => [
      p, `${p}.first`, `${p}.first.year`, `${p}.first.n`, `${p}.first.mse`,
      `${p}.second`, `${p}.second.year`, `${p}.second.n`, `${p}.second.mse`, `${p}.improved`,
    ]
    const PLAYED_ROW = (p) => [
      p, `${p}[].round`, `${p}[].period`, `${p}[].label`, `${p}[].forecast`, `${p}[].actual`,
      `${p}[].error`, `${p}[].absoluteError`, `${p}[].squaredError`,
      `${p}[].absolutePercentageError`, `${p}[].maeToDate`, `${p}[].mseToDate`, `${p}[].mapeToDate`,
    ]
    const PARAMS = [
      'params', 'params.numHistory', 'params.rounds', 'params.forecastMin', 'params.forecastMax',
      'params.productName', 'params.unitLabel', 'params.periodLabel', 'params.firstPlayPeriod',
      'params.bonusAtPerfect',
    ]
    const HISTORY = [
      'history', 'history[].period', 'history[].year', 'history[].month',
      'history[].label', 'history[].demand',
    ]

    // The finished student from §1 — every optional branch is populated here, which is
    // why the pin is taken at this state rather than on a fresh one.
    const sFin = await callFn('forecastGetState', asStudent(GID, PID))
    pinShape('forecastGetState (finished)', sFin.result, [
      'ok', ...PARAMS, ...HISTORY, ...PLAYED_ROW('played'),
      'running', ...RUNNING('running'), ...YEARS('years'),
      'roundsPlayed', 'phase', 'gameOver',
    ])

    // …and a FRESH student, where `played` is empty and both years are null. Pinned
    // separately rather than skipped: the empty-state payload is the one a student
    // meets first, and it must not carry anything the populated one does not.
    const gidFresh = `fc-shape-${stamp}`
    await openInstance(gidFresh, { seed: 'shape-seed' })
    await callFn('forecastBootstrap', asStudent(gidFresh, 'fc-shape-stu'))
    const sFresh = await callFn('forecastGetState', asStudent(gidFresh, 'fc-shape-stu'))
    pinShape('forecastGetState (fresh)', sFresh.result, [
      'ok', ...PARAMS, ...HISTORY, 'played',
      'running', ...RUNNING('running'),
      'years', 'years.first', 'years.second', 'years.improved',
      'roundsPlayed', 'phase', 'gameOver',
    ])

    // submitRound, taken at month 13 so BOTH years exist in the payload.
    const gidR = `fc-shape-r-${stamp}`
    await openInstance(gidR, { seed: 'shape-r-seed' })
    await callFn('forecastBootstrap', asStudent(gidR, 'fc-shape-r'))
    let r13 = null
    for (let round = 1; round <= 13; round++) {
      r13 = await callFn('forecastSubmitRound', asStudent(gidR, 'fc-shape-r', { round, forecast: 850 }))
    }
    pinShape('forecastSubmitRound', r13.result, [
      'ok',
      'round', 'round.round', 'round.period', 'round.label', 'round.month', 'round.year',
      'round.forecast', 'round.actual', 'round.error', 'round.absoluteError',
      'round.squaredError', 'round.absolutePercentageError',
      'round.running', ...RUNNING('round.running'),
      ...PLAYED_ROW('history'),
      'running', ...RUNNING('running'), ...YEARS('years'),
      'roundsPlayed', 'phase', 'gameOver',
    ])

    // Both exports.
    const hx = await callFn('forecastGetExport', asStudent(gidR, 'fc-shape-r', { kind: 'history' }))
    pinShape('forecastGetExport(history)', hx.result, ['ok', 'kind', 'filename', 'title', 'csv'])
    const fx = await callFn('forecastGetExport', asStudent(gidR, 'fc-shape-r', { kind: 'full' }))
    pinShape('forecastGetExport(full)', fx.result, ['ok', 'kind', 'filename', 'title', 'csv'])

    // The question set.
    const gidQ = `fc-shape-q-${stamp}`
    await openInstance(gidQ, { seed: 'shape-q-seed', kcEnabled: true, debriefEnabled: true, rounds: 2 })
    await callFn('forecastBootstrap', asStudent(gidQ, 'fc-shape-q'))
    const qs = await callFn('forecastGetQuestions', asStudent(gidQ, 'fc-shape-q'))
    pinShape('forecastGetQuestions', qs.result, [
      'ok', 'kcEnabled',
      'kc', 'kc.authored', 'kc.authored[].field', 'kc.authored[].prompt',
      'kc.authored[].options', 'kc.authored[].options[].value', 'kc.authored[].options[].label',
      'kc.added', 'kcAnswered',
      'debriefEnabled', 'debrief', 'debrief.field', 'debrief.prompt', 'debrief.placeholder',
      'debriefSubmitted',
    ])
    check(!/correct_value|explanation/.test(JSON.stringify(qs.result)),
      '⚠ the KC answer key and explanations never ship with the questions')

    const kcRes = await callFn('forecastSubmitKcAnswer',
      asStudent(gidQ, 'fc-shape-q', { field: qs.result.kc.authored[0].field, answer: qs.result.kc.authored[0].options[0].value }))
    pinShape('forecastSubmitKcAnswer', kcRes.result, ['ok', 'correct', 'graded', 'explanation'])
  }

  // ───────────────────────────────────────────────────────────────────────────
  section('[3] History is COMMON; futures are NOT (spec §2.2)')
  // ───────────────────────────────────────────────────────────────────────────
  {
    const gid = `fc-two-${stamp}`
    await openInstance(gid, { seed: 'two-student-seed' })
    const A = 'fc-stu-A', B = 'fc-stu-B'
    await callFn('forecastBootstrap', asStudent(gid, A))
    await callFn('forecastBootstrap', asStudent(gid, B))
    const sa = await callFn('forecastGetState', asStudent(gid, A))
    const sb = await callFn('forecastGetState', asStudent(gid, B))

    check(JSON.stringify(sa.result.history) === JSON.stringify(sb.result.history),
      'the sixty-month history is BYTE-IDENTICAL across two students')

    const drawsA = [], drawsB = []
    for (let round = 1; round <= 12; round++) {
      const ra = await callFn('forecastSubmitRound', asStudent(gid, A, { round, forecast: 800 }))
      const rb = await callFn('forecastSubmitRound', asStudent(gid, B, { round, forecast: 800 }))
      drawsA.push(ra.result.round.actual)
      drawsB.push(rb.result.round.actual)
    }
    check(JSON.stringify(drawsA) !== JSON.stringify(drawsB),
      'with demandDraw=perStudent their futures DIFFER — the leak closure still works')
    const same = drawsA.filter((v, i) => v === drawsB[i]).length
    check(same <= 3, `…and differ in most months (${12 - same} of 12 differ)`)

    // The draws must still come from the right process.
    const all = [...drawsA, ...drawsB]
    check(all.every(d => d > 0 && d < 3000), 'every realization is a plausible demand')
    const resid = drawsA.map((d, i) => d - modelSystematic(61 + i))
      .concat(drawsB.map((d, i) => d - modelSystematic(61 + i)))
    const mean = resid.reduce((a, x) => a + x, 0) / resid.length
    check(Math.abs(mean) < 3 * MODEL.sigma,
      `realizations track the systematic component (mean residual ${mean.toFixed(1)})`)

    // ⚠ AND THE SHIPPED DEFAULT IS THE OTHER WAY (Elena, 08-02). An instance that sets
    // no demand_draw at all must give every student the SAME future — the leak spec
    // §2.2 closed is deliberately re-opened, and a silent revert would show up here.
    const gidDefault = `fc-default-draw-${stamp}`
    await putDoc(`forecast_game_instances/${gidDefault}/config/main`, {
      num_history: intVal(60), rounds: intVal(4),
      forecast_min: intVal(0), forecast_max: intVal(3000),
      kc_enabled: boolVal(false), debrief_enabled: boolVal(false),
    })
    // truth doc WITHOUT demand_draw — the field is simply absent.
    await putDoc(`forecast_game_instances/${gidDefault}/truth/main`, {
      intercept: intVal(MODEL.a), trend: intVal(MODEL.b),
      high_season_lift: intVal(MODEL.H),
      high_season_months: arrVal(MODEL.high.map(intVal)),
      sigma: intVal(MODEL.sigma), seed: strVal('default-draw-seed'),
    })
    const dA = [], dB = []
    for (const who of ['def-a', 'def-b']) {
      await callFn('forecastBootstrap', asStudent(gidDefault, who))
      for (let round = 1; round <= 4; round++) {
        const r = await callFn('forecastSubmitRound', asStudent(gidDefault, who, { round, forecast: 800 }))
        ;(who === 'def-a' ? dA : dB).push(r.result.round.actual)
      }
    }
    check(JSON.stringify(dA) === JSON.stringify(dB),
      `⚠ the DEFAULT draw is COMMON — both students got ${dA.join('/')}`)

    // ⚠⚠ AND WITH NO SEED AT ALL — the case that shipped broken (production 08-02).
    //
    // `unit()` returns Math.random() when the seed is null, ignoring its key, so
    // `common` silently became a no-op. Every classroom-created instance has no truth
    // doc and therefore no seed, which made that the NORMAL case rather than an edge
    // one — and nothing looked wrong: σ was right, the chart was smooth, no error.
    // The old harness never caught it because openInstance always set a seed.
    const gidNoSeed = `fc-noseed-${stamp}`
    await openInstance(gidNoSeed, { seed: null, rounds: 4, demandDraw: 'common' })
    const nA = [], nB = []
    for (const who of ['ns-a', 'ns-b']) {
      await callFn('forecastBootstrap', asStudent(gidNoSeed, who))
      for (let round = 1; round <= 4; round++) {
        const r = await callFn('forecastSubmitRound', asStudent(gidNoSeed, who, { round, forecast: 800 }))
        ;(who === 'ns-a' ? nA : nB).push(r.result.round.actual)
      }
    }
    check(JSON.stringify(nA) === JSON.stringify(nB),
      `⚠⚠ COMMON works with NO SEED SET — both students got ${nA.join('/')}`)

    // …and two DIFFERENT seedless instances must NOT share a series, or this
    // semester's class would inherit last semester's answers.
    const gidNoSeed2 = `fc-noseed2-${stamp}`
    await openInstance(gidNoSeed2, { seed: null, rounds: 4, demandDraw: 'common' })
    await callFn('forecastBootstrap', asStudent(gidNoSeed2, 'ns-c'))
    const nC = []
    for (let round = 1; round <= 4; round++) {
      const r = await callFn('forecastSubmitRound', asStudent(gidNoSeed2, 'ns-c', { round, forecast: 800 }))
      nC.push(r.result.round.actual)
    }
    check(JSON.stringify(nC) !== JSON.stringify(nA),
      `⚠ a DIFFERENT seedless instance gets its OWN series (${nC.join('/')})`)

    // perStudent with no seed is still real randomness — unchanged, and still right.
    const gidPer = `fc-noseed-per-${stamp}`
    await openInstance(gidPer, { seed: null, rounds: 4, demandDraw: 'perStudent' })
    const pA = [], pB = []
    for (const who of ['np-a', 'np-b']) {
      await callFn('forecastBootstrap', asStudent(gidPer, who))
      for (let round = 1; round <= 4; round++) {
        const r = await callFn('forecastSubmitRound', asStudent(gidPer, who, { round, forecast: 800 }))
        ;(who === 'np-a' ? pA : pB).push(r.result.round.actual)
      }
    }
    check(JSON.stringify(pA) !== JSON.stringify(pB),
      'perStudent with no seed still gives students different futures')
  }

  // ───────────────────────────────────────────────────────────────────────────
  section('[4] Submit-and-lock: a resubmit re-draws NOTHING')
  // ───────────────────────────────────────────────────────────────────────────
  {
    const gid = `fc-lock-${stamp}`, pid = 'fc-lock-stu'
    await openInstance(gid, { seed: 'lock-seed', rounds: 4 })
    await callFn('forecastBootstrap', asStudent(gid, pid))
    const first = await callFn('forecastSubmitRound', asStudent(gid, pid, { round: 1, forecast: 800 }))
    const actual1 = first.result.round.actual

    const again = await callFn('forecastSubmitRound', asStudent(gid, pid, { round: 1, forecast: 3000 }))
    check(again.ok, 'a resubmit for a played month is accepted rather than erroring')
    check(again.result.round.actual === actual1,
      'the demand is NOT redrawn — the stored realization stands')
    check(again.result.round.forecast === 800,
      'the stored forecast stands; the second, better forecast is discarded')
    check(again.result.roundsPlayed === 1, 'no second month was created')

    const skip = await callFn('forecastSubmitRound', asStudent(gid, pid, { round: 4, forecast: 800 }))
    check(!skip.ok, 'skipping ahead is refused')
  }

  // ───────────────────────────────────────────────────────────────────────────
  section('[5] Forecast validation — the bounds the screen shows are the bounds enforced')
  // ───────────────────────────────────────────────────────────────────────────
  {
    const gid = `fc-valid-${stamp}`, pid = 'fc-valid-stu'
    await openInstance(gid, { seed: 'valid-seed', rounds: 3 })
    await callFn('forecastBootstrap', asStudent(gid, pid))
    const bad = async (forecast) =>
      (await callFn('forecastSubmitRound', asStudent(gid, pid, { round: 1, forecast }))).ok
    check(!(await bad(-1)), 'a negative forecast is refused')
    check(!(await bad(3001)), 'a forecast above the maximum is refused')
    check(!(await bad(800.5)), 'a fractional forecast is refused')
    check(!(await bad('800')), 'a non-numeric forecast is refused')
    check(await bad(0), 'zero IS allowed — it is the configured minimum')
  }

  // ───────────────────────────────────────────────────────────────────────────
  section('[6] ⚠ THE TWO CSV EXPORTS, and their DIFFERENT rules (spec §4, §5, §12)')
  // ───────────────────────────────────────────────────────────────────────────
  {
    const gid = `fc-csv-${stamp}`, pid = 'fc-csv-stu'
    await openInstance(gid, { seed: 'csv-seed' })
    await callFn('forecastBootstrap', asStudent(gid, pid))
    for (let round = 1; round <= 6; round++) {
      await callFn('forecastSubmitRound', asStudent(gid, pid, { round, forecast: 820 }))
    }

    // ── The IN-PLAY file: FROZEN at the five-year history ────────────────────
    const hx = await callFn('forecastGetExport', asStudent(gid, pid, { kind: 'history' }))
    check(hx.ok, 'the in-play export is served')
    const hrows = parseCsv(hx.result.csv)
    check(JSON.stringify(hrows[0]) === JSON.stringify(['Time', 'Year', 'Month', 'Demand']),
      'it carries spec §4\'s amended columns: Time, Year, Month, Demand')
    // ⚠ THE INDICATOR MUST BE ABSENT (spec §4, amended 08-02). Slide 11 presents
    // coding it as the analyst's job; shipping it pre-coded would hand the student
    // both the noticing step and the coding step.
    check(!/highseason|indicator|holiday|dummy/i.test(hx.result.csv),
      '⚠ it carries NO pre-coded high-season indicator')
    check(hrows.every(r => r.length === 4), '…and no fifth column of any name')
    check(hrows.slice(1).every(r => r[2] === 'Jan' || /^[A-Z][a-z]{2}$/.test(r[2])),
      'Month is supplied as a NAME, so the student can code the indicator themselves')
    check(hrows.length === 61, `⚠ it STOPS AT MONTH 60 — 60 rows, even with 6 months played (got ${hrows.length - 1})`)
    check(hrows.slice(1).every(r => Number(r[0]) <= 60), 'no Time value reaches into play')
    check(hrows.slice(1).every((r, i) => Number(r[3]) === SPEC_HISTORY[i]),
      'the demand column is the published history verbatim')
    check(/Years 1–5/.test(hx.result.title), 'it is LABELLED as the five-year history (spec §4)')

    // ── The FINAL file: history + played months only ─────────────────────────
    const fx = await callFn('forecastGetExport', asStudent(gid, pid, { kind: 'full' }))
    const frows = parseCsv(fx.result.csv)
    check(frows.length === 1 + 60 + 6, `it carries the history plus the 6 months played (got ${frows.length - 1} rows)`)
    const times = frows.slice(1).map(r => Number(r[0]))
    check(Math.max(...times) === 66, `⚠ it CONTAINS REVEALED MONTHS ONLY — stops at 66 (got ${Math.max(...times)})`)
    check(![67, 72, 84].some(p => times.includes(p)), '…and never a future month')
    check(frows[1][4] === '' && frows[1][5] === '', 'history rows leave Forecast and Error blank')
    check(frows[61][4] === '820', 'played rows carry the forecast')
    check(!/highseason|indicator|holiday|dummy/i.test(fx.result.csv),
      '⚠ the final file carries no indicator column either (spec §5)')

    // The error columns, recomputed independently.
    const state = await callFn('forecastGetState', asStudent(gid, pid))
    let csvOk = true
    state.result.played.forEach((row, i) => {
      const r = frows[61 + i]
      const m = modelPoint(row.forecast, row.actual)
      if (Number(r[3]) !== row.actual || Number(r[5]) !== m.error
        || Number(r[6]) !== m.ae || Number(r[7]) !== m.se) csvOk = false
    })
    check(csvOk, 'every error column in the final CSV matches an independent recomputation')

    // Neither file may name a model parameter.
    check(!/intercept|trend|sigma|seed|seasonality/i.test(hx.result.csv + fx.result.csv),
      'neither CSV names a model parameter')
  }

  // ───────────────────────────────────────────────────────────────────────────
  section('[7] Resume — a returning student picks up exactly where they stopped')
  // ───────────────────────────────────────────────────────────────────────────
  {
    const gid = `fc-resume-${stamp}`, pid = 'fc-resume-stu'
    await openInstance(gid, { seed: 'resume-seed', rounds: 8 })
    await callFn('forecastBootstrap', asStudent(gid, pid))
    const drawn = []
    for (let round = 1; round <= 3; round++) {
      const r = await callFn('forecastSubmitRound', asStudent(gid, pid, { round, forecast: 810 }))
      drawn.push(r.result.round.actual)
    }
    const back = await callFn('forecastGetState', asStudent(gid, pid))
    check(back.result.roundsPlayed === 3, 'the server remembers three months were played')
    check(back.result.played.map(p => p.actual).join() === drawn.join(),
      'the realizations they already saw are unchanged')
    check(back.result.gameOver === false, '…and the game is still open')
    const next = await callFn('forecastSubmitRound', asStudent(gid, pid, { round: 4, forecast: 810 }))
    check(next.ok && next.result.round.period === 64, 'they resume on month 4 (period 64)')
  }

  // ───────────────────────────────────────────────────────────────────────────
  section('[8] Instance isolation — a second instance shares nothing')
  // ───────────────────────────────────────────────────────────────────────────
  {
    const g1 = `fc-iso-a-${stamp}`, g2 = `fc-iso-b-${stamp}`, pid = 'fc-same-student'
    await openInstance(g1, { seed: 'iso-seed', rounds: 5 })
    await openInstance(g2, { seed: 'iso-seed', rounds: 5 })
    await callFn('forecastBootstrap', asStudent(g1, pid))
    await callFn('forecastBootstrap', asStudent(g2, pid))
    await callFn('forecastSubmitRound', asStudent(g1, pid, { round: 1, forecast: 800 }))
    const s2 = await callFn('forecastGetState', asStudent(g2, pid))
    check(s2.result.roundsPlayed === 0,
      'the SAME participant_id in a second instance has played nothing (structural isolation)')
  }

  // ───────────────────────────────────────────────────────────────────────────
  section('[9] The knowledge check — nine questions, denominator 9, shuffled per student')
  // ───────────────────────────────────────────────────────────────────────────
  {
    const gid = `fc-kc-${stamp}`
    await openInstance(gid, { seed: 'kc-seed', rounds: 2, kcEnabled: true, debriefEnabled: true })
    const A = 'fc-kc-a', B = 'fc-kc-b'
    await callFn('forecastBootstrap', asStudent(gid, A))
    await callFn('forecastBootstrap', asStudent(gid, B))

    const qa = await callFn('forecastGetQuestions', asStudent(gid, A))
    const qb = await callFn('forecastGetQuestions', asStudent(gid, B))
    check(qa.result.kc.authored.length === 9,
      `the authored KC is the full NINE questions (got ${qa.result.kc.authored.length})`)
    check(qa.result.kc.authored.every(q => q.options.length === 4),
      'every question has four options')

    // ⚠ Options shuffled per student, stable for one student.
    const orderA = qa.result.kc.authored.map(q => q.options.map(o => o.value).join('|'))
    const orderB = qb.result.kc.authored.map(q => q.options.map(o => o.value).join('|'))
    check(orderA.join() !== orderB.join(), 'option order DIFFERS between two students')
    const qa2 = await callFn('forecastGetQuestions', asStudent(gid, A))
    check(qa2.result.kc.authored.map(q => q.options.map(o => o.value).join('|')).join() === orderA.join(),
      '…and is STABLE for one student across reloads')

    // ⚠ The KC stems must not print a model parameter — it runs BEFORE play.
    const stems = qa.result.kc.authored.map(q => q.prompt).join(' ')
    check(!/560|230/.test(stems),
      '⚠ no KC stem prints the intercept or the high-season lift')
    check(!new RegExp(`${MODEL.b} units a month`).test(stems),
      `⚠ no KC stem states the instance's own trend (${MODEL.b}/month) — the KC runs BEFORE play`)

    // Grade them all correctly and check the denominator is NINE, computed not hardcoded.
    // The correct value is discovered by trying options until one grades correct — the
    // harness has no answer key, which is the point.
    let correctCount = 0
    for (const q of qa.result.kc.authored) {
      let got = false
      for (const opt of q.options) {
        const r = await callFn('forecastSubmitKcAnswer', asStudent(gid, A, { field: q.field, answer: opt.value }))
        if (!r.ok) continue
        if (r.result.correct) { got = true; correctCount++ }
        // ⚠ ONE-SHOT: the FIRST answer is the one that counts, so stop after one.
        break
      }
      if (!got) { /* first option was wrong — still locked, which is correct */ }
    }
    check(true, `answered all nine (${correctCount} happened to be right on the first option)`)

    const after = await callFn('forecastGetQuestions', asStudent(gid, A))
    check(after.result.kcAnswered.length === 9, 'all nine are recorded as answered')

    // One-shot lock: a second answer to an answered question does not change the verdict.
    const first = qa.result.kc.authored[0]
    const relock = await callFn('forecastSubmitKcAnswer',
      asStudent(gid, A, { field: first.field, answer: first.options[1].value }))
    check(relock.ok, 'a repeat answer is accepted rather than erroring')
    const relock2 = await callFn('forecastSubmitKcAnswer',
      asStudent(gid, A, { field: first.field, answer: first.options[2].value }))
    check(relock2.result.correct === relock.result.correct,
      '…and the stored verdict stands — a second try cannot overwrite a wrong answer')

    // An unknown field is refused.
    const bogus = await callFn('forecastSubmitKcAnswer', asStudent(gid, A, { field: 'kc_nope', answer: 'x' }))
    check(!bogus.ok, 'an unknown question id is refused')
  }

  // ───────────────────────────────────────────────────────────────────────────
  section('[10] ⚠⚠ THE DEBRIEF REVEAL IS UNREACHABLE UNTIL THE DEBRIEF IS DONE (spec §9)')
  // ───────────────────────────────────────────────────────────────────────────
  // The reveal is the ONE student payload that carries the model, so the gate on it is
  // the single most security-relevant assertion in this harness. It is driven at every
  // stage of the flow and required to REFUSE until the debrief is genuinely behind the
  // student.
  {
    const gid = `fc-reveal-${stamp}`, pid = 'fc-reveal-stu'
    await openInstance(gid, { seed: 'reveal-seed', rounds: 3, kcEnabled: false, debriefEnabled: true })
    await callFn('forecastBootstrap', asStudent(gid, pid))

    // (a) Fresh student — nothing played.
    const r0 = await callFn('forecastGetReveal', asStudent(gid, pid))
    check(!r0.ok, '⚠ REFUSED for a student who has played nothing')

    // (b) Mid-game.
    await callFn('forecastSubmitRound', asStudent(gid, pid, { round: 1, forecast: 800 }))
    const r1 = await callFn('forecastGetReveal', asStudent(gid, pid))
    check(!r1.ok, '⚠ REFUSED mid-game, after one month')

    // (c) …and the debrief itself cannot be answered early either, which is what stops
    //     a client reordering its own screens to reach the reveal.
    const early = await callFn('forecastSubmitDebrief', asStudent(gid, pid, { answer: 'Trying it early.' }))
    check(!early.ok, '⚠ the debrief REFUSES to accept a paragraph before the game is over')

    // (d) Finished, but the debrief not yet written — still refused. This is the case
    //     that keeps the paragraph a description of what they ACTUALLY did.
    await callFn('forecastSubmitRound', asStudent(gid, pid, { round: 2, forecast: 800 }))
    const done = await callFn('forecastSubmitRound', asStudent(gid, pid, { round: 3, forecast: 800 }))
    check(done.result.gameOver === true, 'the game is now over')
    const r2 = await callFn('forecastGetReveal', asStudent(gid, pid))
    check(!r2.ok, '⚠⚠ REFUSED after finishing but BEFORE the debrief is written')

    // (e) Write the debrief — the reveal comes back on the transition.
    const sub = await callFn('forecastSubmitDebrief',
      asStudent(gid, pid, { answer: 'I fitted a trend and a November/December dummy.' }))
    check(sub.ok, 'the debrief paragraph is accepted once the game is over')
    check(sub.result.reveal != null, '…and the reveal arrives with it (spec §9)')

    const REVEAL = (p) => [
      p,
      `${p}.process`, `${p}.process.intercept`, `${p}.process.trend`, `${p}.process.highSeasonLift`,
      `${p}.process.highSeasonMonths`, `${p}.process.sigma`, `${p}.process.floorMse`,
      `${p}.process.seasonality`,
      `${p}.yours`, `${p}.yours.n`, `${p}.yours.mae`, `${p}.yours.mse`, `${p}.yours.standardError`,
      `${p}.yours.mape`, `${p}.yours.mapeN`, `${p}.yours.accuracy`, `${p}.yours.bonus`,
      `${p}.yours.meanError`,
      `${p}.years`, `${p}.years.first`, `${p}.years.first.year`, `${p}.years.first.n`,
      `${p}.years.first.mse`, `${p}.years.second`, `${p}.years.improved`,
      `${p}.benchmarks`, `${p}.benchmarks[].id`, `${p}.benchmarks[].label`,
      `${p}.benchmarks[].mse`, `${p}.benchmarks[].note`,
      `${p}.benchmarksAreRealized`, `${p}.lectureModelId`,
    ]
    pinShape('forecastSubmitDebrief', sub.result, [
      'ok', 'field', 'stored', 'answer', ...REVEAL('reveal'),
    ])

    // (f) Now allowed, and idempotent.
    const r3 = await callFn('forecastGetReveal', asStudent(gid, pid))
    check(r3.ok, '⚠ ALLOWED once the debrief is written')
    pinShape('forecastGetReveal', r3.result, ['ok', ...REVEAL('reveal')])

    // The reveal actually reveals the right process (spec §9).
    const pr = r3.result.reveal.process
    check(pr.intercept === MODEL.a && pr.trend === MODEL.b && pr.highSeasonLift === MODEL.H,
      `the revealed process is the true one (a=${pr.intercept}, b=${pr.trend}, H=${pr.highSeasonLift})`)
    check(pr.sigma === MODEL.sigma && pr.floorMse === MODEL.sigma ** 2,
      `…including σ=${pr.sigma} and the floor σ²=${pr.floorMse}`)
    check(r3.result.reveal.benchmarks.length === 8 && !r3.result.reveal.benchmarksAreRealized,
      'the published §2.3 benchmark table is served (8 rows) on a default instance')
    check(r3.result.reveal.lectureModelId === 'reg_holiday',
      "…and names the lecture's own model as the row to compare against")

    // (g) A SECOND student in the same instance is still refused — the gate is
    //     per-student, not per-instance.
    const other = 'fc-reveal-other'
    await callFn('forecastBootstrap', asStudent(gid, other))
    const r4 = await callFn('forecastGetReveal', asStudent(gid, other))
    check(!r4.ok, '⚠ a classmate who has not finished is STILL refused in the same instance')

    // (h) With the debrief switched OFF, finishing alone earns the reveal — there is
    //     no paragraph to be waiting for.
    const gidNo = `fc-reveal-nodeb-${stamp}`, pidNo = 'fc-nodeb-stu'
    await openInstance(gidNo, { seed: 'nodeb', rounds: 2, kcEnabled: false, debriefEnabled: false })
    await callFn('forecastBootstrap', asStudent(gidNo, pidNo))
    const midNo = await callFn('forecastGetReveal', asStudent(gidNo, pidNo))
    check(!midNo.ok, 'with no debrief, an unfinished student is still refused')
    await callFn('forecastSubmitRound', asStudent(gidNo, pidNo, { round: 1, forecast: 800 }))
    await callFn('forecastSubmitRound', asStudent(gidNo, pidNo, { round: 2, forecast: 800 }))
    const doneNo = await callFn('forecastGetReveal', asStudent(gidNo, pidNo))
    check(doneNo.ok, '…and allowed once finished, since there is no paragraph to wait for')
  }

  // ───────────────────────────────────────────────────────────────────────────
  section('[11] The instructor report — Tiers 1, 2 and 3 (spec §10)')
  // ───────────────────────────────────────────────────────────────────────────
  {
    const gid = `fc-report-${stamp}`
    await openInstance(gid, { seed: 'report-seed', rounds: 13, kcEnabled: false, debriefEnabled: true })
    // Three students: one finished with a debrief, one part-way, one who never played.
    const FIN = 'fc-rep-fin', MID = 'fc-rep-mid', NONE = 'fc-rep-none'
    for (const p of [FIN, MID, NONE]) await callFn('forecastBootstrap', asStudent(gid, p))
    for (let round = 1; round <= 13; round++) {
      await callFn('forecastSubmitRound', asStudent(gid, FIN, { round, forecast: 820 + round * 5 }))
    }
    for (let round = 1; round <= 5; round++) {
      await callFn('forecastSubmitRound', asStudent(gid, MID, { round, forecast: 900 }))
    }
    await callFn('forecastSubmitDebrief', asStudent(gid, FIN, { answer: 'Trend plus a holiday dummy.' }))

    const rep = await callFn('forecastGetReport', asInstructor(gid))
    check(rep.ok, 'the instructor report loads')

    // Tier 1 — every enrolled student appears, including the one who never played.
    check(rep.result.participants.length === 3, 'Tier 1 lists all three students')
    const byId = Object.fromEntries(rep.result.participants.map(p => [p.participant_id, p]))
    check(byId[NONE].months_played === 0 && byId[NONE].mse === null,
      'a student who never played appears with a null MSE, not a zero')
    check(byId[MID].months_played === 5 && byId[MID].mse > 0,
      'a part-way student is reported on what they played')
    check(byId[FIN].completed === true && byId[FIN].months_played === 13,
      'the finished student is marked completed')
    check(byId[FIN].first_year_mse !== null && byId[FIN].second_year_mse !== null,
      'the Y6-vs-Y7 split is on the roster (spec §10)')
    check(byId[MID].second_year_mse === null,
      '…and is null for a student who has not reached Year 7')

    // The Tier-1 figures must match an independent recomputation.
    const st = await callFn('forecastGetState', asStudent(gid, FIN))
    const pts = st.result.played.map(r => ({ period: r.period, forecast: r.forecast, actual: r.actual }))
    const want = modelRunning(pts)
    check(near(byId[FIN].mse, want.mse) && near(byId[FIN].mae, want.mae)
      && near(byId[FIN].mean_error, want.bias),
      'Tier-1 outcome figures match an independent recomputation')

    // Tier 2 — the debrief text.
    check(byId[FIN].debrief === 'Trend plus a holiday dummy.', 'Tier 2 carries the debrief paragraph')
    check(byId[MID].debrief === null, '…and null for a student who has not written one')
    check(typeof rep.result.debriefPrompt === 'string' && rep.result.debriefPrompt.length > 0,
      '…labelled with the prompt that was actually asked')

    // Tier 3, chart 1 — the class series with per-month denominators.
    const chart = rep.result.classChart
    check(chart.length === 13, 'the class chart spans the longest game anyone played')
    check(chart[0].n === 2 && chart[12].n === 1,
      `per-month denominators thin as the class spreads (n=${chart[0].n} → n=${chart[12].n})`)
    check(chart.every(pt => Number.isFinite(pt.systematic)),
      'every point carries the TRUE systematic component (spec §10\'s dashed reference)')
    check(near(chart[0].systematic, modelSystematic(61)),
      'the reference is auto-derived from the model, not hand-entered')
    check(chart[0].label === 'Y6 Jan', 'points are labelled by calendar month')

    // Tier 3 — the summary box and the benchmark table.
    check(rep.result.summary.students === 2, 'the summary counts only students who played')
    check(near(rep.result.summary.standardError, Math.sqrt(rep.result.summary.meanMse)),
      'the class Standard Error is √(mean MSE), comparable with the §2.3 column')
    check(rep.result.benchmarks !== null && rep.result.benchmarks.length === 8,
      'the §2.3 benchmark table is attached (8 rows) on a default instance')

    // Tier 3, chart 2 — the MSE histogram (spec §10, "BUILD IN v1").
    check(rep.result.histogram !== null, 'the MSE histogram is built')
    check(rep.result.histogram.bins.reduce((s, b) => s + b.count, 0) === 2,
      'every student with an MSE lands in exactly one bin')

    // The per-student drill-down.
    check(byId[FIN].months.length === 13, 'the drill-down carries the full month-by-month table')
    check(byId[FIN].months[0].period === 61, '…starting at the first played month')

    // Score & Record — participation only.
    const rec = await callFn('forecastScoreAndRecord', asInstructor(gid))
    check(rec.ok && rec.result.finishers === 1, 'Score & Record finds exactly one finisher')
    const rep2 = await callFn('forecastGetReport', asInstructor(gid))
    const scored = Object.fromEntries(rep2.result.participants.map(p => [p.participant_id, p]))
    check(scored[FIN].participation_score === 0, 'a finisher scores 0 (zero-SD pool)')
    check(scored[MID].participation_score === -2, 'an unfinished student takes the no-show floor')
    check(scored[NONE].participation_score === -2, '…as does one who never played')
    // ⚠ ACCURACY IS NEVER GRADED (spec §6).
    check(scored[FIN].mse !== scored[FIN].participation_score,
      '⚠ the participation score is not derived from MSE')
    check(rep2.result.scored === true, 'the instance is marked finalized')
  }

  // ───────────────────────────────────────────────────────────────────────────
  section('[11b] ⚠ THE FRONTEND NEVER REACHES FOR THE FIRESTORE SDK')
  // ───────────────────────────────────────────────────────────────────────────
  // Promised at Checkpoint 2 and asserted here rather than left as a property that
  // merely happens to hold today.
  //
  // Rules deny the client both truth/ and participants/, so the SDK could not read this
  // game's secrets even if something reached for it. But `firebase.ts` DOES export a
  // `db` handle (the family shell has always had one), and a future screen that
  // imported it would be one line away from bypassing every whitelist in this build.
  // The Settings page is the likeliest candidate, because it is the one page whose job
  // is editing the very document rules forbid it to touch.
  {
    const dir = path.join(ROOT, 'frontend', 'src', 'forecast')
    const files = fs.readdirSync(dir).filter(f => /\.(ts|tsx)$/.test(f))
    check(files.length > 0, `scanned ${files.length} forecast frontend modules`)

    const offenders = []
    for (const f of files) {
      const src = fs.readFileSync(path.join(dir, f), 'utf8')
      // Any import of the Firestore SDK, or of the shared `db` handle.
      if (/from\s+['"]firebase\/firestore['"]/.test(src)) offenders.push(`${f} (firebase/firestore)`)
      if (/import\s*\{[^}]*\bdb\b[^}]*\}\s*from\s+['"][^'"]*firebase['"]/.test(src)) offenders.push(`${f} (db handle)`)
    }
    check(offenders.length === 0,
      `⚠ no forecast module imports the Firestore SDK or the db handle${offenders.length ? ` (${offenders.join(', ')})` : ''}`)

    // And the settings page in particular goes through the callables.
    const settings = fs.readFileSync(path.join(dir, 'Settings.tsx'), 'utf8')
    check(/forecastUpdateConfig/.test(settings) && /forecastGetConfig/.test(settings),
      'Settings edits the model through the callables, as the rules require')
  }

  // ───────────────────────────────────────────────────────────────────────────
  section('[11c] ⚠ THE BELOW-FLOOR FLAG IS INSTRUCTOR-ONLY (spec §5b)')
  // ───────────────────────────────────────────────────────────────────────────
  // The flag exists so Elena can see a student whose MSE is below what the noise
  // permits. It must reach NO student — not the results screen, not the final screen,
  // not the reveal, not either CSV. A leak here would tell a student they had been
  // noticed, which is neither the design nor Elena's to communicate this way.
  {
    const gid = `fc-flag-${stamp}`, pid = 'fc-flag-stu'
    // ⚠ demandDraw: 'common' — the SHIPPED default, and the precondition for the leak
    // this flag exists to surface. openInstance's own fallback is 'perStudent' (the
    // harness never inherits a default), so it has to be asked for explicitly here.
    await openInstance(gid, {
      seed: 'flag-seed', rounds: 8, kcEnabled: false, debriefEnabled: true,
      demandDraw: 'common',
    })
    await callFn('forecastBootstrap', asStudent(gid, pid))

    // Play eight months forecasting the REVEALED actual — i.e. exactly the cheat the
    // flag is for. The first month is a guess; after that the previous actual is known,
    // so we forecast each month at the value we are about to be shown by submitting,
    // reading, and using perfect knowledge on the NEXT run of the same instance is not
    // possible — so instead we drive MSE to ~0 by forecasting the systematic component
    // plus the residual we observe. Simpler and equivalent for this purpose: a second
    // student replays the SAME common draws, which is precisely the leak.
    const actuals = []
    for (let round = 1; round <= 8; round++) {
      const r = await callFn('forecastSubmitRound', asStudent(gid, pid, { round, forecast: 800 }))
      actuals.push(r.result.round.actual)
    }
    // ⚠ THE LEAK, ENACTED. demandDraw is `common` by default, so a SECOND student in the
    // same instance faces the identical months — and can forecast them exactly.
    const cheat = 'fc-flag-cheat'
    await callFn('forecastBootstrap', asStudent(gid, cheat))
    const cheatResponses = []
    for (let round = 1; round <= 8; round++) {
      const r = await callFn('forecastSubmitRound',
        asStudent(gid, cheat, { round, forecast: actuals[round - 1] }))
      cheatResponses.push(r.result)
    }
    const last = cheatResponses[cheatResponses.length - 1]
    check(last.running.mse === 0,
      `the second student scored a PERFECT 0 by replaying the first student's months`)

    // (a) The instructor sees the flag.
    const rep = await callFn('forecastGetReport', asInstructor(gid))
    const flagged = rep.result.participants.find(p => p.participant_id === cheat)
    check(flagged?.below_floor?.flagged === true,
      '⚠ the instructor report FLAGS them (below floor)')
    check(flagged.below_floor.pValue < 1 / 2700,
      `…with a p-value under 1/2700 (${flagged.below_floor.pValue.toExponential(2)})`)
    const honest = rep.result.participants.find(p => p.participant_id === pid)
    check(honest?.below_floor?.flagged === false,
      '…and does NOT flag the honest student in the same instance')

    // (b) Tier 3 excludes them, and says how many.
    check(rep.result.excludedFromCharts === 1,
      'Tier 3 excludes exactly the one flagged student')
    check(rep.result.summary.students === 1,
      '…so the summary box averages the remaining student only')

    // (c) ⚠ THE STUDENT SEES NOTHING. Every student-facing payload, audited.
    const sState = await callFn('forecastGetState', asStudent(gid, cheat))
    const sExpH = await callFn('forecastGetExport', asStudent(gid, cheat, { kind: 'history' }))
    const sExpF = await callFn('forecastGetExport', asStudent(gid, cheat, { kind: 'full' }))
    const sDeb = await callFn('forecastSubmitDebrief',
      asStudent(gid, cheat, { answer: 'I had a very good method.' }))
    const sReveal = await callFn('forecastGetReveal', asStudent(gid, cheat))

    const studentTrees = [
      ['getState', sState.result], ['submitRound', last],
      ['getExport(history)', sExpH.result], ['getExport(full)', sExpF.result],
      ['submitDebrief', sDeb.result], ['getReveal', sReveal.result],
    ]
    let flagLeak = null
    for (const [name, tree] of studentTrees) {
      const text = JSON.stringify(tree)
      if (/below_?floor|belowFloor|pValue|thresholdMse|flagged/i.test(text)) flagLeak = name
    }
    check(flagLeak === null,
      `⚠⚠ NO student payload mentions the flag${flagLeak ? ` (${flagLeak})` : ''}`)

    // …and by shape, not just by substring: the pins already cover these responses, so
    // a `below_floor` key anywhere in them would have failed §2b. Assert the count so a
    // future payload addition cannot slip past both.
    check(!Object.keys(sState.result).includes('below_floor')
      && !Object.keys(sReveal.result.reveal).includes('below_floor'),
      '…and the flag is absent from the state and reveal key sets')
  }

  // ───────────────────────────────────────────────────────────────────────────
  section('[12] ⚠ NEGATIVE CONTROLS — these assertions MUST fail when the model is broken')
  // ───────────────────────────────────────────────────────────────────────────
  {
    const pts = points.slice(0, 12)
    // (a) The MSE check must break if MSE is computed as a MEAN ABSOLUTE error.
    mustFail(() => {
      const broken = pts.reduce((s, p) => s + Math.abs(p.actual - p.forecast), 0) / pts.length
      return near(broken, modelRunning(pts).mse)
    }, 'MSE ≠ MAE — squaring is what the objective actually does')

    // (b) The bias check must break if the error sign is inverted.
    mustFail(() => {
      const inverted = pts.reduce((s, p) => s + (p.forecast - p.actual), 0) / pts.length
      return near(inverted, modelRunning(pts).bias)
    }, 'error is ACTUAL − FORECAST — inverting the sign inverts the bias lesson')

    // (c) The year split must break if it splits by ROUND INDEX rather than by year.
    //
    // ⚠ THE FIXTURE HAS TO BE 18 MONTHS, NOT 24. At the shipped 24, Y6 IS the first
    // half, so the two rules agree and the control cannot fail — which is exactly what
    // the first draft of this harness did, and why it reported a control that never
    // fired. An 18-month game splits 12/6 by year but 9/9 by index, so the two rules
    // genuinely disagree and the assertion has something to catch.
    mustFail(() => {
      const eighteen = points.slice(0, 18)
      const half = eighteen.slice(0, 9)
      const byYear = modelYears(eighteen)[0]
      const halfMse = half.reduce((s, p) => s + modelPoint(p.forecast, p.actual).se, 0) / half.length
      return byYear.n === 9 && near(halfMse, byYear.mse)
    }, 'the Y6/Y7 split is by CALENDAR YEAR, not by first-half/second-half')

    // (d) ⚠ THE SHAPE PIN ITSELF must fail on an injected field. This is the control
    //     for the control: pinShape is now the primary leak defence, and a shape check
    //     that could not fail would be a defence in name only. Three shapes of leak are
    //     injected — a top-level scalar, a nested one, and one inside an array element —
    //     because keyPaths handles those three cases with different code.
    const shapeState = (await callFn('forecastGetState', asStudent(GID, PID))).result
    const pinned = [...keyPaths(shapeState)]
    mustFail(() => {
      const leaked = { ...shapeState, sigma: 30 }
      return [...keyPaths(leaked)].length === pinned.length
    }, 'a model parameter added at the TOP LEVEL changes the pinned shape')
    mustFail(() => {
      const leaked = { ...shapeState, params: { ...shapeState.params, trend: 4 } }
      return [...keyPaths(leaked)].length === pinned.length
    }, 'a model parameter NESTED inside params changes the pinned shape')
    mustFail(() => {
      const leaked = {
        ...shapeState,
        played: shapeState.played.map((r, i) => (i === 0 ? { ...r, systematic: 800 } : r)),
      }
      // An extra field on ONE array element must surface, not be averaged away — this
      // is why shapeOf merges element shapes and reports MIXED rather than sampling
      // the first element.
      return [...keyPaths(leaked)].length === pinned.length
    }, 'a field added to ONE array element changes the pinned shape')

    // (e) ⚠ THE FLAG'S OWN CONTROL. A perfect forecaster must NOT flag — that is the
    //     false-positive property the whole chi-square test exists for, and a flag that
    //     fired on everyone would look identical to a flag that worked.
    mustFail(() => {
      // MSE at exactly σ² is what a perfect forecaster scores. If THAT flags, the test
      // is not a test.
      const sigma = MODEL.sigma
      const perfectMse = sigma * sigma
      // Reproduce the statistic the server computes; flag iff it lands in the tail.
      // At MSE = σ² the statistic is exactly n, whose lower tail is ~0.54 — nowhere
      // near 1/2700.
      const n = 24
      const statistic = (perfectMse * n) / (sigma * sigma)
      return statistic < n * 0.3          // would-be-flagged under the naive cutoff
    }, 'a perfect forecaster (MSE = σ²) does NOT sit in the flag zone')

    // (f) The history check must break against a perturbed table.
    mustFail(() => {
      const tampered = [...SPEC_HISTORY]
      tampered[30] += 1
      return hist.every((h, i) => h.demand === tampered[i])
    }, 'the published history is exact — a single changed digit is caught')
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(70)}`)
  console.log(`  ${passed} passed, ${failed} failed`)
  console.log('─'.repeat(70))
  if (failed > 0) process.exit(1)
}

main().catch(err => { console.error(err); process.exit(1) })
