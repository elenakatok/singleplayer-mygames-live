// ═══════════════════════════════════════════════════════════════════════════════
// Scorecard robot cohort — EMULATOR DRY RUN.
//
// Populates an instance with a class-sized cohort of simulated students, one per
// persona, driving the REAL callables. Its purpose is threefold:
//
//   1. Give the reports a realistic cohort so all four Tier-3 charts and the Tier-1
//      roster can be looked at with real spread in them.
//   2. ⚠ ASSERT THAT EACH PERSONA'S RESPONSE TO RELIABILITY IS WHAT IT CLAIMS. This is
//      the control: if condition plumbing collapsed, the 'strong' responders would come
//      back with a gap near zero and this run FAILS. A cohort that merely filled the
//      roster would hide exactly the bug the charts exist to reveal.
//   3. ⚠ PROVE THE OPTIMIZER USES THE CP1 SOLVER — its policy is imported from the
//      compiled functions bundle, never reimplemented here (spec §16).
//
// Run:  npm run robots:scorecard:dryrun
// ═══════════════════════════════════════════════════════════════════════════════

import {
  STYLES, STYLE_NAMES, styleFor, EXPECTED_RESPONSE, LEARNER_SWITCH_CONTRACT,
} from './bot/scorecard-styles.mjs'
// ⚠⚠ THE SOLVER, IMPORTED — not reimplemented. This is the one place the robot cohort
// touches server code on purpose: spec §16 requires ONE solver with four consumers, and
// the optimizer robot is consumer three. `functions/lib` is the compiled output the
// emulator itself serves, so this is the same code the settings panel and the reports run.
import { solve, highEffortOptimal } from './functions/lib/scorecard/dp.js'

const PROJECT = 'demo-singleplayer'
const FUNCTIONS = `http://127.0.0.1:5010/${PROJECT}/us-central1`
const FIRESTORE = `http://127.0.0.1:8090/v1/projects/${PROJECT}/databases/(default)/documents`

let passed = 0, failed = 0
const check = (cond, label) => {
  if (cond) { passed++; console.log(`  ✓ ${label}`) }
  else { failed++; console.error(`  ✗ ${label}`) }
}
const section = (t) => console.log(`\n${t}`)

