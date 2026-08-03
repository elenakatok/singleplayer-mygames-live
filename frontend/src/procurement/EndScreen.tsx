import type { CSSProperties } from 'react'
import { colors, typography } from '@mygames/game-ui'
import type { ProcurementParams, ProcurementPlayedRow } from './api'
import { HistoryTable } from './HistoryTable'
import { signedEcu } from './format'

// ═══════════════════════════════════════════════════════════════════════════════
// The final results screen (§9).
//
// ⚠ CHECKPOINT 3a SHIPS THE NUMBERS, NOT THE CHART. The scatter — bid against cost, the
// 45° line, the optimal line, and bot bids as a series defaulting to OFF — is CP3b, and
// it is a real omission rather than a stub: nothing here pretends to be it.
//
// ⚠ THE BENCHMARK IS COMPUTED SERVER-SIDE against the SAME realized rival bids
// (`totalEquilibriumProfit`, §9). It is not "the average student", not a class rank, and
// not a target — it is what β would have earned from THIS student's draws, which is the
// only comparison that controls for the luck in their own cost sequence.
//
// ⚠ PROFIT IS NOT THE GRADE (§11). Participation is scored and the KC is scored; auction
// profit never is. The copy says so, because a scoreboard-looking screen that says
// nothing invites the opposite assumption.
// ═══════════════════════════════════════════════════════════════════════════════

const card: CSSProperties = {
  border: `1px solid ${colors.borderMid}`, borderRadius: 8,
  padding: '1rem 1.15rem', marginTop: '1rem', background: colors.white,
}

export function EndScreen({
  params,
  history,
  totalProfit,
  totalEquilibriumProfit,
  roundsWon,
}: {
  params: ProcurementParams
  history: ProcurementPlayedRow[]
  totalProfit: number
  totalEquilibriumProfit: number
  roundsWon: number
}) {
  const c = params.currencyLabel

  return (
    <div style={{ fontFamily: typography.fontFamily }}>
      <h1 data-testid="proc-end-heading" style={{ marginTop: 0, fontSize: '1.5rem', color: colors.text }}>
        All {params.rounds} rounds are done
      </h1>

      <section style={{ ...card, marginTop: 0 }}>
        <p style={{ margin: 0, fontSize: '1.1rem' }}>
          You won <strong data-testid="proc-end-wins">{roundsWon}</strong> of {params.rounds}{' '}
          contracts and earned{' '}
          <strong data-testid="proc-end-profit">{signedEcu(totalProfit, c)}</strong> in total.
        </p>
        <p data-testid="proc-end-benchmark" style={{ margin: '0.8rem 0 0', color: colors.textSecondary }}>
          A perfect player would have earned {signedEcu(totalEquilibriumProfit, c)} from your
          draws — bidding the equilibrium markup every round, against the very same
          rivals you faced.
        </p>
        <p style={{ margin: '0.8rem 0 0', fontSize: '0.85rem', color: colors.textSecondary }}>
          Your profit is not your grade. You are marked on completing the game and on the
          knowledge check.
        </p>
      </section>

      <HistoryTable history={history} currency={c} totalRounds={params.rounds} />
    </div>
  )
}
