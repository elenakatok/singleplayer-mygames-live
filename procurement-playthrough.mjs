// ═══════════════════════════════════════════════════════════════════════════════
// Procurement Auction (sealed) — emulator harness. Checkpoint 3a.
//
// It drives the SAME CALLABLES THE UI INVOKES — procurementBootstrap, GetState,
// SubmitBid — over HTTP. It never imports the compute functions and never calls them
// directly: a harness that imported resolveRound() would prove that resolveRound agrees
// with itself.
//
// ⚠⚠ §4 IS THE POINT OF THIS FILE. "The rival costs must not exist anywhere reachable
// before the bid is committed." That is asserted FROM THE OUTSIDE, three ways, none of
// which trusts a comment in the source:
//
//   §3  THE STORED DOC IS READ DIRECTLY, with owner credentials, immediately BEFORE the
//       bid for round t. If round t's rivals had been drawn early — at round start, in
//       getState, by a background write — they would be in that document. They are not.
//   §4  THE STUDENT CALLABLES ARE KEY-SET PINNED, recursively. Not value-scanned:
//       a value scan false-positives the moment a cost equals a bid, and it PASSES a
//       leaked cost that happens to collide with nothing. The key set is the contract.
//   §5  A RESUBMIT RETURNS BYTE-IDENTICAL RIVAL BIDS, which is what proves the draw
//       happened once. A second draw would be invisible to every other check here.
//
// ⚠ THE EQUILIBRIUM IS RE-IMPLEMENTED HERE, INDEPENDENTLY, from sealed §5.1's formula —
// the reserve-conditioned form, not the simple one. It is checked against the
// counterfactual the server returns on every round of every playthrough. Two routes to
// the same number.
//
// ⚠ NEGATIVE CONTROLS (§9 convention). Checks run against DELIBERATELY BROKEN
// expectations and REQUIRED TO FAIL. A test never seen to fail is not known to work.
//
// ⚠ EVERY INSTANCE THIS FILE CREATES SETS `rounds`, `reserve` AND BOTH COST RANGES
// EXPLICITLY. Never inherit a shipped default — a harness that does silently re-tunes
// itself the day someone edits the default.
//
// Run:  npm run harness:procurement
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

/** Runs a check that MUST FAIL, and fails the harness if it holds. */
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

/** ⚠ OWNER CREDENTIALS. This is how §3 sees what a student never can — the harness
 *  deliberately reads past the rules the client is bound by. */
async function getDoc(docPath) {
  const res = await fetch(`${FIRESTORE}/${docPath}`, { headers: { Authorization: 'Bearer owner' } })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`firestore GET ${docPath} → ${res.status}`)
  return (await res.json()).fields ?? {}
}

const intVal = (n) => ({ integerValue: String(n) })
const strVal = (s) => ({ stringValue: s })
const boolVal = (b) => ({ booleanValue: b })
const arrVal = (xs) => ({ arrayValue: { values: xs } })
const mapVal = (fields) => ({ mapValue: { fields } })
const asStudent = (gid, pid, extra = {}) => ({ _test: { participant_id: pid, game_instance_id: gid }, ...extra })

const distVal = (min, max) => mapVal({
  distribution: strVal('uniform'), min: intVal(min), max: intVal(max), integer: boolVal(true),
})

// ═══════════════════════════════════════════════════════════════════════════════
// The model — sealed §5.1 and §7, re-implemented independently. NOTHING below is
// imported from functions/src/procurement.
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * β(c), the reserve-conditioned equilibrium bid (sealed §5.1), written straight from the
 * spec's formula:
 *
 *        (θmax − c)ⁿ − (θmax − r)ⁿ
 *   β(c) = c + ─────────────────────────      for c ≤ r ;   NO BID for c > r
 *              n · (θmax − c)ⁿ⁻¹
 *
 * ⚠ THE SECOND NUMERATOR TERM IS NOT OPTIONAL. At r = θmax it vanishes and this
 * collapses to the simple form — which is exactly why a "simplification" survives the
 * default-reserve checks. The lowered-reserve instance below is what catches it.
 */
