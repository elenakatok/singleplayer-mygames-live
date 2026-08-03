import { onCall } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import { extractStudentOnCallIds } from '@mygames/game-server'
import {
  PROCUREMENT_CORS_ORIGINS, INSTANCES_COLLECTION, PARTICIPANTS_SUBCOLLECTION, CONFIG_DOC,
  loadProcurementConfig,
} from './config'
import {
  KC_POOL_IDS, defaultVisibleFor, resolveQuestions, gradedFor, toClientQuestions,
} from './questions'

// ═══════════════════════════════════════════════════════════════════════════════
// procurementGetQuestions (student) — every non-round question in ONE call: the
// knowledge check, the prep paragraph and the debrief paragraph, plus which of them this
// student has already answered.
//
// ⚠⚠ ALL THREE STAGES COME FROM THE SAME POOL, filtered by `format` and by the
// instructor's `kcVisible` list. There is no separate "debrief prompt" config key and no
// second source of wording: S8/S9 and O9/O10 are pool entries with a `stage` tag,
// switched on and off exactly like every graded question. One list to configure, one
// list to report on.
//
// ⚠⚠ THE DENOMINATOR SHIPS WITH THE SET AND IS COMPUTED, NEVER STORED. `gradedTotal` is
// `gradedFor(...)`.length — the SAME call the grader makes. A hidden question cannot
// reach it, because it is not in the resolved set to begin with.
//
// ⚠ THE ANSWER KEY NEVER SHIPS. `toClientQuestions` drops `correct_value` and
// `explanation`, building each question field by field. The explanation is EARNED by
// answering — procurementSubmitKcAnswer returns it.
//
// ⚠ OPTION ORDER IS PER STUDENT and stable on reload, keyed on (participantId, question
// id). The grader resolves the same order from the same key, and compares STABLE VALUES
// rather than positions, so shuffling cannot affect a score.
// ═══════════════════════════════════════════════════════════════════════════════

export const procurementGetQuestions = onCall({ cors: PROCUREMENT_CORS_ORIGINS }, async (request) => {
  const data = request.data as Record<string, unknown>
  const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true'
  const authHeader = request.rawRequest.headers.authorization as string | undefined

  const { participantId, gameInstanceId } = await extractStudentOnCallIds(data, isEmulator, authHeader)

  const db = admin.firestore()
  const instanceRef = db.collection(INSTANCES_COLLECTION).doc(gameInstanceId)
  const [configSnap, participantSnap] = await Promise.all([
    instanceRef.collection('config').doc(CONFIG_DOC).get(),
    instanceRef.collection(PARTICIPANTS_SUBCOLLECTION).doc(participantId).get(),
  ])

  const config = loadProcurementConfig(configSnap.data(), KC_POOL_IDS, defaultVisibleFor)
  const pData = participantSnap.data() ?? {}

  const kc = config.kcEnabled ? resolveQuestions(config.format, config.kcVisible, 'kc') : []
  const prep = resolveQuestions(config.format, config.kcVisible, 'prep')
  const debrief = resolveQuestions(config.format, config.kcVisible, 'debrief')

  const answers = (pData.kc_static_answers ?? {}) as Record<string, unknown>
  const freeText = (pData.free_text_answers ?? {}) as Record<string, unknown>

  return {
    ok: true as const,
    kcEnabled: config.kcEnabled,
    kc: toClientQuestions(kc, participantId),
    kcAnswered: kc.filter(q => answers[q.id] != null).map(q => q.id),
    /** ⚠ COMPUTED from the VISIBLE GRADED set. The student's score is out of this. */
    gradedTotal: config.kcEnabled ? gradedFor(config.format, config.kcVisible).length : 0,
    /** Asked BEFORE play — the student's plan, written down so they can compare it. */
    prep: toClientQuestions(prep, participantId),
    prepAnswered: prep.filter(q => freeText[q.id] != null).map(q => q.id),
    /** Asked AFTER the final results screen. */
    debrief: toClientQuestions(debrief, participantId),
    debriefAnswered: debrief.filter(q => freeText[q.id] != null).map(q => q.id),
  }
})
