import { onCall } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import { extractInstructorGameId } from '@mygames/game-server'
import {
  SCORECARD_CORS_ORIGINS, INSTANCES_COLLECTION, PARTICIPANTS_SUBCOLLECTION, renderLabel,
} from './config'
import { loadInstance } from './instance'
import { parseStoredContracts, fullSchedule, type StoredContract } from './state'
import { clientParams } from './clientState'
import { freeTextQuestions } from './questions'
import { inducedBehaviour, policyGridPanels } from './validate'
import { optimalProfile } from './dp'
import {
  contractsIn, highEffortRate, effortByPeriod, effortByRound, effortGap, meanEarnings,
  bonusesWon, periodsPaidAfterDead, effortSpend, gapDistribution, classEffortByPeriod,
  contestedEffortRate, contestedEffortGap, contestedPeriodCount,
} from './stats'
import { splitPopulation, isBot } from './botFilter'

// ═══════════════════════════════════════════════════════════════════════════════
// scorecardGetReport (instructor) — the single instructor-facing data source, feeding
// the dashboard roster (Tier 1), the debrief export (Tier 2) and all four Tier-3 charts.
// One callable, one read of the instance, as every other game in the family does.
//
// ⚠ THIS RESPONSE CARRIES THE TREATMENT AND THE DP, and that is correct. Spec §8
// withholds the design from the STUDENT, not from the instructor; spec §11 chart 4 IS the
// optimal policy. It is behind an instructor session (`extractInstructorGameId`), and no
// student screen imports from here.
//
// ⚠⚠ BUT THE DP IS CONFINED TO WHERE §11 PUTS IT (decided 08-07):
//   • chart 4's policy grid — the whole point of that chart
//   • chart 2's optional dashed overlay — DEFAULT OFF, an instructor toggle
//   • the summary box's per-condition optimum
// It is NOT in the Tier-1 roster. The benchmark-ratio columns are REMOVED: the comparison
// that matters is a student against themselves across conditions, not against a program
// they were never asked to solve.
//
// ⚠ CORRECT ON PARTIAL DATA. Elena opens this mid-week with the class spread across the
// assignment. Every aggregate is over who actually played, every point carries its own
// denominator, and every rate is null rather than 0 on an empty cohort (stats.ts).
// ═══════════════════════════════════════════════════════════════════════════════

/** One student, as the dashboard and Tier 1 render them (spec §11). */
export interface ScorecardReportParticipant {
  participant_id: string
  name: string | null
  launched: boolean
  completed: boolean
  finalized: boolean
  contracts_completed: number
  total_earnings: number
  /** ⚠ INSTRUCTOR-ONLY. The arm this student was counterbalanced into. */
  starts_with: 'high' | 'low' | null
  // ── Paired per-condition columns (spec §11) ──────────────────────────────
  high_effort_rate_high: number | null
  high_effort_rate_low: number | null
  /**
   * ⚠⚠ THE HEADLINE (spec §11) — measured over CONTESTED periods only. Null when either
   * condition had none. Never 0 for an absent condition (stats.ts).
   */
  contested_gap: number | null
  contested_rate_high: number | null
  contested_rate_low: number | null
  contested_periods_high: number
  contested_periods_low: number
  /**
   * ⚠ SECONDARY ONLY. The raw all-period gap, retained because a large raw gap beside a
   * near-zero contested one IS the deadness artifact made legible. Never sorted on by
   * default, never what chart 3 distributes.
   */
  effort_gap: number | null
  earnings_high: number | null
  earnings_low: number | null
  bonuses_high: number
  bonuses_low: number
  /** Spec §11. ⚠ Strict `isDead`, not `isWrittenOff` (BUILD_NOTES §1a). */
  periods_paid_after_dead: number
  knowledge_check_score: number | null
  participation_score: number | null
  /** §10 step 1 — captured BEFORE the reveal, ungraded. */
  noticing: string | null
  /** §10 step 3 — ⚠ GRADED BY ELENA OFFLINE, never scored in game. */
  linking: string | null
  /** ⚠ Spec §11: a human in a cohort that also contains bots is MARKED. */
  from_bot_cohort: boolean
}

