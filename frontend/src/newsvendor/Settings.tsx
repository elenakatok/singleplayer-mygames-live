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
import {
  KnowledgeCheckSettings,
  type KcSettingsDraft, type KcSettingsQuestion, type KcSettingsStage,
} from '../shared/KnowledgeCheckSettings'

// ═══════════════════════════════════════════════════════════════════════════════
// Newsvendor instructor settings (spec §2). Same shape as pricing's: sections of
// plain inputs, a live PREVIEW of exactly what the student will see, an edit warning
// once anyone has played, and one Save that sends only what changed.
//
// ⚠ THE 4-NUMBER CONFIGURATOR DOES NOT APPLY HERE (spec §2). This is not a 2×2 matrix
// game; it has its own scalar config, and the fields below are it.
//
// ⚠⚠ THE KNOWLEDGE CHECK IS NOW EDITABLE — and the reason it used to say otherwise is
// still true, so the caution is kept rather than deleted (convergence spec §3).
//
// The old sentence was "the knowledge check is not editable, and that is the feature". That
// was an argument against DERIVING the questions from the instance, not against an
// instructor rewording one. Pricing derives its KC from the market so the two can never
// disagree; this game's twenty use FIXED teaching numbers that deliberately DIFFER from the
// instance, so a student must recompute rather than read an answer off the play screen.
//
// ⚠ THE CAUTION THAT SURVIVES: don't rewrite a question to use THIS instance's market. The
// numbers in these stems are chosen to be different on purpose; replacing them with the
// live P, c, mean and sd would let a student read the answer straight off the order screen
// instead of computing it. Everything else — wording, clarity, an extra distractor label —
// is fair game (D1; Elena, 08-10: "I don't see any harm").
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

/**
 * Newsvendor's two stages, for the shared block.
 *
 * ⚠⚠ `post` READS "AFTER THE RESULTS" — not pd's "After play" and not scorecard's "After
 * the reveal". Newsvendor's final-results screen is the last content screen before this
 * stage (resume.ts), so a student answering anything here has already seen their own
 * profits and their gap from the optimal order. An instructor writing a question needs to
 * know that.
 */
const KC_STAGES: KcSettingsStage[] = [
  { id: 'pre', label: 'Before play', note: 'Asked before the first period.' },
  {
    id: 'post',
    label: 'After the results',
    note: 'Asked once the game is over. ⚠ Students have already seen their final results — '
      + 'their profits, and how far their orders were from the optimal quantity.',
  },
]

