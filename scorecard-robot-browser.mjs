// ═══════════════════════════════════════════════════════════════════════════════
// Boots a vite dev server, seeds an instance, and runs the LAUNCHER'S OWN robot driver
// against the emulator — so the driver Elena's launcher spawns is the one that gets
// exercised, rather than a second copy of its logic.
//
// ⚠ T9 — `spawn('npx', …)` orphans vite. Both children are killed explicitly in `finally`.
//
// Run:  npm run robots:scorecard:browser
// ═══════════════════════════════════════════════════════════════════════════════
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const PROJECT = 'demo-singleplayer'
const VITE_PORT = 5199
const APP = `http://localhost:${VITE_PORT}`
const FIRESTORE = `http://127.0.0.1:8090/v1/projects/${PROJECT}/databases/(default)/documents`

const intVal = n => ({ integerValue: String(n) })
const dblVal = n => ({ doubleValue: n })
const strVal = s => ({ stringValue: s })
const boolVal = b => ({ booleanValue: b })

async function putDoc(p, fields) {
  const res = await fetch(`${FIRESTORE}/${p}`, {
    method: 'PATCH',
    headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields }),
  })
  if (!res.ok) throw new Error(`PATCH ${p} → ${res.status}`)
}

async function startVite() {
  const child = spawn('npx', ['vite', '--port', String(VITE_PORT), '--strictPort', '--host', '127.0.0.1'], {
    cwd: path.join(ROOT, 'frontend'),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      VITE_FIREBASE_API_KEY: 'demo-key',
      VITE_FIREBASE_AUTH_DOMAIN: 'localhost',
      VITE_FIREBASE_PROJECT_ID: PROJECT,
      VITE_FIREBASE_STORAGE_BUCKET: `${PROJECT}.appspot.com`,
      VITE_FIREBASE_MESSAGING_SENDER_ID: '0',
      VITE_FIREBASE_APP_ID: 'demo-app',
    },
  })
  child.stderr.on('data', d => process.stderr.write(`[vite] ${d}`))
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    try { const r = await fetch(APP); if (r.ok) return child } catch { /* not up */ }
    await new Promise(r => setTimeout(r, 250))
  }
  child.kill('SIGKILL')
  throw new Error('vite did not start')
}

const gid = `sc-robotdrv-${Date.now()}`
// ⚠ A SHORT session on purpose — this proves the driver walks the whole flow, not that
// it can survive 200 clicks. 3 contracts x 4 periods keeps the run under a minute.
await putDoc(`scorecard_game_instances/${gid}/config/main`, {
  contracts: intVal(3), periods_per_contract: intVal(4), target_score: intVal(3),
  bonus: intVal(120), high_effort_cost: intVal(4), low_effort_cost: intVal(0),
  p_acceptable_low: dblVal(0.30), endowment_per_contract: intVal(50),
  show_target_reached_banner: boolVal(true), show_prior_contracts_panel: boolVal(true),
  show_running_balance: boolVal(true), show_reliability_label: boolVal(true),
  currency: strVal('ECU'),
})
await putDoc(`scorecard_game_instances/${gid}/truth/main`, {
  reliability_high: dblVal(0.70), reliability_low: dblVal(0.40),
  reliability_schedule: strVal('alternating'),
  label_high: strVal('High Reliability ({pct})'), label_low: strVal('Low Reliability ({pct})'),
  seed: strVal('robotdrv'),
})
console.log(`instance: ${gid}`)

let vite
let code = 1
try {
  vite = await startVite()
  code = await new Promise((resolve) => {
    const drv = spawn(process.execPath, [
      path.join(ROOT, 'bot', 'scorecard-robot-driver.mjs'),
      '--instance', gid, '--students', '7', '--pace', 'fast',
      '--emulator', '--app', APP, '--headless', '--exit-when-done',
    ], { stdio: 'inherit' })
    drv.on('exit', resolve)
  })
} finally {
  if (vite) vite.kill('SIGKILL')   // ⚠ T9
}

// Verify from the STORED docs that all seven actually completed the whole flow.
const list = await fetch(`${FIRESTORE}/scorecard_game_instances/${gid}/participants`,
  { headers: { Authorization: 'Bearer owner' } }).then(r => r.json())
const docs = list.documents ?? []
let ok = 0
console.log('\n  participant        contracts  finished  KC  noticing  linking')
console.log('  ' + '-'.repeat(62))
for (const d of docs) {
  const f = d.fields ?? {}
  const name = d.name.split('/').pop()
  const contracts = (f.contracts?.arrayValue?.values ?? []).length
  const finished = f.finished_at != null
  const kc = Object.keys(f.kc_answers?.mapValue?.fields ?? {}).length
  const ft = f.free_text_answers?.mapValue?.fields ?? {}
  const notice = ft.noticing != null
  const link = ft.linking != null
  if (contracts === 3 && finished && kc === 10 && notice && link) ok++
  console.log(`  ${name.padEnd(18)} ${String(contracts).padStart(9)} ${String(finished).padStart(9)} ${String(kc).padStart(3)} ${String(notice).padStart(9)} ${String(link).padStart(8)}`)
}
console.log('  ' + '-'.repeat(62))
console.log(`  ${ok}/${docs.length} robots completed the FULL flow (3 contracts, 10 KC answers, both free-text steps)`)
process.exit(ok === 7 && docs.length === 7 ? 0 : 1)