function beta(c, { rivalCostMax: tMax, reserve: r, totalBidders: n }) {
  if (c > r) return null
  if (c >= tMax) return c
  const num = Math.pow(tMax - c, n) - Math.pow(tMax - r, n)
  const den = n * Math.pow(tMax - c, n - 1)
  return c + num / den
}

/** How the server rounds β to a submittable bid. Derived, not asserted — see §2. */
const betaInt = (c, s) => {
  const b = beta(c, s)
  return b === null ? null : Math.round(b)
}

/** Sealed §7, steps 1–6, over a list of revealed bids. */
function resolveIndependently(bids, reserve) {
  const admissible = bids.filter(b => b.amount !== null && b.amount <= reserve)
  if (admissible.length === 0) return { price: null, winners: [] }
  const price = Math.min(...admissible.map(b => b.amount))
  return { price, winners: admissible.filter(b => b.amount === price) }
}

// ═══════════════════════════════════════════════════════════════════════════════
// §4 — the recursive key-set pins.
//
// ⚠ EXACT KEY SETS, RECURSIVELY, not a value scan. `rival_costs` and `rivalCosts` are
// both absent by construction; so is anything else nobody has thought of yet, because
// an unexpected key fails the pin rather than being ignored.
// ═══════════════════════════════════════════════════════════════════════════════

const GET_STATE_KEYS = [
  'ok', 'params', 'played', 'totalProfit', 'totalEquilibriumProfit', 'roundsWon',
  'roundsPlayed', 'currentRound', 'currentCost', 'phase', 'gameOver',
].sort()

const PARAMS_KEYS = [
  'format', 'rounds', 'rivalCount', 'totalBidders', 'reserve', 'rivalCostMin',
  'rivalCostMax', 'playerCostMin', 'playerCostMax', 'bidIncrementUnit', 'currencyLabel',
  'decrementSchedule', 'botDelayMs',
].sort()

const PLAYED_KEYS = ['round', 'yourCost', 'yourBid', 'won', 'price', 'profit', 'profitTotal'].sort()

const SUBMIT_KEYS = [
  'ok', 'nextRound', 'nextCost', 'round', 'history', 'totalProfit',
  'totalEquilibriumProfit', 'roundsWon', 'roundsPlayed', 'phase', 'gameOver',
].sort()

const RESULT_KEYS = [
  'round', 'yourCost', 'yourBid', 'bids', 'won', 'price', 'profit', 'profitTotal',
  'noAward', 'costAboveReserve', 'tie', 'tiedAndLost',
  'equilibriumBid', 'equilibriumWouldHaveWon', 'equilibriumProfit',
].sort()

const BID_LINE_KEYS = ['label', 'amount', 'isYou', 'won'].sort()

const keysOf = (o) => Object.keys(o).sort()
const sameKeys = (o, expected) => JSON.stringify(keysOf(o)) === JSON.stringify(expected)

function pinStateShape(state, label) {
  check(sameKeys(state, GET_STATE_KEYS), `${label}: getState key set is exactly the contract`)
  check(sameKeys(state.params, PARAMS_KEYS), `${label}: params key set is exactly the contract`)
  check(state.played.every(r => sameKeys(r, PLAYED_KEYS)),
    `${label}: every history row key set is exactly the contract`)
}

function pinSubmitShape(res, label) {
  check(sameKeys(res, SUBMIT_KEYS), `${label}: submitBid key set is exactly the contract`)
  check(sameKeys(res.round, RESULT_KEYS), `${label}: round-result key set is exactly the contract`)
  check(res.round.bids.every(b => sameKeys(b, BID_LINE_KEYS)),
    `${label}: every bid line key set is exactly the contract — no cost field`)
  check(res.history.every(r => sameKeys(r, PLAYED_KEYS)),
    `${label}: every history row key set is exactly the contract`)
}

// ── Instance setup ─────────────────────────────────────────────────────────────

