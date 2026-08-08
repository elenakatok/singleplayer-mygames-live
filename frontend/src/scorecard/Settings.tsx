import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { colors } from '@mygames/game-ui'
import { useInstructorSession } from '../shared/useInstructorSession'
import { InstructorChrome } from '../shared/InstructorChrome'
import {
  scorecardGetConfig, scorecardUpdateConfig, scorecardInstructorSession, instructorErrorMessage,
  type ScorecardConfigResponse, type ScorecardConditionPanel, type ScorecardAddedKcQuestion,
} from './api'
import { PolicyGridSVG, PolicyGridLegend } from './PolicyGridSVG'

// ═══════════════════════════════════════════════════════════════════════════════
// Settings (spec §3) + THE INDUCED-BEHAVIOUR PANEL (spec §3.1).
//
// ⚠⚠ "EVERY NUMBER IS A SETTING" IS ONLY HONEST IF THE INSTRUCTOR CAN SEE WHAT THE
// NUMBERS INDUCE. The DP is ~110 cells and nobody can read a threshold policy off seven
// parameters, so the server solves BOTH conditions on every save and returns the panel —
// the thresholds, the benchmarks, the warnings, and the policy grid.
//
// ⚠⚠ WARNINGS INFORM, THEY NEVER BLOCK (spec §3.1). An instructor who wants a degenerate
// configuration for a demonstration gets it. Nothing on this page refuses a save. The one
// thing that genuinely blocks is the standing parameter lock, which is a different
// mechanism and is not implemented here — `started` is surfaced so the page can say so.
//
// ⚠ THE POLICY GRID IS THE SAME COMPONENT THE REPORTS USE, fed by the same server
// function (spec §11: "same solver, one implementation, two placements"). It depends on no
// student data, so it renders here with zero participants — which is the point: an
// instructor can see what an edit induced BEFORE anyone plays.
// ═══════════════════════════════════════════════════════════════════════════════

const row: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: '0.75rem', margin: '0.4rem 0' }
const lbl: React.CSSProperties = { flex: '0 0 15rem', fontSize: '0.9rem' }
const inp: React.CSSProperties = { width: '9rem', padding: '0.3rem 0.45rem' }

