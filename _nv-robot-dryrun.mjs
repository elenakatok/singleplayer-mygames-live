// Throwaway: boots vite, seeds a short newsvendor instance, and runs the SHIPPED
// robot driver headless against the emulator. Proves the driver drives the real UI.
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PROJECT = 'demo-singleplayer'
const FIRESTORE = `http://127.0.0.1:8090/v1/projects/${PROJECT}/databases/(default)/documents`
const ROOT = path.dirname(fileURLToPath(import.meta.url))
const VITE_PORT = 5196
const APP = `http://localhost:${VITE_PORT}`
const GID = `nv-robot-${Date.now()}`

const intVal = (n) => ({ integerValue: String(n) })
const boolVal = (b) => ({ booleanValue: b })
const strVal = (s) => ({ stringValue: s })

async function putDoc(p, fields) {
  const res = await fetch(`${FIRESTORE}/${p}`, {
    method: 'PATCH',
    headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields }),
  })
  if (!res.ok) throw new Error(`PATCH ${p} → ${res.status} ${await res.text()}`)
}

async function startVite() {
  const child = spawn('npx', ['vite', '--port', String(VITE_PORT), '--strictPort', '--host', '127.0.0.1'], {
    cwd: path.join(ROOT, 'frontend'), stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env,
      VITE_FIREBASE_API_KEY: 'demo-key', VITE_FIREBASE_AUTH_DOMAIN: 'localhost',
      VITE_FIREBASE_PROJECT_ID: PROJECT, VITE_FIREBASE_STORAGE_BUCKET: `${PROJECT}.appspot.com`,
      VITE_FIREBASE_MESSAGING_SENDER_ID: '0', VITE_FIREBASE_APP_ID: 'demo-app' },
  })
  const deadline = Date.now() + 60000
  while (Date.now() < deadline) {
    try { if ((await fetch(APP)).ok) return child } catch {}
    await new Promise(r => setTimeout(r, 250))
  }
  child.kill('SIGKILL'); throw new Error('vite did not start')
}

const vite = await startVite()
try {
  // A SHORT game (4 periods) — this proves the loop, not endurance. `periods` explicit.
  await putDoc(`newsvendor_game_instances/${GID}/config/main`, {
    price: intVal(3000), unit_cost: intVal(1000), salvage: intVal(800),
    goodwill: intVal(150), holding: intVal(300),
    is_normal: boolVal(true), mean: intVal(1000), sd: intVal(300),
    min_demand: intVal(0), max_demand: intVal(100), periods: intVal(4),
    ...(process.env.NV_DUAL === '1' ? { dual: boolVal(true), second_source_cost: intVal(2000) } : {}),
  })
  await putDoc(`newsvendor_game_instances/${GID}/truth/main`, { seed: strVal('robot-dryrun') })

  const driver = spawn('node', [
    path.join(ROOT, 'bot', 'newsvendor-robot-driver.mjs'),
    '--instance', GID, '--students', '4', '--pace', 'fast',
    '--emulator', '--app', APP, '--headless', '--exit-when-done',
  ], { stdio: 'inherit', cwd: path.join(ROOT, 'bot') })

  const code = await new Promise(r => driver.on('exit', r))
  console.log(`\nDRIVER EXIT CODE: ${code}`)
  console.log(`INSTANCE: ${GID}`)
  process.exitCode = code
} finally {
  vite.kill('SIGKILL')
}
