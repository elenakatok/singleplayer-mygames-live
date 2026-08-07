// Screenshot the Pricing INSTRUCTOR surfaces (audit, read-only).
// Boots vite dev like pricing-playwright.mjs, seeds a mixed population, shoots screens.
import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import path from 'node:path'

const PROJECT = 'demo-singleplayer'
const FUNCTIONS = `http://127.0.0.1:5010/${PROJECT}/us-central1`
const FIRESTORE = `http://127.0.0.1:8090/v1/projects/${PROJECT}/databases/(default)/documents`
const ROOT = '/Users/emk120030/projects/games-platform/games/singleplayer'
const OUT = '/private/tmp/claude-502/-Users-emk120030-projects-games-platform/199154c2-a8e9-48fb-806b-64d88857f33b/scratchpad/shots'
const VITE_PORT = 5199
const APP = `http://localhost:${VITE_PORT}`

async function callFn(name, data) {
  const res = await fetch(`${FUNCTIONS}/${name}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data }),
  })
  let body = null
  try { body = await res.json() } catch {}
  if (res.ok && body && 'result' in body) return { ok: true, result: body.result }
  return { ok: false, error: body?.error?.message ?? `http ${res.status}` }
}
async function putDoc(docPath, fields) {
  const res = await fetch(`${FIRESTORE}/${docPath}`, {
    method: 'PATCH', headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields }),
  })
  if (!res.ok) throw new Error(`PATCH ${docPath} → ${res.status} ${await res.text()}`)
}
async function getDoc(docPath) {
  const res = await fetch(`${FIRESTORE}/${docPath}`, { headers: { Authorization: 'Bearer owner' } })
  if (res.status === 404) return null
  return (await res.json()).fields ?? {}
}
const strVal = (s) => ({ stringValue: s })
const boolVal = (b) => ({ booleanValue: b })
const asStudent = (gid, pid, extra = {}) => ({ _test: { participant_id: pid, game_instance_id: gid }, ...extra })

async function startVite() {
  const child = spawn('npx', ['vite', '--port', String(VITE_PORT), '--strictPort', '--host', '127.0.0.1'], {
    cwd: path.join(ROOT, 'frontend'), stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env,
      VITE_FIREBASE_API_KEY: 'demo-key', VITE_FIREBASE_AUTH_DOMAIN: 'localhost',
      VITE_FIREBASE_PROJECT_ID: PROJECT, VITE_FIREBASE_STORAGE_BUCKET: `${PROJECT}.appspot.com`,
      VITE_FIREBASE_MESSAGING_SENDER_ID: '0', VITE_FIREBASE_APP_ID: 'demo-app' },
  })
  child.stderr.on('data', d => process.stderr.write(`[vite] ${d}`))
  const deadline = Date.now() + 60000
  while (Date.now() < deadline) {
    try { const r = await fetch(APP); if (r.ok) return child } catch {}
    await new Promise(r => setTimeout(r, 250))
  }
  child.kill('SIGKILL'); throw new Error('vite did not start')
}

const stamp = Date.now()
const GID = `audit-${stamp}`

async function seedStudent(gid, pid, name, rounds, priceFor) {
  await putDoc(`pricing_game_instances/${gid}/participants/${pid}`, {
    participant_id: strVal(pid), game_instance_id: strVal(gid), name: strVal(name),
  })
  await callFn('pricingBootstrap', asStudent(gid, pid))
  const served = await callFn('pricingGetQuestions', asStudent(gid, pid))
  for (const q of [...served.result.kc.derived, ...served.result.kc.added]) {
    await callFn('pricingSubmitKcAnswer', asStudent(gid, pid, { field: q.field, answer: q.options[0].value }))
  }
  for (let n = 1; n <= rounds; n++) {
    const res = await callFn('pricingSubmitPrice', asStudent(gid, pid, { round: n, price: priceFor(n) }))
    if (!res.ok) break
  }
  await callFn('pricingSubmitDebrief', asStudent(gid, pid, {
    answer: `I started high to test the competitor, then settled near the middle of the grid. ${name}.`,
  }))
}

async function main() {
  const vite = await startVite()
  const browser = await chromium.launch({})
  try {
    await putDoc(`pricing_game_instances/${GID}/config/main`, { seed: strVal('audit-seed'), pmg: boolVal(false) })
    await callFn('pricingBootstrap', asStudent(GID, 'stu-fin'))
    const truth = await getDoc(`pricing_game_instances/${GID}/truth/participant_stu-fin`)
    const horizon = Number(truth?.rounds?.integerValue)
    console.log('finisher horizon =', horizon)
    await seedStudent(GID, 'stu-fin', 'Ada Finisher', horizon, n => 1200 + (n % 3) * 200)
    await seedStudent(GID, 'stu-mid', 'Bo Midgame', 4, () => 1800)
    await putDoc(`pricing_game_instances/${GID}/participants/stu-never`, {
      participant_id: strVal('stu-never'), game_instance_id: strVal(GID), name: strVal('Cy Neverstarted'),
    })

    const ctx = await browser.newContext({ viewport: { width: 1280, height: 1600 } })
    const page = await ctx.newPage()
    const url = (p) => `${APP}${p}?game=pricing&_gid=${GID}`

    await page.goto(url('/dashboard'))
    await page.waitForSelector('[data-testid="pricing-roster"]', { timeout: 30000 })
    await page.waitForTimeout(1200)
    await page.screenshot({ path: `${OUT}/01-dashboard.png`, fullPage: true })

    await page.goto(url('/reports'))
    await page.waitForSelector('[data-testid="pricing-mode-header"]', { timeout: 30000 })
    await page.waitForTimeout(1500)
    await page.screenshot({ path: `${OUT}/02-reports-board.png`, fullPage: true })

    await page.click('text=Outcomes — all students')
    await page.waitForSelector('[data-testid="pricing-report-outcomes"]', { timeout: 15000 })
    await page.waitForTimeout(600)
    await page.screenshot({ path: `${OUT}/03-reports-tier1.png` })
    await page.keyboard.press('Escape').catch(() => {})
    await page.goto(url('/reports')); await page.waitForTimeout(1200)

    await page.click('text=Debrief paragraphs')
    await page.waitForSelector('[data-testid="pricing-report-debrief"]', { timeout: 15000 })
    await page.waitForTimeout(600)
    await page.screenshot({ path: `${OUT}/04-reports-tier2.png` })
    await page.goto(url('/reports')); await page.waitForTimeout(1200)

    await page.click('text=Average price and profit by round')
    await page.waitForSelector('[data-testid="pricing-price-chart"]', { timeout: 15000 })
    await page.waitForTimeout(800)
    await page.screenshot({ path: `${OUT}/05-reports-tier3.png` })

    await page.goto(url('/settings'))
    await page.waitForTimeout(2500)
    await page.screenshot({ path: `${OUT}/06-settings.png`, fullPage: true })

    // Score & Record, then re-shoot the dashboard action bar
    await page.goto(url('/dashboard'))
    await page.waitForSelector('[data-testid="pricing-score-and-record"]', { timeout: 30000 })
    await page.click('[data-testid="pricing-score-and-record"]')
    await page.waitForTimeout(4000)
    await page.screenshot({ path: `${OUT}/07-dashboard-after-score.png`, fullPage: true })

    console.log('SHOTS DONE')
  } finally {
    await browser.close()
    vite.kill('SIGKILL')
  }
}
main().catch(e => { console.error(e); process.exit(1) })
