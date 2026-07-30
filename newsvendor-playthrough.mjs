// ═══════════════════════════════════════════════════════════════════════════════
// Newsvendor (REGULAR / single-source) — emulator harness.
//
// It drives the SAME CALLABLES THE UI INVOKES — newsvendorBootstrap, GetState,
// SubmitRound, GetQuestions, SubmitKcAnswer, SubmitFreeText, SyncRoster,
// ScoreAndRecord, GetReport, GetConfig, UpdateConfig — over HTTP. It never imports the
// compute functions and never calls them directly: a harness that imported
// computePeriod() would prove that computePeriod agrees with itself.
//
// ⚠ THE SPEC IS RE-IMPLEMENTED HERE, INDEPENDENTLY (§ "The model" below). Every profit,
// every benchmark and every service level is predicted from the spec's formulas written
// out afresh, and checked against what the server returned. Two routes to the same
// number is the whole point.
//
// ⚠ NEGATIVE CONTROLS (§13). Two checks are run against DELIBERATELY BROKEN models and
// are REQUIRED TO FAIL. A test never seen to fail is not known to work:
//   • the shortage penalty — force g = 0 in the model and the profit check must break;
//   • the benchmark — perturb the critical ratio and the profitOpt check must break.
// If either "broken" run passes, the harness fails loudly: it means the assertion was
// not actually testing what it claims to test.
//
// ⚠ `periods` IS SET EXPLICITLY IN EVERY INSTANCE THIS FILE CREATES. Never rely on the
// shipped default — a harness that inherits a period count silently re-tunes itself the
// day someone edits the default, and the round-count assertions stop meaning anything.
//
// Run:  npm run harness:newsvendor
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

/**
 * Runs a check that MUST FAIL, and fails the harness if it passes.
 *
 * `predicate` returns true when the assertion it stands for HOLDS. Here we have
 * deliberately broken the model it is checked against, so it must NOT hold.
 */
const mustFail = (predicate, label) => {
  let held
  try { held = predicate() } catch { held = false }   // a throw is also "did not hold"
  if (held) {
    failed++
    console.error(`  ✗✗ NEGATIVE CONTROL DID NOT FAIL: ${label} — the assertion is not testing what it claims`)
  } else {
    passed++
    console.log(`  ✓ negative control failed as required: ${label}`)
  }
}

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

async function getDoc(docPath) {
  const res = await fetch(`${FIRESTORE}/${docPath}`, { headers: { Authorization: 'Bearer owner' } })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`firestore GET ${docPath} → ${res.status}`)
  return (await res.json()).fields ?? {}
}

const intVal = (n) => ({ integerValue: String(n) })
const dblVal = (n) => ({ doubleValue: n })
const strVal = (s) => ({ stringValue: s })
const boolVal = (b) => ({ booleanValue: b })
const asStudent = (gid, pid, extra = {}) => ({ _test: { participant_id: pid, game_instance_id: gid }, ...extra })
const asInstructor = (gid, extra = {}) => ({ _dev: { game_instance_id: gid }, ...extra })

// ═══════════════════════════════════════════════════════════════════════════════
// The model — the spec, re-implemented independently. NOTHING here is imported from
// functions/src/newsvendor; every line is written from Newsvendor_Game_Specification_v1
// §3–§4 directly.
// ═══════════════════════════════════════════════════════════════════════════════

/** Spec §4: sales = min(Q,D); profit = P·sales − c·Q + (Q−sales)(v−h) − (D−sales)·g. */
function modelPeriod(Q, D, cfg) {
  const sales = Math.min(Q, D)
  const leftover = Math.max(Q - sales, 0)
  const short = Math.max(D - sales, 0)
  const profit = cfg.P * sales - cfg.c * Q + leftover * (cfg.v - cfg.h) - short * cfg.g
  const sl = D <= 0 ? 1 : Math.min(1, sales / D)
  return { sales, leftover, short, profit, sl }
}

/** Spec §4: CU = P − c + g; CO = c − (v − h); CR = CU/(CU+CO). */
function modelCriticalRatio(cfg) {
  const CU = cfg.P - cfg.c + cfg.g
  const CO = cfg.c - (cfg.v - cfg.h)
  return { CU, CO, CR: CU / (CU + CO) }
}

/**
 * Φ⁻¹ — a SECOND, independent implementation (bisection on the CDF below), so the
 * benchmark check does not lean on the same rational approximation the server uses.
 * Slow and obviously correct, which is exactly what a test oracle should be.
 */
function modelInvNorm(p) {
  let lo = -10, hi = 10
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2
    if (modelNormalCdf(mid) < p) lo = mid; else hi = mid
  }
  return (lo + hi) / 2
}

/** Φ — Simpson's rule on the standard normal density. Independent of the server's erfc. */
function modelNormalCdf(x) {
  if (x < -10) return 0
  if (x > 10) return 1
  const n = 20000
  const a = -10, b = x
  const f = (t) => Math.exp(-t * t / 2) / Math.sqrt(2 * Math.PI)
  const step = (b - a) / n
  let sum = f(a) + f(b)
  for (let i = 1; i < n; i++) sum += f(a + i * step) * (i % 2 === 0 ? 2 : 4)
  return (step / 3) * sum
}

