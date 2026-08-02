import { onCall, HttpsError } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import { extractStudentOnCallIds } from '@mygames/game-server'
import { FORECAST_CORS_ORIGINS, INSTANCES_COLLECTION, PARTICIPANTS_SUBCOLLECTION } from './config'
import { loadInstance } from './instance'
import { parseStoredRounds } from './rounds'
import { buildHistoryCsv, buildFullCsv, historyCsvFilename, FULL_CSV_FILENAME } from './csv'

// ═══════════════════════════════════════════════════════════════════════════════
// forecastGetExport (student) — serves the two CSV files (spec §4, §5).
//
// ⚠⚠ GENERATED SERVER-SIDE, NEVER ASSEMBLED IN THE BROWSER (spec §12: "Both must be
// generated from revealed data server-side, never assembled from anything the client
// was trusted to hold").
//
// That rule is not stylistic. If the client built these files it would need the raw
// series in memory to do it — and the moment an unplayed month is in the bundle for any
// reason, the game is over regardless of what is rendered. Building them here means the
// browser holds only what it was already shown.
//
// TWO KINDS (spec §4, §5):
//   'history'  the IN-PLAY file, FROZEN at the five-year history. Does not grow.
//   'full'     the FINAL-SCREEN file: history plus every month actually PLAYED.
//
// ⚠ WHY 'full' IS NOT GATED ON gameOver. It is a UI decision that the full export is
// offered on the final screen — the server does not enforce it, deliberately. The file
// is built from the STORED ROUNDS (csv.ts), so it cannot contain a month the student
// has not played no matter when it is requested; gating would add a failure mode (a
// resumed session racing the finish stamp) without adding any safety the data model
// does not already give. The guarantee lives in what the file is built FROM, which is
// the guarantee that actually holds.
// ═══════════════════════════════════════════════════════════════════════════════

export const forecastGetExport = onCall({ cors: FORECAST_CORS_ORIGINS }, async (request) => {
  const data = request.data as Record<string, unknown>
  const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true'
  const authHeader = request.rawRequest.headers.authorization as string | undefined

  const { participantId, gameInstanceId } = await extractStudentOnCallIds(data, isEmulator, authHeader)

  const kind = data.kind
  if (kind !== 'history' && kind !== 'full') {
    throw new HttpsError('invalid-argument', "kind must be 'history' or 'full'.")
  }

  const db = admin.firestore()
  // ⚠ `model` is deliberately NOT destructured. Since the high-season indicator was
  // removed from both files (spec §4, amended 08-02), neither builder takes a model —
  // so this callable never even holds one, and the export path has no access to a, b,
  // H, σ or the high season.
  const { history } = await loadInstance(db, gameInstanceId)

  if (kind === 'history') {
    // ⚠ No participant read at all on this branch. The in-play file is the COMMON
    // history and nothing else, so there is no path through which a played month could
    // reach it — "frozen" is enforced by which data this branch even loads.
    return {
      ok: true as const,
      kind,
      filename: historyCsvFilename(history),
      /** Spec §4 requires the file be LABELLED as the five-year history. */
      title: `Demand history, Years 1–${Math.ceil(history.length / 12)}`,
      csv: buildHistoryCsv(history),
    }
  }

  const snap = await db
    .collection(INSTANCES_COLLECTION).doc(gameInstanceId)
    .collection(PARTICIPANTS_SUBCOLLECTION).doc(participantId)
    .get()
  const rounds = parseStoredRounds(snap.data()?.rounds)

  return {
    ok: true as const,
    kind,
    filename: FULL_CSV_FILENAME,
    title: 'Demand history and your forecasts',
    csv: buildFullCsv(history, rounds),
  }
})
