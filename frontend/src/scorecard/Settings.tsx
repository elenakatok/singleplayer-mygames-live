import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { colors } from '@mygames/game-ui'
import { StartedBanner } from '../shared/StartedBanner'
import { useInstructorSession } from '../shared/useInstructorSession'
import { InstructorChrome } from '../shared/InstructorChrome'
import {
  scorecardGetConfig, scorecardUpdateConfig, scorecardInstructorSession, instructorErrorMessage,
  type ScorecardConfigResponse, type ScorecardConditionPanel,
  type ScorecardKcStage,
} from './api'
import { PolicyGridSVG, PolicyGridLegend } from './PolicyGridSVG'
import {
  KnowledgeCheckSettings,
  type KcSettingsDraft, type KcSettingsQuestion, type KcSettingsStage,
} from '../shared/KnowledgeCheckSettings'

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

/**
 * ⚠⚠ TWO STAGES, AND `post` MEANS AFTER THE REVEAL.
 *
 * The convergence spec's D11 names three — `pre_game`, `post_game` (after play, BEFORE the
 * results) and `debrief` (after the reveal). Scorecard's `'pre'` is `pre_game`; its
 * `'post'` questions are served AFTER the §10 reveal, so `'post'` IS `debrief`.
 *
 * ⚠ Scorecard's post_game slot holds only the `noticing` free-text step, and there is NO
 * render phase between the session summary and the reveal for a KC question to occupy.
 * Offering a third option here would let an instructor write a question that never appears.
 * See the report — this is flagged for Elena, not silently dropped.
 */
const KC_STAGES: KcSettingsStage[] = [
  {
    id: 'pre',
    label: 'Before play',
    note: 'Asked before the first contract begins.',
  },
  {
    id: 'post',
    label: 'After the reveal',
    note: 'Asked once the student has seen their two effort curves.',
  },
]

/**
 * ⚠ §9.1 SURVIVES AS A WARNING, NOT AS A MECHANISM (spec D13, §4.1 — warn-never-block).
 * Added questions used to be pinned to the post stage precisely because an instructor
 * cannot be expected to know this rule. Now they are told it instead.
 */
