import { onRequest } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import { makeSinglePlayerBootstrap } from './shared/singlePlayerBootstrap'
import { makeSinglePlayerInstructorSession } from './shared/singlePlayerInstructorSession'
import { PENNIES_COLLECTION_PREFIX, PENNIES_CORS_ORIGINS } from './pennies/config'

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
export { penniesScoreAndRecord } from './pennies/scoreAndRecord'
export { penniesGetReport } from './pennies/report'

// ── Health probe (onRequest; not a game endpoint) ─────────────────────────────

const CORS_ORIGINS = new Set(PENNIES_CORS_ORIGINS)

export const penniesHealth = onRequest((req, res) => {
  const origin = req.headers.origin ?? ''
  if (CORS_ORIGINS.has(origin)) {
    res.set('Access-Control-Allow-Origin', origin)
    res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.set('Vary', 'Origin')
  }
  if (req.method === 'OPTIONS') { res.status(204).send(''); return }
  res.json({ ok: true, game: 'pennies' })
})
