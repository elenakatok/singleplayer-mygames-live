import { onCall } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import { extractStudentOnCallIds } from '@mygames/game-server'
import {
  SCORECARD_CORS_ORIGINS, INSTANCES_COLLECTION, PARTICIPANTS_SUBCOLLECTION,
} from './config'
import { loadInstance } from './instance'
import {
  scorecardKcQuestions, questionsForStage, toClientKcQuestions, addedToClientKcQuestions,
  kcDenominator, noticingQuestion, linkingQuestion,
} from './questions'

// ═══════════════════════════════════════════════════════════════════════════════
// scorecardGetQuestions (student) — the split knowledge check (§9) and the two free-text
// steps (§10), plus which of them this student has already answered.
//
// ⚠⚠ THE PRE AND POST SETS ARE RETURNED SEPARATELY AND MUST NEVER BE MERGED. The split is
// the point (spec §9): the strategy questions moved after play because asking them first
// TAUGHT THE ANSWER BEFORE MEASURING THE BEHAVIOUR. A client that concatenated the two
// arrays and rendered them up front would silently undo the decision — so they arrive as
// two fields with two names, not one list with a flag to filter on.
//
// ⚠ THE ANSWER KEY NEVER SHIPS. `toClientKcQuestions` drops `correctOptionId` and
// `explanation`; the explanation is EARNED by answering.
//
// ⚠ NOR DOES THE POSITION OF THE ANSWER. Every question is AUTHORED with its correct
// option first; `toClientKcQuestions` permutes the options per (participant, question), so
// the served order carries no signal. Both stages get it — a shuffle applied to `pre` and
// forgotten on `post` would leave four questions answerable without reading them.
//
// ⚠ NOTHING PRE-PLAY STATES THAT A TARGET CAN BECOME UNREACHABLE (spec §9.1). Q8 asks it,
// and Q8 is in the POST set.
// ═══════════════════════════════════════════════════════════════════════════════

export const scorecardGetQuestions = onCall({ cors: SCORECARD_CORS_ORIGINS }, async (request) => {
  const data = request.data as Record<string, unknown>
  const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true'
  const authHeader = request.rawRequest.headers.authorization as string | undefined

  const { participantId, gameInstanceId } = await extractStudentOnCallIds(data, isEmulator, authHeader)

  const db = admin.firestore()
  const { config, truth } = await loadInstance(db, gameInstanceId)

  const snap = await db
    .collection(INSTANCES_COLLECTION).doc(gameInstanceId)
    .collection(PARTICIPANTS_SUBCOLLECTION).doc(participantId)
    .get()
  const pData = snap.data() ?? {}

  const all = scorecardKcQuestions(config, truth)
  const answered = (pData.kc_answers ?? {}) as Record<string, { answer?: unknown }>
  const freeText = (pData.free_text_answers ?? {}) as Record<string, unknown>

  // ⚠⚠ `kcEnabled: false` EMPTIES BOTH STAGES RATHER THAN ADDING A CLIENT BRANCH.
  //
  // The flow in Play.tsx already advances past an empty stage at every point it can reach
  // one — resume skips `kc-pre` when `pre` has no unanswered question, and the reveal goes
  // straight to `linking` when `post` is empty. Returning two empty arrays therefore skips
  // the KC everywhere, INCLUDING a resume mid-flow, with no client change at all.
  //
  // ⚠ That matters more here than in the other four games: §10's ordering
  // (noticing → REVEAL → linking) is enforced by MECHANISM on the server — `linking` is
  // refused until `noticing` is stored, and the reveal is returned only by the noticing
  // submit. A `kcEnabled` branch in the client would be a second place that decides
  // sequence, and the two could disagree. There is no such branch.
  const pre = config.kcEnabled ? questionsForStage(all, 'pre') : []
  const post = config.kcEnabled ? questionsForStage(all, 'post') : []
  const added = config.kcEnabled ? config.addedKcQuestions : []

  const noticing = noticingQuestion(config)
  const linking = linkingQuestion(config)

  // ⚠ APPENDED, so instructor questions come after the built-in four of §9.2 — "asked
  // after the built-in ten", the same placement pd and pricing give theirs.
  const postClient = [
    ...toClientKcQuestions(post, participantId),
    ...addedToClientKcQuestions(added, participantId),
  ]

  return {
    ok: true as const,
    kc: {
      /** Whether this instance has a knowledge check at all. */
      enabled: config.kcEnabled,
      /** Asked BEFORE the contracts begin. ⚠ Built-in only — §9.1 keeps this set closed. */
      pre: toClientKcQuestions(pre, participantId),
      /** ⚠ Asked only AFTER the §10 reveal. Never rendered before it. */
      post: postClient,
      /** ⚠ DYNAMIC denominator over BOTH stages AND the graded additions. */
      total: kcDenominator(config.kcEnabled ? all : [], added),
      preTotal: pre.length,
      postTotal: postClient.length,
      answeredIds: Object.keys(answered),
      score: typeof pData.knowledge_check_score === 'number' ? pData.knowledge_check_score : null,
      complete: pData.knowledge_check_completed_at != null,
    },
    /** §10's two free-text steps, in order. Step 2 (the reveal) sits between them. */
    freeText: {
      noticing: {
        id: noticing.id,
        prompt: noticing.prompt,
        followUps: noticing.followUps,
        answered: freeText[noticing.id] != null,
      },
      linking: {
        id: linking.id,
        prompt: linking.prompt,
        followUps: linking.followUps,
        answered: freeText[linking.id] != null,
      },
    },
  }
})
