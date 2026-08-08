import type { ScorecardConfig } from './config'
import type { StoredContract } from './state'
import type { ParticipantContracts } from './stats'

// ═══════════════════════════════════════════════════════════════════════════════
// ⚠⚠ ONE BOT RULE, ONE PLACE (spec §11, decided 08-07).
//
// The rule is the SAME for the Tier-1 roster, all four Tier-3 charts, and the student
// reveal: **humans only**. An earlier version had Tier 3 include bots so a robot cohort
// would produce non-empty charts, with chart 3 as an exception. That was wrong, and the
// reason it was wrong reaches further than the chart:
//
//   ⚠ THE §10 STUDENT REVEAL DRAWS ITS CLASS AVERAGE FROM THE SAME POPULATION. Bots in
//   charts 1 and 2 meant students were being compared against robots — on a screen with
//   no banner and no way to tell.
//
// So the filter lives here, is applied once, and every consumer takes the filtered list.
//
// ⚠ THE DEMO FALLBACK IS INSTRUCTOR-ONLY. When a cohort has ZERO humans the instructor
// charts render the bot data behind a "demo cohort — robot data" banner, because four
// empty charts are useless to somebody testing. The STUDENT reveal has no such fallback:
// it is humans-only unconditionally, and suppressed below a minimum n.
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * ⚠ IS THIS PARTICIPANT A BOT? Two signals, because the robot driver identifies itself
 * differently in its two modes: a dry run against the emulator uses dev `?_pid=robot-N`
 * params, while a production run mints a real classroom token and the launcher stamps
 * `is_robot`. A false negative here would put a simulated student on a roster Elena
 * grades from, or into a class average a student is measured against.
 */
export function isBot(participantId: string, data: Record<string, unknown>): boolean {
  return data.is_robot === true || /^robot-/i.test(participantId)
}

export interface SplitPopulation {
  /** Humans only. What Tier 1, all four charts and the student reveal use. */
  humans: ParticipantContracts[]
  /** Bots only. Used ONLY for the instructor demo fallback. */
  bots: ParticipantContracts[]
  botCount: number
  humanCount: number
  /**
   * ⚠ INSTRUCTOR CHARTS ONLY. True when there are no humans at all, so the reports
   * render bot data behind a banner instead of four empty charts. Never consulted by
   * anything a student sees.
   */
  isDemoCohort: boolean
  /** What the instructor charts should actually plot. */
  chartPopulation: ParticipantContracts[]
}

export function splitPopulation(
  docs: readonly { id: string; data: Record<string, unknown> }[],
  config: ScorecardConfig,
  parse: (raw: unknown, config: ScorecardConfig) => StoredContract[],
): SplitPopulation {
  const humans: ParticipantContracts[] = []
  const bots: ParticipantContracts[] = []
  for (const { id, data } of docs) {
    const entry = { participantId: id, contracts: parse(data.contracts, config) }
    if (isBot(id, data)) bots.push(entry)
    else humans.push(entry)
  }
  // ⚠ "Zero humans", not "zero humans who played" — a roster of never-started students is
  // a real class, and showing them robot data under a demo banner would be a lie.
  const isDemoCohort = humans.length === 0 && bots.length > 0
  return {
    humans,
    bots,
    botCount: bots.length,
    humanCount: humans.length,
    isDemoCohort,
    chartPopulation: isDemoCohort ? bots : humans,
  }
}
