import { onRequest } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import { makeSinglePlayerBootstrap } from './shared/singlePlayerBootstrap'
import { makeSinglePlayerInstructorSession } from './shared/singlePlayerInstructorSession'
import { PENNIES_COLLECTION_PREFIX, PENNIES_CORS_ORIGINS } from './pennies/config'
import { POLL_COLLECTION_PREFIX, POLL_CORS_ORIGINS } from './poll/config'

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
