import { onRequest } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import { makeSinglePlayerBootstrap } from './shared/singlePlayerBootstrap'
import { makeSinglePlayerInstructorSession } from './shared/singlePlayerInstructorSession'
import { PENNIES_COLLECTION_PREFIX, PENNIES_CORS_ORIGINS } from './pennies/config'
import { POLL_COLLECTION_PREFIX, POLL_CORS_ORIGINS } from './poll/config'
import { PD_COLLECTION_PREFIX, PD_CORS_ORIGINS } from './pd/config'
import { PRICING_COLLECTION_PREFIX, PRICING_CORS_ORIGINS } from './pricing/config'
import { NEWSVENDOR_COLLECTION_PREFIX, NEWSVENDOR_CORS_ORIGINS } from './newsvendor/config'
import { FORECAST_COLLECTION_PREFIX, FORECAST_CORS_ORIGINS } from './forecast/config'

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

// ── Newsvendor (game_id: newsvendor) ──────────────────────────────────────────
//
// PART 1 — the REGULAR (single-source) game: prep → period loop → final results →
// knowledge check → debrief, participation scoring + the gradebook push, the
// instructor dashboard, all report tiers, and instructor settings.
//
// ⚠ DUAL SOURCING IS PART 2 and is NOT built. It is a per-instance config flag on
// this same game (never a second game_id, never a second set of callables), and
// newsvendorUpdateConfig refuses to set it until the branch exists.

export const newsvendorBootstrap = makeSinglePlayerBootstrap({
  collectionPrefix: NEWSVENDOR_COLLECTION_PREFIX,
  corsOrigins: NEWSVENDOR_CORS_ORIGINS,
})
export const newsvendorInstructorSession = makeSinglePlayerInstructorSession({
  corsOrigins: NEWSVENDOR_CORS_ORIGINS,
})

// Student.
export { newsvendorGetState } from './newsvendor/getState'
export { newsvendorSubmitRound } from './newsvendor/submitRound'
export { newsvendorGetQuestions } from './newsvendor/getQuestions'
export { newsvendorSubmitKcAnswer } from './newsvendor/submitKcAnswer'
export { newsvendorSubmitFreeText } from './newsvendor/submitFreeText'

// Instructor.
export { newsvendorSyncRoster } from './newsvendor/syncRoster'
export { newsvendorScoreAndRecord } from './newsvendor/scoreAndRecord'
export { newsvendorGetReport } from './newsvendor/report'
export { newsvendorGetConfig, newsvendorUpdateConfig } from './newsvendor/instructorConfig'

// ── Forecasting Game (game_id: forecast) ──────────────────────────────────────
//
// The student walks: KC → the month loop (forecast → compute → results) → final
// results → debrief. Demand for a month is drawn SERVER-SIDE AFTER that month's
// forecast is committed, in the same transaction (forecast/submitRound.ts).
//
// ⚠ THIS GAME'S CONFIG/TRUTH SPLIT IS THE INVERSE OF NEWSVENDOR'S. The demand model
// (a, b, H, σ, the high season) is the ANSWER, not a setting the student is shown, so
// it lives in the rules-denied truth/main alongside the seed — never in the
// student-readable config/main. See forecast/config.ts.

export const forecastBootstrap = makeSinglePlayerBootstrap({
  collectionPrefix: FORECAST_COLLECTION_PREFIX,
  corsOrigins: FORECAST_CORS_ORIGINS,
})
export const forecastInstructorSession = makeSinglePlayerInstructorSession({
  corsOrigins: FORECAST_CORS_ORIGINS,
})

// Student.
export { forecastGetState } from './forecast/getState'
export { forecastSubmitRound } from './forecast/submitRound'
export { forecastGetExport } from './forecast/getExport'

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
export const newsvendorHealth = makeHealth('newsvendor', NEWSVENDOR_CORS_ORIGINS)
export const forecastHealth = makeHealth('forecast', FORECAST_CORS_ORIGINS)