let seq = 0
async function makeInstance({ rounds, reserve, rivalCount = 4, seed = null, format = 'sealed_first_price' }) {
  const gid = `proc-${++seq}-${Date.now()}`
  await putDoc(`procurement_game_instances/${gid}/config/main`, {
    format: strVal(format),
    rounds: intVal(rounds),
    rivalCount: intVal(rivalCount),
    reserve: intVal(reserve),
    rivalCostDist: distVal(10, 110),
    playerCostDist: distVal(10, 60),
    bidIncrementUnit: intVal(1),
    currencyLabel: strVal('ECU'),
    kcEnabled: boolVal(false),
    kcVisible: arrVal([]),
  })
  if (seed !== null) {
    await putDoc(`procurement_game_instances/${gid}/truth/main`, { seed: strVal(seed) })
  }
  return gid
}

const storedRounds = async (gid, pid) => {
  const d = await getDoc(`procurement_game_instances/${gid}/participants/${pid}`)
  return d?.rounds?.arrayValue?.values ?? []
}

// ═══════════════════════════════════════════════════════════════════════════════

async function main() {
  const RESERVE = 110
  const ROUNDS = 8

  // ── §1 launch and initial state ─────────────────────────────────────────────
  section('§1  Launch, and the state a student starts from')

  const gid = await makeInstance({ rounds: ROUNDS, reserve: RESERVE, seed: 'harness-seed-1' })
  const pid = 'student-a'

  const boot = await callFn('procurementBootstrap', asStudent(gid, pid))
  check(boot.ok, 'procurementBootstrap accepts the test launch')

  const s0 = (await callFn('procurementGetState', asStudent(gid, pid))).result
  pinStateShape(s0, 'fresh')
  check(s0.params.rounds === ROUNDS && s0.params.reserve === RESERVE,
    'the instance serves the config this harness wrote, not a default')
  check(s0.params.totalBidders === s0.params.rivalCount + 1,
    'totalBidders is derived, and the +1 is right')
  check(s0.roundsPlayed === 0 && s0.played.length === 0, 'no rounds played yet')
  check(s0.currentRound === 1, 'currentRound is 1')
  check(typeof s0.currentCost === 'number'
    && s0.currentCost >= s0.params.playerCostMin
    && s0.currentCost <= s0.params.playerCostMax,
    'the PLAYER\'s own cost for round 1 is served, inside the player range')
  check(s0.currentCost <= 60,
    '§5.2 the player draws from the NARROWER range — a cost above 60 would mean the rival range was used')
  check(s0.gameOver === false, 'the game is not over')

  // ⚠ THE COST IS DERIVED, NOT STORED. A reload must return the SAME number, and must
  // not have written anything to reserve it.
  const s0again = (await callFn('procurementGetState', asStudent(gid, pid))).result
  check(s0again.currentCost === s0.currentCost, 'reloading returns the same cost — no re-roll')
  check((await storedRounds(gid, pid)).length === 0,
    'reading the state wrote NOTHING to the participant doc')

  mustFail(() => s0.currentCost !== s0again.currentCost,
    'the cost changes on reload (it must not)')

  // ── §2 a full playthrough ───────────────────────────────────────────────────
  section('§2  Eight rounds, checked against an independent §5.1 / §7')

  const eq = {
    rivalCostMax: s0.params.rivalCostMax,
    reserve: s0.params.reserve,
    totalBidders: s0.params.totalBidders,
  }

  let expectedTotal = 0
  let expectedWins = 0
  let expectedBenchmark = 0
  let cost = s0.currentCost
  const played = []

  for (let t = 1; t <= ROUNDS; t++) {
    // ── §3 THE ORDERING INVARIANT, asserted from outside ──────────────────────
    // Read the participant doc with OWNER credentials immediately before the bid. If
    // round t's rivals had been drawn at round start, in getState, or by anything else,
    // they would be in this document now.
    const beforeDoc = await getDoc(`procurement_game_instances/${gid}/participants/${pid}`) ?? {}
    const before = beforeDoc.rounds?.arrayValue?.values ?? []
    check(before.length === t - 1,
      `§4 round ${t}: no resolved round t exists in storage before the bid is committed`)
    // ⚠ AND NOTHING ELSE ON THE DOC EITHER. Checking only the rounds array would miss a
    // "pending_rivals" scratch field written at round start, which is precisely the shape
    // §4 forbids. A KEY-NAME check, not a value scan: a stray 47 proves nothing, a key
    // called `rival_*` outside a resolved round proves everything.
    const strayRivalKeys = Object.keys(beforeDoc).filter(k => /rival|cost|bot|draw|seed/i.test(k))
    check(strayRivalKeys.length === 0,
      `§4 round ${t}: the participant doc holds no rival/cost/seed scratch field of any kind`)

    // A markup that is neither the equilibrium nor a round number, so a check that
    // accidentally compares the bid to β cannot pass by coincidence.
    const bid = Math.min(RESERVE, cost + 7 + (t % 3))

    const res = (await callFn('procurementSubmitBid', asStudent(gid, pid, { round: t, bid }))).result
    pinSubmitShape(res, `round ${t}`)

    const r = res.round
    check(r.round === t, `round ${t}: the card is for this round`)
    check(r.yourCost === cost, `round ${t}: the cost resolved against is the one that was shown`)
    check(r.yourBid === bid, `round ${t}: the bid is the one submitted`)

    // ── The resolver, independently (§7) ──────────────────────────────────────
    const mine = r.bids.find(b => b.isYou)
    check(mine !== undefined && mine.amount === bid, `round ${t}: the player's line carries their bid`)
    check(r.bids.length === s0.params.totalBidders,
      `round ${t}: every bidder has a line, including any priced out by the reserve`)

    const amounts = r.bids.map(b => b.amount).filter(a => a !== null)
    const sortedOk = r.bids.every((b, i, arr) =>
      i === 0 || b.amount === null || arr[i - 1].amount === null || arr[i - 1].amount <= b.amount)
    check(sortedOk, `round ${t}: bids are sorted ascending, with "no bid" last`)

    const indep = resolveIndependently(r.bids, RESERVE)
    check(r.price === indep.price, `round ${t}: the winning price is the lowest admissible bid`)
    check(r.noAward === (indep.price === null), `round ${t}: noAward agrees with there being no admissible bid`)
    check(r.bids.filter(b => b.won).length === (indep.price === null ? 0 : 1),
      `round ${t}: exactly one winner is marked`)
    check(r.won === (mine.won === true), `round ${t}: the player's win flag and their line agree`)

    const expectedProfit = r.won ? bid - cost : 0
    check(r.profit === expectedProfit,
      `round ${t}: first price — the winner is paid their OWN bid, so profit is bid − cost`)

    check(r.tie === (indep.winners.length > 1), `round ${t}: the tie flag agrees with the bid list`)
    check(r.tiedAndLost === (r.tie && !r.won && mine.amount === r.price),
      `round ${t}: tiedAndLost fires only when the player matched the winning price and lost`)

    // ── §5.1, independently ───────────────────────────────────────────────────
    check(r.equilibriumBid === betaInt(cost, eq),
      `round ${t}: the counterfactual bid is β(cost) from the spec's own formula`)
    check(r.costAboveReserve === (cost > RESERVE),
      `round ${t}: costAboveReserve reflects the player's own cost against the reserve`)

    if (r.equilibriumBid !== null) {
      // β against the SAME realized rival bids. The player's own line is replaced.
      const hypo = resolveIndependently(
        [{ amount: r.equilibriumBid, isYou: true },
         ...r.bids.filter(b => !b.isYou)],
        RESERVE,
      )
      const couldWin = hypo.winners.some(w => w.isYou)
      // A tie β could have lost is the one case the two routes may legitimately differ;
      // the player is nominated, so β wins any tie it is in, and so must this.
      check(r.equilibriumWouldHaveWon === couldWin,
        `round ${t}: the counterfactual outcome agrees with β against these same rivals`)
      check(r.equilibriumProfit === (couldWin ? r.equilibriumBid - cost : 0),
        `round ${t}: the counterfactual profit is β − cost when it wins, else zero`)
    }

    expectedTotal += r.profit
    expectedWins += r.won ? 1 : 0
    expectedBenchmark += r.equilibriumProfit
    played.push({ t, bid, cost, price: r.price, won: r.won, profit: r.profit })

    check(r.profitTotal === expectedTotal, `round ${t}: the running total is the sum of the rounds`)
    check(res.totalProfit === expectedTotal, `round ${t}: the response's total agrees with the card`)
    check(res.totalEquilibriumProfit === expectedBenchmark,
      `round ${t}: the §9 benchmark accumulates β's profit, not the player's`)
    check(res.roundsWon === expectedWins, `round ${t}: roundsWon agrees`)
    check(res.roundsPlayed === t, `round ${t}: roundsPlayed agrees`)
    check(res.history.length === t, `round ${t}: the whole history comes back every time`)

    const last = t === ROUNDS
    check(res.gameOver === last, `round ${t}: gameOver is ${last}`)
    check(res.nextRound === (last ? null : t + 1), `round ${t}: nextRound is right`)
    check(last ? res.nextCost === null : typeof res.nextCost === 'number',
      `round ${t}: the next cost ships with the round — and NOT after the last one`)

    if (!last) cost = res.nextCost
  }

  check(expectedBenchmark !== expectedTotal || expectedTotal === 0,
    '§9 the benchmark is genuinely a different number from the realized total')

  // ── §3 what the doc holds, and what the student never sees ──────────────────
  section('§3  The stored record carries the rival costs — and only the server reads it')

  const docRounds = await storedRounds(gid, pid)
  check(docRounds.length === ROUNDS, 'all eight rounds are stored')
  const r1 = docRounds[0].mapValue.fields
  check((r1.rival_costs?.arrayValue?.values ?? []).length === 4,
    'the stored round DOES carry the four rival costs — the reports need them')
  check(r1.played_at?.timestampValue !== undefined,
    'played_at is a concrete Timestamp inside the array element, not a rejected sentinel')

  const finalState = (await callFn('procurementGetState', asStudent(gid, pid))).result
  pinStateShape(finalState, 'finished')
  check(finalState.currentRound === null && finalState.currentCost === null,
    'a finished student is handed no ninth cost')
  check(finalState.gameOver === true, 'the finished student is past play')
  check(finalState.totalProfit === expectedTotal, 'the reloaded total matches the playthrough')

  // The pins above are the leak defence. This is their negative control: the exact same
  // pin, run against a key set that OMITS a field the response really does carry.
  mustFail(() => sameKeys(finalState, GET_STATE_KEYS.filter(k => k !== 'phase')),
    'the key-set pin holds against a deliberately wrong key set')

  // ── §5 submit and lock ──────────────────────────────────────────────────────
  section('§5  Submit and lock — a resubmit draws nothing')

  const gid2 = await makeInstance({ rounds: 4, reserve: RESERVE, seed: 'harness-seed-2' })
  const pid2 = 'student-b'
  await callFn('procurementBootstrap', asStudent(gid2, pid2))
  const b0 = (await callFn('procurementGetState', asStudent(gid2, pid2))).result

  const first = (await callFn('procurementSubmitBid',
    asStudent(gid2, pid2, { round: 1, bid: b0.currentCost + 12 }))).result
  const firstBids = JSON.stringify(first.round.bids)

  // ⚠ A DIFFERENT BID, deliberately. If the resubmit were honoured at all, the stored
  // round would change; if it re-drew, the rival bids would change. Both are visible.
  const againCall = await callFn('procurementSubmitBid',
    asStudent(gid2, pid2, { round: 1, bid: b0.currentCost + 40 }))
  // ⚠ A RESUBMIT MUST SUCCEED AND RETURN THE STORED ROUND — it must not error. Asserted
  // separately so that a build where the resubmit falls through to the out-of-step guard
  // reports as a named failure here rather than crashing four lines later on `.round`.
  check(againCall.ok, 'a resubmit SUCCEEDS — it returns the stored round rather than erroring')
  const again = againCall.result ?? { round: {}, roundsPlayed: -1 }
  check(again.round.yourBid === first.round.yourBid,
    'a resubmit is DISCARDED — the stored bid is returned, not the new one')
  check(JSON.stringify(again.round.bids) === firstBids,
    'the rival bids are byte-identical — the resubmit triggered NO second draw')
  check(again.roundsPlayed === 1, 'the resubmit did not append a second round')
  check((await storedRounds(gid2, pid2)).length === 1, 'and it wrote no second round to the doc')

  mustFail(() => again.round.yourBid === b0.currentCost + 40,
    'the resubmitted bid was accepted (it must not be)')

  // ── §6 ordering, skipping, and the end ──────────────────────────────────────
  section('§6  Rounds go in order, one at a time')

  const skip = await callFn('procurementSubmitBid', asStudent(gid2, pid2, { round: 4, bid: 50 }))
  check(!skip.ok && /not the round you are on/i.test(skip.error ?? ''),
    'skipping ahead is refused with a reason a student can act on')
  check((await storedRounds(gid2, pid2)).length === 1, 'and the refused skip wrote nothing')

  const noRound = await callFn('procurementSubmitBid', asStudent(gid2, pid2, { bid: 50 }))
  check(!noRound.ok, 'a submit with no round number is refused')

  // Finish the instance so the past-the-end branch is reachable.
  let c2 = (await callFn('procurementGetState', asStudent(gid2, pid2))).result.currentCost
  for (let t = 2; t <= 4; t++) {
    const r = (await callFn('procurementSubmitBid', asStudent(gid2, pid2, { round: t, bid: Math.min(RESERVE, c2 + 10) }))).result
    c2 = r.nextCost
  }
  const past = await callFn('procurementSubmitBid', asStudent(gid2, pid2, { round: 5, bid: 50 }))
  check(!past.ok && /no more rounds/i.test(past.error ?? ''),
    'a ninth bid on an eight-round game is refused')

  // ── §7 the reserve gate ─────────────────────────────────────────────────────
  section('§7  The reserve is a VISIBLE validation gate, and it costs no draw')

  const gid3 = await makeInstance({ rounds: 3, reserve: 90, seed: 'harness-seed-3' })
  const pid3 = 'student-c'
  await callFn('procurementBootstrap', asStudent(gid3, pid3))
  const c3 = (await callFn('procurementGetState', asStudent(gid3, pid3))).result

  const over = await callFn('procurementSubmitBid', asStudent(gid3, pid3, { round: 1, bid: 91 }))
  check(!over.ok, 'a bid above the reserve is refused')
  check(/above the reserve price of 90 will not be accepted/i.test(over.error ?? ''),
    'and the message is the spec\'s own §6.2 wording, naming the number')
  check((await storedRounds(gid3, pid3)).length === 0,
    '⚠ the refused bid consumed NO round and, more importantly, NO DRAW')
  check((await callFn('procurementGetState', asStudent(gid3, pid3))).result.currentCost === c3.currentCost,
    'and the student\'s cost is unchanged — a rejected bid is not a re-roll')

  const atReserve = await callFn('procurementSubmitBid', asStudent(gid3, pid3, { round: 1, bid: 90 }))
  check(atReserve.ok, 'a bid exactly AT the reserve is admissible — the bound is inclusive')

  const decimal = await callFn('procurementSubmitBid', asStudent(gid3, pid3, { round: 2, bid: 45.5 }))
  check(!decimal.ok && /whole ECU|decimals/i.test(decimal.error ?? ''), 'a decimal bid is refused')

  const negative = await callFn('procurementSubmitBid', asStudent(gid3, pid3, { round: 2, bid: -5 }))
  check(!negative.ok, 'a negative bid is refused')

  // ⚠ BELOW YOUR OWN COST IS LEGAL (§6.2) and must NOT be gated. This is the check that
  // stops a future "helpful" floor being added.
  const s3 = (await callFn('procurementGetState', asStudent(gid3, pid3))).result
  const below = await callFn('procurementSubmitBid',
    asStudent(gid3, pid3, { round: 2, bid: Math.max(0, s3.currentCost - 5) }))
  check(below.ok, 'a bid BELOW the player\'s own cost is accepted — losing money is legal (§6.2)')
  if (below.ok && below.result.round.won) {
    check(below.result.round.profit < 0, 'and winning with it produces a genuine loss')
  }

  // ── §8 the lowered reserve, and β's second term ─────────────────────────────
  section('§8  A lowered reserve — where the simple β diverges')

  const gid4 = await makeInstance({ rounds: 2, reserve: 70, seed: 'harness-seed-4' })
  const pid4 = 'student-d'
  await callFn('procurementBootstrap', asStudent(gid4, pid4))
  const s4 = (await callFn('procurementGetState', asStudent(gid4, pid4))).result
  const eq4 = { rivalCostMax: 110, reserve: 70, totalBidders: s4.params.totalBidders }

  const r4 = (await callFn('procurementSubmitBid',
    asStudent(gid4, pid4, { round: 1, bid: Math.min(70, s4.currentCost + 8) }))).result.round

  check(r4.equilibriumBid === betaInt(s4.currentCost, eq4),
    '⚠ at r < θmax the counterfactual matches the RESERVE-CONDITIONED β — the load-bearing check')

  // The negative control that gives the line above its meaning: the SIMPLE form, which
  // is what a "simplification" would leave behind. It must NOT match here.
  const simple = Math.round(s4.currentCost + (110 - s4.currentCost) / eq4.totalBidders)
  mustFail(() => r4.equilibriumBid === simple,
    'the simple β also matches at a lowered reserve (it must not — that is the divergence)')

  check(r4.bids.filter(b => !b.isYou).every(b => b.amount === null || b.amount <= 70),
    'no rival bid exceeds the reserve — a priced-out rival is ABSENT, not bidding high')

  // ── §9 the open format is refused, not silently resolved ───────────────────
  section('§9  An open-format instance is refused by the sealed callable')

  const gid5 = await makeInstance({ rounds: 2, reserve: RESERVE, format: 'open_descending' })
  const pid5 = 'student-e'
  await callFn('procurementBootstrap', asStudent(gid5, pid5))
  const open = await callFn('procurementSubmitBid', asStudent(gid5, pid5, { round: 1, bid: 50 }))
  check(!open.ok && /open-bid format/i.test(open.error ?? ''),
    'the sealed mechanism refuses to resolve an open instance')
  check((await storedRounds(gid5, pid5)).length === 0, 'and it wrote nothing')

  // ── §10 two students, one seed ──────────────────────────────────────────────
  section('§10  Determinism is per student, not per instance')

  const gidS = await makeInstance({ rounds: 2, reserve: RESERVE, seed: 'shared-seed' })
  await callFn('procurementBootstrap', asStudent(gidS, 'x'))
  await callFn('procurementBootstrap', asStudent(gidS, 'y'))
  const sx = (await callFn('procurementGetState', asStudent(gidS, 'x'))).result
  const sy = (await callFn('procurementGetState', asStudent(gidS, 'y'))).result
  // ⚠ NOT "their costs differ". Two students colliding on one integer out of 51 proves
  // nothing either way, and a check that reads as an independence test but passes 98% of
  // the time on a coin flip is exactly the failure BUILD_NOTES §3 records.
  //
  // The assertion that IS decidable: one student re-derives their own draws identically
  // (that is what the seed is for), and the two students' RIVAL VECTORS — four integers
  // out of 101 each, asserted across every student in the loop below — do not coincide.
  const sx2 = (await callFn('procurementGetState', asStudent(gidS, 'x'))).result
  check(sx2.currentCost === sx.currentCost, 'one student re-derives their own cost identically')

  const vectors = []
  for (const who of ['x', 'y', 'z', 'w', 'v', 'u']) {
    await callFn('procurementBootstrap', asStudent(gidS, who))
    const st = (await callFn('procurementGetState', asStudent(gidS, who))).result
    const rr = (await callFn('procurementSubmitBid',
      asStudent(gidS, who, { round: 1, bid: Math.min(RESERVE, st.currentCost + 9) }))).result
    vectors.push(JSON.stringify(rr.round.bids.filter(b => !b.isYou).map(b => b.amount).sort()))
  }
  check(new Set(vectors).size === vectors.length,
    'six students under ONE seed each face a distinct rival vector — the stream is keyed per student')

  mustFail(() => new Set(vectors).size === 1,
    'all six students share one rival vector (they must not — that would be an instance-wide draw)')

  // ═══════════════════════════════════════════════════════════════════════════
  console.log(`\n${'═'.repeat(70)}`)
  console.log(`  ${passed} passed, ${failed} failed`)
  console.log('═'.repeat(70))
  if (failed > 0) process.exit(1)
}

main().catch(err => {
  console.error('\nHARNESS ERROR:', err)
  process.exit(1)
})
