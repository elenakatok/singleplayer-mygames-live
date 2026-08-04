import { onCall } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import { extractInstructorGameId } from '@mygames/game-server'
import {
  PROCUREMENT_CORS_ORIGINS, INSTANCES_COLLECTION, PARTICIPANTS_SUBCOLLECTION, CONFIG_DOC,
  loadProcurementConfig,
} from './config'
import { KC_POOL_IDS, defaultVisibleFor, gradedFor, resolveQuestions } from './questions'
import {
  parseStoredRounds, toClientHistory, totalProfit, roundsWon, toReportRivalPoints,
} from './rounds'

// ═══════════════════════════════════════════════════════════════════════════════
// procurementGetReport (instructor) — every report tier in ONE call, as the rest of the
// single-player family does. The instructor is authenticated; nothing here is
// student-reachable, so the whitelisting discipline that governs the student callables
// does not apply — this may (and does) carry figures a student must never see.
//
// ⚠⚠ TIER 2 IS THE SPAWN GATE, AND IT IS ONE REPORT PER FREE-TEXT QUESTION. This game
// has FOUR across the two formats — S8/S9 sealed, O9/O10 open — and the game does not
// pass verification until all four exist. `freeText` below is keyed by question id and is
// built from the pool, so a question added later gets its report automatically rather
// than needing one retrofitted.
//
// ⚠ TIER 3 DATA IS SERVED HERE, NOT COMPUTED ON THE CLIENT: each student's (cost, bid)
// pairs, on `rows[].rounds`, so the class scatter can plot them against the 45° and
// optimal lines. The line's PARAMETERS travel with the report too (see the return), so
// two instances with different rival ranges cannot end up sharing one line.
//
// ⚠⚠ TIER 3 DOES CARRY RIVAL COSTS, AND THAT CHANGED ON 2026-08-03. Until then this
// header said it never would — §12's class scatter was students' bids against students'
// costs, with the bots represented by the optimal LINE. Elena asked for the simulated
// rivals to be PLOTTED as their own series, coloured by whether they won, so
// `rows[].rivalPoints` now carries (cost, bid, won) per rival per round.
//
// ⚠ THIS DOES NOT TOUCH §4. This callable is instructor-authenticated and nothing it
// returns reaches a student. The STUDENT path's rival reveal is a different payload
// (`getState.revealRivalPoints`), still gated per student on `finished_at`, and the
// harness asserts that gate independently — including that opening this report does not
// open it.
//
// ⚠ RESOLVED ROUNDS ONLY, structurally: these come off the stored round record, and a
// round is only there once it resolved. A mid-game student contributes what they have
// finished and nothing else.
// ═══════════════════════════════════════════════════════════════════════════════

export const procurementGetReport = onCall({ cors: PROCUREMENT_CORS_ORIGINS }, async (request) => {
  const data = request.data as Record<string, unknown>
  const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true'
  const authHeader = request.rawRequest.headers.authorization as string | undefined

  const gameInstanceId = await extractInstructorGameId(data, isEmulator, authHeader)

  const db = admin.firestore()
  const instanceRef = db.collection(INSTANCES_COLLECTION).doc(gameInstanceId)
  const [configSnap, instanceSnap, participantsSnap] = await Promise.all([
    instanceRef.collection('config').doc(CONFIG_DOC).get(),
    instanceRef.get(),
    instanceRef.collection(PARTICIPANTS_SUBCOLLECTION).get(),
  ])

  const config = loadProcurementConfig(configSnap.data(), KC_POOL_IDS, defaultVisibleFor)
  /** ⚠ COMPUTED, not stored — the same call the grader makes. A report that printed a
   *  stored denominator could disagree with the score beside it. */
  const gradedTotal = config.kcEnabled ? gradedFor(config.format, config.kcVisible).length : 0

  /** The free-text questions this instance asks, in flow order: prep, then debrief.
   *  Their PROMPTS travel with the report so each Tier-2 tile is captioned with the
   *  question it answers rather than a bare id. */
  const textQuestions = [
    ...resolveQuestions(config.format, config.kcVisible, 'prep'),
    ...resolveQuestions(config.format, config.kcVisible, 'debrief'),
  ]

  const rows = participantsSnap.docs.map(d => {
    const p = d.data()
    const rounds = parseStoredRounds(p.rounds)
    return {
      participantId: d.id,
      name: (p.name as string | undefined) ?? null,
      externalId: (p.external_id as string | undefined) ?? null,
      finished: p.finished_at != null,
      roundsPlayed: rounds.length,
      roundsWon: roundsWon(rounds),
      profitTotal: totalProfit(rounds),
      knowledgeCheckScore: typeof p.knowledge_check_score === 'number' ? p.knowledge_check_score : null,
      rawScore: typeof p.raw_score === 'number' ? p.raw_score : null,
      normalizedScore: typeof p.normalized_score === 'number' ? p.normalized_score : null,
      /** Tier 1b — this student's rounds, in full. */
      rounds: toClientHistory(rounds),
      /** ⚠ TIER 3 — the simulated rivals this student faced, for the class chart's
       *  rival series (Elena, 08-03). INSTRUCTOR-ONLY; the student path's own reveal is
       *  gated on `finished_at` and is untouched by this. */
      rivalPoints: toReportRivalPoints(rounds),
      /** ⚠ TIER 2 — EVERY free-text answer, keyed by question id. Not just the debrief:
       *  the prep paragraph is a Tier-2 question too, and the pair is the point — the
       *  plan beside what actually happened. */
      freeText: (() => {
        const ft = (p.free_text_answers ?? {}) as Record<string, { answer?: unknown }>
        const out: Record<string, string> = {}
        for (const q of textQuestions) {
          const a = ft[q.id]?.answer
          if (typeof a === 'string') out[q.id] = a
        }
        return out
      })(),
    }
  })

  return {
    ok: true as const,
    /** Echoed so the report header can say which mechanism produced these numbers —
     *  the two formats are two instances and their results are not comparable rows in
     *  one table. */
    format: config.format,
    rounds: config.rounds,
    reserve: config.reserve,
    /**
     * ⚠⚠ THE TIER-3 CHART'S LINE IS DERIVED FROM THESE, PER INSTANCE. β needs θmax and
     * n, not just the reserve — and this file's own earlier note had the formula wrong
     * (`c + (reserve − c)/n`), which is right ONLY at the default reserve, where
     * reserve = rivalCostMax. Two instances with different rival ranges or bidder counts
     * must not share one line, and this is the chart Elena presents in lecture.
     *
     * Served rather than left to the client to assume, for the same reason the student
     * scatter takes them from `params`: a hardcoded line still looks like a line.
     */
    rivalCostMin: config.rivalCostDist.min,
    rivalCostMax: config.rivalCostDist.max,
    playerCostMin: config.playerCostDist.min,
    playerCostMax: config.playerCostDist.max,
    rivalCount: config.rivalCount,
    /** n — TOTAL bidders. Derived here so no chart re-derives it and gets the +1 wrong. */
    totalBidders: config.rivalCount + 1,
    currencyLabel: config.currencyLabel,
    gradedTotal,
    finalized: instanceSnap.data()?.finalized === true,
    /** ⚠ ONE ENTRY PER TIER-2 TILE. The Reports page renders from this, so a question
     *  switched on in Settings gets a tile with no code change. */
    textQuestions: textQuestions.map(q => ({ field: q.id, stage: q.stage, prompt: q.prompt })),
    rows,
  }
})
