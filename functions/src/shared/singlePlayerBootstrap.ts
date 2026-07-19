import { onCall, HttpsError } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import { FieldValue } from 'firebase-admin/firestore'
import { verifyClassroomToken } from '@mygames/game-server'

// ═══════════════════════════════════════════════════════════════════════════════
// SINGLE-PLAYER SESSION BOOTSTRAP — family machinery, shared by every game in this
// project. It is the whole "launch" of the single-player family: the student
// arrives from the classroom with a launch JWT and exchanges it here for a
// persistent Firebase session.
//
// It is the multiplayer `assignRole` with the multiplayer parts REMOVED. There is:
//   • NO role assignment    (single-player family has one kind of participant)
//   • NO composition / role_counts, NO matching, NO groups, NO presence
// It keeps ONLY the two things every launch needs: verify the JWT, and mint a
// Firebase custom token whose UID is the participant_id (so Firestore rules can
// gate "read only your own participant doc" on request.auth.uid).
//
// The participant document is a TOP-LEVEL, prefixed collection
// (`<prefix>_participants/{pid}`), not an instance subcollection — the single-
// player data model (spec §4.2). game_instance_id is stored as a FIELD.
//
// Custom-token claims: { game_instance_id } only — no role claim. verifyFirebaseToken
// then reads role as 'student' by default, which is exactly what the authed student
// callables (penniesSubmit, added in Part 2) expect on the Bearer path.
// ═══════════════════════════════════════════════════════════════════════════════

export interface SinglePlayerBootstrapOptions {
  /** Collection prefix for this game, e.g. 'pennies'. Never displayed. */
  collectionPrefix: string
  /** Allowed CORS origins for the callable (the game's own subdomain). */
  corsOrigins: string[]
}

/**
 * Returns an onCall bootstrap for one single-player game.
 *
 * Call data (production): { token: "<student classroom JWT>" }
 * Call data (emulator):   { _test: { participant_id, game_instance_id } }
 * Returns: { ok, participant_id, game_instance_id, customToken }
 */
export function makeSinglePlayerBootstrap(opts: SinglePlayerBootstrapOptions) {
  const participantsCollection = `${opts.collectionPrefix}_participants`

  return onCall({ cors: opts.corsOrigins }, async (request) => {
    const data = request.data as Record<string, unknown>
    const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true'

    let participantId: string
    let gameInstanceId: string
    let displayName: string | undefined

    if (isEmulator && data._test != null) {
      const test = data._test as Record<string, unknown>
      if (typeof test.participant_id !== 'string' || typeof test.game_instance_id !== 'string') {
        throw new HttpsError('invalid-argument', '_test requires participant_id and game_instance_id strings')
      }
      participantId = test.participant_id
      gameInstanceId = test.game_instance_id
    } else {
      if (typeof data.token !== 'string') {
        throw new HttpsError('invalid-argument', 'Missing token')
      }
      try {
        const payload = verifyClassroomToken(data.token)
        participantId = payload.participant_id
        gameInstanceId = payload.game_instance_id
        displayName = payload.name
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Invalid token'
        throw new HttpsError('unauthenticated', message)
      }
    }

    try {
      const db = admin.firestore()
      const participantRef = db.collection(participantsCollection).doc(participantId)

      // Idempotent upsert of the participant's identity. Created once on first launch;
      // a returning student (resume) re-enters here only if they lack a live session,
      // and we must NOT clobber an existing estimate/bid/submitted_at — so identity
      // fields are set on create only, inside a transaction.
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(participantRef)
        if (!snap.exists) {
          tx.set(participantRef, {
            participant_id: participantId,
            game_instance_id: gameInstanceId,
            ...(displayName ? { name: displayName } : {}),
            created_at: FieldValue.serverTimestamp(),
          })
        }
      })

      const customToken = await admin.auth().createCustomToken(participantId, {
        game_instance_id: gameInstanceId,
      })

      return {
        ok: true as const,
        participant_id: participantId,
        game_instance_id: gameInstanceId,
        customToken,
      }
    } catch (err) {
      if (err instanceof HttpsError) throw err
      console.error('[singlePlayerBootstrap] error:', err)
      throw new HttpsError('internal', 'Internal error')
    }
  })
}
