import { onCall } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import { extractStudentOnCallIds } from '@mygames/game-server'
import {
  NEWSVENDOR_CORS_ORIGINS, INSTANCES_COLLECTION, PARTICIPANTS_SUBCOLLECTION, CONFIG_DOC,
  loadNewsvendorConfig,
} from './config'
import {
  resolveNewsvendorKcQuestions, toClientKcQuestions, shuffleClientOptions,
  prepQuestion, debriefQuestion,
} from './questions'

// ═══════════════════════════════════════════════════════════════════════════════
// newsvendorGetQuestions (student) — the whole non-period question set in ONE call:
// the prep paragraph (spec §8), the ten-question knowledge check, and the debrief
// paragraph, plus which of them this student has already answered.
//
// ⚠ THE KC IS AUTHORED, NOT DERIVED (questions.ts). It uses fixed teaching numbers
// that DIFFER from the instance's config on purpose, so a student must recompute
// rather than read an answer off the place-order screen. Do not "fix" this by
// deriving it from config — that would defeat the whole design.
//
// ⚠ OPTION ORDER IS PER STUDENT, and the same order the grader will validate against,
// because both call resolveNewsvendorKcQuestions(participantId).
//
// ⚠ THE ANSWER KEY NEVER SHIPS, from EITHER source. toClientKcQuestions drops
// `correct_value` and `explanation` from the authored set; added questions are rebuilt
// field by field for the same reason. The explanation is earned by answering
// (newsvendorSubmitKcAnswer returns it).
//
// TWO FREE-TEXT QUESTIONS, NOT ONE. The prep is asked before play and the debrief
// after, and each gets its own Tier-2 report (spec §8). They are returned separately
// so the flow can place them at opposite ends of the sequence.
// ═══════════════════════════════════════════════════════════════════════════════

export const newsvendorGetQuestions = onCall({ cors: NEWSVENDOR_CORS_ORIGINS }, async (request) => {
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

  const config = loadNewsvendorConfig(configSnap.data())
  const pData = participantSnap.data() ?? {}

  const authored = config.kcEnabled
    ? toClientKcQuestions(resolveNewsvendorKcQuestions(participantId, config.dual))
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
    /** Which mode this instance runs — the client branches its labels on it. */
    dual: config.dual,
    /** ⚠ Two SOURCES, kept apart all the way to the grader: `authored` is this file's
     *  fixed ten; `added` is the instructor's own list with its own keys. */
    kc: { authored, added },
    kcAnswered: answered,
    /** The prep paragraph, asked BEFORE play (spec §8). */
    prepEnabled: config.prepEnabled,
    prep: config.prepEnabled
      ? { field: prepQuestion.field, prompt: config.prepPrompt, placeholder: prepQuestion.placeholder }
      : null,
    prepSubmitted: freeText[prepQuestion.field] != null,
    /** The debrief paragraph, asked AFTER play (spec §8). */
    debriefEnabled: config.debriefEnabled,
    debrief: config.debriefEnabled
      ? { field: debriefQuestion.field, prompt: config.debriefPrompt, placeholder: debriefQuestion.placeholder }
      : null,
    debriefSubmitted: freeText[debriefQuestion.field] != null,
  }
})
