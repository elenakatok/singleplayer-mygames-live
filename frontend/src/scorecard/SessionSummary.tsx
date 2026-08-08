import { typography } from '@mygames/game-ui'
import type { ScorecardContractResult, ScorecardParams } from './api'

// ═══════════════════════════════════════════════════════════════════════════════
// The session summary (spec §4).
//
// ⚠ THE RELIABILITY COLUMN IS THE POINT OF THIS SCREEN — spec §4: "where a student first
// sees their two conditions side by side". Every other column they have already seen on
// the contract-result screens.
//
// ⚠ NEWEST FIRST (spec §4). The contract they just finished is the one they are looking
// for; scrolling to the bottom for it is the wrong default.
//
// ⚠ NO CLASS COMPARISON — family rule (spec §5): a display screen shows only this
// student's own data.
// ═══════════════════════════════════════════════════════════════════════════════

const money = (n: number, c: string) => `${n} ${c}`

const th: React.CSSProperties = {
  textAlign: 'left', padding: '0.4rem 0.7rem', borderBottom: '2px solid #ddd',
  fontWeight: 600, fontSize: '0.85rem',
}
const td: React.CSSProperties = { padding: '0.35rem 0.7rem', borderBottom: '1px solid #eee' }

export function SessionSummary({
  completed, params, totalEarnings, onContinue, testId = 'sc-session-summary',
}: {
  completed: ScorecardContractResult[]
  params: ScorecardParams
  totalEarnings: number
  onContinue?: () => void
  /**
   * ⚠⚠ THIS COMPONENT IS RENDERED IN TWO ROLES and they must not share an identity:
   * the TERMINAL session-summary screen, and the PRIOR-CONTRACTS PANEL that sits under
   * the effort screen mid-session (spec §3 `showPriorContractsPanel`).
   *
   * They looked identical to automation, and that cost a real bug: the robot driver
   * waited for "the next screen" and matched `sc-session-summary` from the panel while
   * the student was still mid-contract, so every robot broke out of the contract loop
   * after the first period of contract 2. Same markup, different meaning — different id.
   */
  testId?: string
}) {
  const noun = params.contractNoun
  const Noun = noun.charAt(0).toUpperCase() + noun.slice(1)
  // ⚠ Copy before reversing — `completed` is props and must not be mutated.
  const rows = [...completed].reverse()

  return (
    <div>
      <h3 style={{ marginTop: 0 }} data-testid={testId}>Your session</h3>
      <p style={{ color: '#444' }}>
        You worked {completed.length} {noun}s of {params.periodsPerContract} {params.periodNoun}s
        for {params.buyerName}.
      </p>

      <table style={{ borderCollapse: 'collapse', width: '100%', marginTop: '0.75rem' }}>
        <thead>
          <tr>
            <th style={th}>{Noun}</th>
            {/* ⚠ THE COLUMN THIS SCREEN EXISTS FOR (spec §4). */}
            {params.showReliabilityLabel && <th style={th}>Reliability</th>}
            <th style={th}>High-effort {params.periodNoun}s</th>
            <th style={th}>Final {params.scorecardNoun}</th>
            <th style={th}>Earnings</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.contract}>
              <td style={td}>{r.contract}</td>
              {params.showReliabilityLabel && (
                <td style={td}>{r.label ?? `${Math.round(r.reliability * 100)}%`}</td>
              )}
              <td style={td}>{r.highEffortPeriods} of {params.periodsPerContract}</td>
              <td style={td}>
                {r.score}
                {r.metTarget && <span style={{ color: '#14532d' }}> ★</span>}
              </td>
              <td style={td}>{money(r.earnings, params.currency)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td style={{ ...td, fontWeight: 600 }} colSpan={params.showReliabilityLabel ? 4 : 3}>
              Total
            </td>
            <td style={{ ...td, fontWeight: 600 }}>{money(totalEarnings, params.currency)}</td>
          </tr>
        </tfoot>
      </table>

      {onContinue && (
        <button
          style={{
            marginTop: '1.25rem', padding: '0.5rem 1.4rem', fontSize: '1rem',
            fontFamily: typography.fontFamily, cursor: 'pointer',
          }}
          onClick={onContinue}
          data-testid="sc-summary-continue"
        >
          Continue
        </button>
      )}
    </div>
  )
}
