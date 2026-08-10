import { onCall } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import { extractStudentOnCallIds } from '@mygames/game-server'
import {
  PRICING_CORS_ORIGINS, INSTANCES_COLLECTION, PARTICIPANTS_SUBCOLLECTION, CONFIG_DOC, TRUTH_DOC,
  loadPricingConfig, loadPricingStrategies, activeStrategy,
} from './config'
import { STRATEGY_DESCRIPTIONS } from './strategy'
import {
  pricingResolveKc, toClientKcQuestions, addedToClientKcQuestions, postStageToClient,
  debriefQuestion,
} from './questions'

// ═══════════════════════════════════════════════════════════════════════════════
// pricingGetQuestions (student) — the whole non-round question set in ONE call: the
// knowledge check (spec §8) and the debrief paragraph (spec §9), plus which of them
// this student has already answered.
//
// ⚠ THE MODE PICKS THE SET (spec §8.1 vs §8.2), and it is recomputed from this
// instance's market on every call — never stored as text, so it cannot drift from
// the market the student is pricing in.
//
// ⚠ THE TWO KC SOURCES ARE RETURNED SEPARATELY, and stay separate all the way down.
//   • `kc.derived` — the mode's questions, RECOMPUTED from this instance's market on
//     every call. Never stored as text, so they cannot drift from the market the
//     student is pricing in.
//   • `kc.added`   — the instructor's own questions, read from config as stored data
//     objects with their own answer keys.
// The client renders derived-then-added; the grader routes each field to its own
// path. Flattening these server-side would mean freezing the derived set as text,
// which is exactly what the derivation exists to prevent.
//
// ⚠ THE ANSWER KEY NEVER SHIPS, from EITHER source. toClientKcQuestions drops
// `correct_value` and `explanation` from the derived set; the added questions are
// rebuilt field by field below for the same reason. The explanation is earned by
// answering (pricingSubmitKcAnswer returns it).
//
// ⚠⚠ THE COMPETITOR REVEAL IS GATED ON THE GAME BEING OVER (spec §5, §9). The
// debrief screen tells the student what their competitor was programmed to do — and
// that sentence is the one thing the whole round loop is built to withhold. It is
// therefore served ONLY when `finished_at` is stamped, and is `null` in every
// response before that. A student who calls this callable by hand on round 1 gets
// null, exactly as the UI does.
// ═══════════════════════════════════════════════════════════════════════════════

export const pricingGetQuestions = onCall({ cors: PRICING_CORS_ORIGINS }, async (request) => {
  const data = request.data as Record<string, unknown>
  const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true'
  const authHeader = request.rawRequest.headers.authorization as string | undefined

  const { participantId, gameInstanceId } = await extractStudentOnCallIds(data, isEmulator, authHeader)

  const db = admin.firestore()
  const instanceRef = db.collection(INSTANCES_COLLECTION).doc(gameInstanceId)
  const [configSnap, truthSnap, participantSnap] = await Promise.all([
    instanceRef.collection('config').doc(CONFIG_DOC).get(),
    instanceRef.collection('truth').doc(TRUTH_DOC).get(),
    instanceRef.collection(PARTICIPANTS_SUBCOLLECTION).doc(participantId).get(),
  ])

  const config = loadPricingConfig(configSnap.data())
  const pData = participantSnap.data() ?? {}
  const finished = pData.finished_at != null

  // ⚠⚠ HIDDEN, ORDER AND OVERRIDES ARE APPLIED BY `pricingResolveKc`, WHICH THE GRADER
  // ALSO CALLS (through `pricingKcScoringSet`). Do not filter again here — a second filter
  // is a second answer to "which questions exist", and the two would eventually disagree
  // (spec §5). The `ordered` flag still decides shuffling, per question, inside
  // `toClientKcQuestions`.
  const derived = toClientKcQuestions(pricingResolveKc(config), participantId)

  // Added questions, whitelisted field by field — never spread, so a stored
  // `correct_value` cannot ride along.
  //
  // ⚠ SHUFFLED TOO. An instructor typing a question into Settings has no reason to think
  // about where they put the right answer, and most people type it first — so the same
  // tell the derived set just lost would come straight back in through this door.
  // ⚠ PRE-STAGE ONLY. Added questions used to be stage-less and every one of them was
  // appended here, before play. They are stage-aware now, so this is explicitly the `pre`
  // ones and the `post` ones are served below — a question cannot appear twice.
  const added = addedToClientKcQuestions(config, participantId, 'pre')

  const answers = (pData.kc_static_answers ?? {}) as Record<string, unknown>
  const answered = [...derived, ...added].filter(q => answers[q.field] != null).map(q => q.field)

  // The reveal sentence — built only when it is allowed to exist at all.
  const strategy = activeStrategy(config, loadPricingStrategies(truthSnap.data()))
  const competitorReveal = finished
    ? `Your competitor was programmed to ${STRATEGY_DESCRIPTIONS[strategy]}.`
    : null

  return {
    ok: true as const,
    kcEnabled: config.kcEnabled,
    /** Does this instance open with the PMG rules screen (spec §6.2)? */
    pmg: config.pmg,
    kc: { derived, added },
    debriefEnabled: config.debriefEnabled,
    // Ungraded and keyless, but still built field by field.
    debrief: config.debriefEnabled
      ? {
          field: debriefQuestion.field,
          // The MODE's prompt (spec §9), or the instructor's edit of it.
          prompt: config.debriefPrompt,
          placeholder: debriefQuestion.placeholder,
        }
      : null,
    kcAnswered: answered,
    /**
     * ⚠⚠ THE WHOLE `post` STAGE, IN ORDER — the debrief row plus any added question the
     * instructor put after the results. The debrief screen walks this list.
     *
     * ⚠ ANSWERED IS READ FROM TWO MAPS, because the two kinds submit to two callables: the
     * debrief lands in `debrief_answers` (pricingSubmitDebrief) and an added question in
     * `kc_static_answers` (pricingSubmitKcAnswer). Presence of the key IS "answered", and
     * the client resumes at the first row whose flag is false.
     */
    postStage: postStageToClient(config, participantId).map(r => ({
      ...r,
      answered: r.kind === 'debrief'
        ? (pData.debrief_answers ?? {})[r.field] != null
        : (pData.kc_static_answers ?? {})[r.field] != null,
    })),
    debriefSubmitted: (pData.debrief_answers ?? {})[debriefQuestion.field] != null,
    /** ⚠ null until the game is over — see the header. */
    competitorReveal,
  }
})