export default function Settings() {
  const session = useInstructorSession(scorecardInstructorSession)
  const [data, setData] = useState<ScorecardConfigResponse | null>(null)
  const [form, setForm] = useState<Record<string, unknown>>({})
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState<string | null>(null)
  const navigate = useNavigate()

  // ── The added-question composer (ported from pd/pricing) ───────────────────
  const [newType, setNewType] = useState<'mc' | 'text'>('mc')
  const [newPrompt, setNewPrompt] = useState('')
  const [newOptions, setNewOptions] = useState<string[]>(['', ''])
  const [newCorrect, setNewCorrect] = useState(0)
  const [addError, setAddError] = useState<string | null>(null)

  const addedQuestions = (form.addedKcQuestions ?? []) as ScorecardAddedKcQuestion[]

  /** Short, collision-resistant enough for ids the instructor never types. */
  const shortId = () => Math.random().toString(36).slice(2, 8)

  function addQuestion() {
    setAddError(null)
    if (!newPrompt.trim()) { setAddError('A question needs a prompt.'); return }

    let options: { value: string; label: string }[] | undefined
    let correct_value: string | undefined
    if (newType === 'mc') {
      const labels = newOptions.map(o => o.trim()).filter(Boolean)
      if (labels.length < 2) { setAddError('A multiple-choice question needs at least two options.'); return }
      options = labels.map(label => ({ value: `o_${shortId()}`, label }))
      correct_value = options[Math.min(newCorrect, options.length - 1)].value
    }
    const q: ScorecardAddedKcQuestion = {
      // ⚠ `akc_` — never a built-in id. The server refuses any id in the built-in set
      // outright, because the grader looks built-ins up FIRST and a collision would grade
      // the student against the built-in key instead of this one.
      id: `akc_${shortId()}`,
      type: newType,
      prompt: newPrompt.trim(),
      ...(options ? { options } : {}),
      ...(correct_value ? { correct_value } : {}),
    }
    set('addedKcQuestions')([...addedQuestions, q])
    setNewPrompt(''); setNewOptions(['', '']); setNewCorrect(0)
  }

  useEffect(() => {
    if (session.kind !== 'ready') return
    let cancelled = false
    scorecardGetConfig()
      .then(r => { if (!cancelled) { setData(r); setForm(seed(r)) } })
      .catch(e => { if (!cancelled) setError(instructorErrorMessage(e)) })
    return () => { cancelled = true }
  }, [session])

  function seed(r: ScorecardConfigResponse): Record<string, unknown> {
    return {
      contracts: r.config.contracts,
      periodsPerContract: r.config.periodsPerContract,
      targetScore: r.config.targetScore,
      bonus: r.config.bonus,
      highEffortCost: r.config.highEffortCost,
      lowEffortCost: r.config.lowEffortCost,
      pAcceptableLow: r.config.pAcceptableLow,
      endowmentPerContract: r.config.endowmentPerContract,
      showReliabilityLabel: r.config.showReliabilityLabel,
      showTargetReachedBanner: r.config.showTargetReachedBanner,
      showPriorContractsPanel: r.config.showPriorContractsPanel,
      showRunningBalance: r.config.showRunningBalance,
      currency: r.config.currency,
      buyerName: r.config.buyerName,
      // ⚠ The four nouns that the student screens ACTUALLY RENDER. `productName` is
      // accepted by the callable and carried in the student params, but no scorecard
      // screen prints it — see the note beside the Labels fields below.
      contractNoun: r.config.contractNoun,
      periodNoun: r.config.periodNoun,
      deliveryNoun: r.config.deliveryNoun,
      scorecardNoun: r.config.scorecardNoun,
      kcEnabled: r.config.kcEnabled,
      addedKcQuestions: r.config.addedKcQuestions,
      reliabilityHigh: r.truth.reliabilityHigh,
      reliabilityLow: r.truth.reliabilityLow,
      reliabilitySchedule: r.truth.reliabilitySchedule,
      labelHigh: r.truth.labelHigh,
      labelLow: r.truth.labelLow,
      seed: r.truth.seed ?? '',
    }
  }

  async function save() {
    setSaving(true)
    setError(null)
    try {
      const r = await scorecardUpdateConfig(form)
      setData(r)
      setForm(seed(r))
      setSavedAt(new Date().toLocaleTimeString())
    } catch (e) {
      setError(instructorErrorMessage(e))
    } finally {
      setSaving(false)
    }
  }

  const set = (k: string) => (v: unknown) => setForm(f => ({ ...f, [k]: v }))
  const numField = (k: string, label: string, step = 1) => (
    <div style={row} key={k}>
      <label style={lbl}>{label}</label>
      <input style={inp} type="number" step={step} value={String(form[k] ?? '')}
        onChange={e => set(k)(e.target.value === '' ? '' : Number(e.target.value))} />
    </div>
  )
  const boolField = (k: string, label: string) => (
    <div style={row} key={k}>
      <label style={lbl}>{label}</label>
      <input type="checkbox" checked={form[k] === true} onChange={e => set(k)(e.target.checked)} />
    </div>
  )
  const textField = (k: string, label: string) => (
    <div style={row} key={k}>
      <label style={lbl}>{label}</label>
      <input style={{ ...inp, width: '20rem' }} type="text" value={String(form[k] ?? '')}
        onChange={e => set(k)(e.target.value)} />
    </div>
  )

  if (session.kind === 'loading') return <InstructorChrome title="Settings"><p>Loading…</p></InstructorChrome>
  if (session.kind === 'error') {
    return <InstructorChrome title="Settings"><p style={{ color: '#c00' }}>{session.message}</p></InstructorChrome>
  }
  if (!data) {
    return (
      <InstructorChrome title="Settings">
        {error ? <p style={{ color: '#c00' }}>{error}</p> : <p>Loading…</p>}
      </InstructorChrome>
    )
  }

  const { induced } = data
  const pct = (x: number) => `${Math.round(x * 100)}%`
  const ecu = (x: number) => (Number.isFinite(x) ? (Math.round(x * 100) / 100).toString() : '—')

  return (
    <InstructorChrome
      title="Supplier Scorecard — settings"
      navLinks={[
        { label: '← Dashboard', href: `/dashboard${window.location.search}` },
        { label: 'Reports →', href: `/reports${window.location.search}` },
      ]}
      onNavigate={navigate}
    >
      {data.started && (
        <p style={{
          background: '#fff8e6', border: '1px solid #e6d3a3', borderRadius: 6,
          padding: '0.6rem 0.9rem', fontSize: '0.85rem',
        }}>
          ⚠ Students have already started. Editing the rules now means different students
          played different games — the reports cannot separate them.
        </p>
      )}

      <h3>Structure</h3>
      {numField('contracts', 'Contracts')}
      {numField('periodsPerContract', 'Periods per contract')}
      {numField('targetScore', 'Target score for the bonus')}

      <h3>The reliability treatment</h3>
      {numField('reliabilityHigh', 'High reliability', 0.05)}
      {numField('reliabilityLow', 'Low reliability', 0.05)}
      {numField('pAcceptableLow', 'P(acceptable | low effort)', 0.05)}
      <div style={row}>
        <label style={lbl}>Schedule</label>
        <select style={inp} value={String(form.reliabilitySchedule)}
          onChange={e => set('reliabilitySchedule')(e.target.value)}>
          <option value="alternating">alternating</option>
          <option value="blocked">blocked</option>
          <option value="betweenSubject">betweenSubject</option>
        </select>
      </div>
      {boolField('showReliabilityLabel', 'Name the condition on screen')}
      {textField('labelHigh', 'Label — high')}
      {textField('labelLow', 'Label — low')}
      <p style={{ fontSize: '0.8rem', color: colors.textSecondary, margin: '0.2rem 0 0 15.75rem' }}>
        ⚠ Write <code>{'{pct}'}</code> where the percentage should appear — it is filled in
        from the live value above. Typing a percentage here would leave the screen
        contradicting the game the moment you edit a probability.
      </p>

      <h3>Effort and reward</h3>
      {numField('highEffortCost', 'High effort costs')}
      {numField('lowEffortCost', 'Low effort costs')}
      {numField('bonus', 'Bonus')}
      {numField('endowmentPerContract', 'Endowment per contract')}

      <h3>What the student sees</h3>
      {boolField('showTargetReachedBanner', 'Banner when the target is reached')}
      {boolField('showPriorContractsPanel', 'Show their completed contracts')}
      {boolField('showRunningBalance', 'Show the running balance')}
      <p style={{ fontSize: '0.8rem', color: colors.textSecondary }}>
        ⚠ There is deliberately no setting for a &ldquo;you can no longer reach the
        target&rdquo; message. Noticing a written-off contract is the decision under test.
        Periods remaining are always shown, so the inference stays available.
      </p>

      <h3>Other</h3>
      {textField('currency', 'Currency')}
      {textField('buyerName', 'Buyer name')}
      {/* ⚠ These four are RENDERED on the student screens — EffortScreen, SessionSummary
          and DebriefScreen — and three of them are also interpolated into the knowledge
          check's prompts and options, so an edit here changes what students read.

          ⚠⚠ `productName` IS DELIBERATELY ABSENT. The callable accepts it and
          `clientState.ts` carries it all the way to the browser, but NO scorecard screen
          prints it — it is live in forecast (EndScreen) and dead here. A field for it
          would look like it worked and change nothing, which is worse than not offering
          it. Recorded in BUILD_NOTES; add the control if a screen ever uses it. */}
      {textField('contractNoun', 'Noun — contract')}
      {textField('periodNoun', 'Noun — period')}
      {textField('deliveryNoun', 'Noun — acceptable delivery')}
      {textField('scorecardNoun', 'Noun — scorecard')}
      {textField('seed', 'Seed (blank = random)')}

      {/* ═══ THE KNOWLEDGE CHECK (spec §9) ═══════════════════════════════════ */}
      <h3>Knowledge check</h3>
      {boolField('kcEnabled', 'Include the knowledge check')}
      <p style={{ fontSize: '0.8rem', color: colors.textSecondary, marginTop: 0 }}>
        Off removes both stages — the six asked before play and the four asked after the
        reveal — along with anything added below. ⚠ The three ordered steps of the debrief
        are <em>not</em> part of the knowledge check and are unaffected: students still
        answer the noticing question, see their two curves, and answer the linking
        question.
      </p>

      <p style={{ fontSize: '0.85rem', color: colors.textSecondary, marginBottom: '0.4rem' }}>
        The built-in ten are fixed and cannot be edited or reordered. Your own questions are
        asked <strong>after</strong> them, once the reveal has been shown.
      </p>
      {/* ⚠ ALWAYS POST-REVEAL, and not a choice offered here. Nothing asked BEFORE play may
          hint that a target can become unreachable (spec §9.1) — noticing that is the
          behaviour being measured, and an instructor writing a question has no way to know
          the constraint. Placing additions after the reveal makes it impossible to
          violate by accident. */}

      {addedQuestions.length === 0 && (
        <p style={{ fontSize: '0.85rem', fontStyle: 'italic', color: colors.textSecondary }}>
          None yet.
        </p>
      )}
      <ul style={{ listStyle: 'none', margin: '0.5rem 0 0', padding: 0, display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
        {addedQuestions.map(q => (
          <li key={q.id} data-testid={`sc-set-added-${q.id}`}
            style={{ border: `1px solid ${colors.borderMid}`, borderRadius: 6, padding: '0.6rem 0.8rem' }}>
            <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginBottom: '0.3rem' }}>
              <span style={{ fontSize: '0.72rem', textTransform: 'uppercase', letterSpacing: '0.03em', color: colors.textSecondary }}>
                {q.type === 'mc' ? 'multiple choice' : 'free text (not graded)'}
              </span>
              <span style={{ flex: 1 }} />
              <button
                data-testid={`sc-set-delete-${q.id}`}
                onClick={() => set('addedKcQuestions')(addedQuestions.filter(x => x.id !== q.id))}
                style={{ fontSize: '0.8rem', padding: '0.15rem 0.5rem', color: '#c00' }}
              >
                Delete
              </button>
            </div>
            <div style={{ fontSize: '0.9rem' }}>{q.prompt}</div>
            {q.type === 'mc' && (
              <div style={{ fontSize: '0.78rem', color: colors.textSecondary, marginTop: '0.2rem' }}>
                {/* Bold marks the key. ⚠ Instructor-side only — the student payload drops
                    `correct_value` entirely (api.ts ScorecardInstructorConfig). */}
                {(q.options ?? []).map(o => (
                  <span key={o.value} style={{ marginRight: '0.6rem', fontWeight: o.value === q.correct_value ? 700 : 400 }}>
                    {o.label}
                  </span>
                ))}
              </div>
            )}
          </li>
        ))}
      </ul>

      <div style={{ border: `1px dashed ${colors.borderMid}`, borderRadius: 6, padding: '0.75rem', marginTop: '0.75rem' }}>
        <div style={row}>
          <label style={lbl}>New question</label>
          <select style={inp} value={newType} data-testid="sc-set-new-type"
            onChange={e => setNewType(e.target.value as 'mc' | 'text')}>
            <option value="mc">Multiple choice</option>
            <option value="text">Free text (not graded)</option>
          </select>
        </div>
        <div style={row}>
          <label style={lbl}>Prompt</label>
          <input style={{ ...inp, width: '24rem' }} type="text" value={newPrompt}
            data-testid="sc-set-new-prompt" onChange={e => setNewPrompt(e.target.value)} />
        </div>
        {newType === 'mc' && newOptions.map((o, i) => (
          <div style={row} key={i}>
            <label style={lbl}>
              <input type="radio" name="sc-new-correct" checked={newCorrect === i}
                data-testid={`sc-set-new-correct-${i}`}
                onChange={() => setNewCorrect(i)} /> Option {i + 1}
            </label>
            <input style={{ ...inp, width: '20rem' }} type="text" value={o}
              data-testid={`sc-set-new-option-${i}`}
              onChange={e => setNewOptions(newOptions.map((x, j) => (j === i ? e.target.value : x)))} />
          </div>
        ))}
        {newType === 'mc' && (
          <button style={{ fontSize: '0.8rem', marginRight: '0.5rem' }}
            data-testid="sc-set-new-option-add"
            onClick={() => setNewOptions([...newOptions, ''])}>Add option</button>
        )}
        <button data-testid="sc-set-new-add" onClick={addQuestion}
          style={{ fontSize: '0.9rem', padding: '0.3rem 0.9rem' }}>Add question</button>
        {addError && <p style={{ color: '#c00', fontSize: '0.85rem' }}>{addError}</p>}
        <p style={{ fontSize: '0.78rem', color: colors.textSecondary, margin: '0.5rem 0 0' }}>
          ⚠ Added questions are saved with the rest of the page — the Save button below.
          Options are shown to students in a different order for each student, so the
          position of the right answer is never a hint.
        </p>
      </div>

      <div style={{ margin: '1.25rem 0' }}>
        <button onClick={save} disabled={saving} style={{ padding: '0.5rem 1.5rem', fontSize: '1rem' }}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        {savedAt && <span style={{ marginLeft: '1rem', color: colors.textSecondary }}>Saved {savedAt}</span>}
        {error && <p style={{ color: '#c00' }}>{error}</p>}
      </div>

      {/* ═══ THE §3.1 INDUCED-BEHAVIOUR PANEL ═══════════════════════════════ */}
      <hr style={{ margin: '2rem 0 1.5rem', border: 0, borderTop: `1px solid ${colors.borderMid}` }} />
      <h2 style={{ marginTop: 0 }}>What these numbers induce</h2>
      <p style={{ fontSize: '0.85rem', color: colors.textSecondary }}>
        Computed from the settings above, for both conditions. Nothing here blocks a save.
      </p>

      {induced.warnings.length > 0 && (
        <div style={{ margin: '1rem 0' }}>
          {induced.warnings.map(w => (
            <div key={w.id} style={{
              background: w.level === 'severe' ? '#fdf0f0' : '#fff8e6',
              border: `1px solid ${w.level === 'severe' ? '#e6bcbc' : '#e6d3a3'}`,
              borderRadius: 6, padding: '0.6rem 0.9rem', margin: '0 0 0.5rem', fontSize: '0.87rem',
            }}>
              <strong>{w.level === 'severe' ? '⚠ ' : ''}{w.message}</strong>
            </div>
          ))}
        </div>
      )}

      <table style={{ borderCollapse: 'collapse', fontSize: '0.9rem', margin: '1rem 0' }}>
        <thead>
          <tr>
            <th style={{ textAlign: 'left', padding: '0.3rem 1rem 0.3rem 0' }} />
            <th style={{ textAlign: 'left', padding: '0.3rem 1rem' }}>{induced.high.label}</th>
            <th style={{ textAlign: 'left', padding: '0.3rem 1rem' }}>{induced.low.label}</th>
          </tr>
        </thead>
        <tbody>
          {([
            ['One point must be worth more than', b => ecu(b.threshold as number)],
            ['Best possible earnings / contract', b => ecu(b.benchmarks.optimal)],
            ['Always working hard', b => ecu(b.benchmarks.alwaysHigh)],
            ['Never working hard', b => ecu(b.benchmarks.alwaysLow)],
            ['P(bonus) playing best', b => pct(b.benchmarks.pBonusOptimal)],
            ['High-effort periods, best play', b => b.benchmarks.expectedHighEffortPeriods.toFixed(2)],
          ] as [string, (b: ScorecardConditionPanel) => string][]).map(([label, get]) => (
            <tr key={label}>
              <td style={{ padding: '0.3rem 1rem 0.3rem 0' }}>{label}</td>
              <td style={{ padding: '0.3rem 1rem', fontVariantNumeric: 'tabular-nums' }}>{get(induced.high)}</td>
              <td style={{ padding: '0.3rem 1rem', fontVariantNumeric: 'tabular-nums' }}>{get(induced.low)}</td>
            </tr>
          ))}
          <tr>
            <td style={{ padding: '0.6rem 1rem 0.3rem 0', fontWeight: 600 }}>Separation</td>
            <td colSpan={2} style={{ padding: '0.6rem 1rem 0.3rem', fontWeight: 600 }}>
              {induced.separation.toFixed(2)} periods
              <span style={{ fontWeight: 400, color: colors.textSecondary }}>
                {' '}— how far apart best play is in the two conditions. The lesson needs at least 4.
              </span>
            </td>
          </tr>
        </tbody>
      </table>

      <h3>Optimal policy at these settings</h3>
      <p style={{ fontSize: '0.85rem', color: colors.textSecondary, margin: '0 0 0.75rem' }}>
        The slide-6 picture, computed from the numbers above. No student data is involved,
        so it is available before anyone has played — and students never see it.
      </p>
      <PolicyGridSVG panels={induced.policyGrid} currency={data.config.currency} />
      <PolicyGridLegend />
    </InstructorChrome>
  )
}