const KC_STAGE_WARNINGS: Record<string, string> = {
  pre:
    'This question is asked before play. Don’t write anything that suggests a target '
    + 'can stop being reachable — noticing that is what the game tests.',
}

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

  // ═══════════════════════════════════════════════════════════════════════════
  // THE KNOWLEDGE CHECK — now the SHARED block (convergence spec §2, §8.1).
  //
  // ⚠ The composer, the added-question list and the id minting all moved into
  // `shared/KnowledgeCheckSettings`. Scorecard supplies only what is genuinely its own:
  // the stage names, the §9.1 warning, and the copy saying what the toggle removes.
  // ═══════════════════════════════════════════════════════════════════════════

  /** ⚠ The draft is separate from `form` because it is a nested shape and `form`'s
   *  `set(k)(v)` helper is flat. Both go into the same `scorecardUpdateConfig` call. */
  const [kcDraft, setKcDraft] = useState<KcSettingsDraft | null>(null)
  /** What was graded when the page loaded — D2's comparison point. */

  useEffect(() => {
    if (session.kind !== 'ready') return
    let cancelled = false
    scorecardGetConfig()
      .then(r => {
        if (cancelled) return
        setData(r)
        setForm(seed(r))
        const d = seedKc(r)
        setKcDraft(d)
      })
      .catch(e => { if (!cancelled) setError(instructorErrorMessage(e)) })
    return () => { cancelled = true }
  }, [session])

  /** The server's inventory in the shared block's shape. Both kinds, one list. */
  function kcQuestions(r: ScorecardConfigResponse): KcSettingsQuestion[] {
    return [...r.kc.builtIn, ...r.kc.added]
  }

  function seedKc(r: ScorecardConfigResponse): KcSettingsDraft {
    return {
      enabled: r.config.kcEnabled,
      hidden: { ...r.config.kcHidden },
      order: { ...r.config.kcOrder },
      overrides: { ...r.config.kcOverrides },
      added: r.config.addedKcQuestions.map(q => ({ ...q })),
    }
  }

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
      // ⚠ The knowledge check is NOT seeded into `form` — it lives in `kcDraft` and is
      // merged into the patch at save time. Two homes for one field would drift.
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
      // ⚠ ONE CALL. The knowledge-check draft is merged into the same patch as everything
      // else, so a save is atomic from the instructor's point of view and the server's
      // re-read returns one consistent picture.
      const patch = { ...form, ...(kcDraft ? kcPatch(kcDraft) : {}) }
      const r = await scorecardUpdateConfig(patch)
      setData(r)
      setForm(seed(r))
      const d = seedKc(r)
      setKcDraft(d)
      // ⚠ The D2 baseline moves to what was just SAVED, so the banner reflects "changed
      // since you last saved" rather than firing forever after one edit.
      setSavedAt(new Date().toLocaleTimeString())
    } catch (e) {
      setError(instructorErrorMessage(e))
    } finally {
      setSaving(false)
    }
  }

  /** The draft, in the callable's field names. */
  function kcPatch(d: KcSettingsDraft) {
    return {
      kcEnabled: d.enabled,
      kcHidden: d.hidden,
      kcOrder: d.order,
      kcOverrides: d.overrides,
      addedKcQuestions: d.added,
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

  /** ⚠ The §9.1 caution, shown beside Save so it is in front of the instructor at the
   *  moment they commit. It never blocks — `save()` does not consult it. */
  const preStageAdded = (kcDraft?.added ?? []).filter(
    a => (a.stage as ScorecardKcStage | undefined) === 'pre',
  )

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
      {/* ⚠ The wording that used to be inline here is now shared/StartedBanner.tsx,
          verbatim — this page is where it came from, and five other games adopted it. */}
      <StartedBanner started={data.started} testIdPrefix="sc" />

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

      {/* ═══ THE KNOWLEDGE CHECK — the SHARED block (convergence spec §2) ════ */}
      {kcDraft && (
        <KnowledgeCheckSettings
          testIdPrefix="sc-kc"
          questions={kcQuestions(data)}
          stages={KC_STAGES}
          draft={kcDraft}
          onChange={setKcDraft}
          stageWarnings={KC_STAGE_WARNINGS}
          // ⚠ SCORECARD'S OWN WORDING, PRESERVED (D12 — "Scorecard's shipped copy is the
          // model"). The block supplies the toggle; this sentence says what OFF removes,
          // and it must keep saying that the §10 debrief steps are NOT part of it.
          enableNote={(
            <>
              Off removes both stages — the questions asked before play and those asked
              after the reveal — along with anything you have added. ⚠ The three ordered
              steps of the debrief are <em>not</em> part of the knowledge check and are
              unaffected: students still answer the noticing question, see their two
              curves, and answer the linking question.
            </>
          )}
          // ⚠⚠ NO `startedWarning` IS PASSED ANY MORE — DELETED 2026-08-11, deliberately.
          // A KC-specific save-time warning lived here, firing when the VISIBLE GRADED SET
          // changed. The page-level banner at the top now covers it, and Elena's decision
          // is ONE mechanism across six games rather than five with one and scorecard with
          // two. The standing banner also needs no baseline, no comparison and no
          // definition of "a change" — and it is on screen BEFORE the instructor edits
          // anything, where a save-time warning could only ever arrive afterwards.
          // ⚠ Do not reinstate it without reversing that decision; a test asserts it is gone.
        />
      )}

      {/* ⚠ THE SAVE-TIME §9.1 WARNING (spec §4.1). It WARNS; `save()` never reads it. */}
      {preStageAdded.length > 0 && (
        <p
          data-testid="sc-kc-pre-stage-warning"
          style={{
            background: '#fff8e6', border: '1px solid #e6d3a3', borderRadius: 6,
            padding: '0.6rem 0.9rem', fontSize: '0.85rem', margin: '1.25rem 0 0',
          }}
        >
          ⚠ {KC_STAGE_WARNINGS.pre}
          {preStageAdded.length > 1 && ` (${preStageAdded.length} questions.)`}
        </p>
      )}

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
