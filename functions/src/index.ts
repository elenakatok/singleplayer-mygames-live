import { onRequest } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import { makeSinglePlayerBootstrap } from './shared/singlePlayerBootstrap'
import {
  PENNIES_COLLECTION_PREFIX,
  PENNIES_CORS_ORIGINS,
} from './pennies/config'

admin.initializeApp()

// ═══════════════════════════════════════════════════════════════════════════════
// Function exports — ONE Firebase project hosts several single-player games, so
// every function is named PER GAME (never a generic dispatcher). Deploy scoped by
// name only — NEVER `--only functions` (see README "Deploy discipline"): a blanket
// deploy would mint revisions for every game and risk the Cloud Run CPU-quota
// pileup.
// ═══════════════════════════════════════════════════════════════════════════════

// ── Jar of Pennies (game_id: pennies) ─────────────────────────────────────────

// Launch / session exchange — the classroom JWT → Firebase session handshake.
// This is all the placeholder screen (Part 1) needs to reach a 'ready' session.
export const penniesBootstrap = makeSinglePlayerBootstrap({
  collectionPrefix: PENNIES_COLLECTION_PREFIX,
  corsOrigins: PENNIES_CORS_ORIGINS,
})

// ── Part 2 callables (NOT built in this pass — listed so the naming is fixed) ──
//   penniesGetScreen        (student)    — jar image + question defs; never true_value
//   penniesSubmit           (student)    — write estimate/bid/submitted_at; one-shot lock
//   penniesGetConfig        (instructor) — read true_value from truth/main
//   penniesUpdateConfig     (instructor) — write true_value into truth/main
//   penniesScoreAndRecord   (instructor) — class-wide pass: winner, grades, gradebook
//   penniesGetReport        (instructor) — report data

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