/** Spec §4: Normal → round(mean + Φ⁻¹(CR)·sd); Uniform → round(minD + CR·(maxD−minD)). */
function modelOptimalOrder(cfg, crOverride) {
  const CR = crOverride ?? modelCriticalRatio(cfg).CR
  const q = cfg.isNormal
    ? cfg.mean + modelInvNorm(CR) * cfg.sd
    : cfg.minD + CR * (cfg.maxD - cfg.minD)
  return Math.max(0, Math.round(q))
}

/** Spec §4: the benchmark's profit, at Q_opt, against the SAME D. */
function modelBenchmarkProfit(D, cfg, crOverride) {
  const Qopt = modelOptimalOrder(cfg, crOverride)
  return { Qopt, profitOpt: modelPeriod(Qopt, D, cfg).profit }
}

/** Spec §3: the order box's bounds, which the server also enforces. */
function modelOrderBounds(cfg) {
  return cfg.isNormal
    ? { min: Math.max(0, Math.round(cfg.mean - 3 * cfg.sd)), max: Math.round(cfg.mean + 3 * cfg.sd) }
    : { min: Math.round(cfg.minD), max: Math.round(cfg.maxD) }
}

// ── Seeding ────────────────────────────────────────────────────────────────────

/** The regular default market (spec §2, "Plain default"), with `periods` ALWAYS explicit. */
const REGULAR = {
  P: 3000, c: 1000, v: 800, g: 150, h: 300,
  isNormal: true, mean: 1000, sd: 300, minD: 0, maxD: 100,
  periods: 6,
}

