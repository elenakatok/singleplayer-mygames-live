import { ExitScatterSVG, ExitScatterCaption, type ExitPoint } from './ExitScatterSVG'
import type { ProcurementReport } from './api'

// ═══════════════════════════════════════════════════════════════════════════════
// TIER 3 FOR THE OPEN FORMAT (§7) — the class exit-price scatter. This is what Elena
// presents in lecture for an open instance.
//
// ⚠⚠ THIS FILE EXISTS BECAUSE OF A LIVE BUG, AND THE BUG IS WORTH RECORDING. Before
// CP4b, `Reports.tsx` read `data.format` in exactly one place — to print a label — and
// rendered `ClassScatterSVG` unconditionally. On an open instance that drew CASCADE BIDS
// against cost, put β through them as "the optimal line", and captioned itself *"the
// rivals bid the optimal markup for their own cost every time"* — over a cloud of rival
// dots at (cost 65, bid 100) that visibly did not. The chart contradicted its own caption
// in front of a room.
//
// It was a MISSING FORMAT GATE, not missed scope: the student end screen refused to draw
// the sealed chart and said results were still being built; the instructor side had no
// such refusal. Every format-dependent surface now has the gate.
//
// ⚠ THE AXES AND THE BENCHMARK ARE DIFFERENT QUANTITIES, not a relabelling:
//     sealed   y = the one sealed bid        benchmark = β, the optimal markup
//     open     y = the EXIT PRICE            benchmark = the 45° line, exit = cost
//   There is no β here and there must never be one.
//
// ⚠ THE CHART ITSELF IS `ExitScatterSVG`, shared with the student's own §5.3 results, so
// the two cannot disagree about what a point means in front of a room. Only the DATA and
// the SUBJECT differ, which is exactly the split the sealed pair already uses.
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Every student's exit price against their own cost, flattened across students and rounds.
 *
 * ⚠ RESOLVED ROUNDS ONLY, by construction: `rows[].rounds` is the stored history and a
 * round is only there once it resolved. A mid-game student contributes what they have
 * finished.
 *
 * ⚠ ROUNDS WITH NO EXIT PRICE ARE OMITTED, not plotted at zero. Any round played before
 * CP4b's capture landed has none, and a point at (cost, 0) would be a lie about a
 * stopping point nobody recorded.
 */
export function openClassExitPoints(report: ProcurementReport): ExitPoint[] {
  const out: ExitPoint[] = []
  for (const row of report.rows) {
    for (const r of row.rounds) {
      if (r.exitPrice === null) continue
      // ⚠ `censored` COMES FROM THE RECORD, never from where the point sits or from `won`
      // being re-read here. The server stored it at round end for exactly this reason.
      out.push({ cost: r.yourCost, exitPrice: r.exitPrice, censored: r.exitCensored })
    }
  }
  return out
}

/**
 * The simulated suppliers' exits — each bot's own COST.
 *
 * ⚠⚠ THIS IS THE BOT'S *LIMIT*, NOT THE STANDING PRICE IT HAPPENED TO STOP AT, and §7
 * asks for it in those terms: *"bot exits plotted as a toggleable series, sitting exactly
 * on the 45° line, since bots stop precisely at cost."* A bot's observed stopping standing
 * would sit slightly ABOVE the line — it declines the next legal bid, which is one step
 * below where it is standing — and the series would stop being the clean benchmark the
 * chart exists to show. Recorded as a decision rather than left to be rediscovered.
 */
export function openClassBotExits(report: ProcurementReport): number[] {
  return report.rows.flatMap(row => row.rivalPoints.map(p => p.cost))
}

export function OpenClassScatterSVG({
  report,
  showBots,
}: {
  report: ProcurementReport
  showBots: boolean
}) {
  return (
    <div>
      <ExitScatterSVG
        points={openClassExitPoints(report)}
        botExits={openClassBotExits(report)}
        showBots={showBots}
        min={report.rivalCostMin}
        max={report.rivalCostMax}
        currencyLabel={report.currencyLabel}
        subjectLabel="Every student in the class"
      />
      <ExitScatterCaption subject="class" />
    </div>
  )
}
