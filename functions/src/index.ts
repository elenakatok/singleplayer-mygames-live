import { onRequest } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import { makeSinglePlayerBootstrap } from './shared/singlePlayerBootstrap'
import { makeSinglePlayerInstructorSession } from './shared/singlePlayerInstructorSession'
import { PENNIES_COLLECTION_PREFIX, PENNIES_CORS_ORIGINS } from './pennies/config'
import { POLL_COLLECTION_PREFIX, POLL_CORS_ORIGINS } from './poll/config'
import { PD_COLLECTION_PREFIX, PD_CORS_ORIGINS } from './pd/config'
import { PRICING_COLLECTION_PREFIX, PRICING_CORS_ORIGINS } from './pricing/config'

admin.initializeApp()

// ═══════════════════════════════════════════════════════════════════════════════
// Function exports — ONE Firebase project hosts several single-player games, so
// every function is named PER GAME (never a generic dispatcher, which would also
// collide across games in a shared project). Deploy scoped by name only — NEVER
// `--only functions` (see README "Deploy discipline"): a blanket deploy would mint
// revisions for every game and risk the Cloud Run CPU-quota pileup.
// ═══════════════════════════════════════════════════════════════════════════════

// ── Jar of Pennies (game_id: pennies) ─────────────────────────────────────────

// Launch / session exchange.
export const penniesBootstrap = makeSinglePlayerBootstrap({
  collectionPrefix: PENNIES_COLLECTION_PREFIX,
  corsOrigins: PENNIES_CORS_ORIGINS,
})
export const penniesInstructorSession = makeSinglePlayerInstructorSession({
  corsOrigins: PENNIES_CORS_ORIGINS,
})

// Student.
export { penniesGetScreen } from './pennies/getScreen'
export { penniesSubmit } from './pennies/submit'

// Instructor.
export { penniesGetConfig, penniesUpdateConfig } from './pennies/instructorConfig'
export { penniesSyncRoster } from './pennies/syncRoster'
export { penniesScoreAndRecord } from './pennies/scoreAndRecord'
export { penniesGetReport } from './pennies/report'

// ── Poll (game_id: poll) — entirely ungraded; NO scoreAndRecord, NO gradebook push ──

export const pollBootstrap = makeSinglePlayerBootstrap({
  collectionPrefix: POLL_COLLECTION_PREFIX,
  corsOrigins: POLL_CORS_ORIGINS,
})
export const pollInstructorSession = makeSinglePlayerInstructorSession({
  corsOrigins: POLL_CORS_ORIGINS,
})

// Student.
export { pollGetQuestions } from './poll/getQuestions'
export { pollSubmitAnswer } from './poll/submitAnswer'

// Instructor.
export { pollGetConfig, pollUpdateConfig } from './poll/instructorConfig'
export { pollSyncRoster } from './poll/syncRoster'
export { pollGetReport } from './poll/report'

// ── Repeated Prisoner's Dilemma (game_id: pd) ─────────────────────────────────
//
// SLICE 3 — the complete student flow: KC → round loop → debrief, plus
// participation scoring and the gradebook push. The reports arrive in Slice 4.

export const pdBootstrap = makeSinglePlayerBootstrap({
  collectionPrefix: PD_COLLECTION_PREFIX,
  corsOrigins: PD_CORS_ORIGINS,
})
export const pdInstructorSession = makeSinglePlayerInstructorSession({
  corsOrigins: PD_CORS_ORIGINS,
})

// Student.
export { pdGetState } from './pd/getState'
export { pdSubmitRound } from './pd/submitRound'
export { pdGetQuestions } from './pd/getQuestions'
export { pdSubmitKcAnswer } from './pd/submitKcAnswer'
export { pdSubmitDebrief } from './pd/submitDebrief'

// Instructor.
export { pdSyncRoster } from './pd/syncRoster'
export { pdScoreAndRecord } from './pd/scoreAndRecord'
export { pdGetReport } from './pd/report'
export { pdGetConfig, pdUpdateConfig } from './pd/instructorConfig'

// ── Pricing Game / Cheyenne Shipping (game_id: pricing) ───────────────────────
//
// SLICE 4 — feature-complete bar instructor settings: (PMG rules →) KC → round loop
// → debrief, participation scoring + the gradebook push, and the instructor dashboard
// + all three report tiers. One game, TWO course instances (Standard / PMG)
// distinguished by a per-instance config flag, so there is exactly ONE set of
// callables here — never a second game_id, and never a second set of names to deploy.

export const pricingBootstrap = makeSinglePlayerBootstrap({
  collectionPrefix: PRICING_COLLECTION_PREFIX,
  corsOrigins: PRICING_CORS_ORIGINS,
})
export const pricingInstructorSession = makeSinglePlayerInstructorSession({
  corsOrigins: PRICING_CORS_ORIGINS,
})

// Student.
export { pricingGetState } from './pricing/getState'
export { pricingSubmitPrice } from './pricing/submitPrice'
export { pricingGetQuestions } from './pricing/getQuestions'
export { pricingSubmitKcAnswer } from './pricing/submitKcAnswer'
export { pricingSubmitDebrief } from './pricing/submitDebrief'

// Instructor.
export { pricingSyncRoster } from './pricing/syncRoster'
export { pricingScoreAndRecord } from './pricing/scoreAndRecord'
export { pricingGetReport } from './pricing/report'
export { pricingGetConfig, pricingUpdateConfig } from './pricing/instructorConfig'

// ── Health probes (onRequest; not game endpoints) ─────────────────────────────

function makeHealth(game: string, origins: string[]) {
  const allow = new Set(origins)
  return onRequest((req, res) => {
    const origin = req.headers.origin ?? ''
    if (allow.has(origin)) {
      res.set('Access-Control-Allow-Origin', origin)
      res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
      res.set('Vary', 'Origin')
    }
    if (req.method === 'OPTIONS') { res.status(204).send(''); return }
    res.json({ ok: true, game })
  })
}

export const penniesHealth = makeHealth('pennies', PENNIES_CORS_ORIGINS)
export const pollHealth = makeHealth('poll', POLL_CORS_ORIGINS)
export const pdHealth = makeHealth('pd', PD_CORS_ORIGINS)
export const pricingHealth = makeHealth('pricing', PRICING_CORS_ORIGINS)
