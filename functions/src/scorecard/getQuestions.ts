import { onCall } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import { extractStudentOnCallIds } from '@mygames/game-server'
import {
  SCORECARD_CORS_ORIGINS, INSTANCES_COLLECTION, PARTICIPANTS_SUBCOLLECTION,
} from './config'
import { loadInstance } from './instance'
import {
  scorecardKcQuestions, questionsForStage, toClientKcQuestions, kcDenominator,
  noticingQuestion, linkingQuestion,
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
  const pre = questionsForStage(all, 'pre')
  const post = questionsForStage(all, 'post')
  const answered = (pData.kc_answers ?? {}) as Record<string, { answer?: unknown }>
  const freeText = (pData.free_text_answers ?? {}) as Record<string, unknown>

  const noticing = noticingQuestion(config)
  const linking = linkingQuestion(config)

  return {
    ok: true as const,
    kc: {
      /** Asked BEFORE the contracts begin. */
      pre: toClientKcQuestions(pre),
      /** ⚠ Asked only AFTER the §10 reveal. Never rendered before it. */
      post: toClientKcQuestions(post),
      /** ⚠ DYNAMIC denominator over BOTH stages — never a hardcoded count. */
      total: kcDenominator(all),
      preTotal: pre.length,
      postTotal: post.length,
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