async function openInstance(gid, cfg, seed) {
  const fields = {
    price: intVal(cfg.P),
    unit_cost: intVal(cfg.c),
    salvage: intVal(cfg.v),
    goodwill: intVal(cfg.g),
    holding: intVal(cfg.h),
    is_normal: boolVal(cfg.isNormal),
    mean: intVal(cfg.mean),
    sd: intVal(cfg.sd),
    min_demand: intVal(cfg.minD),
    max_demand: intVal(cfg.maxD),
    // ⚠ ALWAYS EXPLICIT — never inherited from the shipped default.
    periods: intVal(cfg.periods),
  }
  await putDoc(`newsvendor_game_instances/${gid}/config/main`, fields)
  if (seed !== undefined) {
    await putDoc(`newsvendor_game_instances/${gid}/truth/main`, { seed: strVal(seed) })
  }
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

// ═══════════════════════════════════════════════════════════════════════════════

async function main() {
  const stamp = Date.now()

  // ───────────────────────────────────────────────────────────────────────────
  section('[1] A full regular game, every period checked against the spec')
  // ───────────────────────────────────────────────────────────────────────────
  const GID = `nv-main-${stamp}`
  const PID = 'nv-stu-1'
  await openInstance(GID, REGULAR, 'harness-seed-1')

  const boot = await callFn('newsvendorBootstrap', asStudent(GID, PID))
  check(boot.ok && boot.result.participant_id === PID, 'bootstrap mints a session for the student')

  const state0 = await callFn('newsvendorGetState', asStudent(GID, PID))
  check(state0.ok, 'getState returns the opening position')
  const params = state0.result.params
  check(params.periods === REGULAR.periods,
    `the period count is the CONFIGURED one, not a default (${params.periods})`)
  const bounds = modelOrderBounds(REGULAR)
  check(params.orderMin === bounds.min && params.orderMax === bounds.max,
    `the order bounds are mean ± 3 SD (${params.orderMin}–${params.orderMax})`)
  check(state0.result.history.length === 0 && state0.result.periodsPlayed === 0,
    'a fresh student has played nothing')
  check(state0.result.gameOver === false, '…and is not finished')

  // Answer the prep FIRST, exactly as the UI's sequence does.
  const q0 = await callFn('newsvendorGetQuestions', asStudent(GID, PID))
  check(q0.ok && q0.result.prep !== null && q0.result.prepSubmitted === false,
    'the prep question is served and unanswered')
  check(q0.result.kc.authored.length === 10,
    `the authored KC is the full TEN questions (got ${q0.result.kc.authored.length})`)
  // ⚠ THE PROMPT IS WRITTEN AGAINST THE KC RUNNING FIRST — it asks what the student
  // intends to do with the optimal quantity they have just computed. The flow order
  // itself is a CLIENT concern (the server accepts these two in any order, by design:
  // it stores facts, not positions), so this assertion is the only thing tying the
  // wording to the sequence. If the screens are ever reordered, it fails here.
  check(/optimal order quantity/i.test(q0.result.prep.prompt),
    'the prep prompt asks about the optimal quantity from the knowledge check')
  const prepRes = await callFn('newsvendorSubmitFreeText',
    asStudent(GID, PID, { field: q0.result.prep.field, answer: 'I will aim a bit above the mean.' }))
  check(prepRes.ok && prepRes.result.stored === false, 'the prep paragraph is accepted')

  // The period loop. A deliberately varied order schedule: below the mean, at it,
  // above it, and at both bounds — so leftover, shortage and the exact-fit case all
  // occur, rather than only the comfortable middle.
  const orderFor = (n) => [400, 1000, 1600, bounds.min, bounds.max, 1200][(n - 1) % 6]
  const responses = []
  const played = []
  for (let n = 1; n <= REGULAR.periods; n++) {
    const Q = orderFor(n)
    const res = await callFn('newsvendorSubmitRound', asStudent(GID, PID, { round: n, order: Q }))
    if (!res.ok) { check(false, `period ${n} submitted (${res.error})`); break }
    responses.push(res.result)
    const r = res.result.round
    const D = r.demand
    played.push({ round: n, Q, D })

    const want = modelPeriod(Q, D, REGULAR)
    check(r.yourOrder === Q, `period ${n}: the order came back unchanged (${Q})`)
    check(Number.isInteger(D) && D >= 0, `period ${n}: demand is a non-negative integer (${D})`)
    check(r.sales === want.sales, `period ${n}: sales = min(Q,D) = ${want.sales}`)
    check(r.unitsOver === want.leftover, `period ${n}: units over = ${want.leftover}`)
    check(r.unitsShort === want.short, `period ${n}: units short = ${want.short}`)
    check(r.profit === want.profit,
      `period ${n}: profit = ${want.profit} (got ${r.profit})`)
    check(Math.abs(r.serviceLevel - want.sl) < 1e-12,
      `period ${n}: demand proportion met = ${want.sl.toFixed(4)}`)
    check(res.result.gameOver === (n === REGULAR.periods),
      `period ${n}: gameOver is ${n === REGULAR.periods}`)
  }

  check(played.length === REGULAR.periods,
    `all ${REGULAR.periods} periods were played (${played.length})`)

  // Running totals, against the model.
  const last = responses[responses.length - 1]
  const wantTotal = played.reduce((a, p) => a + modelPeriod(p.Q, p.D, REGULAR).profit, 0)
  check(last.totalProfit === wantTotal, `the running total profit is ${wantTotal}`)
  check(Math.abs(last.averageProfit - wantTotal / REGULAR.periods) < 1e-9,
    'the average profit per period matches')
  const wantAvgOrder = played.reduce((a, p) => a + p.Q, 0) / played.length
  check(Math.abs(last.averageOrder - wantAvgOrder) < 1e-9, `the average order is ${wantAvgOrder}`)

  // The history table's running values.
  check(last.history.length === REGULAR.periods,
    `the history carries one row per period played (${last.history.length})`)
  let running = 0
  let historyOk = last.history.length === REGULAR.periods
  for (const row of last.history) {
    running += row.profit
    if (row.yourTotal !== running) historyOk = false
    if (Math.abs(row.yourAverage - running / row.round) > 1e-9) historyOk = false
  }
  check(historyOk, 'every history row carries the correct cumulative and average profit')

  // ───────────────────────────────────────────────────────────────────────────
  section('[2] ⚠ THE BENCHMARK IS STORED, AND REACHES NO STUDENT RESPONSE (spec §9.2)')
  // ───────────────────────────────────────────────────────────────────────────
  const wantQopt = modelOptimalOrder(REGULAR)
  const { CR: wantCR } = modelCriticalRatio(REGULAR)

  // It IS stored, period by period, against the same demand draw.
  const pDoc = await getDoc(`newsvendor_game_instances/${GID}/participants/${PID}`)
  const storedRounds = pDoc?.rounds?.arrayValue?.values ?? []
  check(storedRounds.length === REGULAR.periods,
    `the participant doc stores all ${REGULAR.periods} periods (${storedRounds.length})`)
  let benchOk = storedRounds.length === REGULAR.periods
  for (let i = 0; i < storedRounds.length; i++) {
    const f = storedRounds[i].mapValue.fields
    const D = Number(f.d.integerValue ?? f.d.doubleValue)
    const want = modelBenchmarkProfit(D, REGULAR)
    const gotQopt = Number(f.q_opt.integerValue ?? f.q_opt.doubleValue)
    const gotProfitOpt = Number(f.profit_opt.integerValue ?? f.profit_opt.doubleValue)
    if (gotQopt !== want.Qopt || gotProfitOpt !== want.profitOpt) benchOk = false
  }
  check(benchOk,
    `every stored period carries q_opt = ${wantQopt} and the profit it earns against that period's own demand`)

  // ⚠ AND IT REACHES NO STUDENT RESPONSE. Every response this student actually
  // received is scanned for the forbidden keys AND for the numeric value of Q_opt.
  const studentResponses = [state0.result, q0.result, prepRes.result, ...responses]
  const forbiddenKeys = ['qopt', 'q_opt', 'profitopt', 'profit_opt', 'benchmark', 'criticalratio',
    'critical_ratio', 'cr', 'cu', 'co', 'seed', 'optimal', 'gap']
  const leakedKeys = []
  const leakedValues = []
  for (const resp of studentResponses) {
    for (const { path, value } of walk(resp)) {
      const leaf = path.split('.').pop().replace(/\[\d+\]/g, '').toLowerCase()
      if (forbiddenKeys.includes(leaf)) leakedKeys.push(path)
      // Q_opt is 1385 at this market — a number no legitimate student field carries.
      // Orders and demands are the student's own and are excluded by path.
      if (typeof value === 'number' && value === wantQopt
        && !/yourOrder|demand|orderMin|orderMax|sales|history/i.test(path)) {
        leakedValues.push(`${path}=${value}`)
      }
    }
  }
  check(studentResponses.length === REGULAR.periods + 3,
    `the leak audit scanned every student response (${studentResponses.length})`)
  check(leakedKeys.length === 0,
    `⚠ no student response carries a benchmark/seed key (found: ${leakedKeys.join(', ') || 'none'})`)
  check(leakedValues.length === 0,
    `⚠ no student response carries the benchmark ORDER as a value (found: ${leakedValues.join(', ') || 'none'})`)
  check(wantCR > 0 && wantCR < 1, `the critical ratio is a probability (${wantCR.toFixed(4)})`)

  // ───────────────────────────────────────────────────────────────────────────
  section('[3] Submit-and-lock: a resubmit re-draws NOTHING')
  // ───────────────────────────────────────────────────────────────────────────
  const third = responses[2]
  const replay = await callFn('newsvendorSubmitRound',
    asStudent(GID, PID, { round: 3, order: 999 }))
  check(replay.ok, 'a resubmit for a played period is accepted rather than erroring')
  check(replay.result.round.yourOrder === third.round.yourOrder,
    'it returns the STORED order, discarding the incoming one')
  check(replay.result.round.demand === third.round.demand,
    '⚠ …and the SAME demand — a retry cannot buy a second draw')
  check(replay.result.round.profit === third.round.profit, '…and the same profit')

  const pastEnd = await callFn('newsvendorSubmitRound',
    asStudent(GID, PID, { round: REGULAR.periods + 1, order: 1000 }))
  check(!pastEnd.ok && /over|no more/i.test(pastEnd.error),
    'a period past the configured count is refused')

  // ───────────────────────────────────────────────────────────────────────────
  section('[4] Order validation — the bounds the screen shows are the bounds enforced')
  // ───────────────────────────────────────────────────────────────────────────
  const GID_V = `nv-valid-${stamp}`
  await openInstance(GID_V, REGULAR, 'harness-seed-v')
  await callFn('newsvendorBootstrap', asStudent(GID_V, 'nv-v'))
  for (const [order, label] of [
    [bounds.max + 1, 'above the upper bound'],
    [bounds.min - 1, 'below the lower bound'],
    [1000.5, 'not a whole number'],
    ['1000', 'a string'],
  ]) {
    const bad = await callFn('newsvendorSubmitRound', asStudent(GID_V, 'nv-v', { round: 1, order }))
    check(!bad.ok, `an order ${label} is refused (${order})`)
  }
  const outOfStep = await callFn('newsvendorSubmitRound', asStudent(GID_V, 'nv-v', { round: 3, order: 1000 }))
  check(!outOfStep.ok && /not the period/i.test(outOfStep.error),
    'skipping ahead to period 3 before period 1 is refused')

  // ───────────────────────────────────────────────────────────────────────────
  section('[5] The demand draw — seeded, independent across students, in range')
  // ───────────────────────────────────────────────────────────────────────────
  // Same seed, same student id, a fresh instance ⇒ the SAME sequence.
  const GID_A = `nv-seed-a-${stamp}`
  const GID_B = `nv-seed-b-${stamp}`
  await openInstance(GID_A, REGULAR, 'identical-seed')
  await openInstance(GID_B, REGULAR, 'identical-seed')
  const drawSeq = async (gid, pid) => {
    await callFn('newsvendorBootstrap', asStudent(gid, pid))
    const ds = []
    for (let n = 1; n <= 4; n++) {
      const r = await callFn('newsvendorSubmitRound', asStudent(gid, pid, { round: n, order: 1000 }))
      if (!r.ok) break
      ds.push(r.result.round.demand)
    }
    return ds
  }
  const seqA = await drawSeq(GID_A, 'twin')
  const seqB = await drawSeq(GID_B, 'twin')
  const seqOther = await drawSeq(GID_A, 'other-student')
  check(seqA.length === 4 && seqB.length === 4 && seqOther.length === 4,
    'three 4-period draw sequences were collected')
  check(JSON.stringify(seqA) === JSON.stringify(seqB),
    `the same seed and student reproduce the same demand sequence (${seqA.join(', ')})`)
  check(JSON.stringify(seqA) !== JSON.stringify(seqOther),
    '⚠ …while a DIFFERENT student in the same instance draws differently (independence)')

  // Uniform demand, including the D = 0 case the service-level guard exists for.
  const UNIFORM = { ...REGULAR, isNormal: false, minD: 0, maxD: 4, periods: 12 }
  const GID_U = `nv-uniform-${stamp}`
  await openInstance(GID_U, UNIFORM, 'uniform-seed')
  await callFn('newsvendorBootstrap', asStudent(GID_U, 'nv-u'))
  const uState = await callFn('newsvendorGetState', asStudent(GID_U, 'nv-u'))
  check(uState.result.params.orderMin === 0 && uState.result.params.orderMax === 4,
    'Uniform mode offers the demand range itself as the order bounds')
  const uDraws = []
  for (let n = 1; n <= UNIFORM.periods; n++) {
    const r = await callFn('newsvendorSubmitRound', asStudent(GID_U, 'nv-u', { round: n, order: 2 }))
    if (!r.ok) break
    uDraws.push(r.result.round)
  }
  check(uDraws.length === UNIFORM.periods, `${UNIFORM.periods} uniform periods were played`)
  check(uDraws.every(r => Number.isInteger(r.demand) && r.demand >= 0 && r.demand <= 4),
    'every uniform draw is an integer inside [minD, maxD]')
  const zeroDraws = uDraws.filter(r => r.demand === 0)
  check(zeroDraws.length > 0, `a D = 0 draw actually occurred (${zeroDraws.length} of ${uDraws.length})`)
  check(zeroDraws.every(r => r.serviceLevel === 1),
    '⚠ D = 0 gives a demand proportion of 1, not a divide-by-zero (spec §6)')
  check(uDraws.every(r => r.profit === modelPeriod(r.yourOrder, r.demand, UNIFORM).profit),
    'every uniform period’s profit matches the model')

  // ───────────────────────────────────────────────────────────────────────────
  section('[6] The knowledge check — ten questions, denominator 10, shuffled per student')
  // ───────────────────────────────────────────────────────────────────────────
  // The answer key, transcribed from Newsvendor_KC_Questions_v1.md. NOT imported from
  // the game — this is the doc's key, checked against what the game grades.
  const KC_KEY = {
    kc_cr_concept: 'over_under',
    kc_underage: 'cu_90',
    kc_overage: 'co_10',
    kc_critical_ratio: 'cr_090',
    kc_direction: 'above',
    kc_qstar: 'q_628',
    kc_profit_leftover: 'p_26000',
    kc_profit_shortage: 's_22000',
    kc_salvage_rises: 'up',
    kc_variability: 'higher',
  }

  const served = q0.result.kc.authored
  check(served.length === Object.keys(KC_KEY).length,
    `every question in the doc is served (${served.length})`)
  check(served.every(q => KC_KEY[q.field] !== undefined),
    'every served field is one the answer key knows')
  check(served.every(q => q.options.length === 4), 'every question offers four options')
  check(served.every(q => q.options.some(o => o.value === KC_KEY[q.field])),
    'the correct answer is among the options offered for every question')
  check(served.every(q => q.correct_value === undefined && q.explanation === undefined),
    '⚠ the answer key never ships to the client')

  // ⚠ THE TEACHING NUMBERS ARE NOT THE GAME'S. The stems must state the KC's own
  // market (P = 120 …), which is deliberately different from the instance (P = 3000).
  const stems = served.map(q => q.prompt).join(' ')
  check(/P = 120|sells for \*\*P = 120\*\*|sells for P = 120/.test(stems) || /120/.test(stems),
    'the stems carry their own teaching numbers (P = 120)')
  check(!stems.includes(String(REGULAR.P)),
    `⚠ …and NOT the instance's own price (${REGULAR.P}) — students must recompute`)

  // Option order differs across students, and is stable for one student.
  const q0b = await callFn('newsvendorGetQuestions', asStudent(GID, PID))
  const orderNow = q0b.result.kc.authored.map(q => q.options.map(o => o.value).join('|')).join('//')
  const orderFirst = served.map(q => q.options.map(o => o.value).join('|')).join('//')
  check(orderNow === orderFirst, 'one student sees a STABLE option order across calls')

  await callFn('newsvendorBootstrap', asStudent(GID, 'nv-stu-2'))
  const qOther = await callFn('newsvendorGetQuestions', asStudent(GID, 'nv-stu-2'))
  const orderOther = qOther.result.kc.authored.map(q => q.options.map(o => o.value).join('|')).join('//')
  check(orderOther !== orderFirst, '⚠ …while a DIFFERENT student gets a different shuffle')
  check(
    qOther.result.kc.authored.every(q =>
      q.options.map(o => o.value).sort().join(',')
      === served.find(s => s.field === q.field).options.map(o => o.value).sort().join(',')),
    '…and it is a permutation of the same options, not a different question')

  // Answer nine right and one wrong: the score must be 9/10, not 1 and not 0.9 by luck.
  const wrongField = 'kc_overage'
  for (const q of served) {
    const correct = KC_KEY[q.field]
    const answer = q.field === wrongField
      ? q.options.find(o => o.value !== correct).value
      : correct
    const r = await callFn('newsvendorSubmitKcAnswer', asStudent(GID, PID, { field: q.field, answer }))
    check(r.ok && r.result.correct === (q.field !== wrongField),
      `KC ${q.field}: graded ${q.field === wrongField ? 'incorrect' : 'correct'}`)
    if (q.field === wrongField) {
      check(r.result.explanation.length > 0, '…and a wrong answer still earns its explanation')
    }
  }
  const kcDoc = await getDoc(`newsvendor_game_instances/${GID}/participants/${PID}`)
  const kcScore = Number(kcDoc?.knowledge_check_score?.doubleValue ?? kcDoc?.knowledge_check_score?.integerValue)
  check(Math.abs(kcScore - 0.9) < 1e-9,
    `⚠ the KC score is 9/10 = 0.9 — a DENOMINATOR OF TEN, computed from the served set (got ${kcScore})`)

  const relock = await callFn('newsvendorSubmitKcAnswer',
    asStudent(GID, PID, { field: wrongField, answer: KC_KEY[wrongField] }))
  check(relock.ok && relock.result.correct === false,
    'a re-answer cannot overwrite a wrong answer with a right one (one-shot lock)')

  const unknownQ = await callFn('newsvendorSubmitKcAnswer',
    asStudent(GID, PID, { field: 'kc_not_a_question', answer: 'x' }))
  check(!unknownQ.ok && /not a knowledge-check question/.test(unknownQ.error),
    'an unknown KC field is refused by name')

  // ───────────────────────────────────────────────────────────────────────────
  section('[7] The two free-text questions — each its own field, each one-shot')
  // ───────────────────────────────────────────────────────────────────────────
  const qAfter = await callFn('newsvendorGetQuestions', asStudent(GID, PID))
  check(qAfter.result.prepSubmitted === true, 'the prep is recorded as submitted')
  check(qAfter.result.debrief !== null && qAfter.result.debriefSubmitted === false,
    'the debrief is served and still open')
  check(qAfter.result.prep.field !== qAfter.result.debrief.field,
    '⚠ prep and debrief are DIFFERENT fields — two questions, two reports (spec §8)')

  const debriefRes = await callFn('newsvendorSubmitFreeText',
    asStudent(GID, PID, { field: qAfter.result.debrief.field, answer: 'I drifted upward as I kept selling out.' }))
  check(debriefRes.ok && debriefRes.result.stored === false, 'the debrief paragraph is accepted')

  const rewrite = await callFn('newsvendorSubmitFreeText',
    asStudent(GID, PID, { field: qAfter.result.debrief.field, answer: 'A different answer.' }))
  check(rewrite.ok && rewrite.result.stored === true
    && rewrite.result.answer === 'I drifted upward as I kept selling out.',
    'a second submission returns the stored paragraph rather than overwriting it')

  const badField = await callFn('newsvendorSubmitFreeText',
    asStudent(GID, PID, { field: 'debrief_dual', answer: 'x' }))
  check(!badField.ok && /not a free-text question/.test(badField.error),
    'a field outside the closed whitelist is refused (including Part 2’s dual field)')

  const emptyText = await callFn('newsvendorSubmitFreeText',
    asStudent(GID, 'nv-stu-2', { field: qAfter.result.prep.field, answer: '   ' }))
  check(!emptyText.ok, 'an empty paragraph is refused')

  // ───────────────────────────────────────────────────────────────────────────
  section('[8] Resume — a returning student picks up exactly where they stopped')
  // ───────────────────────────────────────────────────────────────────────────
  const GID_R = `nv-resume-${stamp}`
  await openInstance(GID_R, REGULAR, 'resume-seed')
  await callFn('newsvendorBootstrap', asStudent(GID_R, 'nv-r'))
  for (let n = 1; n <= 3; n++) {
    await callFn('newsvendorSubmitRound', asStudent(GID_R, 'nv-r', { round: n, order: 1100 }))
  }
  const resumed = await callFn('newsvendorGetState', asStudent(GID_R, 'nv-r'))
  check(resumed.result.periodsPlayed === 3, 'the server reports three periods played')
  check(resumed.result.history.length === 3, '…and returns all three history rows')
  check(resumed.result.gameOver === false, '…and the game is still open')
  const resumedDemands = resumed.result.history.map(r => r.demand)
  // A legal-but-different order for an already-played period: it must come back as the
  // STORED period. (An out-of-bounds order would be rejected by validation before the
  // lock is ever consulted — input validation runs first, deliberately, so a malformed
  // call costs no read.)
  const replayed = await callFn('newsvendorSubmitRound',
    asStudent(GID_R, 'nv-r', { round: 2, order: 900 }))
  check(replayed.ok && replayed.result.round.demand === resumedDemands[1],
    'the history a resumed student sees is the history the server stored')

  // ───────────────────────────────────────────────────────────────────────────
  section('[9] Config validation (spec §2) — including the two the benchmark requires')
  // ───────────────────────────────────────────────────────────────────────────
  const GID_C = `nv-config-${stamp}`
  await openInstance(GID_C, REGULAR, 'cfg-seed')

  const cfgView = await callFn('newsvendorGetConfig', asInstructor(GID_C))
  check(cfgView.ok, 'getConfig returns the instance settings')
  check(cfgView.result.config.periods === REGULAR.periods,
    'it reports the configured period count')
  check(cfgView.result.benchmark !== null
    && cfgView.result.benchmark.Qopt === wantQopt,
    `⚠ the instructor view DOES carry the benchmark (Q* = ${wantQopt}) — that is its job`)
  check(Math.abs(cfgView.result.benchmark.CR - wantCR) < 1e-6,
    `…and the critical ratio (${wantCR.toFixed(4)})`)
  check(cfgView.result.authoredKcCount === 10, 'the settings page is told the KC denominator is 10')
  check(cfgView.result.authoredKcPreview.length === 10
    && cfgView.result.authoredKcPreview.every(q => typeof q.correct_value === 'string'),
    '…and previews all ten WITH the key (instructor-side)')

  const rejects = [
    [{ P: 500, c: 1000 }, 'a price at or below the unit cost'],
    [{ v: 1200, h: 0 }, 'a net salvage at or above the unit cost (no finite Q*)'],
    [{ periods: 0 }, 'zero periods'],
    [{ periods: 3.5 }, 'a fractional period count'],
    [{ isNormal: false, minD: 500, maxD: 500 }, 'a uniform range with maxD ≤ minD'],
    [{ sd: 0 }, 'a zero standard deviation'],
    [{ c: -5 }, 'a negative cost'],
    [{ dual: true }, '⚠ dual sourcing (Part 2, not built)'],
  ]
  for (const [patch, label] of rejects) {
    const r = await callFn('newsvendorUpdateConfig', asInstructor(GID_C, patch))
    check(!r.ok, `updateConfig refuses ${label}`)
  }

  const accepted = await callFn('newsvendorUpdateConfig',
    asInstructor(GID_C, { P: 4000, periods: 8, showCalculator: false }))
  check(accepted.ok && accepted.result.config.P === 4000 && accepted.result.config.periods === 8
    && accepted.result.config.showCalculator === false,
    'a legal edit is stored and returned')
  check(accepted.result.benchmark.Qopt !== wantQopt,
    'the benchmark moves when the parameters move')

  // The seed round-trips to TRUTH, and is not in the student-readable config doc.
  await callFn('newsvendorUpdateConfig', asInstructor(GID_C, { seed: 'set-by-settings' }))
  const truthDoc = await getDoc(`newsvendor_game_instances/${GID_C}/truth/main`)
  const configDoc = await getDoc(`newsvendor_game_instances/${GID_C}/config/main`)
  check(truthDoc?.seed?.stringValue === 'set-by-settings',
    '⚠ the seed is written to the RULES-DENIED truth doc')
  check(configDoc?.seed === undefined,
    '⚠ …and never to the student-readable config doc')

  // ───────────────────────────────────────────────────────────────────────────
  section('[10] Score & Record — participation only, benchmark reported not graded')
  // ───────────────────────────────────────────────────────────────────────────
  const GID_S = `nv-score-${stamp}`
  await openInstance(GID_S, { ...REGULAR, periods: 3 }, 'score-seed')
  const SCFG = { ...REGULAR, periods: 3 }

  // A finisher, a mid-game student, and one the roster created who never launched.
  await callFn('newsvendorBootstrap', asStudent(GID_S, 'fin'))
  const finPlayed = []
  for (let n = 1; n <= 3; n++) {
    const r = await callFn('newsvendorSubmitRound', asStudent(GID_S, 'fin', { round: n, order: 1200 }))
    finPlayed.push({ Q: 1200, D: r.result.round.demand })
  }
  await callFn('newsvendorBootstrap', asStudent(GID_S, 'mid'))
  await callFn('newsvendorSubmitRound', asStudent(GID_S, 'mid', { round: 1, order: 800 }))
  // ⚠ NOT a bootstrap — a never-started student is one the ROSTER SYNC created:
  // identity fields only, no launched_at.
  await putDoc(`newsvendor_game_instances/${GID_S}/participants/never`, {
    participant_id: strVal('never'),
    game_instance_id: strVal(GID_S),
    name: strVal('Never Started'),
  })

  const scoreRes = await callFn('newsvendorScoreAndRecord', asInstructor(GID_S))
  check(scoreRes.ok, 'scoreAndRecord runs')
  check(scoreRes.result.scored === 3, `it scored all three participants (${scoreRes.result.scored})`)
  check(scoreRes.result.finishers === 1, `exactly one finisher (${scoreRes.result.finishers})`)
  check(scoreRes.result.push === null,
    'with no classroom callback configured it pushes nothing and SAYS so')

  const finDoc = await getDoc(`newsvendor_game_instances/${GID_S}/participants/fin`)
  const neverDoc = await getDoc(`newsvendor_game_instances/${GID_S}/participants/never`)
  check(Number(finDoc.raw_score.integerValue ?? finDoc.raw_score.doubleValue) === 1,
    'the finisher gets raw_score 1')
  check(Number(finDoc.normalized_score.integerValue ?? finDoc.normalized_score.doubleValue) === 0,
    '…normalized to 0 (the all-ones pool’s zero-SD guard)')
  check(Number(neverDoc.normalized_score.integerValue ?? neverDoc.normalized_score.doubleValue) === -2,
    'the never-started student gets the −2 no-show floor')
  check(neverDoc.raw_score?.nullValue !== undefined, '…with a null raw score')

  // ⚠ Profit and the gap are written for REPORTS, and are not the score.
  const wantFinProfit = finPlayed.reduce((a, p) => a + modelPeriod(p.Q, p.D, SCFG).profit, 0)
  const wantFinBench = finPlayed.reduce((a, p) => a + modelBenchmarkProfit(p.D, SCFG).profitOpt, 0)
  const gotFinProfit = Number(finDoc.profit_total.integerValue ?? finDoc.profit_total.doubleValue)
  const gotFinBench = Number(finDoc.benchmark_profit_total.integerValue ?? finDoc.benchmark_profit_total.doubleValue)
  check(gotFinProfit === wantFinProfit, `the finisher's stored total profit is ${wantFinProfit}`)
  check(gotFinBench === wantFinBench, `…and the stored benchmark total is ${wantFinBench}`)
  check(Number(finDoc.raw_score.integerValue ?? finDoc.raw_score.doubleValue) === 1,
    '⚠ …and the score is STILL 1 — profit and the gap are outcomes, never grades')

  // ───────────────────────────────────────────────────────────────────────────
  section('[11] The instructor report — correct on partial data')
  // ───────────────────────────────────────────────────────────────────────────
  const rep = await callFn('newsvendorGetReport', asInstructor(GID_S))
  check(rep.ok, 'getReport runs')
  check(rep.result.participants.length === 3, `it returns all three students (${rep.result.participants.length})`)
  const finRow = rep.result.participants.find(p => p.participant_id === 'fin')
  const midRow = rep.result.participants.find(p => p.participant_id === 'mid')
  const neverRow = rep.result.participants.find(p => p.participant_id === 'never')
  check(finRow.completed === true && midRow.completed === false && neverRow.launched === false,
    'the three states are distinguished: finished / in progress / never started')
  check(finRow.total_profit === wantFinProfit, 'the finisher’s reported total profit matches the model')
  check(finRow.benchmark_profit === wantFinBench, '…and their benchmark total')
  check(finRow.optimality_gap === wantFinBench - wantFinProfit,
    `…and the gap is benchmark − realized, SIGNED (${wantFinBench - wantFinProfit})`)
  check(neverRow.average_order === null && neverRow.optimality_gap === null,
    'a never-started student shows null (a dash), not zero')
  check(rep.result.maxPeriodsPlayed === 3,
    'the charts’ x-axis is the longest game anyone played, not the configured count')
  check(rep.result.charts.orders.length === 3, 'the order chart has one point per played period')
  const ns = rep.result.charts.orders.map(p => p.n)
  check(ns[0] === 2 && ns[2] === 1,
    `⚠ the per-period denominator genuinely thins as the class spreads out (${ns.join(', ')})`)
  check(rep.result.charts.profits.map(p => p.n).join() === ns.join(),
    'the profit chart averages over exactly the same students, period for period')
  check(rep.result.benchmark !== null && rep.result.benchmark.Qopt === modelOptimalOrder(SCFG),
    'the report carries the benchmark for the reference line')

  const repMain = await callFn('newsvendorGetReport', asInstructor(GID))
  const mainRow = repMain.result.participants.find(p => p.participant_id === PID)
  check(mainRow.prep !== null && mainRow.debrief !== null,
    '⚠ BOTH free-text answers reach the report, on their own fields (two Tier-2 tiles)')
  check(mainRow.prep !== mainRow.debrief, '…and they are the two different paragraphs')
  check(Math.abs(mainRow.knowledge_check_score - 0.9) < 1e-9,
    'the KC score reaches the report as 9/10')

  // ───────────────────────────────────────────────────────────────────────────
  section('[12] The instance is isolated — a second instance shares nothing')
  // ───────────────────────────────────────────────────────────────────────────
  const GID_ISO = `nv-iso-${stamp}`
  await openInstance(GID_ISO, { ...REGULAR, periods: 2 }, 'iso-seed')
  await callFn('newsvendorBootstrap', asStudent(GID_ISO, PID))   // the SAME participant id
  const isoState = await callFn('newsvendorGetState', asStudent(GID_ISO, PID))
  check(isoState.result.periodsPlayed === 0,
    '⚠ the same student in a second instance starts fresh (per-instance subcollection)')
  check(isoState.result.params.periods === 2, '…against the second instance’s own config')

  // ───────────────────────────────────────────────────────────────────────────
  section('[13] ⚠ NEGATIVE CONTROLS — these assertions MUST fail when the model is broken')
  // ───────────────────────────────────────────────────────────────────────────
  // The two checks above that carry the most weight are "profit matches the model" and
  // "the benchmark matches the model". Below, each is re-run against a DELIBERATELY
  // WRONG model. If either still passes, the original assertion was not testing what it
  // claims, and the harness says so rather than reporting a green run.

  // (a) THE SHORTAGE PENALTY. Force g = 0 and re-check the periods where demand
  //     EXCEEDED the order — the goodwill term is the only difference, so those periods
  //     must now disagree.
  const shortagePeriods = played.filter(p => p.D > p.Q)
  check(shortagePeriods.length > 0,
    `the played game really did contain shortage periods to test (${shortagePeriods.length})`)
  const brokenG = { ...REGULAR, g: 0 }
  mustFail(
    () => shortagePeriods.length > 0 && shortagePeriods.every((p, i) => {
      const actual = responses[played.indexOf(p)].round.profit
      return actual === modelPeriod(p.Q, p.D, brokenG).profit
    }),
    'profit still matches with the shortage penalty g forced to 0',
  )
  // …and the SAME check against the true model must hold, so the failure above is the
  // broken g and nothing else.
  check(shortagePeriods.every(p => responses[played.indexOf(p)].round.profit
    === modelPeriod(p.Q, p.D, REGULAR).profit),
    '…while the same periods DO match once g is restored (so the control isolated g)')

  // (b) THE BENCHMARK. Perturb the critical ratio and re-check the stored profitOpt.
  //     Q_opt is a quantile of demand at CR, so a perturbed CR must move it.
  const perturbedCR = modelCriticalRatio(REGULAR).CR - 0.08
  check(modelOptimalOrder(REGULAR, perturbedCR) !== wantQopt,
    `perturbing the critical ratio really does move Q* (${modelOptimalOrder(REGULAR, perturbedCR)} vs ${wantQopt})`)
  mustFail(
    () => {
      if (storedRounds.length === 0) return false
      return storedRounds.every((el) => {
        const f = el.mapValue.fields
        const D = Number(f.d.integerValue ?? f.d.doubleValue)
        const gotProfitOpt = Number(f.profit_opt.integerValue ?? f.profit_opt.doubleValue)
        return gotProfitOpt === modelBenchmarkProfit(D, REGULAR, perturbedCR).profitOpt
      })
    },
    'the stored benchmark still matches with the critical ratio perturbed by −0.08',
  )
  check(benchOk, '…while the benchmark DOES match at the true critical ratio (control isolated CR)')

  // ───────────────────────────────────────────────────────────────────────────
  console.log(`\n${'═'.repeat(70)}`)
  console.log(`Newsvendor harness: ${passed} passed, ${failed} failed`)
  console.log('═'.repeat(70))
  if (failed > 0) process.exit(1)
}

main().catch(err => {
  console.error('\nHarness crashed:', err)
  process.exit(1)
})
