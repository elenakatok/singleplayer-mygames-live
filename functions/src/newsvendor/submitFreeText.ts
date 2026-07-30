import { onCall, HttpsError } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import { FieldValue } from 'firebase-admin/firestore'
import { extractStudentOnCallIds } from '@mygames/game-server'
import {
  NEWSVENDOR_CORS_ORIGINS, INSTANCES_COLLECTION, PARTICIPANTS_SUBCOLLECTION, CONFIG_DOC,
  loadNewsvendorConfig,
} from './config'
import { prepQuestion, debriefQuestion } from './questions'

// ═══════════════════════════════════════════════════════════════════════════════
// newsvendorSubmitFreeText (student) — the two open-ended paragraphs (spec §8):
// the PREP, answered before play, and the DEBRIEF, answered after. UNGRADED: no
// correctness, no score, no feedback.
//
// ⚠ ONE CALLABLE, TWO FIELDS — and this is the one place this game's shape differs
// from pricing's, which has a single `pricingSubmitDebrief`. Newsvendor asks two
// free-text questions at opposite ends of the flow, and they are otherwise identical
// in every respect that matters here: same storage map, same one-shot lock, same
// ungraded-by-construction property, same Tier-2 export. Two callables would be the
// same seventy lines twice, and a bug fixed in one of them. The FIELD is therefore a
// parameter — validated against a closed whitelist, so it can only ever be one of the
// two questions this game actually asks.
//
// Stored under `free_text_answers` keyed by field. Each field gets its OWN Tier-2
// report (spec §8, last line): the prep and the debrief are different questions, not
// a before/after pair of one question, and Elena reads them side by side.
//
// Ungraded BY CONSTRUCTION, not by convention: neither question carries `grading` or
// `correct_value` (questions.ts), so neither can enter calcKCScore's denominator, and
// this callable never touches knowledge_check_score.
//
// One-shot, like every other submit in the family: an existing answer is returned
// rather than overwritten, inside a transaction.
// ═══════════════════════════════════════════════════════════════════════════════

/** Bound so a runaway paste cannot push the participant doc toward the 1 MiB limit. */
const MAX_LENGTH = 5000

export const newsvendorSubmitFreeText = onCall({ cors: NEWSVENDOR_CORS_ORIGINS }, async (request) => {
  const data = request.data as Record<string, unknown>
  const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true'
  const authHeader = request.rawRequest.headers.authorization as string | undefined

  const { participantId, gameInstanceId } = await extractStudentOnCallIds(data, isEmulator, authHeader)

  const field = data.field
  if (field !== prepQuestion.field && field !== debriefQuestion.field) {
    throw new HttpsError('invalid-argument', `'${String(field)}' is not a free-text question in this game.`)
  }

  const raw = data.answer
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new HttpsError('invalid-argument', 'Please write a few sentences before submitting.')
  }
  const answer = raw.trim().slice(0, MAX_LENGTH)

  const db = admin.firestore()
  const instanceRef = db.collection(INSTANCES_COLLECTION).doc(gameInstanceId)

  const configSnap = await instanceRef.collection('config').doc(CONFIG_DOC).get()
  const config = loadNewsvendorConfig(configSnap.data())
  // Each question has its own on/off switch, so an instructor who drops the prep
  // still gets the debrief.
  const enabled = field === prepQuestion.field ? config.prepEnabled : config.debriefEnabled
  if (!enabled) {
    throw new HttpsError('failed-precondition', 'That question is not part of this game.')
  }

  const participantRef = instanceRef.collection(PARTICIPANTS_SUBCOLLECTION).doc(participantId)

  const result = await db.runTransaction(async (tx) => {
    const snap = await tx.get(participantRef)
    const pData = snap.data() ?? {}
    const existing = (pData.free_text_answers ?? {}) as Record<string, { answer: string }>

    if (existing[field] != null) {
      return { stored: true as const, answer: existing[field].answer }
    }

    tx.set(participantRef, {
      participant_id: participantId,
      game_instance_id: gameInstanceId,
      free_text_answers: { [field]: { answer, submitted_at: FieldValue.serverTimestamp() } },
    }, { merge: true })

    return { stored: false as const, answer }
  })

  return { ok: true as const, field, ...result }
})
