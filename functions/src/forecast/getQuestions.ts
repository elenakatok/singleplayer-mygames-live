import { onCall } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import { extractStudentOnCallIds } from '@mygames/game-server'
import {
  FORECAST_CORS_ORIGINS, INSTANCES_COLLECTION, PARTICIPANTS_SUBCOLLECTION, CONFIG_DOC,
  loadForecastConfig,
} from './config'
import {
  resolveForecastKcQuestions, toClientKcQuestions, shuffleClientOptions, debriefQuestion,
} from './questions'

// ═══════════════════════════════════════════════════════════════════════════════
// forecastGetQuestions (student) — the whole non-month question set in ONE call: the
// nine-question knowledge check (spec §8) and the debrief prompt (spec §9), plus which
// of them this student has already answered.
//
// ⚠ THE KC IS AUTHORED, NOT DERIVED (questions.ts). Its stems carry their own numbers,
// and here that is a LEAK CONTROL, not a style choice: the KC runs BEFORE play, and a
// stem derived from this instance's a, b, H or σ would print a model parameter on the
// screen before the one where the student is asked to infer it.
//
// ⚠ OPTION ORDER IS PER STUDENT, and the same order the grader will validate against,
// because both call resolveForecastKcQuestions(participantId).
//
// ⚠ THE ANSWER KEY NEVER SHIPS, from EITHER source. toClientKcQuestions drops
// `correct_value` and `explanation` from the authored set; added questions are rebuilt
// field by field for the same reason. The explanation is earned by answering
// (forecastSubmitKcAnswer returns it).
//
// ⚠ AND NEITHER DOES THE REVEAL. This callable says whether the debrief has been
// answered; it never carries the process. That lives behind forecastGetReveal, which
// is gated on the game being over AND the debrief being done — see getReveal.ts.
// ═══════════════════════════════════════════════════════════════════════════════

export const forecastGetQuestions = onCall({ cors: FORECAST_CORS_ORIGINS }, async (request) => {
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

  const config = loadForecastConfig(configSnap.data())
  const pData = participantSnap.data() ?? {}

  const authored = config.kcEnabled
    ? toClientKcQuestions(resolveForecastKcQuestions(participantId))
    : []

  // Added questions, whitelisted field by field — never spread, so a stored
  // `correct_value` cannot ride along.
  //
  // ⚠ SHUFFLED PER STUDENT, like the authored set. Without this, added questions were
  // the one door the always-answer-first tell could walk back in through.
  const added = config.kcEnabled
    ? config.addedKcQuestions.map(q => ({
        field: q.id,
        type: q.type,
        prompt: q.prompt,
        options: shuffleClientOptions(q.options ?? [], participantId, q.id),
      }))
    : []

  const answers = (pData.kc_static_answers ?? {}) as Record<string, unknown>
  const answered = [...authored, ...added].filter(q => answers[q.field] != null).map(q => q.field)

  const freeText = (pData.free_text_answers ?? {}) as Record<string, unknown>

  return {
    ok: true as const,
    kcEnabled: config.kcEnabled,
    /** ⚠ Two SOURCES, kept apart all the way to the grader: `authored` is this file's
     *  fixed nine; `added` is the instructor's own list with its own keys. */
    kc: { authored, added },
    kcAnswered: answered,
    /** The debrief paragraph, asked AFTER the final results screen (spec §9). */
    debriefEnabled: config.debriefEnabled,
    debrief: config.debriefEnabled
      ? { field: debriefQuestion.field, prompt: config.debriefPrompt, placeholder: debriefQuestion.placeholder }
      : null,
    debriefSubmitted: freeText[debriefQuestion.field] != null,
  }
})