export const scorecardGetReport = onCall({ cors: SCORECARD_CORS_ORIGINS }, async (request) => {
  const data = request.data as Record<string, unknown>
  const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true'
  const authHeader = request.rawRequest.headers.authorization as string | undefined

  const gameInstanceId = await extractInstructorGameId(data, isEmulator, authHeader)

  const db = admin.firestore()
  const instanceRef = db.collection(INSTANCES_COLLECTION).doc(gameInstanceId)

  const [participantsSnap, instanceSnap, instance] = await Promise.all([
    instanceRef.collection(PARTICIPANTS_SUBCOLLECTION).get(),
    instanceRef.get(),
    loadInstance(db, gameInstanceId),
  ])

  const { config, truth } = instance
  const scored = instanceSnap.data()?.finalized === true
  const freeTextQs = freeTextQuestions(config)

  // ═══════════════════════════════════════════════════════════════════════════
  // ⚠⚠ HUMANS ONLY — TIER 1 **AND** ALL FOUR CHARTS (spec §11, decided 08-07).
  //
  // An earlier version had Tier 3 include bots so a robot cohort would produce non-empty
  // charts. That was wrong, and it reached further than the charts: THE §10 STUDENT REVEAL
  // DRAWS ITS CLASS AVERAGE FROM THE SAME POPULATION, so bots in charts 1 and 2 meant
  // students were being compared against robots — on a screen with no banner.
  //
  // One rule, applied once, in botFilter.ts. The only concession is the DEMO FALLBACK:
  // with ZERO humans the instructor charts render bot data behind a banner rather than
  // four empty panels. That fallback is instructor-only and never reaches a student.
  // ═══════════════════════════════════════════════════════════════════════════
  const all = participantsSnap.docs.map(d => ({ id: d.id, data: d.data() }))
  const split = splitPopulation(all, config, parseStoredContracts)
  const humans = all.filter(x => !isBot(x.id, x.data))
  const hasBots = split.botCount > 0

  const participants: ScorecardReportParticipant[] = humans.map(({ id, data: p }) => {
    const contracts = parseStoredContracts(p.contracts, config)
    const freeText = (p.free_text_answers ?? {}) as Record<string, { answer?: unknown }>
    const textOf = (id: string) => {
      const a = freeText[id]?.answer
      return typeof a === 'string' ? a : null
    }
    const startsWith = p.starts_with === 'high' || p.starts_with === 'low' ? p.starts_with : null
    const hiContracts = contractsIn(contracts, 'high', config)
    const loContracts = contractsIn(contracts, 'low', config)

    return {
      participant_id: id,
      name: (p.name as string | undefined) ?? null,
      launched: contracts.length > 0 || p.starts_with != null,
      completed: p.finished_at != null,
      finalized: p.finalized_at != null,
      contracts_completed: contracts.filter(c => c.periods.length >= config.periodsPerContract).length,
      total_earnings: typeof p.total_earnings === 'number' ? p.total_earnings : 0,
      starts_with: startsWith,
      high_effort_rate_high: highEffortRate(contractsIn(contracts, 'high', config)),
      high_effort_rate_low: highEffortRate(contractsIn(contracts, 'low', config)),
      contested_gap: contestedEffortGap(contracts, config),
      contested_rate_high: contestedEffortRate(hiContracts, config),
      contested_rate_low: contestedEffortRate(loContracts, config),
      contested_periods_high: contestedPeriodCount(hiContracts, config),
      contested_periods_low: contestedPeriodCount(loContracts, config),
      effort_gap: effortGap(contracts, config),
      earnings_high: meanEarnings(contracts, 'high', config),
      earnings_low: meanEarnings(contracts, 'low', config),
      bonuses_high: bonusesWon(contracts, 'high', config),
      bonuses_low: bonusesWon(contracts, 'low', config),
      periods_paid_after_dead: periodsPaidAfterDead(contracts, config),
      knowledge_check_score: typeof p.knowledge_check_score === 'number' ? p.knowledge_check_score : null,
      participation_score: typeof p.normalized_score === 'number' ? p.normalized_score : null,
      noticing: textOf(freeTextQs[0].id),
      linking: textOf(freeTextQs[1].id),
      // ⚠ Marked, not hidden. The roster is where a mixed cohort should be visible.
      from_bot_cohort: hasBots,
    }
  })

  // ── Tier 3 ────────────────────────────────────────────────────────────────
  // ⚠ HUMANS (or, with zero humans, the demo cohort — see the block above).
  const played = split.chartPopulation.filter(p => p.contracts.length > 0)

  /** Class effort per condition, for the summary box. */
  const classRate = (condition: 'high' | 'low') =>
    highEffortRate(played.flatMap(p => contractsIn(p.contracts, condition, config)))
  const classEarn = (condition: 'high' | 'low') => {
    const earned = played
      .flatMap(p => contractsIn(p.contracts, condition, config))
      .map(c => c.earnings)
      .filter((e): e is number => typeof e === 'number')
    return earned.length === 0 ? null : earned.reduce((s, e) => s + e, 0) / earned.length
  }

  const induced = inducedBehaviour(config, truth)

  return {
    ok: true as const,
    scored,
    /** The student-safe params, so the dashboard reads the same numbers students saw. */
    params: clientParams(config),
    /**
     * ⚠ INSTRUCTOR-ONLY: the treatment. Both reliabilities, both labels, the schedule.
     * Needed for every chart caption (R7 — captions follow config).
     */
    treatment: {
      reliabilityHigh: truth.reliabilityHigh,
      reliabilityLow: truth.reliabilityLow,
      reliabilitySchedule: truth.reliabilitySchedule,
      labelHigh: renderLabel(truth, 'high'),
      labelLow: renderLabel(truth, 'low'),
      /** Both arms' schedules, so the dashboard can show what each half faced. */
      scheduleStartingHigh: fullSchedule('high', config, truth),
      scheduleStartingLow: fullSchedule('low', config, truth),
    },
    participants,
    /** ⚠ Spec §11: bots never appear above, but their COUNT is reported so a caption
     *  can say the cohort is mixed. */
    botCount: split.botCount,
    /** §10's two prompts, so Tier 2 can head each report with the question asked. */
    freeTextQuestions: freeTextQs.map(q => ({
      id: q.id, step: q.step, prompt: q.prompt, followUps: q.followUps, gradedNote: q.gradedNote,
    })),
    /** ⚠ Instructor-only: with zero humans the charts show ROBOT data behind a banner. */
    isDemoCohort: split.isDemoCohort,
    humanCount: split.humanCount,

    tier3: {
      /** Chart 1 — effort by CONTRACT ROUND, two series. Reproduces slide 7. */
      byRound: {
        high: effortByRound(played, 'high', config),
        low: effortByRound(played, 'low', config),
      },
      /** Chart 2 — effort by PERIOD within a contract, two series. */
      byPeriod: {
        high: classEffortByPeriod(played, 'high', config),
        low: classEffortByPeriod(played, 'low', config),
        /**
         * ⚠ THE DP OVERLAY IS OPTIONAL AND DEFAULT OFF (spec §11, 08-07). It ships in
         * the payload so an instructor can toggle it in lecture without a redeploy —
         * "useful to show how far the low-reliability optimum sits, but a rhetorical
         * device for the room, not a standard students are held to." Never rendered on
         * a student screen; there is no student callable that returns it.
         */
        optimalHigh: optimalProfile(config, truth.reliabilityHigh).map(m => m.pHigh),
        optimalLow: optimalProfile(config, truth.reliabilityLow).map(m => m.pHigh),
      },
      /** Chart 3 — distribution of the per-student effort gap. ⚠ R6: exclusions
       *  counted from the data and returned so the legend can reconcile them. */
      // ⚠ HUMANS ONLY. Unlike the two class-average charts, this one plots ONE POINT PER
      // STUDENT — a bot in it is a fake person in a distribution Elena reads as her
      // class, and "a mass at zero is the finding" (spec §11) must be a mass of REAL
      // students. The other Tier-3 charts are aggregates where a bot moves a mean; this
      // one would put a body in a bucket.
      gapDistribution: gapDistribution(split.chartPopulation, config),
      /** Chart 4 — the optimal policy grid. ⚠ LOW LEFT, HIGH RIGHT (spec §11). */
      policyGrid: policyGridPanels(config, truth),
    },

    /** The §11 summary box. */
    summary: {
      classEffortHigh: classRate('high'),
      classEffortLow: classRate('low'),
      classEarningsHigh: classEarn('high'),
      classEarningsLow: classEarn('low'),
      /** ⚠ Instructor-side DP, per §11. */
      optimalEffortHigh:
        induced.high.benchmarks.expectedHighEffortPeriods / config.periodsPerContract,
      optimalEffortLow:
        induced.low.benchmarks.expectedHighEffortPeriods / config.periodsPerContract,
      optimalEarningsHigh: induced.high.benchmarks.optimal,
      optimalEarningsLow: induced.low.benchmarks.optimal,
      /** Total ECU the class spent on effort under LOW reliability, against the
       *  per-contract optimum — spec §11's closing figure. */
      lowConditionEffortSpend: played.reduce(
        (s, p) => s + effortSpend(p.contracts, 'low', config), 0,
      ),
      lowConditionOptimalSpendPerContract:
        induced.low.benchmarks.expectedHighEffortPeriods
        * (config.highEffortCost - config.lowEffortCost),
      lowConditionContractsPlayed: played.reduce(
        (s, p) => s + contractsIn(p.contracts, 'low', config).length, 0,
      ),
      studentsWithData: played.length,
    },
  }
})

/** Exported for the harness and the unit tests — the roster shaping, without Firestore. */
export function buildRosterRow(
  participantId: string,
  contracts: readonly StoredContract[],
  config: Parameters<typeof effortGap>[1],
): Pick<ScorecardReportParticipant,
  'participant_id' | 'high_effort_rate_high' | 'high_effort_rate_low' | 'effort_gap'> {
  return {
    participant_id: participantId,
    high_effort_rate_high: highEffortRate(contractsIn(contracts, 'high', config)),
    high_effort_rate_low: highEffortRate(contractsIn(contracts, 'low', config)),
    effort_gap: effortGap(contracts, config),
  }
}

// Silence unused-import lint for the re-exported helper surface used by tests.
export { effortByPeriod }
