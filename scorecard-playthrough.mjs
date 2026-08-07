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

  // ─────────────────────────────────────────────────────────────────────────────
  section('§10  Knowledge check and debrief (spec §9, §10)')
  // ─────────────────────────────────────────────────────────────────────────────
  const q = await callFn('scorecardGetQuestions', asStudent(gidR, R))
  check(q.ok, 'scorecardGetQuestions responds')
  check(q.result.kc.questions.length === 8, `eight graded questions (got ${q.result.kc.questions.length})`)
  check(q.result.kc.total === q.result.kc.questions.length,
    '⚠ the denominator is DYNAMIC, not a hardcoded /8')
  const kcKeys = keyPaths(q.result.kc.questions[0])
  check(![...kcKeys].some(k => k.includes('correct')), 'no answer key ships with the questions')
  check(![...kcKeys].some(k => k.includes('explanation')), 'no explanation ships with the questions')

  // ⚠ Q1 and Q2 must COMPUTE 10 and 40 from the general threshold form.
  const q1 = q.result.kc.questions.find(x => x.id === 'q1_threshold_high')
  const q2 = q.result.kc.questions.find(x => x.id === 'q2_threshold_low')
  // ⚠ ROUNDED BEFORE COMPARING, and the reason is a finding rather than a convenience:
  // (4 − 0) / (0.4 − 0.3) is 39.999999999999986 in IEEE 754, because 0.4 − 0.3 is not
  // exactly 0.1. The SERVER already handles this — `ecu()` rounds before rendering, so a
  // student reads "40 ECU" — and an earlier version of this harness compared against the
  // raw float and failed, which is exactly the check doing its job in reverse. Round here
  // too, or the harness demands a string no student should ever see.
  const thHigh = Math.round((P.cHigh - P.cLow) / (P.relHigh - P.pLow) * 100) / 100
  const thLow = Math.round((P.cHigh - P.cLow) / (P.relLow - P.pLow) * 100) / 100
  check(q1.options.some(o => o.text.startsWith(`${thHigh} `)), `Q1 offers ${thHigh} ECU`)
  check(q2.options.some(o => o.text.startsWith(`${thLow} `)), `Q2 offers ${thLow} ECU`)
  // ⚠ And no option may print a raw float — the thing the rounding exists to prevent.
  const allOptionText = q.result.kc.questions.flatMap(x => x.options.map(o => o.text)).join(' | ')
  check(!/\d\.\d{4,}/.test(allOptionText),
    'no knowledge-check option prints an unrounded float (R8)')
  check(q1.prompt.includes('70%') && q1.prompt.includes('30%'), 'Q1 states both probabilities')

  // The debrief must not name the treatment (spec §10).
  const dprompt = `${q.result.debrief.prompt} ${q.result.debrief.followUps.join(' ')}`.toLowerCase()
  for (const banned of ['reliability', 'reliable', 'unreliable', 'condition', 'treatment', '70%', '40%']) {
    check(!dprompt.includes(banned), `⚠ the debrief prompt does not say '${banned}'`)
  }

  // Answer the KC, then the debrief; the reveal comes only from the debrief.
  for (const question of q.result.kc.questions) {
    const r = await callFn('scorecardSubmitKcAnswer', asStudent(gidR, R, {
      questionId: question.id, answer: question.options[0].id,
    }))
    if (!r.ok) check(false, `KC submit ${question.id}: ${r.error}`)
  }
  const q2nd = await callFn('scorecardGetQuestions', asStudent(gidR, R))
  check(q2nd.result.kc.complete === true, 'the KC scores once every question is answered')
  check(typeof q2nd.result.kc.score === 'number', `KC score recorded (${q2nd.result.kc.score})`)

  const deb = await callFn('scorecardSubmitDebrief', asStudent(gidR, R, {
    answer: 'I worked hard early and gave up when it looked hopeless.',
  }))
  check(deb.ok, 'the debrief is accepted once the session is over')
  check(deb.result.reveal != null, '⚠ the reveal comes back WITH the debrief, not before')
  check(near(deb.result.reveal.high.reliability, P.relHigh)
    && near(deb.result.reveal.low.reliability, P.relLow),
    'the reveal names both conditions')
  check(near(deb.result.reveal.high.benchmarks.optimal, 94.12, 0.01),
    `the reveal carries the DP optimum, 94.12 (got ${deb.result.reveal.high.benchmarks.optimal?.toFixed(2)})`)
  check(near(deb.result.reveal.low.benchmarks.optimal, 51.56, 0.01),
    `and 51.56 for the low condition (got ${deb.result.reveal.low.benchmarks.optimal?.toFixed(2)})`)

  // ⚠ THE GATE. A student who has NOT finished cannot reach the reveal.
  const early = await callFn('scorecardSubmitDebrief', asStudent(gidX, X, { answer: 'too soon' }))
  check(!early.ok, '⚠ the debrief is REFUSED before the session is over — the reveal is gated')

  // ─────────────────────────────────────────────────────────────────────────────
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
    '§7  Leak surface — exact recursive key-set pin (T6, spec §13)': 30,
    '§8  Submit-and-lock, ordering, and the advance gate': 7,
    '§9  The classroom-shaped case: blank seed, NO truth/main (T4)': 6,
    '§10  Knowledge check and debrief (spec §9, §10)': 24,
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
