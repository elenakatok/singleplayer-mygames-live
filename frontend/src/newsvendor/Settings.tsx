import { useEffect, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { colors } from '@mygames/game-ui'
import { InstructorChrome } from '../shared/InstructorChrome'
import { useInstructorSession } from '../shared/useInstructorSession'
import {
  newsvendorGetConfig, newsvendorUpdateConfig, newsvendorInstructorSession, CLASSROOM_URL,
  type NewsvendorConfigResult, type NewsvendorEditableConfig,
} from './api'
import { formatMoney, formatUnits } from './format'
import { ParameterBox, DemandBox } from './ParamsPanel'

// ═══════════════════════════════════════════════════════════════════════════════
// Newsvendor instructor settings (spec §2). Same shape as pricing's: sections of
// plain inputs, a live PREVIEW of exactly what the student will see, an edit warning
// once anyone has played, and one Save that sends only what changed.
//
// ⚠ THE 4-NUMBER CONFIGURATOR DOES NOT APPLY HERE (spec §2). This is not a 2×2 matrix
// game; it has its own scalar config, and the fields below are it.
//
// ⚠ THE KNOWLEDGE CHECK IS NOT EDITABLE, AND THAT IS THE FEATURE. Pricing derives its
// KC from the market so the two can never disagree; this game's ten questions use
// FIXED teaching numbers that deliberately differ from the instance, so students must
// recompute rather than read an answer off the play screen. They are previewed
// read-only below. An instructor who wants instance-specific questions adds their own.
//
// ⚠ THE SEED IS INSTRUCTOR-ONLY AND LIVES IN TRUTH. It derives every demand draw, so
// it is stored in the rules-denied truth doc rather than the student-readable config
// (functions newsvendor/config.ts). Blank = real randomness.
// ═══════════════════════════════════════════════════════════════════════════════

const section: CSSProperties = {
  border: `1px solid ${colors.borderLight}`, borderRadius: 8,
  padding: '1rem 1.15rem', marginBottom: '1.25rem',
}
const sectionTitle: CSSProperties = {
  margin: '0 0 0.75rem', fontSize: '0.78rem', fontWeight: 700,
  letterSpacing: '0.04em', textTransform: 'uppercase', color: colors.textSecondary,
}
const fieldRow: CSSProperties = { display: 'flex', gap: '1rem', flexWrap: 'wrap', marginBottom: '0.6rem' }
const note: CSSProperties = { fontSize: '0.8rem', color: colors.textSecondary, lineHeight: 1.55, margin: '0.4rem 0 0' }
const warn: CSSProperties = { ...note, color: colors.errorAction }

function NumField({ label, value, onChange, step = 1, testId }: {
  label: string
  value: number
  onChange: (v: number) => void
  step?: number
  testId: string
}) {
  return (
    <label style={{ display: 'block' }}>
      <span style={{ display: 'block', fontSize: '0.78rem', color: colors.textSecondary, marginBottom: '0.2rem' }}>
        {label}
      </span>
      <input
        data-testid={testId}
        type="number"
        step={step}
        value={Number.isFinite(value) ? value : ''}
        onChange={e => onChange(Number(e.target.value))}
        style={{
          width: '9rem', fontSize: '0.95rem', padding: '0.4rem 0.55rem', borderRadius: 4,
          border: `1px solid ${colors.inputBorder}`, fontVariantNumeric: 'tabular-nums',
        }}
      />
    </label>
  )
}

function Check({ label, checked, onChange, testId, children }: {
  label: string
  checked: boolean
  onChange: (v: boolean) => void
  testId: string
  children?: ReactNode
}) {
  return (
    <div style={{ marginBottom: '0.5rem' }}>
      <label style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer' }}>
        <input data-testid={testId} type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} />
        <strong style={{ fontWeight: 600 }}>{label}</strong>
      </label>
      {children}
    </div>
  )
}

const TITLE = 'Newsvendor — Settings'

