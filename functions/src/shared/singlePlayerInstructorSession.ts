import { onCall, HttpsError } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import { verifyClassroomToken } from '@mygames/game-server'

// ═══════════════════════════════════════════════════════════════════════════════
// SINGLE-PLAYER INSTRUCTOR SESSION — family machinery. The instructor arrives from
// the classroom with an instructor JWT and exchanges it for a Firebase session
// (custom token) that the dashboard / settings / reports pages hold. Modeled on
// game-server's makeGetInstructorSession, but per-game named because EVERY function
// name must be globally unique within this shared project (a generic
// 'getInstructorSession' would collide across games).
//
// uid = `instructor_${gameInstanceId}`, claims { role:'instructor', game_instance_id }.
// Subsequent instructor callables verify via extractInstructorGameId (Bearer id-token
// role==='instructor', or the _dev emulator bypass) — game-agnostic, keyed off claims.
// ═══════════════════════════════════════════════════════════════════════════════

export interface SinglePlayerInstructorSessionOptions {
  corsOrigins: string[]
}

/** Returns an onCall instructor-session bootstrap for one single-player game. */
export function makeSinglePlayerInstructorSession(opts: SinglePlayerInstructorSessionOptions) {
  return onCall({ cors: opts.corsOrigins }, async (request) => {
    const data = request.data as Record<string, unknown>
    const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true'

    let gameInstanceId: string

    if (isEmulator && data._dev != null) {
      const dev = data._dev as Record<string, unknown>
      if (typeof dev.game_instance_id !== 'string') {
        throw new HttpsError('invalid-argument', '_dev requires game_instance_id string')
      }
      gameInstanceId = dev.game_instance_id
    } else {
      if (typeof data.token !== 'string') {
        throw new HttpsError('invalid-argument', 'Missing token')
      }
      try {
        const payload = verifyClassroomToken(data.token)
        if (payload.role !== 'instructor') {
          throw new HttpsError('permission-denied', 'Instructor access required')
        }
        gameInstanceId = payload.game_instance_id
      } catch (err) {
        if (err instanceof HttpsError) throw err
        const message = err instanceof Error ? err.message : 'Invalid token'
        throw new HttpsError('unauthenticated', message)
      }
    }

    const customToken = await admin.auth().createCustomToken(`instructor_${gameInstanceId}`, {
      role: 'instructor',
      game_instance_id: gameInstanceId,
    })

    return { ok: true as const, customToken }
  })
}
