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
import { PROCUREMENT_COLLECTION_PREFIX, PROCUREMENT_CORS_ORIGINS } from './procurement/config'
import { SCORECARD_COLLECTION_PREFIX, SCORECARD_CORS_ORIGINS } from './scorecard/config'
import { buildStamp } from './buildInfo'

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
export { forecastGetQuestions } from './forecast/getQuestions'
export { forecastSubmitKcAnswer } from './forecast/submitKcAnswer'
export { forecastSubmitDebrief } from './forecast/submitDebrief'
// ⚠ The ONLY student callables that carry the demand model, and both are behind the
// same gate (forecast/reveal.ts): the game must be over AND the debrief behind them.
export { forecastGetReveal } from './forecast/getReveal'

// Instructor.
export { forecastSyncRoster } from './forecast/syncRoster'
export { forecastScoreAndRecord } from './forecast/scoreAndRecord'
export { forecastGetReport } from './forecast/report'
export { forecastGetConfig, forecastUpdateConfig } from './forecast/instructorConfig'

// ── Procurement Auction (game_id: procurement) ────────────────────────────────
//
// ⚠⚠ `procurementResolveRound` IS GONE (CP4a). It was a declared, throwing stub reserved
// for the open format. The open format turned out to need TWO callables rather than one —
// `procurementAdvance` (commit one bot bid) and `procurementDropOut` — while the player's
// own bid routes through `procurementSubmitBid` like the sealed format's, so a single
// "resolve" verb never fitted. The old function stays DEPLOYED and harmless until
// somebody deletes it; nothing calls it.
//
// ⚠ ONE GAME, TWO FORMATS, ONE game_id. `format` (sealed_first_price | open_descending)
// is INSTANCE CONFIG — never a second game_id and never a second set of callables. Same
// structure as pricing's Standard/PMG pair and newsvendor's regular/dual flag. There is
// exactly ONE set of names below to deploy, and it serves both instances.
//
// ⚠ `format` LOCKS on the first submission (procurement/instructorConfig.ts): rounds
// resolved under two mechanisms in one result set would be incoherent.

export const procurementBootstrap = makeSinglePlayerBootstrap({
  collectionPrefix: PROCUREMENT_COLLECTION_PREFIX,
  corsOrigins: PROCUREMENT_CORS_ORIGINS,
})
export const procurementInstructorSession = makeSinglePlayerInstructorSession({
  corsOrigins: PROCUREMENT_CORS_ORIGINS,
})

// Student.
export { procurementGetState } from './procurement/getState'
// ⚠ ONE bid callable for BOTH formats. Sealed resolves the whole round in its
// transaction; open commits one bid into a live auction (procurement/openPlay.ts).
export { procurementSubmitBid } from './procurement/submitBid'
// ⚠ OPEN FORMAT ONLY. `procurementAdvance` is the client's tick — it commits AT MOST ONE
// bot bid and checks the due time itself, so the client controls only WHEN to ask
// (open §4.6). `procurementDropOut` exists here and only here (open §4.5).
export { procurementAdvance, procurementDropOut } from './procurement/openPlay'
export { procurementGetQuestions } from './procurement/getQuestions'
export { procurementSubmitKcAnswer } from './procurement/submitKcAnswer'
// ⚠ ONE callable for BOTH open-response paragraphs (prep and debrief), routed by the
// question's own `stage` tag. They differ only in when they may be answered.
export { procurementSubmitFreeText } from './procurement/submitFreeText'

// Instructor.
export { procurementSyncRoster } from './procurement/syncRoster'
export { procurementScoreAndRecord } from './procurement/scoreAndRecord'
export { procurementGetReport } from './procurement/report'
export { procurementGetConfig, procurementUpdateConfig } from './procurement/instructorConfig'

// ── Metalcraft Supplier Scorecard (game_id: scorecard) ────────────────────────
//
// The student is the SUPPLIER being rated. They work `contracts` contracts of
// `periodsPerContract` periods, choosing High or Low effort each period; reliability —
// P(acceptable | high effort) — ALTERNATES contract by contract between two values, with
// half the roster starting high (spec §2.2).
//
// ⚠⚠ THE FAMILY'S FIRST TWO-LEVEL LOOP:
//   loop(contracts) { contract-start → loop(periods){ effort → compute } → contract-result }
// Bespoke, NOT a generalised primitive (spec §14.2) — contracts are independent of each
// other, which satisfies architecture §2.4, but periods within a contract are not.
//
// ⚠ THE CONFIG/TRUTH SPLIT IS ABOUT THE EXPERIMENTAL DESIGN, not the economics. Almost
// every number is printed on the student's screen and must be (spec §8); what is withheld
// is that reliability alternates, that there are exactly two conditions, and the
// counterbalancing. So BOTH reliabilities and BOTH labels live in truth/main even though
// one of each is on screen at all times. See scorecard/config.ts.
//
// ⚠ `scorecardGetState({ advance: true })` is the contract boundary. It is a GATED read —
// honoured only at contract-result — so the next contract's reliability never exists in
// the payload, or in the database, before that contract starts (spec §13).

export const scorecardBootstrap = makeSinglePlayerBootstrap({
  collectionPrefix: SCORECARD_COLLECTION_PREFIX,
  corsOrigins: SCORECARD_CORS_ORIGINS,
})
export const scorecardInstructorSession = makeSinglePlayerInstructorSession({
  corsOrigins: SCORECARD_CORS_ORIGINS,
})

// Student.
export { scorecardGetState } from './scorecard/getState'
export { scorecardSubmitPeriod } from './scorecard/submitPeriod'
export { scorecardGetQuestions } from './scorecard/getQuestions'
export { scorecardSubmitKcAnswer } from './scorecard/submitKcAnswer'
// ⚠ The ONLY path that returns the reveal, and it is gated on the stored finish stamp.
export { scorecardSubmitDebrief } from './scorecard/submitDebrief'

// Instructor.
export { scorecardSyncRoster } from './scorecard/syncRoster'
export { scorecardScoreAndRecord } from './scorecard/scoreAndRecord'
export { scorecardGetReport } from './scorecard/report'
export { scorecardGetConfig, scorecardUpdateConfig } from './scorecard/instructorConfig'

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
    res.json({ ok: true, game, build: buildStamp() })
  })
}

export const penniesHealth = makeHealth('pennies', PENNIES_CORS_ORIGINS)
export const pollHealth = makeHealth('poll', POLL_CORS_ORIGINS)
export const pdHealth = makeHealth('pd', PD_CORS_ORIGINS)
export const pricingHealth = makeHealth('pricing', PRICING_CORS_ORIGINS)
export const newsvendorHealth = makeHealth('newsvendor', NEWSVENDOR_CORS_ORIGINS)
export const forecastHealth = makeHealth('forecast', FORECAST_CORS_ORIGINS)
export const procurementHealth = makeHealth('procurement', PROCUREMENT_CORS_ORIGINS)
export const scorecardHealth = makeHealth('scorecard', SCORECARD_CORS_ORIGINS)
