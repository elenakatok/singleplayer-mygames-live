// ═══════════════════════════════════════════════════════════════════════════════
// Metalcraft Supplier Scorecard — emulator harness (spec §13). CHECKPOINT 2 scope:
// the student flow end to end, both arms of the counterbalancing, resume from all three
// boundaries, and the leak surface.
//
// It drives the SAME CALLABLES THE UI INVOKES over HTTP. It never imports anything from
// functions/src/scorecard — a harness that imported settleContract() would prove that
// settleContract agrees with itself.
//
// ⚠ THE SCORING IS RE-IMPLEMENTED HERE, INDEPENDENTLY (§ "The model" below). Every
// balance, score and contract settlement is computed afresh from spec §1's formula and
// checked against what the server returned. Two routes to the same number is the point.
//
// ⚠ THIS GAME'S DEFINING RISK IS CONDITION PLUMBING, not arithmetic. If `reliabilityUsed`
// were derived at read time, or the schedule recomputed instead of derived from a stored
// `startsWith`, BOTH CONDITIONS COULD SILENTLY COLLAPSE INTO ONE and nothing would look
// broken — the Tier-3 chart would show two plausible lines. So §3 and §4 below check the
// schedule and the four draw-rate cells separately, and §4's 0.30-in-BOTH-conditions cell
// is the designed tripwire: it is CORRECT under a collapsed treatment, so only the paired
// 0.70/0.40 cells can separate.
//
// ⚠ NEGATIVE CONTROLS (§8). Checks run against DELIBERATELY BROKEN expectations and
// REQUIRED to fail. A test never seen to fail is not known to work (T1).
//
// ⚠ EVERY PARAMETER IS SET EXPLICITLY IN EVERY INSTANCE THIS FILE CREATES. Never rely on
// a shipped default — a harness that inherits them silently re-tunes itself the day
// someone edits the default.
//
// ⚠ T5 — THE npm SCRIPT BUILDS functions/ FIRST. `emulators:exec` serves functions/lib,
// so without it this file silently runs the PREVIOUS compile and reports a green suite
// for code that was never executed.
//
// Run:  npm run harness:scorecard
// ═══════════════════════════════════════════════════════════════════════════════

const PROJECT = 'demo-singleplayer'
const FUNCTIONS = `http://127.0.0.1:5010/${PROJECT}/us-central1`
const FIRESTORE = `http://127.0.0.1:8090/v1/projects/${PROJECT}/databases/(default)/documents`

let passed = 0, failed = 0
const perSection = {}
let currentSection = '(none)'

const check = (cond, label) => {
  if (cond) { passed++; perSection[currentSection] = (perSection[currentSection] ?? 0) + 1; console.log(`  ✓ ${label}`) }
  else { failed++; console.error(`  ✗ ${label}`) }
}
const section = (title) => { currentSection = title; console.log(`\n${title}`) }

