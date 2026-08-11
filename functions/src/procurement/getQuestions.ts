import { onCall } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import { extractStudentOnCallIds } from '@mygames/game-server'
import {
  PROCUREMENT_CORS_ORIGINS, INSTANCES_COLLECTION, PARTICIPANTS_SUBCOLLECTION, CONFIG_DOC,
  loadProcurementConfig,
} from './config'
import {
  KC_POOL_IDS, defaultVisibleFor, resolveBuiltIns, toClientQuestions,
  procurementScoringSet, procurementPreStage, procurementDebriefStage, stageToClient,
  addedToClientKcQuestions,
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

  // ⚠⚠ HIDDEN, ORDER, OVERRIDES AND THE `kcEnabled` GATE ARE ALL APPLIED BY `resolveBuiltIns`,
  // WHICH THE GRADER ALSO REACHES (through `procurementScoringSet`). Do NOT re-apply the
  // toggle here. The `config.kcEnabled ? … : []` ternary that used to sit on this line was
  // one of THREE copies — here, in report.ts and in submitKcAnswer — while the resolver
  // itself ignored it. That is the shape scorecard and forecast each shipped a real bug in;
  // procurement's copies happened to agree, which is luck rather than design (spec §5).
  const kc = resolveBuiltIns(config, 'kc')
  const prep = resolveBuiltIns(config, 'prep')
  const debrief = resolveBuiltIns(config, 'debrief')
  // Added questions, whitelisted field by field — never spread, so a stored `correct_value`
  // cannot ride along. ⚠ SHUFFLED PER STUDENT, like the built-ins.
  const addedPre = addedToClientKcQuestions(config, participantId, 'kc')

  const answers = (pData.kc_static_answers ?? {}) as Record<string, unknown>
  const freeText = (pData.free_text_answers ?? {}) as Record<string, unknown>

  return {
    ok: true as const,
    kcEnabled: config.kcEnabled,
    kc: [...toClientQuestions(kc, participantId), ...addedPre],
    kcAnswered: [...kc.map(q => q.id), ...addedPre.map(q => q.field)]
      .filter(id => answers[id] != null),
    /** ⚠ COMPUTED from the VISIBLE GRADED set — built-ins AND additions — by the SAME
     *  function the grader's denominator comes from. The `kcEnabled` ternary that used to
     *  wrap this is gone: the resolver gates it now. */
    gradedTotal: procurementScoringSet(config).length,
    /** Asked BEFORE play — the student's plan, written down so they can compare it. */
    prep: toClientQuestions(prep, participantId),
    prepAnswered: prep.filter(q => freeText[q.id] != null).map(q => q.id),
    /** Asked AFTER the final results screen. */
    debrief: toClientQuestions(debrief, participantId),
    debriefAnswered: debrief.filter(q => freeText[q.id] != null).map(q => q.id),
    /**
     * ⚠⚠ THE TWO STAGES, IN ORDER, AS THE FLOW RENDERS THEM. `pre` is the graded built-ins,
     * the prep paragraph and any pre-play addition; `debrief` is the debrief paragraph and
     * any addition assigned there. The legacy `kc` / `prep` / `debrief` fields above are kept
     * so nothing still reading them breaks, and the flow reads these.
     *
     * ⚠ ANSWERED IS READ FROM TWO MAPS, because the kinds submit to two callables: a
     * `free-text` row lands in `free_text_answers` (procurementSubmitFreeText) and an
     * `authored`/`added` one in `kc_static_answers` (procurementSubmitKcAnswer). Presence of
     * the key IS "answered", and the client resumes at the first row whose flag is false.
     */
    stages: {
      pre: stageToClient(procurementPreStage(config), participantId).map(r => ({
        ...r,
        answered: r.kind === 'free-text' ? freeText[r.field] != null : answers[r.field] != null,
      })),
      debrief: stageToClient(procurementDebriefStage(config), participantId).map(r => ({
        ...r,
        answered: r.kind === 'free-text' ? freeText[r.field] != null : answers[r.field] != null,
      })),
    },
  }
})
