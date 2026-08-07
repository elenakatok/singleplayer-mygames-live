import { useState } from 'react'
import { typography } from '@mygames/game-ui'
import type { ScorecardContract, ScorecardParams, ScorecardContractResult } from './api'

// ═══════════════════════════════════════════════════════════════════════════════
// The contract-start and effort-choice screens (spec §4).
//
// ⚠⚠ CONTRACT-START IS THIS SCREEN WITH A HEADING. Spec §4 describes it as "Contract k
// of 10 · Period 1 of 10 · the reliability label · score 0 · balance = endowment" —
// which is period 1's effort-choice screen. `contract.isContractStart` drives the
// banner. That is why the build prompt names THREE resume boundaries, not four.
//
// ⚠⚠ §4.1 — WHAT THIS SCREEN MUST NEVER DO. Once `score + periodsRemaining < targetScore`
// the bonus is impossible and every further period is pure cost. This screen says
// NOTHING: no banner, no colour change, no disabled control, no altered copy, no changed
// ordering. Recognising a written-off contract IS the decision under test.
//
//   The inputs stay visible — score and periods remaining are both printed, always
//   (`showRemainingPeriods` is fixed on, spec §3). The inference is one subtraction and
//   must stay available to anyone who thinks to do it. What is withheld is the
//   CONCLUSION, not the arithmetic.
//
// ⚠ The REACHED-target banner DOES render (spec §4, SoPHIE parity). The asymmetry is
// deliberate (spec §16). Do not add its mirror "you can no longer reach the target".
// ═══════════════════════════════════════════════════════════════════════════════

const money = (n: number, currency: string) => `${n} ${currency}`
const pct = (x: number) => `${Math.round(x * 100)}%`

const card: React.CSSProperties = {
  border: '1px solid #dcdcdc', borderRadius: 8, padding: '1rem 1.25rem',
  background: '#fafafa', marginBottom: '1rem',
}
const th: React.CSSProperties = {
  textAlign: 'left', padding: '0.35rem 0.6rem', borderBottom: '2px solid #ddd',
  fontWeight: 600, fontSize: '0.85rem',
}
const td: React.CSSProperties = { padding: '0.3rem 0.6rem', borderBottom: '1px solid #eee' }

