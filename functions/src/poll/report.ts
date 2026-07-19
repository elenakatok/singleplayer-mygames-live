import { onCall } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import { extractInstructorGameId } from '@mygames/game-server'
import {
  POLL_CORS_ORIGINS, INSTANCES_COLLECTION, PARTICIPANTS_SUBCOLLECTION, CONFIG_DOC,
  loadQuestions,
} from './config'

// ═══════════════════════════════════════════════════════════════════════════════
// pollGetReport (instructor) — TYPE-DERIVED reports (Poll spec §7): the report shape
// for a question is DERIVED FROM ITS TYPE, so an instructor-authored question gets a
// working report with zero per-question build work. ONE report per VISIBLE question,
// in order:
//   text → an answers table (participant, answer)
//   mc   → a pie chart (a slice per option, IN DEFINED ORDER, with counts)
// Plus a response-status view (who has / hasn't responded). Instructor-only; nothing
// here is graded and no student path calls it.
// ═══════════════════════════════════════════════════════════════════════════════

type StoredAnswer = { value?: unknown }

export interface TextAnswerRow { participant_id: string; name: string | null; value: string }
export interface TextReport { id: string; type: 'text'; prompt: string; answers: TextAnswerRow[] }
export interface McSlice { value: string; label: string; count: number }
export interface McReport { id: string; type: 'mc'; prompt: string; total: number; slices: McSlice[] }
export type QuestionReport = TextReport | McReport

export interface ResponseRow {
  participant_id: string
  name: string | null
  answered: number
  total: number
  completed: boolean
}

export const pollGetReport = onCall({ cors: POLL_CORS_ORIGINS }, async (request) => {
  const data = request.data as Record<string, unknown>
  const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true'
  const authHeader = request.rawRequest.headers.authorization as string | undefined

  const gameInstanceId = await extractInstructorGameId(data, isEmulator, authHeader)

  const db = admin.firestore()
  const instanceRef = db.collection(INSTANCES_COLLECTION).doc(gameInstanceId)
  const [configSnap, participantsSnap] = await Promise.all([
    instanceRef.collection('config').doc(CONFIG_DOC).get(),
    instanceRef.collection(PARTICIPANTS_SUBCOLLECTION).get(),
  ])

  const visible = loadQuestions(configSnap.data()).filter(q => q.visible)
  const visibleIds = visible.map(q => q.id)

  const participants = participantsSnap.docs.map(d => {
    const p = d.data()
    return {
      participant_id: d.id,
      name: (p.name as string | undefined) ?? null,
      answers: (p.answers ?? {}) as Record<string, StoredAnswer>,
    }
  })

  // One report per visible question, shape chosen by type.
  const reports: QuestionReport[] = visible.map(q => {
    if (q.type === 'mc') {
      const counts = new Map<string, number>()
      for (const p of participants) {
        const a = p.answers[q.id]
        if (a && typeof a.value === 'string') counts.set(a.value, (counts.get(a.value) ?? 0) + 1)
      }
      const slices: McSlice[] = (q.options ?? []).map(o => ({ value: o.value, label: o.label, count: counts.get(o.value) ?? 0 }))
      const total = slices.reduce((s, x) => s + x.count, 0)
      return { id: q.id, type: 'mc', prompt: q.prompt, total, slices }
    }
    const answers: TextAnswerRow[] = []
    for (const p of participants) {
      const a = p.answers[q.id]
      if (a && typeof a.value === 'string') answers.push({ participant_id: p.participant_id, name: p.name, value: a.value })
    }
    return { id: q.id, type: 'text', prompt: q.prompt, answers }
  })

  // Response status — who has answered how many of the visible questions.
  const responseStatus: ResponseRow[] = participants.map(p => {
    const answered = visibleIds.filter(id => p.answers[id] != null).length
    return { participant_id: p.participant_id, name: p.name, answered, total: visibleIds.length, completed: answered === visibleIds.length && visibleIds.length > 0 }
  })

  return { ok: true as const, reports, responseStatus, totalParticipants: participants.length }
})
