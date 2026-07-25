import { onCall } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import { extractInstructorGameId } from '@mygames/game-server'
import {
  PD_CORS_ORIGINS, INSTANCES_COLLECTION, PARTICIPANTS_SUBCOLLECTION, CONFIG_DOC, TRUTH_DOC,
  truthParticipantDoc, loadPdConfig,
} from './config'
import { isStrategy, type Strategy } from './strategy'
import { parseStoredRounds, totals } from './rounds'
import { debriefQuestion } from './questions'
import {
  cooperationByRound, outcomeByFirstMove, cooperationRate, avgYearsPerRound,
  type PdGameRow, type CooperationPoint, type FirstMoveOutcome,
} from './reportStats'

// ═══════════════════════════════════════════════════════════════════════════════
// pdGetReport (instructor) — the single instructor-facing data source, feeding BOTH
// the dashboard roster (Tier 1) and every report tile (Tiers 2 and 3). One callable,
// one read of the instance, exactly as penniesGetReport does.
//
// ⚠ THIS RETURNS THE STRATEGY AND THE ROUND COUNT — deliberately, and safely.
// Both are the things a STUDENT must never see DURING PLAY (spec §3, §5), and no
// student path can reach this function: it is instructor-authenticated through
// extractInstructorGameId, exactly like penniesGetReport returning true_value. The
// debrief reveals the strategy to students afterwards anyway (spec §5, §11). The
// student-facing callables (getState/submitRound/getQuestions) keep their whitelists
// unchanged — this is a different audience, not a relaxed rule.
// ═══════════════════════════════════════════════════════════════════════════════

/** One roster row (Tier 1, Reports Contract). */
export interface PdReportParticipant {
  participant_id: string
  name: string | null
  /** Opened the game at all (pdBootstrap stamped launched_at). */
  launched: boolean
  /** Finished the whole game — the participation criterion (spec §6). */
  completed: boolean
  rounds_played: number
  /** Fraction of their played rounds in which they cooperated. null ⇒ played none. */
  cooperation_rate: number | null
  /** Mean years per round. Lower is better. NEVER graded (spec §6). */
  avg_years: number | null
  student_years_total: number
  bot_years_total: number
  /** The bot they faced. INSTRUCTOR-ONLY. */
  strategy: Strategy | null
  first_move: 'C' | 'D' | null
  knowledge_check_score: number | null
  /** normalized_score — null until Score & Record has run. */
  participation_score: number | null
  /** The debrief paragraph (Tier 2), or null if not written. */
  debrief: string | null
}

export const pdGetReport = onCall({ cors: PD_CORS_ORIGINS }, async (request) => {
  const data = request.data as Record<string, unknown>
  const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true'
  const authHeader = request.rawRequest.headers.authorization as string | undefined

  const gameInstanceId = await extractInstructorGameId(data, isEmulator, authHeader)

  const db = admin.firestore()
  const instanceRef = db.collection(INSTANCES_COLLECTION).doc(gameInstanceId)

  const [participantsSnap, truthSnap, configSnap, instanceSnap] = await Promise.all([
    instanceRef.collection(PARTICIPANTS_SUBCOLLECTION).get(),
    instanceRef.collection('truth').doc(TRUTH_DOC).get(),
    instanceRef.collection('config').doc(CONFIG_DOC).get(),
    instanceRef.get(),
  ])

  const config = loadPdConfig(configSnap.data())
  const roundCount = typeof truthSnap.data()?.rounds === 'number' ? (truthSnap.data()!.rounds as number) : 0
  const scored = instanceSnap.data()?.finalized === true

  // Each student's strategy lives in its OWN truth doc (init.ts), so fetch them in one
  // batch rather than N sequential gets.
  const strategyRefs = participantsSnap.docs.map(d =>
    instanceRef.collection('truth').doc(truthParticipantDoc(d.id)))
  const strategySnaps = strategyRefs.length > 0 ? await db.getAll(...strategyRefs) : []
  const strategyById = new Map<string, Strategy | null>()
  strategySnaps.forEach((snap, i) => {
    const raw = snap.data()?.strategy
    strategyById.set(participantsSnap.docs[i].id, isStrategy(raw) ? raw : null)
  })

  const gameRows: PdGameRow[] = []
  const participants: PdReportParticipant[] = participantsSnap.docs.map(d => {
    const p = d.data()
    const rounds = parseStoredRounds(p.rounds)
    const sums = totals(rounds)
    const strategy = strategyById.get(d.id) ?? null
    const row: PdGameRow = {
      participant_id: d.id,
      moves: rounds.map(r => r.student_move),
      years: rounds.map(r => r.student_years),
      strategy,
    }
    gameRows.push(row)

    const debriefRaw = (p.debrief_answers ?? {})[debriefQuestion.field]
    return {
      participant_id: d.id,
      name: (p.name as string | undefined) ?? null,
      launched: p.launched_at != null,
      completed: p.finished_at != null,
      rounds_played: rounds.length,
      cooperation_rate: cooperationRate(row),
      avg_years: avgYearsPerRound(row),
      student_years_total: sums.student,
      bot_years_total: sums.bot,
      strategy,
      first_move: rounds.length > 0 ? rounds[0].student_move : null,
      knowledge_check_score: typeof p.knowledge_check_score === 'number' ? p.knowledge_check_score : null,
      participation_score: typeof p.normalized_score === 'number' ? p.normalized_score : null,
      debrief: typeof debriefRaw?.answer === 'string' ? debriefRaw.answer : null,
    }
  })

  const charts: { cooperation: CooperationPoint[]; firstMove: FirstMoveOutcome[] } = {
    cooperation: cooperationByRound(gameRows, roundCount),
    firstMove: outcomeByFirstMove(gameRows),
  }

  return {
    ok: true as const,
    scored,
    /** The drawn round count — the cooperation chart's x-axis. Instructor-only. */
    roundCount,
    payoffs: config.payoffs,
    labels: config.labels,
    participants,
    charts,
    debriefPrompt: debriefQuestion.prompt,
  }
})
