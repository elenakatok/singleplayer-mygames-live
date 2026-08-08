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

/**
 * One effort button. ⚠ Large hit area on purpose — 200 of these get pressed per session,
 * often on a phone, and a cramped target is a mis-click that cannot be undone.
 */
function EffortButton({
  label, sub, tone, disabled, onClick,
}: {
  label: string
  sub: string
  tone: string
  disabled: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      data-testid={`sc-effort-${label.split(' ')[0].toLowerCase()}`}
      style={{
        flex: '1 1 12rem',
        minWidth: '11rem',
        padding: '0.9rem 1.1rem',
        fontFamily: typography.fontFamily,
        fontSize: '1rem',
        textAlign: 'left',
        borderRadius: 8,
        border: `2px solid ${disabled ? '#cfcfcf' : tone}`,
        background: disabled ? '#f2f2f2' : '#fff',
        color: disabled ? '#8a8a8a' : tone,
        cursor: disabled ? 'default' : 'pointer',
      }}
    >
      <span style={{ display: 'block', fontWeight: 700 }}>{label}</span>
      <span style={{ display: 'block', fontSize: '0.82rem', marginTop: '0.2rem', opacity: 0.85 }}>
        {sub}
      </span>
    </button>
  )
}

export function EffortScreen({
  contract, params, onSubmit, busy,
}: {
  contract: ScorecardContract
  params: ScorecardParams
  onSubmit: (action: 'high' | 'low') => void
  busy: boolean
}) {
  // ⚠⚠ GUARD 2 (spec §4) — THE ONE THAT WILL ACTUALLY BITE.
  //
  // With one click per period there is no confirmation step, so a double-click's second
  // event has somewhere dangerous to land. Submissions are one-shot (S6) and the server
  // rejects a duplicate for a period already stored — but that is not the failure mode.
  // The failure is: click → server responds → THE NEXT PERIOD'S SCREEN PAINTS → the
  // second click lands on it → and silently commits a choice the student never made.
  // Over 200 periods that will happen without a guard.
  //
  // So there are TWO locks, and the belt-and-braces is deliberate:
  //   • `busy` — owned by Play.tsx, true while the callable is in flight
  //   • `fired` — LOCAL, latched on the first click and never released
  //
  // `fired` is what actually closes the window, because it is local to THIS period's
  // component instance: Play.tsx remounts on `key={screen.id}`, so the next period gets a
  // brand-new latch at false while this one stays locked forever. A shared flag reset in
  // a `finally` cannot do that — there is a frame in which it is false and the old screen
  // is still mounted.
  const [fired, setFired] = useState(false)
  const locked = fired || busy

  function fire(action: 'high' | 'low') {
    if (locked) return
    setFired(true)
    onSubmit(action)
  }

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

      {/* ⚠ The robot driver reads its position from HERE — the same line a student
          reads. It is never handed the contract or period index by the launcher. */}
      <h3 style={{ marginTop: 0 }} data-testid="sc-progress">
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
          {/* ⚠ THIS is the only place a robot can learn the condition — exactly as a
              student does. The driver must never be told it another way. */}
          <strong style={{ fontSize: '1.05rem' }} data-testid="sc-reliability-label">{contract.label}</strong>
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
              <td style={td}><strong data-testid="sc-periods-remaining">{contract.periodsRemaining}</strong></td>
            </tr>
            <tr>
              <td style={td}>Your {params.scorecardNoun}</td>
              <td style={td}><strong data-testid="sc-score">{contract.score}</strong></td>
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

      {/* ⚠⚠ GUARD 1 (spec §4) — THE BANNER'S SPACE IS RESERVED AT ALL TIMES.
          The reached-target banner appears MID-CONTRACT. If it were conditionally
          mounted it would push the buttons down at exactly the moment the student's
          situation changes — moving the click target under a finger already travelling
          toward it. With one click per period and no confirmation step, that is a
          mis-click that commits an unintended effort choice and cannot be undone.
          So the box is always in the layout; only its CONTENTS are conditional. */}
      <div style={{
        ...card,
        minHeight: '3.25rem',
        display: 'flex',
        alignItems: 'center',
        background: contract.targetReached ? '#e8f7ec' : 'transparent',
        borderColor: contract.targetReached ? '#a9d9b8' : 'transparent',
        color: '#14532d',
      }}>
        {params.showTargetReachedBanner && contract.targetReached && (
          <strong>Congratulations — you reached the target {params.scorecardNoun} score.</strong>
        )}
      </div>

      {/* ── The choice: TWO BUTTONS, ONE CLICK PER PERIOD (spec §4) ────────── */}
      <div style={card}>
        <h4 style={{ margin: '0 0 0.75rem' }}>
          Choose your effort for {per} {contract.period}
        </h4>
        <div style={{ display: 'flex', gap: '2.5rem', flexWrap: 'wrap' }}>
          {/* ⚠⚠ GUARD 3 — SEPARATED, AND NEITHER IS A DEFAULT. They are not a
              confirm/cancel pair: both are legitimate choices, so they get real
              horizontal space and distinct (not primary/secondary) styling. Nothing is
              pre-selected and there is no autofocus. */}
          <EffortButton
            label="High Effort"
            sub={`costs ${money(params.highEffortCost, params.currency)} · ${pct(contract.reliability)} chance`}
            tone="#1f4e79"
            disabled={locked}
            onClick={() => fire('high')}
          />
          <EffortButton
            label="Low Effort"
            sub={`costs ${money(params.lowEffortCost, params.currency)} · ${pct(params.pAcceptableLow)} chance`}
            tone="#5a4a1f"
            disabled={locked}
            onClick={() => fire('low')}
          />
        </div>
        {locked && (
          <p style={{ margin: '0.75rem 0 0', color: '#666', fontSize: '0.85rem' }}>
            Recording your choice…
          </p>
        )}
        {/* ⚠ NO UNDO, deliberately (spec §4). One-shot submission is a family rule, and a
            period that can be taken back is a period whose draw can be re-rolled. */}
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
      <h3 style={{ marginTop: 0 }} data-testid="sc-contract-result">
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
        data-testid="sc-contract-continue"
      >
        {busy ? 'Loading…' : isLast ? 'See your session summary' : `Start the next ${noun}`}
      </button>
    </div>
  )
}