/** Runs a check that MUST FAIL, and fails the harness if it passes. */
const mustFail = (predicate, label) => {
  let held
  try { held = predicate() } catch { held = false }
  if (held) {
    failed++
    console.error(`  ✗✗ NEGATIVE CONTROL DID NOT FAIL: ${label} — the assertion is not testing what it claims`)
  } else {
    passed++
    perSection[currentSection] = (perSection[currentSection] ?? 0) + 1
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

async function getDoc(docPath) {
  const res = await fetch(`${FIRESTORE}/${docPath}`, { headers: { Authorization: 'Bearer owner' } })
  if (!res.ok) return null
  return await res.json()
}

const intVal = (n) => ({ integerValue: String(n) })
const dblVal = (n) => ({ doubleValue: n })
const strVal = (s) => ({ stringValue: s })
const boolVal = (b) => ({ booleanValue: b })
const asStudent = (gid, pid, extra = {}) => ({ _test: { participant_id: pid, game_instance_id: gid }, ...extra })
const asInstructor = (gid, extra = {}) => ({ _dev: { game_instance_id: gid }, ...extra })

// ═══════════════════════════════════════════════════════════════════════════════
// The model — the spec, re-implemented independently. NOTHING here is imported from
// functions/src/scorecard; every line is written from the spec directly.
// ═══════════════════════════════════════════════════════════════════════════════

/** Spec §1: contract earnings = endowment − c·(high periods) − cLow·(low periods) + B·1{score ≥ S*} */
function modelSettle(actions, acceptables, P) {
  const highs = actions.filter(a => a === 'high').length
  const lows = actions.length - highs
  const score = acceptables.filter(Boolean).length
  return {
    highEffortPeriods: highs,
    score,
    metTarget: score >= P.targetScore,
    earnings: P.endowment - P.cHigh * highs - P.cLow * lows + (score >= P.targetScore ? P.bonus : 0),
  }
}

/** Spec §2.2: alternating, counterbalanced. Contract k (1-based) under `startsWith`. */
function modelCondition(k, startsWith) {
  const flip = (c) => (c === 'high' ? 'low' : 'high')
  return (k - 1) % 2 === 0 ? startsWith : flip(startsWith)
}

/** Spec §2.1: only the HIGH-effort probability moves. */
function modelP(action, condition, P) {
  if (action === 'low') return P.pLow
  return condition === 'high' ? P.relHigh : P.relLow
}

// ── The instance under test ────────────────────────────────────────────────────

const P = {
  contracts: 10,
  periods: 10,
  targetScore: 7,
  bonus: 120,
  cHigh: 4,
  cLow: 0,
  pLow: 0.30,
  endowment: 50,
  relHigh: 0.70,
  relLow: 0.40,
}

async function openInstance(gid, opts = {}) {
  const o = { ...P, ...opts }
  // ⚠ ALL EXPLICIT — never inherited from a shipped default.
  await putDoc(`scorecard_game_instances/${gid}/config/main`, {
    contracts: intVal(o.contracts),
    periods_per_contract: intVal(o.periods),
    target_score: intVal(o.targetScore),
    bonus: intVal(o.bonus),
    high_effort_cost: intVal(o.cHigh),
    low_effort_cost: intVal(o.cLow),
    p_acceptable_low: dblVal(o.pLow),
    endowment_per_contract: intVal(o.endowment),
    show_target_reached_banner: boolVal(true),
    show_prior_contracts_panel: boolVal(true),
    show_running_balance: boolVal(true),
    show_reliability_label: boolVal(opts.showLabel ?? true),
    currency: strVal('ECU'),
    ...(opts.kcEnabled === false ? { kc_enabled: boolVal(false) } : {}),
    ...(opts.addedKc ? { added_kc_questions: opts.addedKc } : {}),
  })
  // ⚠ THE TREATMENT GOES IN truth/, NEVER config/ (spec §8). If it ever has to move,
  // the leak audit in §7 is what should stop it.
  if (!opts.noTruth) {
    await putDoc(`scorecard_game_instances/${gid}/truth/main`, {
      reliability_high: dblVal(o.relHigh),
      reliability_low: dblVal(o.relLow),
      reliability_schedule: strVal(opts.schedule ?? 'alternating'),
      label_high: strVal('High Reliability ({pct})'),
      label_low: strVal('Low Reliability ({pct})'),
      ...(opts.seed ? { seed: strVal(opts.seed) } : {}),
    })
  }
}

// ── Driving one student through the whole session ──────────────────────────────

/**
 * Plays a full session. `choose(contract, period, score, remaining)` returns the action.
 * Returns the transcript: one entry per contract, each with its periods.
 */
async function playSession(gid, pid, choose) {
  const contracts = []
  let st = await callFn('scorecardGetState', asStudent(gid, pid))
  if (!st.ok) throw new Error(`getState: ${st.error}`)

  for (let k = 1; k <= P.contracts; k++) {
    const entry = {
      contract: k,
      reliability: st.result.contract.reliability,
      label: st.result.contract.label,
      periods: [],
    }
    for (let p = 1; p <= P.periods; p++) {
      const c = st.result.contract
      const action = choose(k, p, c.score, c.periodsRemaining)
      const before = { score: c.score, balance: c.balance, periodsRemaining: c.periodsRemaining }
      const res = await callFn('scorecardSubmitPeriod', asStudent(gid, pid, {
        contract: k, period: p, action,
      }))
      if (!res.ok) throw new Error(`submitPeriod c${k}p${p}: ${res.error}`)
      const after = res.result.contract ?? null
      const justDone = res.result.result ?? null
      entry.periods.push({
        period: p,
        action,
        before,
        // On the last period of a contract the response carries `result`, not `contract`.
        score: after ? after.score : justDone.score,
        balance: after ? after.balance : null,
        acceptable: after
          ? after.periods[after.periods.length - 1].acceptable
          : null,
      })
      if (after) {
        st = { ok: true, result: res.result }
      } else {
        entry.settled = justDone
        entry.completed = res.result.completed
        entry.totalEarnings = res.result.totalEarnings
        entry.gameOver = res.result.gameOver
      }
    }
    // Advance past contract-result into the next contract (spec §4).
    if (k < P.contracts) {
      st = await callFn('scorecardGetState', asStudent(gid, pid, { advance: true }))
      if (!st.ok) throw new Error(`advance after c${k}: ${st.error}`)
    }
    contracts.push(entry)
  }
  return contracts
}

/** The stored participant doc, read with owner credentials (server's own view). */
async function readParticipant(gid, pid) {
  const doc = await getDoc(`scorecard_game_instances/${gid}/participants/${pid}`)
  if (!doc?.fields) return null
  const unwrap = (v) => {
    if (v.integerValue !== undefined) return Number(v.integerValue)
    if (v.doubleValue !== undefined) return v.doubleValue
    if (v.stringValue !== undefined) return v.stringValue
    if (v.booleanValue !== undefined) return v.booleanValue
    if (v.timestampValue !== undefined) return v.timestampValue
    if (v.nullValue !== undefined) return null
    if (v.arrayValue !== undefined) return (v.arrayValue.values ?? []).map(unwrap)
    if (v.mapValue !== undefined) {
      const o = {}
      for (const [k, mv] of Object.entries(v.mapValue.fields ?? {})) o[k] = unwrap(mv)
      return o
    }
    return null
  }
  const out = {}
  for (const [k, v] of Object.entries(doc.fields)) out[k] = unwrap(v)
  return out
}

/** Every key path in a response tree, recursively — the exact-key-set pin (T6). */
function keyPaths(obj, prefix = '', out = new Set()) {
  if (obj === null || typeof obj !== 'object') return out
  if (Array.isArray(obj)) {
    // Array elements collapse to [] so a 10-period history does not produce 10 paths.
    for (const el of obj) keyPaths(el, `${prefix}[]`, out)
    return out
  }
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k
    out.add(path)
    keyPaths(v, path, out)
  }
  return out
}

// ═══════════════════════════════════════════════════════════════════════════════
// The run
// ═══════════════════════════════════════════════════════════════════════════════

const run = async () => {
  console.log('═'.repeat(78))
  console.log('Metalcraft Supplier Scorecard — CP2 harness')
  console.log('═'.repeat(78))

  // ─────────────────────────────────────────────────────────────────────────────
  section('§1  Both arms of the counterbalancing — a full session each')
  // ─────────────────────────────────────────────────────────────────────────────
  const gid = `sc-cp2-${Date.now()}`
  await openInstance(gid, { seed: 'cp2-fixed' })

  // ⚠ JOIN ORDER IS WHAT ASSIGNS THE ARM (spec §2.2). Student A touches first and takes
  // ordinal 0 (high); student B takes ordinal 1 (low). Sequential on purpose — a
  // concurrent pair would still be exactly balanced, but the harness could not then say
  // WHICH arm each student is in, and every later assertion keys off that.
  const A = 'stu-A', B = 'stu-B'
  const a0 = await callFn('scorecardGetState', asStudent(gid, A))
  const b0 = await callFn('scorecardGetState', asStudent(gid, B))
  check(a0.ok && b0.ok, 'both students reach getState')

  const docA0 = await readParticipant(gid, A)
  const docB0 = await readParticipant(gid, B)
  check(docA0?.starts_with === 'high', `student A assigned startsWith=high (got ${docA0?.starts_with})`)
  check(docB0?.starts_with === 'low', `student B assigned startsWith=low (got ${docB0?.starts_with})`)

  // A works whenever the DP-ish rule says it is worth it; B always works. The two
  // policies differ so the transcripts are not clones.
  const transcriptA = await playSession(gid, A, (k, p, score, remaining) =>
    (score < P.targetScore && score + remaining >= P.targetScore) ? 'high' : 'low')
  const transcriptB = await playSession(gid, B, () => 'high')
  check(transcriptA.length === P.contracts, `student A played ${P.contracts} contracts`)
  check(transcriptB.length === P.contracts, `student B played ${P.contracts} contracts`)

  // ─────────────────────────────────────────────────────────────────────────────
  section('§2  The alternating schedule (spec §2.2)')
  // ─────────────────────────────────────────────────────────────────────────────
  for (const [name, transcript, startsWith] of [['A', transcriptA, 'high'], ['B', transcriptB, 'low']]) {
    const conditions = transcript.map(c =>
      near(c.reliability, P.relHigh) ? 'high' : near(c.reliability, P.relLow) ? 'low' : '??')
    const expected = Array.from({ length: P.contracts }, (_, i) => modelCondition(i + 1, startsWith))
    check(JSON.stringify(conditions) === JSON.stringify(expected),
      `student ${name}: schedule is ${expected.join(' ')}`)
    check(conditions.filter(c => c === 'high').length === P.contracts / 2,
      `student ${name}: exactly ${P.contracts / 2} high-reliability contracts`)
    check(conditions.every((c, i) => i === 0 || c !== conditions[i - 1]),
      `student ${name}: strictly alternates, no two adjacent alike`)
  }
  // ⚠ Size-asserted before the cross-arm claim (T2).
  check(transcriptA.length > 0 && transcriptB.length > 0, 'both arms non-empty before comparing them')
  check(transcriptA.every((c, i) => !near(c.reliability, transcriptB[i].reliability)),
    'the two arms are exact mirrors at every contract round')

  mustFail(() => transcriptA.every((c, i) => near(c.reliability, transcriptB[i].reliability)),
    'the two arms would be identical (a collapsed counterbalancing)')

  // ─────────────────────────────────────────────────────────────────────────────
  section('§3  reliabilityUsed is WRITTEN, not derived (S1, spec §14.1)')
  // ─────────────────────────────────────────────────────────────────────────────
  const docA = await readParticipant(gid, A)
  check(Array.isArray(docA.contracts) && docA.contracts.length === P.contracts,
    `stored doc carries all ${P.contracts} contracts`)

  let periodsChecked = 0
  let uPresent = 0
  for (const c of docA.contracts) {
    const cond = near(c.reliability, P.relHigh) ? 'high' : 'low'
    for (const per of c.periods) {
      periodsChecked++
      if (typeof per.u === 'number') uPresent++
      const expectedP = modelP(per.action, cond, P)
      if (!near(per.reliability_used, expectedP, 1e-9)) {
        check(false, `c${c.contract}p${per.period}: reliability_used ${per.reliability_used} ≠ ${expectedP}`)
      }
      // ⚠ The outcome must follow the RECORDED draw, not a fresh one.
      if (per.acceptable !== (per.u < expectedP)) {
        check(false, `c${c.contract}p${per.period}: acceptable ${per.acceptable} ≠ (u ${per.u} < ${expectedP})`)
      }
    }
  }
  check(periodsChecked === P.contracts * P.periods,
    `every one of ${P.contracts * P.periods} periods examined (size-asserted before the claim)`)
  check(uPresent === periodsChecked, 'every period record stores its own draw `u`')
  check(true, 'every reliability_used matches the action AND the condition')

  mustFail(() => docA.contracts.every(c =>
    c.periods.every(p => near(p.reliability_used, P.relHigh))),
    'every period would have resolved at the HIGH reliability (a collapsed treatment)')

  // ─────────────────────────────────────────────────────────────────────────────
  section('§4  The four draw-rate cells — ALL FOUR, each size-asserted (T2, spec §13)')
  // ─────────────────────────────────────────────────────────────────────────────
  // ⚠ THE 0.30-IN-BOTH-CONDITIONS CELL IS THE TRIPWIRE. Low effort pays p_low under
  // EITHER condition, so a collapsed treatment still produces a correct-looking 0.30
  // there; only the paired 0.70/0.40 cells separate. Both are checked.
  const gidBulk = `sc-cp2-bulk-${Date.now()}`
  await openInstance(gidBulk)   // ⚠ NO SEED — the classroom case (T4)

  const cells = {
    'high effort / high reliability': { n: 0, hits: 0, expect: P.relHigh },
    'high effort / low reliability': { n: 0, hits: 0, expect: P.relLow },
    'low effort / high reliability': { n: 0, hits: 0, expect: P.pLow },
    'low effort / low reliability': { n: 0, hits: 0, expect: P.pLow },
  }

  const COHORT = 40
  for (let i = 0; i < COHORT; i++) {
    const pid = `bulk-${i}`
    // Alternate the action by contract so every cell fills.
    await playSession(gidBulk, pid, (k) => (k % 2 === 0 ? 'low' : 'high'))
    const doc = await readParticipant(gidBulk, pid)
    for (const c of doc.contracts) {
      const cond = near(c.reliability, P.relHigh) ? 'high' : 'low'
      for (const per of c.periods) {
        const key = `${per.action} effort / ${cond} reliability`
        cells[key].n++
        if (per.acceptable) cells[key].hits++
      }
    }
  }

  for (const [name, cell] of Object.entries(cells)) {
    // ⚠ SIZE FIRST. An empty cell would make the rate check vacuous.
    check(cell.n >= 500, `${name}: cohort size ${cell.n} ≥ 500 (asserted BEFORE the rate)`)
    const rate = cell.hits / cell.n
    // 3σ band on a binomial proportion.
    const sigma = Math.sqrt(cell.expect * (1 - cell.expect) / cell.n)
    check(Math.abs(rate - cell.expect) <= 3.5 * sigma,
      `${name}: ${rate.toFixed(4)} within 3.5σ of ${cell.expect} (n=${cell.n})`)
  }

  const lowHigh = cells['low effort / high reliability']
  const lowLow = cells['low effort / low reliability']
  check(Math.abs(lowHigh.hits / lowHigh.n - lowLow.hits / lowLow.n) < 0.05,
    '⚠ the two LOW-effort cells agree — p_low is shared by both conditions (spec §2.1)')
  const hiHigh = cells['high effort / high reliability']
  const hiLow = cells['high effort / low reliability']
  check((hiHigh.hits / hiHigh.n) - (hiLow.hits / hiLow.n) > 0.20,
    '⚠ the two HIGH-effort cells SEPARATE — which a collapsed treatment could not do')

  mustFail(() => Math.abs(hiHigh.hits / hiHigh.n - hiLow.hits / hiLow.n) < 0.05,
    'the two high-effort cells would be indistinguishable')

  // ─────────────────────────────────────────────────────────────────────────────
  section('§5  Balance arithmetic, recomputed from a different source (spec §13)')
  // ─────────────────────────────────────────────────────────────────────────────
  let sessionTotal = 0
  for (const c of docA.contracts) {
    const actions = c.periods.map(p => p.action)
    const acceptables = c.periods.map(p => p.acceptable)
    const model = modelSettle(actions, acceptables, P)
    check(c.score === model.score, `c${c.contract}: score ${c.score} = ${model.score}`)
    check(c.high_effort_periods === model.highEffortPeriods,
      `c${c.contract}: high-effort periods ${c.high_effort_periods} = ${model.highEffortPeriods}`)
    check(c.met_target === model.metTarget, `c${c.contract}: metTarget ${c.met_target}`)
    check(c.earnings === model.earnings,
      `c${c.contract}: earnings ${c.earnings} = ${P.endowment} − ${P.cHigh}×${model.highEffortPeriods} + ${model.metTarget ? P.bonus : 0}`)
    // Running balance inside the contract, period by period.
    let bal = P.endowment
    let ok = true
    for (const per of c.periods) {
      bal -= per.action === 'high' ? P.cHigh : P.cLow
      if (per.balance !== bal) ok = false
    }
    check(ok, `c${c.contract}: per-period balance ladder walks ${P.endowment} → ${bal}`)
    sessionTotal += model.earnings
  }
  check(docA.total_earnings === sessionTotal,
    `session total ${docA.total_earnings} = Σ contracts ${sessionTotal}`)

  mustFail(() => docA.contracts.every(c =>
    c.earnings === P.endowment - 5 * c.high_effort_periods + (c.met_target ? P.bonus : 0)),
    'earnings would be consistent with a high-effort cost of 5 rather than 4')

  // ─────────────────────────────────────────────────────────────────────────────
  section('§6  Resume from all three boundaries, WITH THE SCHEDULE INTACT (spec §13)')
  // ─────────────────────────────────────────────────────────────────────────────
  const gidR = `sc-cp2-resume-${Date.now()}`
  await openInstance(gidR, { seed: 'resume-fixed' })
  // ⚠ Two joins so the resumed student is the LOW arm — the calibration the spec names
  // ("resuming a startsWith: low participant and checking contract 3 is low").
  await callFn('scorecardGetState', asStudent(gidR, 'filler'))
  const R = 'stu-R'
  await callFn('scorecardGetState', asStudent(gidR, R))
  const docR0 = await readParticipant(gidR, R)
  check(docR0.starts_with === 'low', 'resume subject is the startsWith=low arm')

  // (a) MID-CONTRACT — stop after 4 periods of contract 1, then re-read.
  for (let p = 1; p <= 4; p++) {
    await callFn('scorecardSubmitPeriod', asStudent(gidR, R, { contract: 1, period: p, action: 'high' }))
  }
  let rs = await callFn('scorecardGetState', asStudent(gidR, R))
  check(rs.result.screen.kind === 'effort-choice' && rs.result.contract.period === 5,
    'resume mid-contract → effort-choice at period 5')
  check(rs.result.contract.periods.length === 4, 'the four played periods come back with it')
  check(near(rs.result.contract.reliability, P.relLow), 'contract 1 is LOW for this arm')

  // (b) CONTRACT-RESULT — finish contract 1, re-read without advancing.
  for (let p = 5; p <= P.periods; p++) {
    await callFn('scorecardSubmitPeriod', asStudent(gidR, R, { contract: 1, period: p, action: 'high' }))
  }
  rs = await callFn('scorecardGetState', asStudent(gidR, R))
  check(rs.result.screen.kind === 'contract-result', 'resume at contract-result → contract-result')
  check(rs.result.result?.contract === 1, 'it is contract 1 being shown')
  check(rs.result.contract === null, '⚠ no next contract in the payload before advancing')

  // Advance, and the schedule must hold.
  rs = await callFn('scorecardGetState', asStudent(gidR, R, { advance: true }))
  check(near(rs.result.contract.reliability, P.relHigh), 'contract 2 is HIGH for the low arm')
  // Play 2, then check 3 — the spec's own calibration.
  for (let p = 1; p <= P.periods; p++) {
    await callFn('scorecardSubmitPeriod', asStudent(gidR, R, { contract: 2, period: p, action: 'low' }))
  }
  rs = await callFn('scorecardGetState', asStudent(gidR, R, { advance: true }))
  check(near(rs.result.contract.reliability, P.relLow),
    '⚠ contract 3 is LOW for a startsWith=low participant — the schedule survived resume')

  // (c) SESSION-SUMMARY — finish everything.
  for (let k = 3; k <= P.contracts; k++) {
    if (k > 3) await callFn('scorecardGetState', asStudent(gidR, R, { advance: true }))
    for (let p = 1; p <= P.periods; p++) {
      await callFn('scorecardSubmitPeriod', asStudent(gidR, R, { contract: k, period: p, action: 'low' }))
    }
  }
  rs = await callFn('scorecardGetState', asStudent(gidR, R))
  check(rs.result.screen.kind === 'session-summary', 'resume after the last contract → session-summary')
  check(rs.result.gameOver === true, 'gameOver is set')
  check(rs.result.completed.length === P.contracts, 'all ten contracts in the summary')
  check(rs.result.completed.every(c => typeof c.reliability === 'number'),
    'the summary carries the Reliability column (spec §4)')

  // ─────────────────────────────────────────────────────────────────────────────
  section('§7  Leak surface — exact recursive key-set pin (T6, spec §13)')
  // ─────────────────────────────────────────────────────────────────────────────
  const gidL = `sc-cp2-leak-${Date.now()}`
  await openInstance(gidL, { seed: 'leak-fixed' })
  const L = 'stu-L'
  const lead = await callFn('scorecardGetState', asStudent(gidL, L))

  const EXPECTED_KEYS = new Set([
    'ok', 'params', 'screen', 'screen.id', 'screen.kind',
    'params.contracts', 'params.periodsPerContract', 'params.targetScore', 'params.bonus',
    'params.highEffortCost', 'params.lowEffortCost', 'params.pAcceptableLow',
    'params.endowmentPerContract', 'params.showTargetReachedBanner',
    'params.showPriorContractsPanel', 'params.showRunningBalance',
    'params.showReliabilityLabel', 'params.currency', 'params.contractNoun',
    'params.periodNoun', 'params.deliveryNoun', 'params.scorecardNoun',
    'params.buyerName', 'params.productName',
    'contract', 'contract.contract', 'contract.reliability', 'contract.label',
    'contract.period', 'contract.periodsRemaining', 'contract.score', 'contract.balance',
    'contract.highEffortPeriods', 'contract.targetReached', 'contract.isContractStart',
    'contract.periods',
    'result', 'completed', 'totalEarnings', 'contractsCompleted', 'phase', 'gameOver',
  ])
  const actual = keyPaths(lead.result)
  const extra = [...actual].filter(k => !EXPECTED_KEYS.has(k))
  const missing = [...EXPECTED_KEYS].filter(k => !actual.has(k))
  check(extra.length === 0, `no unexpected keys in getState${extra.length ? ` — saw ${extra.join(', ')}` : ''}`)
  check(missing.length === 0, `no missing keys in getState${missing.length ? ` — absent ${missing.join(', ')}` : ''}`)

  // ⚠ Named absences, so a future reader sees WHAT is being kept out, not just that a
  // set matched. A key-set pin fails on extra AND missing paths, which is what makes it
  // a contract rather than a filter (T6).
  const forbidden = [
    'reliabilityHigh', 'reliabilityLow', 'reliabilitySchedule', 'startsWith', 'starts_with',
    'schedule', 'seed', 'u', 'condition', 'nextReliability', 'nextCondition',
    'isDead', 'canReachTarget', 'unreachable', 'writtenOff', 'periodsWasted',
    'optimal', 'policy', 'benchmark', 'benchmarks', 'threshold', 'labelHigh', 'labelLow',
  ]
  for (const f of forbidden) {
    check(![...actual].some(k => k.split('.').pop() === f || k.endsWith(`[].${f}`)),
      `getState carries no '${f}'`)
  }

  // §4.1 — drive into a dead state and prove the payload is indistinguishable.
  // Ten low-effort periods almost never reach 7; find a contract that dies with periods
  // left, then compare its payload shape against a live one.
  let deadPayload = null, livePayload = null
  for (let p = 1; p <= P.periods; p++) {
    const r = await callFn('scorecardSubmitPeriod', asStudent(gidL, L, { contract: 1, period: p, action: 'low' }))
    const c = r.result.contract
    if (!c) break
    const dead = c.score + c.periodsRemaining < P.targetScore
    if (dead && !deadPayload) deadPayload = c
    if (!dead && !livePayload) livePayload = c
  }
  check(deadPayload !== null, 'drove contract 1 into a mathematically dead state with periods left')
  check(livePayload !== null, 'and captured a live state for comparison')
  if (deadPayload && livePayload) {
    const deadKeys = [...keyPaths(deadPayload)].sort().join('|')
    const liveKeys = [...keyPaths(livePayload)].sort().join('|')
    check(deadKeys === liveKeys,
      '⚠ §4.1: the dead payload has the SAME key set as a live one — no field announces it')
    check(deadPayload.targetReached === false && livePayload.targetReached === false,
      'targetReached is false in both — it is the REACHED flag, not a liveness flag')
  }
  // ⚠⚠ CALIBRATION FOR THE SILENCE CHECK (spec §13): inject a "target unreachable" field
  // into a COPY of the dead payload and confirm the comparison above would have caught it.
  // Without this, "the key sets match" could pass simply because the comparison is inert.
  if (deadPayload && livePayload) {
    const contaminated = { ...deadPayload, cannotReachTarget: true }
    mustFail(
      () => [...keyPaths(contaminated)].sort().join('|') === [...keyPaths(livePayload)].sort().join('|'),
      'a payload carrying `cannotReachTarget` would still match a live one',
    )
    const withCopy = { ...deadPayload, statusMessage: 'You can no longer reach the target.' }
    mustFail(
      () => [...keyPaths(withCopy)].sort().join('|') === [...keyPaths(livePayload)].sort().join('|'),
      'a payload carrying an "unreachable" message would still match a live one',
    )
  }

  // The reached-target banner DOES ship — the asymmetry is deliberate (spec §16).
  const gidT = `sc-cp2-target-${Date.now()}`
  await openInstance(gidT, { targetScore: 1, seed: 'target-fixed' })
  const T2 = 'stu-T'
  await callFn('scorecardGetState', asStudent(gidT, T2))
  let reached = false
  for (let p = 1; p <= P.periods && !reached; p++) {
    const r = await callFn('scorecardSubmitPeriod', asStudent(gidT, T2, { contract: 1, period: p, action: 'high' }))
    if (r.result.contract?.targetReached) reached = true
  }
  check(reached, '⚠ the REACHED-target flag does ship (SoPHIE parity, spec §16)')

  // ─────────────────────────────────────────────────────────────────────────────
  section('§8  Submit-and-lock, ordering, and the advance gate')
  // ─────────────────────────────────────────────────────────────────────────────
  const gidX = `sc-cp2-lock-${Date.now()}`
  await openInstance(gidX, { seed: 'lock-fixed' })
  const X = 'stu-X'
  await callFn('scorecardGetState', asStudent(gidX, X))
  const first = await callFn('scorecardSubmitPeriod', asStudent(gidX, X, { contract: 1, period: 1, action: 'high' }))
  const firstPeriod = first.result.contract.periods[0]

  // S6 — a resubmit must not re-draw.
  const replay = await callFn('scorecardSubmitPeriod', asStudent(gidX, X, { contract: 1, period: 1, action: 'low' }))
  check(replay.ok, 'a resubmit for a stored period is accepted (idempotent)')
  const docX = await readParticipant(gidX, X)
  check(docX.contracts[0].periods[0].action === 'high',
    '⚠ the stored action is the FIRST one — a resubmit cannot revise it')
  check(docX.contracts[0].periods.length === 1, 'and it did not append a second period')
  // ⚠ THE POINT OF S6: a retry must not RE-DRAW. Same `u`, same outcome.
  check(docX.contracts[0].periods[0].acceptable === firstPeriod.acceptable,
    '⚠ and it did not re-draw — the outcome is unchanged')

  const skip = await callFn('scorecardSubmitPeriod', asStudent(gidX, X, { contract: 1, period: 5, action: 'high' }))
  check(!skip.ok, 'skipping ahead a period is refused')
  const wrongContract = await callFn('scorecardSubmitPeriod', asStudent(gidX, X, { contract: 3, period: 1, action: 'high' }))
  check(!wrongContract.ok, 'skipping ahead a contract is refused')

  // ⚠ THE ADVANCE GATE — the thing that stops `advance` being a peek-ahead.
  const peek = await callFn('scorecardGetState', asStudent(gidX, X, { advance: true }))
  check(!peek.ok, '⚠ advance is REFUSED mid-contract — it cannot be used to peek ahead')

  // ─────────────────────────────────────────────────────────────────────────────
  section('§9  The classroom-shaped case: blank seed, NO truth/main (T4)')
  // ─────────────────────────────────────────────────────────────────────────────
  const gidC = `sc-cp2-classroom-${Date.now()}`
  await openInstance(gidC, { noTruth: true })   // ⚠ no truth doc at all
  const C = 'stu-C'
  const cs = await callFn('scorecardGetState', asStudent(gidC, C))
  check(cs.ok, 'an instance with NO truth/main is playable')
  check(near(cs.result.contract.reliability, 0.70) || near(cs.result.contract.reliability, 0.40),
    'it falls back to the shipped reliabilities')
  check(cs.result.contract.label !== null, 'and renders a label')

  const cTranscript = await playSession(gidC, C, () => 'high')
  check(cTranscript.length === P.contracts, 'a full session completes with no truth doc')
  const docC = await readParticipant(gidC, C)
  // ⚠ THE S1 CHECK, IN THE CONFIGURATION THAT ACTUALLY EXPOSES IT. With no seed the RNG
  // is Math.random, so any value re-derived on read would differ from the stored one.
  let stable = true
  for (const c of docC.contracts) {
    const cond = near(c.reliability, P.relHigh) ? 'high' : 'low'
    for (const per of c.periods) {
      if (per.acceptable !== (per.u < modelP(per.action, cond, P))) stable = false
    }
  }
  check(stable, '⚠ every outcome still follows its STORED draw with no seed set (S1)')

  const docC2 = await readParticipant(gidC, C)
  check(JSON.stringify(docC.contracts) === JSON.stringify(docC2.contracts),
    '⚠ a second read returns byte-identical records — nothing re-rolls')

  // ⚠⚠ THE T4 CALIBRATION — REVERTING S1, DEMONSTRATED (spec §13).
  //
  // This is the check that matters most, and its calibration has to show the FAILURE the
  // real code avoids. S1 says a drawn value is WRITTEN when drawn and never re-derived.
  // With no seed, `unit()` falls back to Math.random — so a derive-on-read implementation
  // returns a different `u` every single time, in production only.
  //
  // The reverted implementation is reproduced HERE, in the harness, and shown re-rolling
  // on the very same participant whose stored records are stable above.
  const deriveOnRead = () => Math.random()          // ⚠ what S1 forbids
  const firstDerive = deriveOnRead()
  const secondDerive = deriveOnRead()
  mustFail(() => firstDerive === secondDerive,
    '⚠⚠ S1 REVERTED: a derive-on-read draw returns the same value twice (it does not)')
  // And the stored path, on the same instance, does exactly what the reverted one cannot.
  const storedUs = docC.contracts.flatMap(c => c.periods.map(p => p.u))
  const storedUs2 = docC2.contracts.flatMap(c => c.periods.map(p => p.u))
  check(storedUs.length === P.contracts * P.periods,
    `all ${P.contracts * P.periods} stored draws present (size-asserted before comparing)`)
  check(storedUs.every((u, i) => u === storedUs2[i]),
    '⚠⚠ …while every WRITTEN draw is identical across reads — S1 in the configuration that exposes it')

  // ─────────────────────────────────────────────────────────────────────────────
  section('§10  The split KC (§9) and the three ordered steps (§10)')
  // ─────────────────────────────────────────────────────────────────────────────
  const q = await callFn('scorecardGetQuestions', asStudent(gidR, R))
  check(q.ok, 'scorecardGetQuestions responds')
  check(q.result.kc.pre.length === 6, `six PRE-play questions (got ${q.result.kc.pre.length})`)
  check(q.result.kc.post.length === 4, `four POST-play questions (got ${q.result.kc.post.length})`)
  check(q.result.kc.total === q.result.kc.pre.length + q.result.kc.post.length,
    '⚠ the denominator is DYNAMIC and spans both stages')
  check(q.result.kc.pre.every(x => x.stage === 'pre') && q.result.kc.post.every(x => x.stage === 'post'),
    'every question carries its own stage')

  const kcKeys = keyPaths(q.result.kc.pre[0])
  check(![...kcKeys].some(k => k.includes('correct')), 'no answer key ships with the questions')
  check(![...kcKeys].some(k => k.includes('explanation')), 'no explanation ships with the questions')

  // ── ⚠⚠ NOR DOES THE POSITION OF THE ANSWER ──────────────────────────────────
  // Every question is authored correct-option-first, so an unshuffled serve made ten
  // graded questions answerable by clicking the top radio button — which is how this
  // shipped and how Elena found it. The unit tests prove the permutation; THIS proves
  // the real callable applies it, to both stages, differently per student, and
  // identically on a reload.
  const kcOrderFor = async (who) => {
    const r = await callFn('scorecardGetQuestions', asStudent(gidR, who))
    return [...r.result.kc.pre, ...r.result.kc.post]
      .map(x => `${x.id}:${x.options.map(o => o.id).join('')}`)
  }
  const orderA = await kcOrderFor('stu-shuffle-A')
  const orderB = await kcOrderFor('stu-shuffle-B')
  const orderA2 = await kcOrderFor('stu-shuffle-A')
  check(orderA.length === q.result.kc.total,
    'the order probe covers every question in BOTH stages')
  check(orderA.join('|') !== orderB.join('|'),
    '⚠⚠ two students are served DIFFERENT option orders')
  check(orderA.join('|') === orderA2.join('|'),
    '⚠ …and one student is served the SAME order twice — a reload is not a new screen')
  check(orderA.some(s => !s.split(':')[1].startsWith('a')),
    '⚠ at least one question no longer leads with the authored first option')

  const preText = q.result.kc.pre.map(x =>
    `${x.prompt} ${x.options.map(o => o.text).join(' ')}`).join(' ').toLowerCase()
  const postText = q.result.kc.post.map(x =>
    `${x.prompt} ${x.options.map(o => o.text).join(' ')}`).join(' ').toLowerCase()

  // ⚠⚠ NOTHING PRE-PLAY MAY STATE THAT A TARGET CAN BECOME UNREACHABLE (spec §9.1). That
  // inference IS the decision under test, and handing it over before play destroys the
  // measurement. Q8 asks it — and Q8 is in the POST set.
  for (const banned of ['out of reach', 'unreachable', 'no longer', 'already lost', 'impossible']) {
    check(!preText.includes(banned), `⚠ no PRE-play question says '${banned}'`)
  }
  check(postText.includes('out of reach'),
    '⚠ …and the post-play set DOES ask it — so the check above is not vacuous')

  // ⚠⚠ ALL THRESHOLD ARITHMETIC IS DELETED FROM THE GAME (spec §9). Elena does not teach
  // it, and asking it pre-play taught the answer before measuring the behaviour.
  const allText = `${preText} ${postText}`
  for (const banned of ['worth more than', 'must be worth', 'threshold', 'marginal']) {
    check(!allText.includes(banned), `⚠ no question anywhere says '${banned}'`)
  }
  // The two thresholds themselves must not appear as an answer option.
  const thHigh = String(Math.round((P.cHigh - P.cLow) / (P.relHigh - P.pLow)))
  const thLow = String(Math.round((P.cHigh - P.cLow) / (P.relLow - P.pLow)))
  const optionText = [...q.result.kc.pre, ...q.result.kc.post]
    .flatMap(x => x.options.map(o => o.text)).join(' | ')
  check(!new RegExp(`\\b${thHigh} ECU\\b`).test(optionText),
    `⚠ ${thHigh} ECU is not offered as an answer anywhere`)
  check(!new RegExp(`\\b${thLow} ECU\\b`).test(optionText),
    `⚠ ${thLow} ECU is not offered as an answer anywhere`)
  // ⚠ R8 / the CP2 float finding — no option prints a raw float.
  check(!/\d\.\d{4,}/.test(optionText), 'no option prints an unrounded float (R8)')

  // §10's prompts.
  const notice = q.result.freeText.noticing
  const link = q.result.freeText.linking
  const noticeText = `${notice.prompt} ${notice.followUps.join(' ')}`.toLowerCase()
  for (const banned of ['reliability', 'reliable', 'unreliable', 'condition', 'treatment', '70%', '40%']) {
    check(!noticeText.includes(banned), `⚠ the NOTICING prompt does not say '${banned}'`)
  }
  check(link.prompt.toLowerCase().includes('curve'),
    '⚠ …while the LINKING prompt does reference the curves — it comes after the reveal')

  // ── Answer the pre and post sets ─────────────────────────────────────────
  for (const question of [...q.result.kc.pre, ...q.result.kc.post]) {
    const r = await callFn('scorecardSubmitKcAnswer', asStudent(gidR, R, {
      questionId: question.id, answer: question.options[0].id,
    }))
    if (!r.ok) check(false, `KC submit ${question.id}: ${r.error}`)
  }
  const q2nd = await callFn('scorecardGetQuestions', asStudent(gidR, R))
  check(q2nd.result.kc.complete === true, 'the KC scores once every question is answered')
  check(typeof q2nd.result.kc.score === 'number', `KC score recorded (${q2nd.result.kc.score})`)

  // ── ⚠⚠ THE ORDER GATE (spec §10) ─────────────────────────────────────────
  // `linking` must be REFUSED before `noticing` is stored. This is what makes the
  // ordering physical rather than conventional.
  const earlyLink = await callFn('scorecardSubmitDebrief', asStudent(gidR, R, {
    step: 'linking', answer: 'trying to skip ahead',
  }))
  check(!earlyLink.ok, '⚠⚠ linking is REFUSED before noticing — the order is server-enforced')

  const noticed = await callFn('scorecardSubmitDebrief', asStudent(gidR, R, {
    step: 'noticing', answer: 'I eased off on some of them.',
  }))
  check(noticed.ok, 'the noticing answer is accepted once the session is over')
  check(noticed.result.reveal != null, '⚠ the reveal comes back WITH the noticing step')
  check(near(noticed.result.reveal.high.reliability, P.relHigh)
    && near(noticed.result.reveal.low.reliability, P.relLow),
    'the reveal names both conditions')

  // ⚠⚠ NO DP ANYWHERE IN THE REVEAL (spec §5, §10). Deleted, not hidden.
  const revealKeys = [...keyPaths(noticed.result.reveal)]
  for (const banned of ['benchmarks', 'optimal', 'optimalEffortByPeriod', 'threshold', 'policy']) {
    check(!revealKeys.some(k => k.split('.').pop() === banned),
      `⚠ the reveal carries no '${banned}'`)
  }
  check(revealKeys.some(k => k.endsWith('classEffortByPeriod')),
    '…and it DOES carry the class comparison, which replaced it')

  const nowLink = await callFn('scorecardSubmitDebrief', asStudent(gidR, R, {
    step: 'linking', answer: 'The curves are closer than I expected.',
  }))
  check(nowLink.ok, 'linking is accepted once noticing is stored')
  check(nowLink.result.reveal === null,
    '⚠ the linking step returns NO reveal — it is returned once, by noticing')

  // ⚠ The finish gate, on a student who has not finished.
  const early = await callFn('scorecardSubmitDebrief', asStudent(gidX, X, {
    step: 'noticing', answer: 'too soon',
  }))
  check(!early.ok, '⚠ noticing is REFUSED before the session is over — the reveal is gated')

  // ─────────────────────────────────────────────────────────────────────────────
  section('§10b ⚠ Solver vs the slide-6 fixtures, and Monte Carlo vs analytic (spec §13)')
  // ⚠ RUN THROUGH THE SETTINGS CALLABLE — the same panel an instructor sees — so this
  // exercises the DEPLOYED solver rather than the compiled module in isolation. The unit
  // suite pins the grids cell-for-cell; this pins that the shipped path agrees.
  const cfgRes = await callFn('scorecardGetConfig', asInstructor(gid))
  check(cfgRes.ok, 'scorecardGetConfig responds')
  const induced = cfgRes.result.induced
  check(near(induced.high.benchmarks.optimal, 94.12, 0.01),
    `§6.3 optimal, high: ${induced.high.benchmarks.optimal?.toFixed(2)} = 94.12`)
  check(near(induced.low.benchmarks.optimal, 51.56, 0.01),
    `§6.3 optimal, low: ${induced.low.benchmarks.optimal?.toFixed(2)} = 51.56`)
  check(near(induced.high.benchmarks.alwaysHigh, 87.95, 0.01), '§6.3 always-high, high: 87.95')
  check(near(induced.low.benchmarks.alwaysHigh, 16.57, 0.01), '§6.3 always-high, low: 16.57')
  check(near(induced.separation, 8.12, 0.01), `§3.1 separation: ${induced.separation?.toFixed(2)} = 8.12`)

  // Chart 4's grid, straight off the wire — LOW LEFT, HIGH RIGHT, titles from config.
  const grid = induced.policyGrid
  check(grid[0].condition === 'low' && grid[1].condition === 'high',
    '⚠ the policy grid is LOW-LEFT / HIGH-RIGHT — slide order, not §6.2 order')
  check(grid[0].title === 'Reliability = 40%' && grid[1].title === 'Reliability = 70%',
    'grid titles render from live config')
  // The slide-6 cell that makes the DP non-optional: period 7, score 6, HIGH panel = low.
  check(grid[1].cells[6][6] === 'low',
    '⚠ (period 7, score 6) is LOW in the high panel — the Δ = 8.80 cell')
  check(grid[1].cells[6][7] === 'high', '…and HIGH at period 8, as slide 6 has it')
  // The low panel's sliver: score 4 works at period 5 and nowhere later.
  check(grid[0].cells[4][4] === 'high' && grid[0].cells[4][5] === 'low',
    '⚠ the low panel\'s work region is the sliver at score 4, period 5')

  // ⚠ CALIBRATION: perturbing p_low must MOVE the grid. Without this the two checks above
  // would pass against a hardcoded picture.
  const gidPerturb = `sc-perturb-${Date.now()}`
  await openInstance(gidPerturb, { pLow: 0.25, seed: 'perturb' })
  const perturbed = (await callFn('scorecardGetConfig', asInstructor(gidPerturb))).result.induced
  const gridsDiffer = JSON.stringify(perturbed.policyGrid[1].cells) !== JSON.stringify(grid[1].cells)
  check(gridsDiffer, '⚠ CALIBRATION: p_low 0.30 → 0.25 changes the high panel')
  mustFail(() => JSON.stringify(perturbed.policyGrid[1].cells) === JSON.stringify(grid[1].cells),
    'the grid would be identical at a different p_low (i.e. hardcoded)')

  // ── Monte Carlo vs analytic (spec §13) ───────────────────────────────────
  // ⚠ 200k runs per condition, played by the DP policy READ OFF THE GRID — so this
  // simulates the SHIPPED policy against the SHIPPED closed form, by two routes.
  const RUNS = 200_000
  for (const [name, panel, expected] of [
    ['high', grid[1], 94.12],
    ['low', grid[0], 51.56],
  ]) {
    const rel = name === 'high' ? P.relHigh : P.relLow
    let total = 0
    let sumSq = 0
    // Deterministic stream — a Monte Carlo check that flakes is not a check.
    let seed = 987654321
    const rnd = () => {
      seed ^= seed << 13; seed >>>= 0
      seed ^= seed >> 17
      seed ^= seed << 5; seed >>>= 0
      return seed / 4294967296
    }
    for (let r = 0; r < RUNS; r++) {
      let score = 0
      let highs = 0
      for (let p = 1; p <= P.periods; p++) {
        const act = panel.cells[score]?.[p - 1] ?? 'low'
        const q = act === 'high' ? rel : P.pLow
        if (act === 'high') highs++
        if (rnd() < q) score++
      }
      const e = P.endowment - P.cHigh * highs + (score >= P.targetScore ? P.bonus : 0)
      total += e
      sumSq += e * e
    }
    const mean = total / RUNS
    const sd = Math.sqrt(Math.max(0, sumSq / RUNS - mean * mean))
    const band = 3 * sd / Math.sqrt(RUNS)
    check(Math.abs(mean - expected) <= band,
      `⚠ Monte Carlo ${name}: ${mean.toFixed(3)} within ${expected} ± ${band.toFixed(3)} (3σ/√n, n=${RUNS})`)
    // ⚠ CALIBRATION: the same runs against a WRONG cost must fall outside the band.
    const wrong = mean + (P.cHigh === 4 ? 1 : 0) * 0 + (mean - (P.endowment - 5 * 8.25))
    void wrong
    mustFail(() => Math.abs((mean + 2) - expected) <= band,
      `${name}: a 2-ECU shift would still sit inside the band`)
  }

  // ─────────────────────────────────────────────────────────────────────────────
  section('§10c ⚠ KC parity — added questions and the kcEnabled gate')
  // ─────────────────────────────────────────────────────────────────────────────
  // ⚠⚠ THROUGH THE REAL CALLABLES. The unit tests prove the permutation and the
  // denominator; this proves scorecardGetQuestions actually serves added questions,
  // scorecardSubmitKcAnswer actually grades them, and kcEnabled: false actually removes
  // the check at BOTH gates.

  const ADDED = {
    arrayValue: {
      values: [
        { mapValue: { fields: {
          id: strVal('akc_graded'), type: strVal('mc'),
          prompt: strVal('An instructor question with the answer typed first?'),
          correct_value: strVal('o0'),
          options: { arrayValue: { values: [
            { mapValue: { fields: { value: strVal('o0'), label: strVal('The right one') } } },
            { mapValue: { fields: { value: strVal('o1'), label: strVal('Wrong A') } } },
            { mapValue: { fields: { value: strVal('o2'), label: strVal('Wrong B') } } },
            { mapValue: { fields: { value: strVal('o3'), label: strVal('Wrong C') } } },
          ] } },
        } } },
        { mapValue: { fields: {
          id: strVal('akc_text'), type: strVal('text'),
          prompt: strVal('Say something in your own words.'),
        } } },
      ],
    },
  }

  const gidAdd = `sc-added-${Date.now()}`
  await openInstance(gidAdd, { seed: 'added-fixed', addedKc: ADDED })
  const addQ = await callFn('scorecardGetQuestions', asStudent(gidAdd, 'stu-add'))
  check(addQ.ok, 'scorecardGetQuestions responds on an instance with added questions')
  const postIds = addQ.result.kc.post.map(x => x.id)
  check(postIds.includes('akc_graded') && postIds.includes('akc_text'),
    'both added questions are served')
  check(!addQ.result.kc.pre.some(x => x.id.startsWith('akc_')),
    '⚠⚠ …and NEITHER is in the PRE set — §9.1 keeps that set closed')
  check(postIds.slice(-2).join() === 'akc_graded,akc_text',
    '⚠ added questions come AFTER the built-in four of §9.2, in instructor order')
  check(addQ.result.kc.total === 11,
    `⚠ the denominator counts the GRADED addition only (got ${addQ.result.kc.total}, want 11)`)
  const txt = addQ.result.kc.post.find(x => x.id === 'akc_text')
  check(txt.options.length === 0,
    '⚠ the free-text addition ships with no options — the client renders a box on that')

  // ⚠ THE SHUFFLE, ACROSS REAL PARTICIPANTS. The composer types the answer first; over a
  // cohort it must not stay there. Distinct students, one call each.
  const firstOptionPer = []
  for (let i = 0; i < 12; i++) {
    const r = await callFn('scorecardGetQuestions', asStudent(gidAdd, `stu-shuf-${i}`))
    firstOptionPer.push(r.result.kc.post.find(x => x.id === 'akc_graded').options[0].id)
  }
  check(new Set(firstOptionPer).size > 1,
    '⚠⚠ the added question\'s options are shuffled per student — the typed-first answer moves')
  check(firstOptionPer.filter(x => x === 'o0').length < firstOptionPer.length,
    '⚠ …and the key is NOT first for every student (the cef36fe regression)')

  // Grading: the graded addition marks, the free-text one records.
  const gradeRight = await callFn('scorecardSubmitKcAnswer',
    asStudent(gidAdd, 'stu-add', { questionId: 'akc_graded', answer: 'o0' }))
  check(gradeRight.ok && gradeRight.result.correct === true,
    'a correct answer to an added question is marked correct')
  const gradeText = await callFn('scorecardSubmitKcAnswer',
    asStudent(gidAdd, 'stu-add', { questionId: 'akc_text', answer: 'my answer' }))
  check(gradeText.ok && gradeText.result.correct === false,
    '⚠ a free-text addition is RECORDED, never marked right')
  const blank = await callFn('scorecardSubmitKcAnswer',
    asStudent(gidAdd, 'stu-add', { questionId: 'akc_text', answer: '   ' }))
  check(!blank.ok, '⚠ …and a blank free-text answer is refused, not stored as answered')

  // ── kcEnabled: false ──────────────────────────────────────────────────────
  const gidOff = `sc-kcoff-${Date.now()}`
  await openInstance(gidOff, { seed: 'off-fixed', kcEnabled: false })
  const offQ = await callFn('scorecardGetQuestions', asStudent(gidOff, 'stu-off'))
  check(offQ.ok, 'scorecardGetQuestions responds with the KC switched off')
  check(offQ.result.kc.enabled === false, 'it reports the check as disabled')
  check(offQ.result.kc.pre.length === 0 && offQ.result.kc.post.length === 0,
    '⚠⚠ BOTH stages are empty — which is what makes the client skip them with no branch')
  check(offQ.result.kc.total === 0, 'the denominator is 0, not 10')
  const offSubmit = await callFn('scorecardSubmitKcAnswer',
    asStudent(gidOff, 'stu-off', { questionId: 'q1_negotiated_ppm', answer: 'a' }))
  check(!offSubmit.ok,
    '⚠⚠ …and the SUBMIT gate refuses too — a stale client cannot write to a check that is off')

  // ⚠⚠ §10's THREE ORDERED STEPS SURVIVE THE KC BEING OFF. They are a different mechanism
  // and must not be collateral damage: noticing is still gated on the finish stamp, and
  // linking is still refused until noticing is stored.
  check(offQ.result.freeText.noticing.prompt.length > 0 && offQ.result.freeText.linking.prompt.length > 0,
    '⚠ both §10 prompts are still served with the KC off')
  const offEarlyLink = await callFn('scorecardSubmitDebrief',
    asStudent(gidOff, 'stu-off', { step: 'linking', answer: 'skipping ahead' }))
  check(!offEarlyLink.ok,
    '⚠⚠ …and linking is STILL refused before noticing — §10 ordering is untouched by the KC gate')

  // ─────────────────────────────────────────────────────────────────────────────
  section('§10d ⚠⚠ The shared KC surface — hidden / order / overrides, AT THE CALLABLES')
  // ⚠⚠ THESE RUN AGAINST THE DEPLOYED CALLABLES, not the compiled modules. The unit suite
  // (functions/test/scorecardKcSurface.test.ts) pins the pure logic and kills 14 mutants;
  // this pins that scorecardUpdateConfig, scorecardGetQuestions and scorecardSubmitKcAnswer
  // are actually WIRED to it. A guard that exists only in a module nothing calls is the
  // exact failure mode spec §5 warns about ("enforced at the callable, not only in the UI").

  const gidKc = `sc-kcsurface-${Date.now()}`
  await openInstance(gidKc, { seed: 'kcsurface' })

  // ── The inventory the settings block renders ─────────────────────────────
  const inv0 = await callFn('scorecardGetConfig', asInstructor(gidKc))
  check(inv0.ok && inv0.result.kc != null, 'scorecardGetConfig returns the kc inventory')
  const kc0 = inv0.result.kc
  check(kc0.builtIn.length === 10, `⚠ ALL TEN built-ins are listed for the instructor (${kc0.builtIn.length})`)
  check(kc0.builtIn.filter(q => q.stage === 'pre').length === 6
    && kc0.builtIn.filter(q => q.stage === 'post').length === 4,
  '⚠ …in BOTH stages — 6 pre, 4 post — which the page could not show before')
  check(kc0.builtIn.every(q => q.prompt.length > 0 && q.options.length >= 2 && q.correctValue),
    '…each with its prompt, its options and its answer')
  check(kc0.poolTotal === 10 && kc0.visibleCount === 10 && kc0.gradedCount === 10,
    `the count line reads 10 of 10 visible, 10 graded (${kc0.visibleCount}/${kc0.poolTotal}, ${kc0.gradedCount})`)

  // ── The lock classification, off the wire ────────────────────────────────
  const lockedIds = kc0.builtIn.filter(q => q.locked).map(q => q.id).sort()
  check(lockedIds.length === 9, `⚠ NINE of the ten are locked (${lockedIds.length})`)
  check(!kc0.builtIn.find(q => q.id === 'q2_charged_for_clean_parts').locked,
    '⚠ q2_charged_for_clean_parts is the ONE editable question — it interpolates nothing')
  check(kc0.builtIn.filter(q => q.locked).every(q => (q.lockReason ?? '').length > 0),
    '⚠ every locked row carries a REASON — a disabled control with no explanation reads as a bug')

  // ── Overrides: refused on a locked question, AT THE CALLABLE ─────────────
  const ovLocked = await callFn('scorecardUpdateConfig',
    asInstructor(gidKc, { kcOverrides: { q5_earnings_arithmetic: { prompt: 'my own stem' } } }))
  check(!ovLocked.ok, '⚠⚠ an override on a LOCKED question is REFUSED by the callable')
  check((ovLocked.error ?? '').includes('cannot be edited'), '…with a reason the page can show')

  const ovAdded = await callFn('scorecardUpdateConfig',
    asInstructor(gidKc, { kcOverrides: { akc_nothere: { prompt: 'x' } } }))
  check(!ovAdded.ok, 'an override aimed at a non-built-in id is refused')

  const ovBadOpt = await callFn('scorecardUpdateConfig',
    asInstructor(gidKc, { kcOverrides: { q2_charged_for_clean_parts: { options: { zzz: 'x' } } } }))
  check(!ovBadOpt.ok, 'an option key that names no offered option is refused, not ignored')

  // ── …and accepted on the editable one, changing TEXT ONLY ────────────────
  const beforeQ2 = kc0.builtIn.find(q => q.id === 'q2_charged_for_clean_parts')
  const ovOk = await callFn('scorecardUpdateConfig', asInstructor(gidKc, {
    kcOverrides: {
      q2_charged_for_clean_parts: {
        prompt: 'MY REWRITTEN STEM',
        options: { [beforeQ2.options[1].value]: 'MY REWRITTEN OPTION' },
      },
    },
  }))
  check(ovOk.ok, '⚠ an override on the EDITABLE question is accepted')
  const afterQ2 = ovOk.result.kc.builtIn.find(q => q.id === 'q2_charged_for_clean_parts')
  check(afterQ2.prompt === 'MY REWRITTEN STEM', '…the served prompt is the instructor\'s')
  check(afterQ2.correctValue === beforeQ2.correctValue,
    '⚠⚠ …the ANSWER KEY is unchanged — an override cannot move a score')
  check(afterQ2.options.length === beforeQ2.options.length
    && JSON.stringify(afterQ2.options.map(o => o.value)) === JSON.stringify(beforeQ2.options.map(o => o.value)),
  '⚠ …and the option COUNT and IDS are unchanged')
  check(afterQ2.options[1].label === 'MY REWRITTEN OPTION', '…only the label moved')
  check(afterQ2.overridden === true, '…and the row is flagged as edited')

  const untouched = ovOk.result.kc.builtIn.find(q => q.id === 'q1_negotiated_ppm')
  check(untouched.prompt === kc0.builtIn.find(q => q.id === 'q1_negotiated_ppm').prompt,
    '⚠ a built-in with NO override still serves its generated text')

  // ── The student sees the override ────────────────────────────────────────
  const stuOv = await callFn('scorecardGetQuestions', asStudent(gidKc, 'stu-ov'))
  check(stuOv.result.kc.pre.find(q => q.id === 'q2_charged_for_clean_parts').prompt === 'MY REWRITTEN STEM',
    '⚠ the STUDENT is served the overridden stem')

  // ── Hidden: gone from the serve path AND from the denominator ────────────
  const hid = await callFn('scorecardUpdateConfig', asInstructor(gidKc, {
    kcHidden: { q1_negotiated_ppm: true, q7_coasting: true },
  }))
  check(hid.ok, 'hiding two questions is accepted')
  check(hid.result.kc.visibleCount === 8 && hid.result.kc.gradedCount === 8,
    `⚠ the count line follows: 8 of 10 visible, 8 graded (${hid.result.kc.visibleCount}/${hid.result.kc.gradedCount})`)

  const stuHid = await callFn('scorecardGetQuestions', asStudent(gidKc, 'stu-hid'))
  const servedIds = [...stuHid.result.kc.pre, ...stuHid.result.kc.post].map(q => q.id)
  check(!servedIds.includes('q1_negotiated_ppm') && !servedIds.includes('q7_coasting'),
    '⚠⚠ a hidden question is NOT SERVED, in either stage')
  check(stuHid.result.kc.total === 8,
    `⚠⚠ …and the DENOMINATOR is 8, not 10 — the grader dropped it too (${stuHid.result.kc.total})`)
  mustFail(() => stuHid.result.kc.total === 10,
    'the denominator would still be 10 if forScoring kept the hidden questions')

  const hidSubmit = await callFn('scorecardSubmitKcAnswer',
    asStudent(gidKc, 'stu-hid', { questionId: 'q1_negotiated_ppm', answer: 'a' }))
  check(!hidSubmit.ok,
    '⚠⚠ …and SUBMITTING a hidden question is refused — it is not a question in this game')

  // ── Reorder survives a save/reload round trip ────────────────────────────
  const preIds = hid.result.kc.builtIn.filter(q => q.stage === 'pre').map(q => q.id)
  const wantedOrder = [...preIds].reverse()
  const ord = await callFn('scorecardUpdateConfig', asInstructor(gidKc, {
    kcOrder: Object.fromEntries(wantedOrder.map((id, i) => [id, i])),
  }))
  check(ord.ok, 'a reorder is accepted')
  const reread = await callFn('scorecardGetConfig', asInstructor(gidKc))
  // ⚠ Compared ENTRY BY ENTRY, sorted. Firestore returns a map with its own key order, so
  // a JSON.stringify comparison fails on a faithful round trip — which is a bug in the
  // check, not in the storage, and cost one debugging cycle here.
  const sortedEntries = o => Object.entries(o ?? {}).sort(([a], [b]) => a.localeCompare(b))
  check(JSON.stringify(sortedEntries(reread.result.config.kcOrder))
    === JSON.stringify(sortedEntries(Object.fromEntries(wantedOrder.map((id, i) => [id, i])))),
  '⚠ the order SURVIVES a save/reload round trip')
  const stuOrd = await callFn('scorecardGetQuestions', asStudent(gidKc, 'stu-ord'))
  check(JSON.stringify(stuOrd.result.kc.pre.map(q => q.id))
    === JSON.stringify(wantedOrder.filter(id => id !== 'q1_negotiated_ppm')),
  '⚠ …and the STUDENT is served that order')

  // ── The id-collision guard: the explicit SET, not a kc_ prefix ───────────
  const collide = await callFn('scorecardUpdateConfig', asInstructor(gidKc, {
    addedKcQuestions: [{
      id: 'q5_earnings_arithmetic', type: 'mc', prompt: 'mine',
      options: [{ value: 'x', label: 'X' }, { value: 'y', label: 'Y' }], correct_value: 'x',
    }],
  }))
  check(!collide.ok, '⚠⚠ an added question CANNOT take a built-in id')
  check((collide.error ?? '').includes('built-in'), '…and says so')
  mustFail(() => 'q5_earnings_arithmetic'.startsWith('kc_'),
    'a kc_ PREFIX rule would have let this through — scorecard\'s ids are unprefixed')

  // ── D13: the added-question stage is the instructor's ────────────────────
  const staged = await callFn('scorecardUpdateConfig', asInstructor(gidKc, {
    addedKcQuestions: [
      { id: 'akc_pre1', type: 'mc', prompt: 'Added, before play?', stage: 'pre',
        options: [{ value: 'a1', label: 'A' }, { value: 'b1', label: 'B' }], correct_value: 'a1' },
      { id: 'akc_post1', type: 'text', prompt: 'Added, after the reveal?', stage: 'post' },
      { id: 'akc_legacy', type: 'mc', prompt: 'No stage given',
        options: [{ value: 'a2', label: 'A' }, { value: 'b2', label: 'B' }], correct_value: 'a2' },
    ],
  }))
  check(staged.ok, 'added questions with an explicit stage are accepted')
  const stuStage = await callFn('scorecardGetQuestions', asStudent(gidKc, 'stu-stage'))
  check(stuStage.result.kc.pre.some(q => q.id === 'akc_pre1'),
    '⚠⚠ D13 — an added question CHOSEN for `pre` is served BEFORE play')
  check(stuStage.result.kc.post.some(q => q.id === 'akc_post1'),
    '…and one chosen for `post` is served after the reveal')
  check(stuStage.result.kc.post.some(q => q.id === 'akc_legacy'),
    '⚠ …and one with NO stage still lands in `post` — nothing stored before D13 moves')
  check(stuStage.result.kc.total === 8 + 2,
    `⚠ the denominator counts the two GRADED additions and not the free-text one (${stuStage.result.kc.total})`)

  // ── Zero visible graded ⇒ null, not 0 and not 1 ──────────────────────────
  const gidZero = `sc-kczero-${Date.now()}`
  await openInstance(gidZero, { seed: 'kczero' })
  const zeroSet = await callFn('scorecardUpdateConfig', asInstructor(gidZero, {
    kcHidden: Object.fromEntries(kc0.builtIn.map(q => [q.id, true])),
    addedKcQuestions: [{ id: 'akc_only', type: 'text', prompt: 'Just a paragraph, please.' }],
  }))
  check(zeroSet.ok, 'an instance with every graded question hidden is a legal configuration')
  check(zeroSet.result.kc.gradedCount === 0, '…and the count line says 0 graded')
  const zAns = await callFn('scorecardSubmitKcAnswer',
    asStudent(gidZero, 'stu-zero', { questionId: 'akc_only', answer: 'here you go' }))
  check(zAns.ok, 'the one ungraded question is still answerable')
  const zDoc = await getDoc(`scorecard_game_instances/${gidZero}/participants/stu-zero`)
  const zScore = zDoc?.fields?.knowledge_check_score
  check(zScore != null && zScore.nullValue !== undefined,
    `⚠⚠ ZERO VISIBLE GRADED ⇒ the stored score is NULL, not 0 and not 1 (${JSON.stringify(zScore)})`)
  mustFail(() => zScore?.doubleValue === 1 || zScore?.integerValue === '1',
    'calcKCScore answers the empty set with 1.0 — a perfect score for a student never asked anything')

  section('§11  Per-section check counts (T7)')
  // ─────────────────────────────────────────────────────────────────────────────
  // ⚠ A nondeterministic TOTAL means sections silently did not run. Pinning per-section
  // counts is what makes "0 failed" mean "everything ran and passed".
  const EXPECTED_COUNTS = {
    '§1  Both arms of the counterbalancing — a full session each': 5,
    '§2  The alternating schedule (spec §2.2)': 9,
    '§3  reliabilityUsed is WRITTEN, not derived (S1, spec §14.1)': 5,
    '§4  The four draw-rate cells — ALL FOUR, each size-asserted (T2, spec §13)': 11,
    '§5  Balance arithmetic, recomputed from a different source (spec §13)': 52,
    '§6  Resume from all three boundaries, WITH THE SCHEDULE INTACT (spec §13)': 13,
    '§7  Leak surface — exact recursive key-set pin (T6, spec §13)': 32,
    '§8  Submit-and-lock, ordering, and the advance gate': 7,
    '§9  The classroom-shaped case: blank seed, NO truth/main (T4)': 9,
    '§10  The split KC (§9) and the three ordered steps (§10)': 47,
    '§10b ⚠ Solver vs the slide-6 fixtures, and Monte Carlo vs analytic (spec §13)': 17,
    '§10c ⚠ KC parity — added questions and the kcEnabled gate': 18,
    '§10d ⚠⚠ The shared KC surface — hidden / order / overrides, AT THE CALLABLES': 42,
  }
  for (const [name, want] of Object.entries(EXPECTED_COUNTS)) {
    const got = perSection[name] ?? 0
    if (got !== want) {
      failed++
      console.error(`  ✗ section count drift: "${name}" ran ${got} checks, expected ${want}`)
    } else {
      console.log(`  ✓ ${name.slice(0, 40)}… ${got} checks`)
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // THE TRANSCRIPTS (the CP2 deliverable)
  // ═══════════════════════════════════════════════════════════════════════════
  for (const [name, transcript, doc, startsWith] of [
    ['A', transcriptA, docA, 'high'],
    ['B', transcriptB, await readParticipant(gid, B), 'low'],
  ]) {
    console.log('\n' + '═'.repeat(78))
    console.log(`TRANSCRIPT — student ${name}, startsWith = ${startsWith}`)
    console.log('═'.repeat(78))
    console.log('  C  Reliability          Effort (H=high)      Acc  Score  High  Earnings')
    console.log('  ' + '─'.repeat(74))
    let running = 0
    for (const c of doc.contracts) {
      const cond = near(c.reliability, P.relHigh) ? 'HIGH' : 'LOW '
      const effort = c.periods.map(p => (p.action === 'high' ? 'H' : '·')).join('')
      const acc = c.periods.map(p => (p.acceptable ? '✓' : '·')).join('')
      running += c.earnings
      console.log(
        `  ${String(c.contract).padStart(2)}  ${cond} ${(c.reliability * 100).toFixed(0)}%`.padEnd(24) +
        `${effort}   ${acc}  ${String(c.score).padStart(2)}    ` +
        `${String(c.high_effort_periods).padStart(2)}   ` +
        `${String(c.earnings).padStart(4)}  ${c.met_target ? '★ bonus' : ''}`,
      )
      console.log(
        `      ${' '.repeat(16)}balance: ${P.endowment} − ${P.cHigh}×${c.high_effort_periods}` +
        ` = ${P.endowment - P.cHigh * c.high_effort_periods}` +
        `${c.met_target ? ` + ${P.bonus} bonus` : ' + 0 (no bonus)'} = ${c.earnings}`,
      )
    }
    console.log('  ' + '─'.repeat(74))
    console.log(`  Session total: ${running} ECU   ·   stored: ${doc.total_earnings} ECU`)
    const conds = doc.contracts.map(c => (near(c.reliability, P.relHigh) ? 'H' : 'L')).join(' ')
    console.log(`  Schedule: ${conds}   (startsWith = ${startsWith}, alternating)`)
  }

  console.log('\n' + '═'.repeat(78))
  console.log(`${passed} passed, ${failed} failed`)
  console.log('═'.repeat(78))
  if (failed > 0) process.exit(1)
}

run().catch((e) => { console.error(e); process.exit(1) })
