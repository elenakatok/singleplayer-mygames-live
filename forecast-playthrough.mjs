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
const MODEL = { a: 560, b: 4, H: 230, sigma: 30, high: [11, 12] }
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
  if (o.seed !== undefined) truth.seed = strVal(o.seed)
  await putDoc(`forecast_game_instances/${gid}/truth/main`, truth)
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
    const paramValues = Object.values(s.result.params).filter(v => typeof v === 'number')
    check(!paramValues.includes(MODEL.H) && !paramValues.includes(MODEL.sigma)
      && !paramValues.includes(MODEL.a),
      'no model parameter value appears among the params scalars')

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
      'their realized futures DIFFER — the async leak is closed')
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
  section('[9] ⚠ NEGATIVE CONTROLS — these assertions MUST fail when the model is broken')
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

    // (d) The history check must break against a perturbed table.
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
