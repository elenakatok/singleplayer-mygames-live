import { onCall } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import { extractInstructorGameId } from '@mygames/game-server'
import {
  SCORECARD_CORS_ORIGINS, INSTANCES_COLLECTION, PARTICIPANTS_SUBCOLLECTION, renderLabel,
} from './config'
import { loadInstance } from './instance'
import { parseStoredContracts, fullSchedule, type StoredContract } from './state'
import { clientParams } from './clientState'
import { scorecardDebriefQuestion } from './questions'
import { inducedBehaviour, policyGridPanels } from './validate'
import { optimalProfile } from './dp'
import {
  contractsIn, highEffortRate, effortByPeriod, effortByRound, effortGap, meanEarnings,
  bonusesWon, periodsPaidAfterDead, effortSpend, gapDistribution, classEffortByPeriod,
  type ParticipantContracts,
} from './stats'

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

/**
 * ⚠ IS THIS PARTICIPANT A BOT? Spec §11: "Bots never appear; humans from bot-filled
 * cohorts appear with a marker."
 *
 * Two signals, because the robot driver identifies itself differently in its two modes:
 * a dry run against the emulator uses dev `?_pid=robot-N` params, while a production run
 * mints a real classroom token and the launcher stamps `is_robot`. Checking both means a
 * cohort is filtered correctly either way — and a false negative here would put a
 * simulated student on a roster Elena grades from.
 */
export function isBot(participantId: string, data: Record<string, unknown>): boolean {
  return data.is_robot === true || /^robot-/i.test(participantId)
}

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
  /** ⚠ THE HEADLINE. Null when only one condition was played — never 0 (stats.ts). */
  effort_gap: number | null
  earnings_high: number | null
  earnings_low: number | null
  bonuses_high: number
  bonuses_low: number
  /** Spec §11. ⚠ Strict `isDead`, not `isWrittenOff` (BUILD_NOTES §1a). */
  periods_paid_after_dead: number
  knowledge_check_score: number | null
  participation_score: number | null
  debrief: string | null
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
  const debriefQ = scorecardDebriefQuestion(config)

  // ── Split bots from humans ONCE, up front (spec §11) ──────────────────────
  const all = participantsSnap.docs.map(d => ({ id: d.id, data: d.data() }))
  const botCount = all.filter(x => isBot(x.id, x.data)).length
  const humans = all.filter(x => !isBot(x.id, x.data))
  const hasBots = botCount > 0

  // ═══════════════════════════════════════════════════════════════════════════
  // ⚠⚠ TIER 1 EXCLUDES BOTS. TIER 3 DOES NOT. The asymmetry is deliberate.
  //
  // Spec §11 states the bot rule under TIER 1 — "every enrolled student … bots never
  // appear" — and Tier 1 is a GRADING ROSTER: a simulated student on it is a row Elena
  // could grade by mistake, so they come out.
  //
  // Tier 3 is a picture of BEHAVIOUR, and excluding bots there would make the robot
  // launcher useless: a cohort of 21 robots would produce four empty charts, which is
  // exactly what happened on the first dry run — `byPeriod` came back all-null and the
  // two class lines were `NaN vs NaN`. The launcher exists so all four charts can be
  // looked at with real spread in them before a class ever runs.
  //
  // ⚠ THE COST, AND HOW IT IS PAID: a real class that also contains bots gets them in
  // its Tier-3 aggregates. So `botCount` travels with the payload and every Tier-3
  // caption states it — the R6 posture applied to inclusion rather than exclusion. Elena
  // must never be looking at a chart that contains simulated students without being told.
  // ═══════════════════════════════════════════════════════════════════════════
  const population: ParticipantContracts[] = all.map(({ id, data: p }) => ({
    participantId: id,
    contracts: parseStoredContracts(p.contracts, config),
  }))
  /** Humans only — what Tier 1 and the gap distribution are built from. */
  const humanPopulation: ParticipantContracts[] = []

  const participants: ScorecardReportParticipant[] = humans.map(({ id, data: p }) => {
    const contracts = parseStoredContracts(p.contracts, config)
    humanPopulation.push({ participantId: id, contracts })

    const freeText = (p.free_text_answers ?? {}) as Record<string, { answer?: unknown }>
    const debriefRaw = freeText[debriefQ.id]?.answer
    const startsWith = p.starts_with === 'high' || p.starts_with === 'low' ? p.starts_with : null

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
      effort_gap: effortGap(contracts, config),
      earnings_high: meanEarnings(contracts, 'high', config),
      earnings_low: meanEarnings(contracts, 'low', config),
      bonuses_high: bonusesWon(contracts, 'high', config),
      bonuses_low: bonusesWon(contracts, 'low', config),
      periods_paid_after_dead: periodsPaidAfterDead(contracts, config),
      knowledge_check_score: typeof p.knowledge_check_score === 'number' ? p.knowledge_check_score : null,
      participation_score: typeof p.normalized_score === 'number' ? p.normalized_score : null,
      debrief: typeof debriefRaw === 'string' ? debriefRaw : null,
      // ⚠ Marked, not hidden. The roster is where a mixed cohort should be visible.
      from_bot_cohort: hasBots,
    }
  })

  // ── Tier 3 ────────────────────────────────────────────────────────────────
  const played = population.filter(p => p.contracts.length > 0)

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
    botCount,
    debriefPrompt: debriefQ.prompt,

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
      gapDistribution: gapDistribution(humanPopulation, config),
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
