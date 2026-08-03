import { onCall, HttpsError } from 'firebase-functions/v2/https'
import { PROCUREMENT_CORS_ORIGINS } from './config'

// ═══════════════════════════════════════════════════════════════════════════════
// procurementResolveRound (student) — the OPEN-DESCENDING format's read/step callable.
//
// ⚠⚠ NOT IMPLEMENTED. A DECLARED, DEPLOYABLE STUB, for the same IAM reason as
// procurementSubmitBid — see that file's header. It throws rather than returning a
// placeholder, so no caller can mistake it for working.
//
// ── WHY THE OPEN FORMAT NEEDS A SECOND CALLABLE AT ALL ────────────────────────
// The sealed format is one submit per round: bid → resolve → reveal, atomic. The open
// format is not. It is an UNBOUNDED EXCHANGE — the standing low bid is public, anyone
// may undercut, bots respond after a delay, and the auction runs until nobody will
// undercut further (Part 2 §2, §4.4). A round may contain one player action or twenty,
// and the count is not known in advance.
//
// ⚠ THIS IS EXACTLY THE SHAPE `Singleplayer_Loop_Audit_Findings.md` §B.3 found to be
// INEXPRESSIBLE as stage-engine stages: `spec.stages` is a static ordered array walked
// once per round, and `seatHasActed` refuses a second submit within a stage. The audit's
// conclusion — and Part 1 §13's recorded decision — is that the exchange is handled
// BELOW the loop, with only the resolved round appended to `rounds[]`. That is what this
// callable is for: it advances the exchange, and `submitBid`/the exchange's terminal
// step is what writes the StoredRound.
//
// ── WHAT CHECKPOINT 2 PUTS HERE ───────────────────────────────────────────────
// Part 2 §4.3 (bot response rule — bots bid down to exactly their own cost; bots with
// `cost > reserve` never bid at all), §4.4 (termination — no clock, and that is correct
// rather than a compromise: a single player who sits idle blocks nobody), §4.5 (Drop
// Out — which exists in THIS FORMAT ONLY; the sealed format requires a bid, Part 1 §6.3).
//
// ⚠ `botDelayMs` IS UX, NEVER STRATEGIC (Part 2 §3). A bot's decision must not depend on
// how long it waited, or the pacing becomes part of the game.
// ═══════════════════════════════════════════════════════════════════════════════

export const procurementResolveRound = onCall({ cors: PROCUREMENT_CORS_ORIGINS }, async () => {
  throw new HttpsError(
    'unimplemented',
    'The open-bid format is not built yet.',
  )
})