export default function Settings() {
  const session = useInstructorSession(newsvendorInstructorSession)
  const navigate = useNavigate()
  const [loaded, setLoaded] = useState<NewsvendorConfigResult | null>(null)
  const [draft, setDraft] = useState<NewsvendorEditableConfig | null>(null)
  const [seed, setSeed] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [saveMsg, setSaveMsg] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const apply = (res: NewsvendorConfigResult) => {
    setLoaded(res)
    setDraft(res.config)
    setSeed(res.seed ?? '')
  }

  useEffect(() => {
    if (session.kind !== 'ready') return
    newsvendorGetConfig().then(apply).catch(e => setErr(e instanceof Error ? e.message : 'Failed to load settings.'))
  }, [session.kind])

  const navLinks = [
    { label: '← Dashboard', href: `/dashboard${window.location.search}` },
    { label: 'Reports →', href: `/reports${window.location.search}` },
  ]
  const chrome = (body: ReactNode) => (
    <InstructorChrome title={TITLE} navLinks={navLinks} onNavigate={navigate}>{body}</InstructorChrome>
  )

  if (session.kind === 'loading') return chrome(<p>Loading…</p>)
  if (session.kind === 'no-token') return chrome(<p>Open settings from the classroom.</p>)
  if (session.kind === 'error') {
    return chrome(<><p style={{ color: '#c00' }}>{session.message}</p><p><a href={CLASSROOM_URL}>← Return to classroom</a></p></>)
  }
  if (err && !loaded) return chrome(<p style={{ color: '#c00' }}>{err}</p>)
  if (!loaded || !draft) return chrome(<p>Loading settings…</p>)

  const set = <K extends keyof NewsvendorEditableConfig>(key: K, value: NewsvendorEditableConfig[K]) =>
    setDraft(d => (d ? { ...d, [key]: value } : d))

  const handleSave = async () => {
    setSaving(true)
    setSaveMsg(null)
    setErr(null)
    try {
      const res = await newsvendorUpdateConfig({ ...draft, seed: seed.trim() === '' ? null : seed.trim() })
      apply(res)
      setSaveMsg('Saved.')
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Save failed.')
    } finally {
      setSaving(false)
    }
  }

  // The preview is built from the DRAFT, not from what is stored, so an instructor
  // sees the consequence of an edit before saving it. The bounds shown come from the
  // server's own view, so they only update after a save — the note says so.
  const previewParams = {
    P: draft.P, c: draft.c, v: draft.v, g: draft.g, h: draft.h,
    dual: draft.dual, cL: draft.dual ? draft.cL : 0,
    isNormal: draft.isNormal, mean: draft.mean, sd: draft.sd, minD: draft.minD, maxD: draft.maxD,
    periods: draft.periods,
    orderMin: loaded.orderBounds.min, orderMax: loaded.orderBounds.max,
    showCalculator: draft.showCalculator, showServiceLevel: draft.showServiceLevel,
  }

  return chrome(
    <>
      {loaded.configError && (
        <p data-testid="nv-settings-config-error" style={{ ...warn, fontWeight: 600, marginBottom: '1rem' }}>
          ⚠ {loaded.configError}
        </p>
      )}

      {/* ── The MODE (spec §5) ─────────────────────────────────────────────── */}
      <section style={section}>
        <h2 style={sectionTitle}>Sourcing</h2>
        <Check
          label="Dual sourcing"
          checked={draft.dual}
          onChange={v => set('dual', v)}
          testId="nv-set-dual"
        />
        <p style={note}>
          One toggle, and everything follows it: how profit is computed, what the optimal
          order means, which knowledge check is asked, what the play screens are labelled,
          and which debrief question is put. Run <strong>two instances of this game</strong>{' '}
          in the same course — one with this off, one with it on.
        </p>
        <p style={note}>
          <strong>Off (single source).</strong> You order once; demand you cannot meet is a
          lost sale, plus the shortage cost.{' '}
          <strong>On (dual sourcing).</strong> Your order is a quantity RESERVED cheaply up
          front; demand beyond it is still met, bought in from a second supplier at the
          higher cost below. Nothing is ever short — so the shortage cost{' '}
          <strong>g is not used at all</strong> in this mode, and students never see it.
        </p>
        {draft.dual && (
          <div style={{ ...fieldRow, marginTop: '0.75rem' }}>
            <NumField
              label="Second-supplier cost per unit"
              value={draft.cL}
              onChange={v => set('cL', v)}
              testId="nv-set-cl"
            />
          </div>
        )}
        {draft.dual && (
          <p style={note}>
            This is the <strong>full</strong> price of a top-up unit, not the extra over your
            own cost. The premium is worked out from it:{' '}
            <strong data-testid="nv-settings-premium">
              {formatMoney(draft.cL)} − {formatMoney(draft.c)} = {formatMoney(draft.cL - draft.c)}
            </strong>{' '}
            per unit. It must be <strong>above</strong> the unit cost — if the second source
            were no dearer than reserving, there would be nothing to trade off and no
            optimal reserve to find.
          </p>
        )}
      </section>

      {/* ── Prices and costs (spec §2) ─────────────────────────────────────── */}
      <section style={section}>
        <h2 style={sectionTitle}>Prices and costs</h2>
        <div style={fieldRow}>
          <NumField label="Selling price P" value={draft.P} onChange={v => set('P', v)} testId="nv-set-P" />
          <NumField
            label={draft.dual ? 'Cost per unit reserved c' : 'Unit cost c'}
            value={draft.c} onChange={v => set('c', v)} testId="nv-set-c"
          />
          <NumField label="Salvage value v" value={draft.v} onChange={v => set('v', v)} testId="nv-set-v" />
          <NumField label="Holding cost h" value={draft.h} onChange={v => set('h', v)} testId="nv-set-h" />
          {!draft.dual && (
            <NumField label="Shortage cost g" value={draft.g} onChange={v => set('g', v)} testId="nv-set-g" />
          )}
        </div>
        <p style={note}>
          A line whose value is zero is hidden from the student&rsquo;s screen rather than
          shown as $0. The selling price must exceed the unit cost, and the unit cost must
          exceed the net salvage (v − h) — otherwise leftover units cost nothing and there
          is no optimal order to compare anyone against.
          {draft.dual && ' The shortage cost is hidden here because dual sourcing never'
            + ' incurs one; it is left stored, untouched, for if you switch back.'}
        </p>
        {loaded.benchmark && (
          <p data-testid="nv-settings-benchmark" style={note}>
            {loaded.config.dual && <>Under dual sourcing the underage is the PREMIUM, not the
              retail margin — the price and the shortage cost drop out entirely, because
              demand is met either way and only the sourcing cost differs.{' '}</>}
            These numbers give underage <strong>{formatMoney(loaded.benchmark.CU)}</strong>,
            overage <strong>{formatMoney(loaded.benchmark.CO)}</strong>, a critical ratio of{' '}
            <strong>{loaded.benchmark.CR.toFixed(3)}</strong>, and an optimal order of{' '}
            <strong>{formatUnits(loaded.benchmark.Qopt)}</strong> units. Students never see any
            of this; it is what the reports compare them against.
          </p>
        )}
        {loaded.anyRoundsPlayed && (
          <p data-testid="nv-settings-played-warning" style={warn}>
            ⚠ Students have already played periods in this instance. Editing these does{' '}
            <strong>not</strong> recompute what they have already done — their recorded
            profits <em>and the benchmark stored beside them</em> were produced by the OLD
            numbers, and the class reports will pool the two. Prefer a fresh instance
            unless you are fixing a typo before anyone has really started.
          </p>
        )}
      </section>

      {/* ── Demand (spec §3) ───────────────────────────────────────────────── */}
      <section style={section}>
        <h2 style={sectionTitle}>Demand</h2>
        <div style={{ marginBottom: '0.6rem' }}>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem', marginRight: '1.25rem', cursor: 'pointer' }}>
            <input
              data-testid="nv-set-normal" type="radio" name="nv-dist" checked={draft.isNormal}
              onChange={() => set('isNormal', true)}
            />
            Normal
          </label>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer' }}>
            <input
              data-testid="nv-set-uniform" type="radio" name="nv-dist" checked={!draft.isNormal}
              onChange={() => set('isNormal', false)}
            />
            Uniform
          </label>
        </div>
        <div style={fieldRow}>
          {draft.isNormal ? (
            <>
              <NumField label="Mean" value={draft.mean} onChange={v => set('mean', v)} testId="nv-set-mean" />
              <NumField label="Standard deviation" value={draft.sd} onChange={v => set('sd', v)} testId="nv-set-sd" />
            </>
          ) : (
            <>
              <NumField label="Minimum demand" value={draft.minD} onChange={v => set('minD', v)} testId="nv-set-minD" />
              <NumField label="Maximum demand" value={draft.maxD} onChange={v => set('maxD', v)} testId="nv-set-maxD" />
            </>
          )}
          <NumField label="Number of periods" value={draft.periods} onChange={v => set('periods', v)} testId="nv-set-periods" />
        </div>
        <p style={note}>
          Demand is drawn on the server, per student and per period, only once the order
          for that period has been committed. The order box accepts{' '}
          <strong>{formatUnits(loaded.orderBounds.min)}</strong> to{' '}
          <strong>{formatUnits(loaded.orderBounds.max)}</strong> — Normal gives mean ± 3 SD,
          Uniform gives the demand range itself. That preview updates when you save.
        </p>
      </section>

      {/* ── What the student sees ──────────────────────────────────────────── */}
      <section style={section}>
        <h2 style={sectionTitle}>On-screen</h2>
        <Check
          label="Show the “try a quantity” calculator"
          checked={draft.showCalculator}
          onChange={v => set('showCalculator', v)}
          testId="nv-set-calculator"
        />
        <Check
          label="Show the demand-proportion (service level) column"
          checked={draft.showServiceLevel}
          onChange={v => set('showServiceLevel', v)}
          testId="nv-set-servicelevel"
        />
        <p style={note}>Both are display only — neither changes how anything is computed or scored.</p>

        <div style={{ marginTop: '1rem' }}>
          <p style={{ ...note, marginBottom: '0.5rem' }}><strong>Preview — exactly what students see:</strong></p>
          <ParameterBox params={previewParams} />
          <DemandBox params={previewParams} />
        </div>
      </section>

      {/* ── Prep, knowledge check, debrief (spec §8) ───────────────────────── */}
      <section style={section}>
        <h2 style={sectionTitle}>Prep question</h2>
        <Check
          label="Ask the prep question before play"
          checked={draft.prepEnabled}
          onChange={v => set('prepEnabled', v)}
          testId="nv-set-prep-enabled"
        />
        <textarea
          data-testid="nv-set-prep-prompt"
          value={draft.prepPrompt}
          onChange={e => set('prepPrompt', e.target.value)}
          rows={4}
          style={{
            width: '100%', fontSize: '0.9rem', padding: '0.5rem', borderRadius: 4, marginTop: '0.4rem',
            border: `1px solid ${colors.inputBorder}`, boxSizing: 'border-box', fontFamily: 'inherit', lineHeight: 1.55,
          }}
        />
        <p style={note}>Free text, ungraded. It gets its own report.</p>
      </section>

      <section style={section}>
        <h2 style={sectionTitle}>Knowledge check</h2>
        <Check
          label="Include the knowledge check"
          checked={draft.kcEnabled}
          onChange={v => set('kcEnabled', v)}
          testId="nv-set-kc-enabled"
        />
        <p style={note}>
          These <strong>{loaded.authoredKcPreview.length}</strong>{' '}
          <strong>{loaded.config.dual ? 'DUAL-SOURCING' : 'single-source'}</strong> questions
          are graded and are this game&rsquo;s assessed component. The two sets are mutually
          exclusive — flipping the sourcing toggle swaps the whole set, and they share no
          questions. They use <strong>fixed teaching numbers that differ
          from this instance on purpose</strong>, so students have to redo the calculation
          rather than read an answer off the play screen — which is why they are not
          editable here. Option order is shuffled per student. They are asked{' '}
          <strong>after</strong> the game, not before.
        </p>
        <ol data-testid="nv-settings-kc-preview" style={{ ...note, paddingLeft: '1.2rem' }}>
          {loaded.authoredKcPreview.map(q => (
            <li key={q.field} style={{ marginBottom: '0.35rem' }}>
              {q.prompt}{' '}
              <em>(answer: {q.options.find(o => o.value === q.correct_value)?.label ?? q.correct_value})</em>
            </li>
          ))}
        </ol>
      </section>

      <section style={section}>
        <h2 style={sectionTitle}>Debrief</h2>
        <Check
          label="Ask for a debrief paragraph"
          checked={draft.debriefEnabled}
          onChange={v => set('debriefEnabled', v)}
          testId="nv-set-debrief-enabled"
        />
        <textarea
          data-testid="nv-set-debrief-prompt"
          value={draft.debriefPrompt}
          onChange={e => set('debriefPrompt', e.target.value)}
          rows={4}
          style={{
            width: '100%', fontSize: '0.9rem', padding: '0.5rem', borderRadius: 4, marginTop: '0.4rem',
            border: `1px solid ${colors.inputBorder}`, boxSizing: 'border-box', fontFamily: 'inherit', lineHeight: 1.55,
          }}
        />
        <p style={note}>Free text, ungraded. It gets its own report, separate from the prep.</p>
      </section>

      {/* ── The seed ───────────────────────────────────────────────────────── */}
      <section style={section}>
        <h2 style={sectionTitle}>Determinism seed</h2>
        <input
          data-testid="nv-set-seed"
          value={seed}
          onChange={e => setSeed(e.target.value)}
          placeholder="blank = real randomness"
          style={{
            width: '18rem', fontSize: '0.95rem', padding: '0.4rem 0.55rem', borderRadius: 4,
            border: `1px solid ${colors.inputBorder}`,
          }}
        />
        <p style={note}>
          Leave this blank for real randomness. Set it and every demand draw becomes a
          function of (seed, student, period) — reproducible across runs, still independent
          across students. It is stored where students cannot read it, because a student
          who had it could work out next period&rsquo;s demand before ordering this one.
        </p>
      </section>

      {err && <p data-testid="nv-settings-error" style={{ color: colors.errorAction, marginBottom: '0.75rem' }}>{err}</p>}
      {saveMsg && <p data-testid="nv-settings-saved" style={{ color: colors.text, marginBottom: '0.75rem' }}>{saveMsg}</p>}

      <button
        data-testid="nv-save-settings"
        onClick={() => void handleSave()}
        disabled={saving}
        style={{
          padding: '0.65rem 1.6rem', fontSize: '1rem', fontWeight: 600,
          cursor: saving ? 'not-allowed' : 'pointer',
          backgroundColor: saving ? '#999' : colors.text, color: colors.white,
          border: 'none', borderRadius: 6, marginBottom: '2rem',
        }}
      >
        {saving ? 'Saving…' : 'Save settings'}
      </button>
    </>,
  )
}
