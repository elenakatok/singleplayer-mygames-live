/**
 * Forecasting — forecastCorrectForecast (instructor) against the emulators.
 *
 * Why: a student typed 152 for 1,152 in the last month (Jamaal, 2026-10-06). The family's
 * submit-and-lock rule rightly refuses a STUDENT's revision, so the instructor needs a
 * sanctioned way to fix a typed forecast — rewriting that one number, never the demand
 * drawn for it and never a score, with an audit entry the report shows.
 *
 * Run (from games/singleplayer, functions built):
 *   firebase emulators:exec --only functions,firestore,auth --project demo-singleplayer \
 *     "node forecast-correct-forecast.mjs"
 */
const PROJECT = 'demo-singleplayer'
const FUNCTIONS = `http://127.0.0.1:5010/${PROJECT}/us-central1`
const FIRESTORE = `http://127.0.0.1:8090/v1/projects/${PROJECT}/databases/(default)/documents`

let passed = 0, failed = 0
const check = (cond, label, extra) => {
  if (cond) { passed++; console.log(`  ✓ ${label}`) } else { failed++; console.log(`  ✗ FAIL: ${label}${extra !== undefined ? ` — ${extra}` : ''}`) }
}
async function callFn(name, data) {
  const res = await fetch(`${FUNCTIONS}/${name}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data }) })
  let body = null; try { body = await res.json() } catch { /* ignore */ }
  if (res.ok && body && 'result' in body) return { ok: true, result: body.result }
  return { ok: false, error: body?.error?.message ?? `http ${res.status}` }
}
async function putDoc(docPath, fields) {
  const res = await fetch(`${FIRESTORE}/${docPath}`, { method: 'PATCH', headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' }, body: JSON.stringify({ fields }) })
  if (!res.ok) throw new Error(`firestore PATCH ${docPath} → ${res.status} ${await res.text()}`)
}
async function getDoc(docPath) {
  const res = await fetch(`${FIRESTORE}/${docPath}`, { headers: { Authorization: 'Bearer owner' } })
  return res.ok ? res.json() : null
}
const intVal = (n) => ({ integerValue: String(n) })
const strVal = (s) => ({ stringValue: s })
const boolVal = (b) => ({ booleanValue: b })
const arrVal = (xs) => ({ arrayValue: { values: xs } })
const asStudent = (gid, pid, extra = {}) => ({ _test: { participant_id: pid, game_instance_id: gid }, ...extra })
const asInstructor = (gid, extra = {}) => ({ _dev: { game_instance_id: gid }, ...extra })
const num = (f) => f?.integerValue != null ? Number(f.integerValue) : f?.doubleValue != null ? Number(f.doubleValue) : null

const MODEL = { a: 560, b: 4, H: 230, sigma: 60, high: [11, 12] }
async function openInstance(gid, rounds) {
  await putDoc(`forecast_game_instances/${gid}/config/main`, {
    num_history: intVal(60), rounds: intVal(rounds), forecast_min: intVal(0), forecast_max: intVal(3000),
    kc_enabled: boolVal(false), debrief_enabled: boolVal(true),
  })
  await putDoc(`forecast_game_instances/${gid}/truth/main`, {
    intercept: intVal(MODEL.a), trend: intVal(MODEL.b), high_season_lift: intVal(MODEL.H),
    high_season_months: arrVal(MODEL.high.map(intVal)), sigma: intVal(MODEL.sigma),
    seasonality: strVal('additive'), season_structure: strVal('twoSeason'), demand_draw: strVal('perStudent'),
  })
}

async function main() {
  const gid = `fc-correct-${Date.now()}`
  const S = 'stu-typo'
  const ROUNDS = 4
  await openInstance(gid, ROUNDS)
  await putDoc(`forecast_game_instances/${gid}/participants/${S}`, { participant_id: strVal(S), game_instance_id: strVal(gid), name: strVal('Typo Student') })

  console.log('\n── play every month; the LAST one is typed as 152 instead of 1152 ──')
  const forecasts = [900, 950, 1000, 152]
  let last = null
  for (let r = 1; r <= ROUNDS; r++) {
    last = await callFn('forecastSubmitRound', asStudent(gid, S, { round: r, forecast: forecasts[r - 1] }))
    check(last.ok, `month ${r} submitted (${forecasts[r - 1]})`, last.error)
  }
  const before = await getDoc(`forecast_game_instances/${gid}/participants/${S}`)
  const roundsBefore = before.fields.rounds.arrayValue.values.map(v => v.mapValue.fields)
  const actual4 = num(roundsBefore[3].actual)
  check(before.fields.finished_at != null && roundsBefore.length === 4, 'game finished (4 months stored)')

  console.log('\n── a STUDENT cannot revise it (submit-and-lock) ──')
  const retry = await callFn('forecastSubmitRound', asStudent(gid, S, { round: 4, forecast: 1152 }))
  const afterRetry = await getDoc(`forecast_game_instances/${gid}/participants/${S}`)
  check(num(afterRetry.fields.rounds.arrayValue.values[3].mapValue.fields.forecast) === 152, 'resubmitting month 4 leaves 152 in place (idempotent, no second draw)')
  const asStu = await callFn('forecastCorrectForecast', asStudent(gid, S, { participant_id: S, round: 4, forecast: 1152 }))
  check(!asStu.ok, `the correction callable refuses a student's credentials (${asStu.error})`)

  console.log('\n── the INSTRUCTOR fixes it ──')
  const bad1 = await callFn('forecastCorrectForecast', asInstructor(gid, { participant_id: S, round: 9, forecast: 1152 }))
  check(!bad1.ok && /not played/.test(bad1.error ?? ''), `an unplayed month is refused (${bad1.error})`)
  const bad2 = await callFn('forecastCorrectForecast', asInstructor(gid, { participant_id: S, round: 4, forecast: 99999 }))
  check(!bad2.ok && /between 0 and 3000/.test(bad2.error ?? ''), `out-of-bounds value is refused with the instance's own bounds (${bad2.error})`)
  const bad3 = await callFn('forecastCorrectForecast', asInstructor(gid, { participant_id: S, round: 4, forecast: 1152.5 }))
  check(!bad3.ok, `a non-integer is refused (${bad3.error})`)
  const bad4 = await callFn('forecastCorrectForecast', asInstructor(gid, { participant_id: 'nobody', round: 1, forecast: 900 }))
  check(!bad4.ok && /not in this game/.test(bad4.error ?? ''), `an unknown student is refused (${bad4.error})`)
  const untouched = await getDoc(`forecast_game_instances/${gid}/participants/${S}`)
  check(num(untouched.fields.rounds.arrayValue.values[3].mapValue.fields.forecast) === 152 && !untouched.fields.forecast_corrections, 'refusals wrote nothing')

  const fix = await callFn('forecastCorrectForecast', asInstructor(gid, { participant_id: S, round: 4, forecast: 1152, note: 'typed 152 for 1,152' }))
  check(fix.ok && fix.result.changed === true && fix.result.from === 152 && fix.result.to === 1152 && fix.result.period === 64, 'month 4 corrected 152 → 1152', JSON.stringify(fix))
  const after = await getDoc(`forecast_game_instances/${gid}/participants/${S}`)
  const r4 = after.fields.rounds.arrayValue.values[3].mapValue.fields
  check(num(r4.forecast) === 1152, 'stored forecast is now 1152')
  check(num(r4.actual) === actual4, `the realized demand is UNTOUCHED (${actual4})`)
  check(after.fields.rounds.arrayValue.values.slice(0, 3).every((v, i) => num(v.mapValue.fields.forecast) === forecasts[i]), 'the other months are untouched')
  const corr = after.fields.forecast_corrections?.arrayValue?.values ?? []
  check(corr.length === 1 && num(corr[0].mapValue.fields.from) === 152 && num(corr[0].mapValue.fields.to) === 1152 && corr[0].mapValue.fields.note?.stringValue === 'typed 152 for 1,152', 'one audit entry, with the note')
  // cached report figures agree with a recomputation from the corrected rounds
  const pts = after.fields.rounds.arrayValue.values.map(v => v.mapValue.fields).map(f => ({ fc: num(f.forecast), ac: num(f.actual) }))
  const mse = pts.reduce((s, p) => s + (p.ac - p.fc) ** 2, 0) / pts.length
  check(Math.abs(num(after.fields.mse) - mse) < 1e-6, `cached MSE refreshed to ${mse.toFixed(1)} (was ${num(before.fields.mse).toFixed(1)})`)
  check(num(after.fields.raw_score) === num(before.fields.raw_score) && num(after.fields.normalized_score) === num(before.fields.normalized_score), 'no score field changed')

  const same = await callFn('forecastCorrectForecast', asInstructor(gid, { participant_id: S, round: 4, forecast: 1152 }))
  const after2 = await getDoc(`forecast_game_instances/${gid}/participants/${S}`)
  check(same.ok && same.result.changed === false && (after2.fields.forecast_corrections.arrayValue.values.length === 1), 'correcting to the same value changes nothing and adds no audit entry')

  console.log('\n── what the student and the instructor now see ──')
  const csv = await callFn('forecastGetExport', asStudent(gid, S, { kind: 'full' }))
  const lastLine = (csv.result?.csv ?? '').trim().split('\n').pop()
  check(csv.ok && /1152/.test(lastLine) && !/,152,|,152$/.test(lastLine), `the student's full CSV carries 1152 on the last month (${lastLine})`)
  const rep = await callFn('forecastGetReport', asInstructor(gid))
  const me = rep.result?.participants?.find(p => p.participant_id === S)
  check(me && me.months[3].forecast === 1152 && me.months[3].actual === actual4, 'the report month table shows 1152 against the same demand')
  check(me && me.corrections.length === 1 && me.corrections[0].from === 152 && me.corrections[0].to === 1152 && /^\d{4}-/.test(me.corrections[0].at), 'the report carries the correction, with an ISO timestamp')
  check(me && Math.abs(me.mse - mse) < 1e-6, 'the report MSE is the recomputed one')

  // the shape pin other suites rely on: a student type never carries corrections
  const st = await callFn('forecastGetState', asStudent(gid, S))
  check(st.ok && !JSON.stringify(st.result).includes('corrections'), 'the student state payload carries no correction data')

  console.log(`\nRESULT — ${passed} passed, ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}
main().catch(e => { console.error('FATAL', e); process.exit(1) })