export function EffortScreen({
  contract, params, onSubmit, busy,
}: {
  contract: ScorecardContract
  params: ScorecardParams
  onSubmit: (action: 'high' | 'low') => void
  busy: boolean
}) {
  // ⚠ LOCAL, AND DELIBERATELY NOT SEEDED FROM ANY PRIOR SCREEN. Play.tsx remounts this
  // component on every period AND every contract (`key={screen.id}`), so this state is
  // always fresh — which is the PD bug class the key isolation exists to prevent.
  const [choice, setChoice] = useState<'high' | 'low' | null>(null)

  const noun = params.contractNoun
  const per = params.periodNoun

  return (
    <div>
      {contract.isContractStart && (
        <div style={{ ...card, background: '#eef4ff', borderColor: '#b9cdf0' }}>
          <h2 style={{ margin: 0, fontSize: '1.15rem' }}>
            The New {noun.charAt(0).toUpperCase() + noun.slice(1)} is Starting
          </h2>
          <p style={{ margin: '0.35rem 0 0', color: '#333' }}>
            {noun.charAt(0).toUpperCase() + noun.slice(1)} {contract.contract} of {params.contracts}
            {' · '}{per.charAt(0).toUpperCase() + per.slice(1)} 1 of {params.periodsPerContract}
          </p>
        </div>
      )}

      <h3 style={{ marginTop: 0 }}>
        {noun.charAt(0).toUpperCase() + noun.slice(1)} {contract.contract} of {params.contracts}
        {' · '}
        {per.charAt(0).toUpperCase() + per.slice(1)} {contract.period} of {params.periodsPerContract}
      </h3>

      {/* ⚠ THE RELIABILITY LABEL, on the contract-start screen AND every period screen
          (spec §2.3). The percentage is interpolated server-side from the LIVE config —
          never a typed-in figure that an instructor edit would falsify (spec §3). */}
      {params.showReliabilityLabel && contract.label !== null && (
        <div style={{
          ...card, background: '#fff8e6', borderColor: '#e6d3a3', marginBottom: '1rem',
        }}>
          <strong style={{ fontSize: '1.05rem' }}>{contract.label}</strong>
          <div style={{ fontSize: '0.9rem', color: '#555', marginTop: '0.25rem' }}>
            On this {noun}, a high-effort {per} produces an {params.deliveryNoun} with
            probability <strong>{pct(contract.reliability)}</strong>.
          </div>
        </div>
      )}

      {/* ── Your Information (spec §4) ─────────────────────────────────────── */}
      <div style={card}>
        <h4 style={{ margin: '0 0 0.5rem' }}>Your Information</h4>
        <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: '0.92rem' }}>
          <tbody>
            <tr>
              <td style={td}>High effort costs</td>
              <td style={td}><strong>{money(params.highEffortCost, params.currency)}</strong></td>
            </tr>
            <tr>
              <td style={td}>
                High effort → an {params.deliveryNoun}
                {params.showReliabilityLabel && contract.label ? ` (${contract.label})` : ''}
              </td>
              <td style={td}><strong>{pct(contract.reliability)}</strong></td>
            </tr>
            <tr>
              <td style={td}>Low effort costs</td>
              <td style={td}><strong>{money(params.lowEffortCost, params.currency)}</strong></td>
            </tr>
            {/* ⚠ SHOWN, and identical in both conditions (spec §2.1) — the mechanism. */}
            <tr>
              <td style={td}>Low effort → an {params.deliveryNoun}</td>
              <td style={td}><strong>{pct(params.pAcceptableLow)}</strong></td>
            </tr>
            <tr>
              <td style={td}>{params.scorecardNoun} target for the bonus</td>
              <td style={td}><strong>{params.targetScore}</strong></td>
            </tr>
            <tr>
              <td style={td}>Bonus if you reach it</td>
              <td style={td}><strong>{money(params.bonus, params.currency)}</strong></td>
            </tr>
          </tbody>
        </table>
      </div>

      {/* ── Your Status (spec §4) ──────────────────────────────────────────── */}
      <div style={card}>
        <h4 style={{ margin: '0 0 0.5rem' }}>Your Status</h4>
        <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: '0.92rem' }}>
          <tbody>
            <tr>
              <td style={td}>High-effort {per}s so far</td>
              <td style={td}><strong>{contract.highEffortPeriods}</strong></td>
            </tr>
            {/* ⚠ ALWAYS SHOWN. `showRemainingPeriods` is fixed on, not defaulted
                (spec §3, §4.1): withholding the CONCLUSION that a contract is dead is
                the design; withholding the INPUTS would be a different, worse game. */}
            <tr>
              <td style={td}>{per.charAt(0).toUpperCase() + per.slice(1)}s remaining</td>
              <td style={td}><strong>{contract.periodsRemaining}</strong></td>
            </tr>
            <tr>
              <td style={td}>Your {params.scorecardNoun}</td>
              <td style={td}><strong>{contract.score}</strong></td>
            </tr>
            {params.showRunningBalance && (
              <tr>
                <td style={td}>Balance on this {noun}</td>
                <td style={td}><strong>{money(contract.balance, params.currency)}</strong></td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* ⚠ THE REACHED-TARGET BANNER. Appears once score ≥ target and stays for the rest
          of the contract (spec §4). There is NO counterpart for an unreachable target. */}
      {params.showTargetReachedBanner && contract.targetReached && (
        <div style={{
          ...card, background: '#e8f7ec', borderColor: '#a9d9b8', color: '#14532d',
        }}>
          <strong>Congratulations — you reached the target {params.scorecardNoun} score.</strong>
        </div>
      )}

      {/* ── The choice ─────────────────────────────────────────────────────── */}
      <div style={card}>
        <h4 style={{ margin: '0 0 0.5rem' }}>
          Your effort for {per} {contract.period}
        </h4>
        <label style={{ display: 'block', margin: '0.45rem 0', cursor: 'pointer' }}>
          <input
            type="radio" name="effort" value="high"
            checked={choice === 'high'} onChange={() => setChoice('high')} disabled={busy}
          />{' '}
          <strong>High Effort</strong> — costs {money(params.highEffortCost, params.currency)},
          {' '}{pct(contract.reliability)} chance of an {params.deliveryNoun}
        </label>
        <label style={{ display: 'block', margin: '0.45rem 0', cursor: 'pointer' }}>
          <input
            type="radio" name="effort" value="low"
            checked={choice === 'low'} onChange={() => setChoice('low')} disabled={busy}
          />{' '}
          <strong>Low Effort</strong> — costs {money(params.lowEffortCost, params.currency)},
          {' '}{pct(params.pAcceptableLow)} chance of an {params.deliveryNoun}
        </label>
        <button
          style={{
            marginTop: '0.75rem', padding: '0.5rem 1.4rem', fontSize: '1rem',
            fontFamily: typography.fontFamily, cursor: choice && !busy ? 'pointer' : 'default',
          }}
          disabled={choice === null || busy}
          onClick={() => choice && onSubmit(choice)}
        >
          {busy ? 'Submitting…' : 'Submit'}
        </button>
      </div>

      {/* ── This contract's history (spec §4, below the fold) ──────────────── */}
      {contract.periods.length > 0 && (
        <div style={card}>
          <h4 style={{ margin: '0 0 0.5rem' }}>This {noun} so far</h4>
          <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: '0.88rem' }}>
            <thead>
              <tr>
                <th style={th}>{per.charAt(0).toUpperCase() + per.slice(1)}</th>
                <th style={th}>Effort</th>
                <th style={th}>{params.deliveryNoun.charAt(0).toUpperCase() + params.deliveryNoun.slice(1)}?</th>
                <th style={th}>{params.scorecardNoun}</th>
                <th style={th}>Balance</th>
              </tr>
            </thead>
            <tbody>
              {contract.periods.map(p => (
                <tr key={p.period}>
                  <td style={td}>{p.period}</td>
                  <td style={td}>{p.action === 'high' ? 'High' : 'Low'}</td>
                  <td style={td}>{p.acceptable ? 'Yes' : 'No'}</td>
                  <td style={td}>{p.score}</td>
                  <td style={td}>{money(p.balance, params.currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

/** The contract-result screen (spec §4). */
export function ContractResultScreen({
  result, params, isLast, onContinue, busy,
}: {
  result: ScorecardContractResult
  params: ScorecardParams
  isLast: boolean
  onContinue: () => void
  busy: boolean
}) {
  const noun = params.contractNoun
  return (
    <div>
      <h3 style={{ marginTop: 0 }}>
        {noun.charAt(0).toUpperCase() + noun.slice(1)} {result.contract} of {params.contracts} — complete
      </h3>

      <div style={{
        ...card,
        background: result.metTarget ? '#e8f7ec' : '#fdf0f0',
        borderColor: result.metTarget ? '#a9d9b8' : '#e6bcbc',
      }}>
        <strong style={{ fontSize: '1.05rem' }}>
          {result.metTarget
            ? `You reached the target — the ${params.bonus} ${params.currency} bonus is yours.`
            : `You did not reach the target of ${params.targetScore}. No bonus on this ${noun}.`}
        </strong>
      </div>

      <div style={card}>
        <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: '0.92rem' }}>
          <tbody>
            {params.showReliabilityLabel && result.label !== null && (
              <tr><td style={td}>Reliability</td><td style={td}><strong>{result.label}</strong></td></tr>
            )}
            <tr>
              <td style={td}>High-effort {params.periodNoun}s</td>
              <td style={td}><strong>{result.highEffortPeriods}</strong> of {params.periodsPerContract}</td>
            </tr>
            <tr>
              <td style={td}>Final {params.scorecardNoun}</td>
              <td style={td}><strong>{result.score}</strong> (target {params.targetScore})</td>
            </tr>
            <tr>
              <td style={td}>Earnings on this {noun}</td>
              <td style={td}><strong>{money(result.earnings, params.currency)}</strong></td>
            </tr>
          </tbody>
        </table>
        <p style={{ fontSize: '0.85rem', color: '#555', margin: '0.6rem 0 0' }}>
          {params.endowmentPerContract} − {params.highEffortCost} × {result.highEffortPeriods}
          {result.metTarget ? ` + ${params.bonus} bonus` : ''} = {result.earnings} {params.currency}
        </p>
      </div>

      {/* ⚠ NO MENTION OF THE NEXT CONTRACT'S RELIABILITY. It is not withheld from this
          component — the server has not sent it, and will not until the student
          advances (spec §13). */}
      <button
        style={{
          padding: '0.5rem 1.4rem', fontSize: '1rem', fontFamily: typography.fontFamily,
          cursor: busy ? 'default' : 'pointer',
        }}
        disabled={busy}
        onClick={onContinue}
      >
        {busy ? 'Loading…' : isLast ? 'See your session summary' : `Start the next ${noun}`}
      </button>
    </div>
  )
}
