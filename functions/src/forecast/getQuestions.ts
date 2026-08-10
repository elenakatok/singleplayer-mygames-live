import { onCall } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import { extractStudentOnCallIds } from '@mygames/game-server'
import {
  FORECAST_CORS_ORIGINS, INSTANCES_COLLECTION, PARTICIPANTS_SUBCOLLECTION, CONFIG_DOC,
  loadForecastConfig,
} from './config'
import {
  authoredToClient, addedToClientKcQuestions, debriefQuestion,
  forecastPreStage, forecastPostStage, stageToClient,
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

  // ⚠⚠ HIDDEN, ORDER, OVERRIDES AND THE `kcEnabled` GATE ARE ALL APPLIED BY
  // `resolveForecastKc`, WHICH THE GRADER ALSO CALLS (through `forecastKcScoringSet`). Do
  // NOT filter again here. The `config.kcEnabled ? … : []` ternaries that used to live on
  // these two lines were the ONLY place the toggle was honoured, so every other caller —
  // the grader's denominator included — still saw all nine while the student saw none.
  // That is scorecard's latent bug, and forecast had the same shape (spec §5).
  const authored = authoredToClient(config, participantId)

  // Added questions, whitelisted field by field — never spread, so a stored
  // `correct_value` cannot ride along.
  //
  // ⚠ SHUFFLED PER STUDENT, like the authored set. Without this, added questions were
  // the one door the always-answer-first tell could walk back in through.
  // ⚠ PRE-STAGE ONLY. Added questions used to be stage-less and every one of them was
  // appended here, before play — which is exactly why `pre` is this game's default stage
  // for a stage-less stored addition. The `post` ones ride in `stages.post` below, so a
  // question cannot appear twice.
  const added = addedToClientKcQuestions(config, participantId, 'pre')

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
    /**
     * ⚠⚠ THE TWO STAGES, IN ORDER, AS THE FLOW RENDERS THEM. `pre` is the authored nine and
     * any pre-stage addition; `post` is the DEBRIEF paragraph and any post-stage addition.
     * The debrief is a ROW here (spec D9) rather than a separate surface — the legacy
     * `debrief` field above is kept only so nothing still reading it breaks, and the flow
     * reads these.
     *
     * ⚠⚠ `stages.post` IS THE LIST THE REVEAL IS GATED ON. `revealGate` builds it from the
     * same `forecastPostStage(config)`, so the screen and the gate cannot disagree about
     * which questions are outstanding — and a row hidden here is absent from the gate too.
     *
     * ⚠ ANSWERED IS READ FROM TWO MAPS, because the kinds submit to two callables: a
     * free-text row lands in `free_text_answers` (forecastSubmitDebrief) and an
     * authored/added one in `kc_static_answers` (forecastSubmitKcAnswer). Presence of the
     * key IS "answered", and the client resumes at the first row whose flag is false.
     */
    stages: {
      pre: stageToClient(forecastPreStage(config), participantId).map(r => ({
        ...r,
        answered: r.kind === 'free-text' ? freeText[r.field] != null : answers[r.field] != null,
      })),
      post: stageToClient(forecastPostStage(config), participantId).map(r => ({
        ...r,
        answered: r.kind === 'free-text' ? freeText[r.field] != null : answers[r.field] != null,
      })),
    },
  }
})
