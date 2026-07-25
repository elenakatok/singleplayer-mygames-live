import { onCall } from 'firebase-functions/v2/https'
import { defineSecret } from 'firebase-functions/params'
import * as admin from 'firebase-admin'
import { FieldValue } from 'firebase-admin/firestore'
import { extractInstructorGameId, toGameResult, dispatchResults, type PushSummary } from '@mygames/game-server'
import { PD_CORS_ORIGINS, INSTANCES_COLLECTION, PARTICIPANTS_SUBCOLLECTION } from './config'
import { scoreClass, type PdParticipantInput } from './scoring'
import { parseStoredRounds, totals } from './rounds'

// ═══════════════════════════════════════════════════════════════════════════════
// pdScoreAndRecord (instructor) — the class-wide pass (spec §6). Instructor-triggered,
// re-runnable: it recomputes from the same stored games, and PD's scoring has no
// randomness at all (nothing is ranked, so there is no tie to break), which makes a
// re-run byte-identical rather than merely equivalent.
//
// ⚠ PARTICIPATION ONLY — cumulative prison-years are NEVER graded (spec §6). They are
// read here for ONE purpose: writing the report fields (student_years_total etc.) that
// Slice 4's reports and the debrief will show. They are not passed to scoreClass —
// which has no parameter to receive them — and toGameResult drops raw_score by
// contract, so the payload that reaches the gradebook carries only normalized_score
// and knowledge_check_score.
//
// Trimmed from penniesScoreAndRecord: same read → score → batch-write → push shape,
// with the auction (winner, tie-break, profit) removed.
// ═══════════════════════════════════════════════════════════════════════════════

// PD's own secret (already provisioned). Per-game, never shared: a game is deployed,
// rotated, and revoked on its own.
const pdCallbackSecret = defineSecret('PD_CALLBACK_SECRET')

/** Callback config: _dev override in the emulator, else deploy-time env + secret. */
function resolveCallbackConfig(data: Record<string, unknown>, isEmulator: boolean): { url: string; secret: string } {
  if (isEmulator) {
    const dev = (data._dev ?? {}) as Record<string, unknown>
    return {
      url: typeof dev.callback_url === 'string' ? dev.callback_url : '',
      secret: typeof dev.callback_secret === 'string' ? dev.callback_secret : '',
    }
  }
  return {
    url: process.env.CLASSROOM_CALLBACK_URL ?? '',
    secret: pdCallbackSecret.value(),
  }
}

export const pdScoreAndRecord = onCall(
  { cors: PD_CORS_ORIGINS, secrets: [pdCallbackSecret] },
  async (request) => {
    const data = request.data as Record<string, unknown>
    const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true'
    const authHeader = request.rawRequest.headers.authorization as string | undefined

    const gameInstanceId = await extractInstructorGameId(data, isEmulator, authHeader)

    const db = admin.firestore()
    const instanceRef = db.collection(INSTANCES_COLLECTION).doc(gameInstanceId)
    const participantsRef = instanceRef.collection(PARTICIPANTS_SUBCOLLECTION)
    const participantsSnap = await participantsRef.get()

    const inputs: PdParticipantInput[] = []
    /** Report-only outcome figures, by participant. NOT scoring inputs. */
    const outcomes = new Map<string, { studentYears: number; botYears: number; cooperations: number }>()

    for (const d of participantsSnap.docs) {
      const p = d.data()
      const rounds = parseStoredRounds(p.rounds)
      const sums = totals(rounds)
      const kc = typeof p.knowledge_check_score === 'number' ? p.knowledge_check_score : null

      inputs.push({
        participant_id: d.id,
        finished: p.finished_at != null,
        rounds_played: rounds.length,
        knowledge_check_score: kc,
      })
      outcomes.set(d.id, {
        studentYears: sums.student,
        botYears: sums.bot,
        cooperations: rounds.filter(r => r.student_move === 'C').length,
      })
    }

    const scored = scoreClass(inputs)

    const nameById = new Map(participantsSnap.docs.map(d => [d.id, (d.data().name as string | undefined) ?? null]))

    const batch = db.batch()
    for (const [pid, s] of Object.entries(scored.results)) {
      const o = outcomes.get(pid)
      batch.set(participantsRef.doc(pid), {
        raw_score: s.raw_score,
        normalized_score: s.normalized_score,
        // Written back so the report reads one place; the KC path is what SET it.
        knowledge_check_score: s.knowledge_check_score,
        rounds_played: s.rounds_played,
        // Report-only outcome fields (spec §9 Tier 1). Never scored.
        student_years_total: o?.studentYears ?? 0,
        bot_years_total: o?.botYears ?? 0,
        cooperation_count: o?.cooperations ?? 0,
        finalized_at: FieldValue.serverTimestamp(),
      }, { merge: true })
    }
    batch.set(instanceRef, { finalized: true, finalized_at: FieldValue.serverTimestamp() }, { merge: true })
    await batch.commit()

    // Push to the classroom gradebook. `roles: []` — this family has no roles, so
    // toGameResult normalizes role to null. status comes from raw_score: finishers
    // 'completed', everyone else 'no_show'.
    const { url, secret } = resolveCallbackConfig(data, isEmulator)
    let push: PushSummary | null = null
    if (url) {
      const records = Object.entries(scored.results).map(([pid, s]) =>
        toGameResult(gameInstanceId, pid, {
          raw_score: s.raw_score,
          normalized_score: s.normalized_score,
          knowledge_check_score: s.knowledge_check_score,
        }, { roles: [] }),
      )
      push = await dispatchResults(records, url, secret)
    }

    return {
      ok: true as const,
      scored: Object.keys(scored.results).length,
      finishers: scored.finishers,
      names: Object.fromEntries(nameById),
      push,
    }
  },
)
