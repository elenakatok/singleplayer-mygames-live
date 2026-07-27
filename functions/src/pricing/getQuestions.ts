import { onCall } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import { extractStudentOnCallIds } from '@mygames/game-server'
import {
  PRICING_CORS_ORIGINS, INSTANCES_COLLECTION, PARTICIPANTS_SUBCOLLECTION, CONFIG_DOC, TRUTH_DOC,
  loadPricingConfig, loadPricingStrategies, activeStrategy,
} from './config'
import { STRATEGY_DESCRIPTIONS } from './strategy'
import { resolvePricingKcQuestions, toClientKcQuestions, debriefQuestion } from './questions'

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

  const derived = config.kcEnabled
    ? toClientKcQuestions(resolvePricingKcQuestions(config.market, config.pmg, config.labels))
    : []

  // Added questions, whitelisted field by field — never spread, so a stored
  // `correct_value` cannot ride along.
  const added = config.kcEnabled
    ? config.addedKcQuestions.map(q => ({
        field: q.id,
        type: q.type,
        prompt: q.prompt,
        options: (q.options ?? []).map(o => ({ value: o.value, label: o.label })),
      }))
    : []

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
    debriefSubmitted: (pData.debrief_answers ?? {})[debriefQuestion.field] != null,
    /** ⚠ null until the game is over — see the header. */
    competitorReveal,
  }
})
