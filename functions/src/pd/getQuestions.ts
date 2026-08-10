import { onCall } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import { extractStudentOnCallIds } from '@mygames/game-server'
import {
  PD_CORS_ORIGINS, INSTANCES_COLLECTION, PARTICIPANTS_SUBCOLLECTION, CONFIG_DOC, loadPdConfig,
} from './config'
import {
  pdResolveKc, addedToClientKcQuestions, toClientKcQuestions, postStageToClient,
  debriefQuestion,
} from './questions'

// ═══════════════════════════════════════════════════════════════════════════════
// pdGetQuestions (student) — the whole non-round question set in ONE call: the
// knowledge check (spec §7) and the debrief paragraph (spec §8), plus which of them
// this student has already answered.
//
// ⚠ THE TWO KC SOURCES ARE RETURNED SEPARATELY, and stay separate all the way down.
//   • `kc.derived` — the four matrix-comprehension questions, RECOMPUTED from this
//     instance's payoff matrix, labels and unit on every call. Never stored as text,
//     so they cannot drift from the matrix the student is looking at.
//   • `kc.added`   — the instructor's own questions, read from config as stored data
//     objects with their own answer keys.
// The client renders derived-then-added; the grader routes each field to its own
// path. Flattening these into one list server-side would mean freezing the derived
// four as text, which is exactly what the derivation exists to prevent.
//
// ⚠ THE ANSWER KEY NEVER SHIPS, from EITHER source. toClientKcQuestions drops
// `correct_value` and `explanation` from the derived four; the added questions are
// rebuilt field by field below for the same reason. The explanation is earned by
// answering (pdSubmitKcAnswer returns it).
//
// Both the KC and the debrief can be switched OFF per instance; when off, the arrays
// are empty / the debrief is null and the client simply omits those screens.
// ═══════════════════════════════════════════════════════════════════════════════

export const pdGetQuestions = onCall({ cors: PD_CORS_ORIGINS }, async (request) => {
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

  const config = loadPdConfig(configSnap.data())
  const pData = participantSnap.data() ?? {}

  // Derived against THIS instance's matrix/labels/unit, so the options match the
  // matrix rendered beside them on the KC screen.
  //
  // ⚠⚠ HIDDEN, ORDER AND OVERRIDES ARE APPLIED BY `pdResolveKc`, WHICH THE GRADER ALSO
  // CALLS (through `pdKcScoringSet`). Do not filter again here — a second filter is a
  // second answer to "which questions exist", and the two would eventually disagree
  // (spec §5).
  const derived = toClientKcQuestions(pdResolveKc(config))

  // Added questions, whitelisted field by field — never spread, so a stored
  // `correct_value` cannot ride along.
  //
  // ⚠ AND SHUFFLED PER STUDENT. The four DERIVED questions need no shuffle — they all
  // offer the SAME sorted ladder of payoff values and their answers are 1/15/0/10, so
  // position says nothing. An instructor typing a question into Settings has no such
  // protection, and most people type the right answer first.
  // ⚠ PRE-STAGE ONLY. Added questions used to be stage-less and every one of them was
  // appended here, before play. They are stage-aware now, so this list is explicitly the
  // `pre` ones and the `post` ones are served below — a question cannot appear twice.
  const added = addedToClientKcQuestions(config, participantId, 'pre')

  const answers = (pData.kc_static_answers ?? {}) as Record<string, unknown>
  const answered = [...derived, ...added].filter(q => answers[q.field] != null).map(q => q.field)

  return {
    ok: true as const,
    kcEnabled: config.kcEnabled,
    kc: { derived, added },
    debriefEnabled: config.debriefEnabled,
    // Ungraded and keyless, but still built field by field.
    debrief: config.debriefEnabled
      ? {
          field: debriefQuestion.field,
          prompt: config.debriefPrompt,
          placeholder: debriefQuestion.placeholder,
        }
      : null,
    kcAnswered: answered,
    debriefSubmitted: (pData.debrief_answers ?? {})[debriefQuestion.field] != null,
    /**
     * ⚠⚠ THE WHOLE `post` STAGE, IN ORDER — the debrief row plus any added questions the
     * instructor put after play. The post-play screen walks this list exactly as the
     * pre-play screens walk the KC list.
     *
     * ⚠ ANSWERED IS READ FROM TWO DIFFERENT MAPS, because the two kinds submit to two
     * different callables: the debrief lands in `debrief_answers` (pdSubmitDebrief) and an
     * added question in `kc_static_answers` (pdSubmitKcAnswer). Presence of the key IS
     * "answered" — the client resumes at the first row whose flag is false, so a student
     * part-way through the post stage comes back to the right screen on any device.
     *
     * ⚠ The answer key never ships here either: `postStageToClient` carries prompt and
     * options only, and the options are shuffled per student.
     */
    postStage: postStageToClient(config, participantId).map(r => ({
      ...r,
      answered: r.kind === 'debrief'
        ? (pData.debrief_answers ?? {})[r.field] != null
        : (pData.kc_static_answers ?? {})[r.field] != null,
    })),
  }
})