async function callFn(name, data) {
  const res = await fetch(`${FUNCTIONS}/${name}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
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
  if (!res.ok) throw new Error(`firestore PATCH ${docPath} → ${res.status}`)
}

const intVal = (n) => ({ integerValue: String(n) })
const dblVal = (n) => ({ doubleValue: n })
const strVal = (s) => ({ stringValue: s })
const boolVal = (b) => ({ booleanValue: b })
const asStudent = (gid, pid, extra = {}) => ({ _test: { participant_id: pid, game_instance_id: gid }, ...extra })
const asInstructor = (gid, extra = {}) => ({ _dev: { game_instance_id: gid }, ...extra })

/** A small deterministic PRNG, so a cohort is reproducible run to run. */
function mulberry(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ⚠ ALL EXPLICIT — never inherited from a shipped default.
const P = {
  contracts: 20, periods: 10, targetScore: 7, bonus: 120,
  cHigh: 4, cLow: 0, pLow: 0.30, endowment: 50, relHigh: 0.70, relLow: 0.40,
}

async function openInstance(gid, over = {}) {
  const o = { ...P, ...over }
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
    show_reliability_label: boolVal(true),
    currency: strVal('ECU'),
  })
  await putDoc(`scorecard_game_instances/${gid}/truth/main`, {
    reliability_high: dblVal(o.relHigh),
    reliability_low: dblVal(o.relLow),
    reliability_schedule: strVal('alternating'),
    label_high: strVal('High Reliability ({pct})'),
    label_low: strVal('Low Reliability ({pct})'),
    seed: strVal(over.seed ?? 'cohort-fixed'),
  })
  return o
}

/** The DP policy for one reliability, from the CP1 solver. */
function policyFor(rules, reliability) {
  const sol = solve(rules, reliability)
  return (periodsRemaining, score) => highEffortOptimal(sol, periodsRemaining, score)
}

/** Drive one robot through a full session. */
async function playRobot(gid, pid, styleName, rules, rand) {
  const style = STYLES[styleName]
  let st = await callFn('scorecardGetState', asStudent(gid, pid))
  if (!st.ok) throw new Error(`${pid} getState: ${st.error}`)

  for (let k = 1; k <= P.contracts; k++) {
    // ⚠ The policy is bound to THIS contract's reliability, which the robot reads off
    // its own screen — exactly what a student sees, and never the schedule.
    const policy = policyFor(rules, st.result.contract.reliability)
    for (let p = 1; p <= P.periods; p++) {
      const c = st.result.contract
      const action = style({
        contract: k,
        period: p,
        periodsRemaining: c.periodsRemaining,
        score: c.score,
        reliability: c.reliability,
        targetScore: st.result.params.targetScore,
        highEffortCost: st.result.params.highEffortCost,
        bonus: st.result.params.bonus,
        pAcceptableLow: st.result.params.pAcceptableLow,
        rand,
        policy,
      })
      const res = await callFn('scorecardSubmitPeriod', asStudent(gid, pid, { contract: k, period: p, action }))
      if (!res.ok) throw new Error(`${pid} c${k}p${p}: ${res.error}`)
      st = { ok: true, result: res.result }
    }
    if (k < P.contracts) {
      st = await callFn('scorecardGetState', asStudent(gid, pid, { advance: true }))
      if (!st.ok) throw new Error(`${pid} advance after c${k}: ${st.error}`)
    }
  }

  // The KC and the debrief, so Tier 2 and the KC column have data.
  const q = await callFn('scorecardGetQuestions', asStudent(gid, pid))
  if (q.ok) {
    for (const question of q.result.kc.questions) {
      // A robot answers with a persona-flavoured guess: optimizers get it right more often.
      const idx = styleName === 'optimizer' ? 0 : Math.floor(rand() * question.options.length)
      await callFn('scorecardSubmitKcAnswer', asStudent(gid, pid, {
        questionId: question.id, answer: question.options[idx].id,
      }))
    }
  }
  await callFn('scorecardSubmitDebrief', asStudent(gid, pid, {
    answer: `[${styleName}] I worked when it seemed worth it and stopped when it did not.`,
  }))
}

const run = async () => {
  console.log('═'.repeat(78))
  console.log('Scorecard — robot cohort dry run')
  console.log('═'.repeat(78))

  const gid = `sc-cohort-${Date.now()}`
  const cfg = await openInstance(gid)
  const rules = {
    periodsPerContract: cfg.periods, targetScore: cfg.targetScore, bonus: cfg.bonus,
    highEffortCost: cfg.cHigh, lowEffortCost: cfg.cLow, pAcceptableLow: cfg.pLow,
    endowmentPerContract: cfg.endowment,
  }

  section('§1  The cohort plays')
  // 21 students — three of each persona, so every persona's gap is an average of three
  // sessions rather than one lucky draw.
  const COHORT = STYLE_NAMES.length * 3
  const assignments = []
  for (let i = 0; i < COHORT; i++) {
    assignments.push({ pid: `robot-${String(i).padStart(2, '0')}`, style: styleFor(i) })
  }
  for (const { pid, style } of assignments) {
    await playRobot(gid, pid, style, rules, mulberry(1000 + assignments.findIndex(a => a.pid === pid)))
  }
  check(true, `${COHORT} robots played ${P.contracts} contracts each`)

  // ── A handful of HUMAN-shaped participants ────────────────────────────────
  // ⚠ Bots are excluded from Tier 1 and from the gap distribution (report.ts), so a
  // cohort of only robots leaves both EMPTY. These plain participant ids exercise the
  // human side of that split — and are what the roster screenshot is of.
  const HUMANS = [
    ['stu-chen', 'Kathy Chen', 'coaster'],
    ['stu-smith', 'Rhett Smith', 'grinder'],
    ['stu-okafor', 'Ada Okafor', 'responder'],
    ['stu-delacruz', 'Ana de la Cruz', 'minimalist'],
    ['stu-park', 'Jae Park', 'learner'],
    ['stu-nowak', 'Piotr Nowak', 'overreactor'],
    ['stu-hall', 'Bea Hall', 'optimizer'],
    ['stu-ito', 'Ren Ito', 'responder'],
    ['stu-abara', 'Chidi Abara', 'grinder'],
  ]
  for (const [pid, name, style] of HUMANS) {
    await putDoc(`scorecard_game_instances/${gid}/participants/${pid}`, {
      name: strVal(name),
    })
    await playRobot(gid, pid, style, rules, mulberry(9000 + pid.length))
  }
  // ⚠ One student who plays only PART of a session — their effort gap is defined but
  // their status is "in progress", and one who never starts at all. Both exist so the
  // roster and chart 3's exclusion counts have something real to reconcile (R6).
  await putDoc(`scorecard_game_instances/${gid}/participants/stu-quiet`, { name: strVal('Sam Quiet') })
  const partial = 'stu-partial'
  await putDoc(`scorecard_game_instances/${gid}/participants/${partial}`, { name: strVal('Lee Partial') })
  await callFn('scorecardGetState', asStudent(gid, partial))
  for (let p = 1; p <= P.periods; p++) {
    await callFn('scorecardSubmitPeriod', asStudent(gid, partial, { contract: 1, period: p, action: 'high' }))
  }
  check(true, `${HUMANS.length} human students played, plus one partial and one no-show`)

  section('§2  ⚠ Each persona responded to reliability as it claims')
  const rep = await callFn('scorecardGetReport', asInstructor(gid))
  check(rep.ok, 'scorecardGetReport responds')

  // ⚠ BOTS NEVER APPEAR IN TIER 1 (spec §11). Every participant here is a bot, so the
  // roster must be EMPTY while the chart data is full — which is also the strongest
  // possible check that the filter is real.
  // ⚠ THE SPLIT, ASSERTED FROM BOTH SIDES: every human appears, every bot does not.
  const rosterIds = rep.result.participants.map(p => p.participant_id)
  check(rosterIds.length === HUMANS.length + 2,
    `⚠ Tier 1 lists ${rosterIds.length} humans (${HUMANS.length} played + 1 partial + 1 no-show)`)
  check(!rosterIds.some(id => id.startsWith('robot-')),
    '⚠ Tier 1 excludes every bot')
  check(rep.result.participants.every(p => p.from_bot_cohort === true),
    '⚠ every human is MARKED as being in a bot-filled cohort (spec §11)')
  check(rep.result.botCount === COHORT, `botCount reports all ${COHORT}`)

  // Read the gaps straight from the stored docs, per persona.
  const byStyle = new Map()
  const perContract = new Map()
  for (const { pid, style } of assignments) {
    const doc = await fetch(`${FIRESTORE}/scorecard_game_instances/${gid}/participants/${pid}`,
      { headers: { Authorization: 'Bearer owner' } }).then(r => r.json())
    const contracts = (doc.fields?.contracts?.arrayValue?.values ?? []).map(v => {
      const f = v.mapValue.fields
      return {
        reliability: Number(f.reliability?.doubleValue ?? f.reliability?.integerValue ?? 0),
        periods: (f.periods?.arrayValue?.values ?? []).map(pv => pv.mapValue.fields.action.stringValue),
      }
    })
    const rate = (hi) => {
      const ps = contracts.filter(c => (c.reliability > 0.55) === hi).flatMap(c => c.periods)
      return ps.length === 0 ? null : ps.filter(a => a === 'high').length / ps.length
    }
    const gap = rate(true) - rate(false)
    if (!byStyle.has(style)) byStyle.set(style, [])
    byStyle.get(style).push(gap)
    if (!perContract.has(style)) perContract.set(style, [])
    perContract.get(style).push(contracts)
  }

  console.log()
  console.log('  persona'.padEnd(16), 'mean gap'.padStart(10), '  expected')
  console.log('  ' + '─'.repeat(46))
  for (const style of STYLE_NAMES) {
    const gaps = byStyle.get(style) ?? []
    const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length
    const want = EXPECTED_RESPONSE[style]
    console.log(`  ${style.padEnd(14)} ${mean.toFixed(3).padStart(10)}   ${want}`)
    // ⚠ Size-asserted before the claim (T2).
    check(gaps.length === 3, `${style}: three sessions measured`)
    if (want === 'none') {
      check(Math.abs(mean) < 0.05, `${style}: gap ≈ 0 as expected (${mean.toFixed(3)})`)
    } else if (want === 'weak') {
      check(mean > 0.01 && mean < 0.35, `${style}: small positive gap (${mean.toFixed(3)})`)
    } else {
      check(mean > 0.35, `${style}: LARGE positive gap (${mean.toFixed(3)})`)
    }
  }

  section('§2b ⚠ The learner\'s response EMERGES — the time path chart 1 shows')
  // ⚠ WHAT MAKES `learner` A DISTINCT PERSONA is not the size of its gap (0.77, strong)
  // but its SHAPE over the session. Without someone whose behaviour drifts, chart 1 —
  // effort by contract ROUND — would be two flat lines and could not demonstrate that
  // plotting against round is what the counterbalancing buys.
  const learnerSessions = perContract.get('learner') ?? []
  check(learnerSessions.length === 3, 'three learner sessions measured')
  const windowGap = (sessions, from, to) => {
    let hiH = 0, hiN = 0, loH = 0, loN = 0
    for (const contracts of sessions) {
      contracts.forEach((c, i) => {
        const k = i + 1
        if (k < from || k > to) return
        const isHigh = c.reliability > 0.55
        for (const a of c.periods) {
          if (isHigh) { hiN++; if (a === 'high') hiH++ }
          else { loN++; if (a === 'high') loH++ }
        }
      })
    }
    return (hiN === 0 || loN === 0) ? null : (hiH / hiN) - (loH / loN)
  }
  const early = windowGap(learnerSessions, 1, LEARNER_SWITCH_CONTRACT)
  const late = windowGap(learnerSessions, LEARNER_SWITCH_CONTRACT + 1, P.contracts)
  check(early !== null && late !== null, 'both windows have data in both conditions (size-asserted)')
  check(Math.abs(early) < 0.05, `learner's gap over contracts 1–${LEARNER_SWITCH_CONTRACT} is ≈ 0 (${early?.toFixed(3)})`)
  check(late > 0.6, `⚠ and LARGE over contracts ${LEARNER_SWITCH_CONTRACT + 1}–${P.contracts} (${late?.toFixed(3)}) — the drift chart 1 renders`)

  section('§3  ⚠ The cohort would EXPOSE a collapsed treatment')
  // The whole point of persona diversity. If both conditions were the same, every gap
  // would be ~0 and the two Tier-3 series would coincide.
  const strongStyles = STYLE_NAMES.filter(s => EXPECTED_RESPONSE[s] === 'strong')
  const strongMean = strongStyles
    .map(s => (byStyle.get(s) ?? []).reduce((a, b) => a + b, 0) / (byStyle.get(s)?.length || 1))
    .reduce((a, b) => a + b, 0) / strongStyles.length
  check(strongMean > 0.35,
    `⚠ the responding personas separate the conditions by ${strongMean.toFixed(3)} — a collapsed treatment could not`)

  const t3 = rep.result.tier3
  const hiSeries = t3.byPeriod.high.filter(v => v !== null)
  const loSeries = t3.byPeriod.low.filter(v => v !== null)
  check(hiSeries.length === P.periods && loSeries.length === P.periods,
    'chart 2 has a point for every period in both series')
  const meanHi = hiSeries.reduce((a, b) => a + b, 0) / hiSeries.length
  const meanLo = loSeries.reduce((a, b) => a + b, 0) / loSeries.length
  check(meanHi - meanLo > 0.15,
    `⚠ chart 2's two class lines are DISTINCT (${meanHi.toFixed(3)} vs ${meanLo.toFixed(3)}) — not one line drawn twice`)

  section('§4  All four Tier-3 charts carry data')
  check(t3.byRound.high.length === P.contracts && t3.byRound.low.length === P.contracts,
    `chart 1: ${P.contracts} rounds in both series`)
  check(t3.byRound.high.every(p => p.n >= 0) && t3.byRound.high.some(p => p.n > 0),
    'chart 1: per-round n present and non-zero')
  check(t3.gapDistribution.bins.length > 0, 'chart 3: gap distribution has bins')
  // ⚠ CHART 3 IS HUMANS-ONLY (report.ts): it plots ONE POINT PER STUDENT, so a bot in it
  // would be a fake body in a bucket Elena reads as her class. Every participant here is
  // a bot, so it is correctly EMPTY — while charts 1, 2 and 4 are full.
  // ⚠⚠ R6 — EVERY STUDENT IS ACCOUNTED FOR: plotted, or excluded with a stated reason.
  const gd = t3.gapDistribution
  const plotted = gd.bins.reduce((a, b) => a + b.count, 0)
  check(plotted === gd.included, `chart 3: bins sum to the plotted count (${plotted})`)
  check(gd.included + gd.excludedUndefined + gd.excludedNoPlay === HUMANS.length + 2,
    `⚠ R6: ${gd.included} plotted + ${gd.excludedUndefined} undefined + ${gd.excludedNoPlay} never-played `
    + `= ${HUMANS.length + 2} humans — the legend reconciles`)
  check(gd.excludedNoPlay >= 1, 'the no-show is excluded as never-played, not plotted at zero')
  check(gd.atZero >= 1, '⚠ there is a mass at zero — the finding chart 3 exists to show')
  check(t3.policyGrid.length === 2, 'chart 4: two panels')
  check(t3.policyGrid[0].condition === 'low', '⚠ chart 4: LOW panel is FIRST (left) — slide order')
  check(t3.policyGrid[1].condition === 'high', '⚠ chart 4: HIGH panel is second (right)')
  check(t3.policyGrid[0].title === 'Reliability = 40%', `chart 4 low title reads config: "${t3.policyGrid[0].title}"`)
  check(t3.policyGrid[1].title === 'Reliability = 70%', `chart 4 high title reads config: "${t3.policyGrid[1].title}"`)

  section('§5  ⚠ The optimizer used the CP1 solver')
  // The optimizer's own contracts must match the DP cell for cell. This is the check
  // that a second policy implementation would fail.
  const optPid = assignments.find(a => a.style === 'optimizer').pid
  const doc = await fetch(`${FIRESTORE}/scorecard_game_instances/${gid}/participants/${optPid}`,
    { headers: { Authorization: 'Bearer owner' } }).then(r => r.json())
  let checkedPeriods = 0
  let mismatches = 0
  for (const cv of doc.fields.contracts.arrayValue.values) {
    const f = cv.mapValue.fields
    const rel = Number(f.reliability.doubleValue ?? f.reliability.integerValue)
    const pol = policyFor(rules, rel)
    let score = 0
    const periods = f.periods.arrayValue.values
    periods.forEach((pv, i) => {
      const pf = pv.mapValue.fields
      const want = pol(P.periods - i, score) ? 'high' : 'low'
      if (pf.action.stringValue !== want) mismatches++
      checkedPeriods++
      score = Number(pf.score.integerValue ?? pf.score.doubleValue)
    })
  }
  check(checkedPeriods === P.contracts * P.periods,
    `every one of ${P.contracts * P.periods} optimizer periods checked (size-asserted)`)
  check(mismatches === 0, `⚠ optimizer matched the CP1 solver in all ${checkedPeriods} periods`)

  console.log('\n' + '═'.repeat(78))
  console.log(`instance: ${gid}`)
  console.log(`${passed} passed, ${failed} failed`)
  console.log('═'.repeat(78))
  if (failed > 0) process.exit(1)
}

run().catch(e => { console.error(e); process.exit(1) })