/** ⚠ The two free-text rows' ids ARE their stored answer keys. Nothing moves. */
const PREP_ROW_ID = 'prep_strategy'
const DEBRIEF_ROW_ID = 'debrief_regular'

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
  // ═══════════════════════════════════════════════════════════════════════════
  // THE KNOWLEDGE CHECK — the SHARED block (convergence spec §2, §8.3).
  //
  // ⚠ The read-only preview <ol>, the prep textarea and the debrief textarea are all gone;
  // all three are rows in the list now. Newsvendor supplies only the stage labels, the
  // toggle copy, and the two-row translation below.
  // ═══════════════════════════════════════════════════════════════════════════
  const [kcDraft, setKcDraft] = useState<KcSettingsDraft | null>(null)

  const apply = (res: NewsvendorConfigResult) => {
    setLoaded(res)
    setDraft(res.config)
    setSeed(res.seed ?? '')
    setKcDraft(seedKc(res))
  }

  /** The server's inventory in the shared block's shape — both paragraph rows included. */
  function kcQuestions(r: NewsvendorConfigResult): KcSettingsQuestion[] {
    return [...r.kc.builtIn, ...r.kc.added, r.kc.prep, r.kc.debrief]
  }

  /**
   * ⚠⚠ THE TWO PARAGRAPH ROWS ARE BACKED BY THEIR OWN CONFIG KEYS, NOT BY THE THREE
   * CONVERGENCE MAPS — that is what makes folding them into the list a UI change with NO
   * STORAGE MIGRATION (spec D9). Inside the block they behave like any row, so their edits
   * land in `overrides[id]` and `hidden[id]`; this pair translates those to and from
   * `prepPrompt`/`prepEnabled` and `debriefPrompt`/`debriefEnabled` at the boundary. The
   * server never sees either, and REFUSES them if a hand-made call sends one.
   *
   * ⚠ `addedKcQuestions` is carried through untouched. It has always round-tripped through
   * this page (it is a member of NewsvendorEditableConfig and the save sends the whole
   * draft) while never being rendered, so an instance may ALREADY hold added questions
   * injected by callable. Adoption must show them, not drop them.
   */
  function seedKc(r: NewsvendorConfigResult): KcSettingsDraft {
    return {
      enabled: r.config.kcEnabled,
      hidden: {
        ...r.config.kcHidden,
        ...(r.config.prepEnabled ? {} : { [PREP_ROW_ID]: true }),
        ...(r.config.debriefEnabled ? {} : { [DEBRIEF_ROW_ID]: true }),
      },
      order: { ...r.config.kcOrder },
      overrides: { ...r.config.kcOverrides },
      added: r.config.addedKcQuestions.map(q => ({ ...q })),
    }
  }

  /** The draft, split back into the callable's real field names. */
  function kcPatch(d: KcSettingsDraft) {
    const { [PREP_ROW_ID]: prepHidden, [DEBRIEF_ROW_ID]: debriefHidden, ...hidden } = d.hidden
    const { [PREP_ROW_ID]: prepOverride, [DEBRIEF_ROW_ID]: debriefOverride, ...overrides } = d.overrides
    return {
      kcEnabled: d.enabled,
      kcHidden: hidden,
      kcOrder: d.order,
      kcOverrides: overrides,
      addedKcQuestions: d.added.map(q => ({
        ...q,
        // The shared draft types `stage` as a plain string (generic across six games);
        // newsvendor's callable takes its own two-value union.
        stage: q.stage === 'post' ? ('post' as const) : ('pre' as const),
      })),
      prepEnabled: prepHidden !== true,
      debriefEnabled: debriefHidden !== true,
      // ⚠ Falls back to what is stored, so a save that never touched a paragraph sends its
      // prompt unchanged rather than blanking it — the callable rejects an empty prompt.
      prepPrompt: prepOverride?.prompt ?? loaded?.config.prepPrompt ?? '',
      debriefPrompt: debriefOverride?.prompt ?? loaded?.config.debriefPrompt ?? '',
    }
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
      const res = await newsvendorUpdateConfig({
        ...draft,
        ...(kcDraft ? kcPatch(kcDraft) : {}),
        seed: seed.trim() === '' ? null : seed.trim(),
      })
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

      {/* ═══ THE KNOWLEDGE CHECK — the SHARED block (convergence spec §2) ════ */}
      {kcDraft && (
        <KnowledgeCheckSettings
          testIdPrefix="nv-kc"
          questions={kcQuestions(loaded)}
          stages={KC_STAGES}
          draft={kcDraft}
          onChange={setKcDraft}
          // ⚠ D12 — THE TOGGLE GATES GRADED QUESTIONS ONLY, and the copy says exactly that.
          // Both paragraphs have their own visibility checkbox in the list below.
          enableNote={(
            <>
              Off removes the{' '}
              <strong>{loaded.config.dual ? 'dual-sourcing' : 'single-source'}</strong>{' '}
              questions and any graded question you have added. ⚠ It does <em>not</em> remove
              the two written answers — the one before play or the one after the results — or
              any free-text question you have added. Those are ungraded, and each has its own
              visibility checkbox below.
            </>
          )}
          // ⚠ NO STARTED-BANNER IS PASSED, DELIBERATELY. Newsvendor has an `anyRoundsPlayed`
          // signal and a warning that uses it, but that warning lives inside the prices-and-
          // costs section and its copy is entirely about editing those numbers — it is not a
          // page-level banner like scorecard's. Spec §10 records this as a decision pending
          // for pd, pricing and now newsvendor, to be swept once rather than invented here.
        />
      )}

      {/* ⚠ THE CAUTION THAT REPLACED "NOT EDITABLE" — see the header. It is about
          DERIVING, which is still forbidden, not about wording, which is now allowed. */}
      <p style={{ ...note, marginTop: '-0.5rem', marginBottom: '1.25rem' }} data-testid="nv-kc-derive-caution">
        ⚠ These questions carry their own numbers on purpose — a{' '}
        <strong>different</strong> market from the one your students play, so they have to
        redo the calculation instead of reading an answer off the order screen. Reword them
        freely, but <strong>don&rsquo;t rewrite one to use this instance&rsquo;s market</strong>:
        that would hand the answer over.
      </p>

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
