import { useEffect, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { colors } from '@mygames/game-ui'
import { InstructorChrome } from '../shared/InstructorChrome'
import { useInstructorSession } from '../shared/useInstructorSession'
import {
  pdGetConfig, pdUpdateConfig, pdInstructorSession, CLASSROOM_URL,
  type PdConfigResult, type PdPayoffs, type PdMoveLabels,
} from './api'
import { PayoffMatrix } from './PayoffMatrix'
import {
  KnowledgeCheckSettings,
  type KcSettingsDraft, type KcSettingsQuestion, type KcSettingsStage,
} from '../shared/KnowledgeCheckSettings'

// ═══════════════════════════════════════════════════════════════════════════════
// PD settings (Slice 5) — the instructor's real work, in poll's Settings shape:
// load the whole config, edit locally, Save writes it back and re-reads.
//
// WHAT IS EDITABLE, AND WHAT DELIBERATELY IS NOT:
//
//   • The payoff matrix, the move labels, and the UNIT. The live preview below is the
//     same PayoffMatrix component the students see, fed from the form, so the
//     instructor reads their edit exactly as the class will.
//
//   • The round-count RANGE. Not the count — that is drawn once per instance and
//     lives rules-denied in truth/; this page never receives it, only WHETHER it has
//     been drawn, so it can warn that a range edit will not move an instance already
//     in play.
//
//   • The knowledge check — now the SHARED block (convergence spec §2). Every question
//     this instance can ask is listed there with the same four controls: show/hide,
//     move up/down, edit (or a reason it cannot be edited), and delete on added
//     questions only.
//     ⚠ THE FOUR MATRIX QUESTIONS ARE NOT EDITABLE, ON PURPOSE — and the block now says
//     so on each row rather than in prose. They are derived from the payoff matrix every
//     time they are served AND every time they are graded, so they cannot drift from the
//     matrix on the student's screen. Editing the matrix rewrites them; that is the
//     feature, not a missing one. The classification is MEASURED server-side, not listed
//     (functions pd/kcLock.ts), so it cannot rot.
//
//   • The debrief is A ROW IN THAT LIST (spec D9) — "debrief is not a separate surface,
//     it is an ungraded question in a later stage". Its standalone textarea is gone.
//     ⚠ Its prompt and visibility still store to `debrief_prompt` / `debrief_enabled`;
//     the translation lives in seedKc/kcPatch below. No stored answer moved.
//
//   • The bot strategies (tit-for-tat / GRIM) are NOT configurable — by decision.
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * PD's two stages, for the shared block.
 *
 * ⚠⚠ `post` READS "AFTER PLAY", NOT "AFTER THE REVEAL". PD HAS NO REVEAL — the bot's
 * assigned strategy is never shown to the student, because inferring it from play IS the
 * exercise (spec §5). Scorecard's wording names a screen this game does not have, which is
 * exactly why these labels are props and not baked into the shared block.
 *
 * ⚠ `acceptsAdded: false` on `post`. Only the debrief lives there: pd's Play.tsx runs the
 * KC screens, then the round loop, then the debrief, with NO post-play KC screen. An added
 * question assigned to `post` would be served before play instead — so the picker does not
 * offer it rather than silently contradicting the instructor. Flagged in the handoff.
 */
const KC_STAGES: KcSettingsStage[] = [
  { id: 'pre', label: 'Before play', note: 'Asked before the first round.' },
  {
    id: 'post',
    label: 'After play',
    note: 'Asked once the last round is over. There is no reveal in this game — the other '
      + 'player’s strategy is never shown.',
    acceptsAdded: false,
  },
]

/** ⚠ The debrief row's id IS its stored answer key. Nothing moves. */
const DEBRIEF_ROW_ID = 'debrief_reflection'

const field: CSSProperties = {
  width: '100%', fontSize: '0.95rem', padding: '0.45rem 0.55rem',
  borderRadius: 4, border: `1px solid ${colors.inputBorder}`, boxSizing: 'border-box',
}
const numField: CSSProperties = { ...field, width: '6rem' }
const sectionStyle: CSSProperties = {
  border: `1px solid ${colors.sectionBorder}`, borderRadius: 8,
  padding: '1rem 1.25rem', marginBottom: '1.25rem',
}
const legend: CSSProperties = {
  margin: '0 0 0.75rem', fontSize: '0.8rem', fontWeight: 700,
  textTransform: 'uppercase', letterSpacing: '0.04em', color: colors.sectionMuted,
}
const hint: CSSProperties = { fontSize: '0.8rem', color: colors.textSecondary, margin: '0.35rem 0 0', lineHeight: 1.5 }
const row: CSSProperties = { display: 'flex', gap: '1rem', flexWrap: 'wrap', alignItems: 'flex-end' }

function Section({ title, children }: { title: string; children: ReactNode }) {
  return <section style={sectionStyle}><h2 style={legend}>{title}</h2>{children}</section>
}

function Labelled({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', fontSize: '0.85rem', color: colors.fieldLabelColor }}>
      {label}
      {children}
    </label>
  )
}

const TITLE = 'Repeated Prisoner’s Dilemma — Settings'

export default function Settings() {
  const session = useInstructorSession(pdInstructorSession)
  const navigate = useNavigate()

  const [cfg, setCfg] = useState<PdConfigResult | null>(null)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  // ═══════════════════════════════════════════════════════════════════════════
  // THE KNOWLEDGE CHECK — the SHARED block (convergence spec §2, §8.2).
  //
  // ⚠ The composer, the added-question list, the id minting and the standalone debrief
  // textarea all moved into `shared/KnowledgeCheckSettings`. pd supplies only what is its
  // own: the stage labels, the toggle copy, and the debrief↔row translation below.
  // ═══════════════════════════════════════════════════════════════════════════
  const [kcDraft, setKcDraft] = useState<KcSettingsDraft | null>(null)

  useEffect(() => {
    if (session.kind !== 'ready') return
    pdGetConfig()
      .then(r => { setCfg(r); setKcDraft(seedKc(r)) })
      .catch(e => setErr(e instanceof Error ? e.message : 'Failed to load settings.'))
  }, [session.kind])

  const patch = (p: Partial<PdConfigResult>) => setCfg(c => (c ? { ...c, ...p } : c))
  const setPayoff = (k: keyof PdPayoffs, v: number) =>
    setCfg(c => (c ? { ...c, payoffs: { ...c.payoffs, [k]: v } } : c))
  const setLabel = (k: keyof PdMoveLabels, v: string) =>
    setCfg(c => (c ? { ...c, labels: { ...c.labels, [k]: v } } : c))

  /** The server's inventory in the shared block's shape — the debrief row included. */
  function kcQuestions(r: PdConfigResult): KcSettingsQuestion[] {
    return [...r.kc.builtIn, ...r.kc.added, r.kc.debrief]
  }

  /**
   * ⚠⚠ THE DEBRIEF ROW IS BACKED BY `debriefPrompt` / `debriefEnabled`, NOT BY THE THREE
   * CONVERGENCE MAPS — that is what makes folding it into the list a UI change with NO
   * STORAGE MIGRATION (spec D9). Inside the block it behaves like any other row, so its
   * edits land in `overrides[debrief_reflection]` and `hidden[debrief_reflection]`; this
   * pair of functions translates those to and from the real config keys at the boundary.
   * The server never sees an override or a hide for the debrief id.
   */
  function seedKc(r: PdConfigResult): KcSettingsDraft {
    return {
      enabled: r.kcEnabled,
      hidden: {
        ...r.kcHidden,
        // debriefEnabled === false IS "hidden" for this row.
        ...(r.debriefEnabled ? {} : { [DEBRIEF_ROW_ID]: true }),
      },
      order: { ...r.kcOrder },
      overrides: { ...r.kcOverrides },
      added: r.addedKcQuestions.map(q => ({ ...q })),
    }
  }

  /** The draft, split back into the callable's real field names. */
  function kcPatch(d: KcSettingsDraft) {
    const { [DEBRIEF_ROW_ID]: debriefHidden, ...hidden } = d.hidden
    const { [DEBRIEF_ROW_ID]: debriefOverride, ...overrides } = d.overrides
    return {
      kcEnabled: d.enabled,
      kcHidden: hidden,
      kcOrder: d.order,
      kcOverrides: overrides,
      addedKcQuestions: d.added,
      debriefEnabled: debriefHidden !== true,
      // ⚠ Falls back to what is stored, so a save that never touched the debrief sends the
      // prompt unchanged rather than blanking it — the callable rejects an empty prompt.
      debriefPrompt: debriefOverride?.prompt ?? cfg?.debriefPrompt ?? '',
    }
  }

  const save = async () => {
    if (!cfg) return
    setSaving(true); setErr(null); setMsg(null)
    try {
      const res = await pdUpdateConfig({
        payoffs: cfg.payoffs,
        labels: cfg.labels,
        unit: cfg.unit,
        minRounds: cfg.minRounds,
        maxRounds: cfg.maxRounds,
        ...(kcDraft ? kcPatch(kcDraft) : {}),
      })
      // Show what was STORED (server-normalized), not what we hoped we sent — and the
      // re-derived KC preview that the new matrix produces.
      setCfg(res)
      setKcDraft(seedKc(res))
      setMsg('Saved.')
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Save failed.')
    } finally {
      setSaving(false)
    }
  }

  const navLinks = [
    { label: '← Dashboard', href: `/dashboard${window.location.search}` },
    { label: 'Reports →', href: `/reports${window.location.search}` },
  ]
  const chrome = (body: ReactNode) => (
    <InstructorChrome title={TITLE} navLinks={navLinks} onNavigate={navigate}>
      <div style={{ maxWidth: 780 }}>{body}</div>
    </InstructorChrome>
  )

  if (session.kind === 'loading') return chrome(<p>Loading…</p>)
  if (session.kind === 'no-token') return chrome(<p>Open settings from the classroom.</p>)
  if (session.kind === 'error') {
    return chrome(<><p style={{ color: '#c00' }}>{session.message}</p><p><a href={CLASSROOM_URL}>← Return to classroom</a></p></>)
  }
  if (err && !cfg) return chrome(<p style={{ color: '#c00' }}>{err}</p>)
  if (!cfg) return chrome(<p>Loading settings…</p>)

  const rangeInvalid = cfg.minRounds > cfg.maxRounds || cfg.minRounds < 1

  return chrome(
    <div data-testid="pd-settings">
      {/* ── Payoffs ─────────────────────────────────────────────────────────── */}
      <Section title="Payoff matrix">
        <div style={row}>
          <Labelled label={`Both choose ${cfg.labels.C}`}>
            <input
              data-testid="pd-set-both_cooperate" type="number" style={numField}
              value={cfg.payoffs.both_cooperate}
              onChange={e => setPayoff('both_cooperate', Number(e.target.value))}
            />
          </Labelled>
          <Labelled label={`You ${cfg.labels.C}, they ${cfg.labels.D}`}>
            <input
              data-testid="pd-set-sucker" type="number" style={numField}
              value={cfg.payoffs.sucker}
              onChange={e => setPayoff('sucker', Number(e.target.value))}
            />
          </Labelled>
          <Labelled label={`You ${cfg.labels.D}, they ${cfg.labels.C}`}>
            <input
              data-testid="pd-set-temptation" type="number" style={numField}
              value={cfg.payoffs.temptation}
              onChange={e => setPayoff('temptation', Number(e.target.value))}
            />
          </Labelled>
          <Labelled label={`Both choose ${cfg.labels.D}`}>
            <input
              data-testid="pd-set-both_defect" type="number" style={numField}
              value={cfg.payoffs.both_defect}
              onChange={e => setPayoff('both_defect', Number(e.target.value))}
            />
          </Labelled>
        </div>
        <p style={hint}>
          Each value is what <strong>you</strong> get in that cell, in the unit set below.
          The game states no direction — whether a bigger number is better is yours to frame.
        </p>

        <div style={{ marginTop: '1rem' }}>
          <p style={{ ...hint, marginBottom: '0.5rem' }}>Preview — exactly what students see:</p>
          <PayoffMatrix payoffs={cfg.payoffs} labels={cfg.labels} unit={cfg.unit} />
        </div>
      </Section>

      {/* ── Labels + unit ───────────────────────────────────────────────────── */}
      <Section title="Wording">
        <div style={row}>
          <Labelled label="First move">
            <input
              data-testid="pd-set-label-c" style={{ ...field, width: '12rem' }}
              value={cfg.labels.C} onChange={e => setLabel('C', e.target.value)}
            />
          </Labelled>
          <Labelled label="Second move">
            <input
              data-testid="pd-set-label-d" style={{ ...field, width: '12rem' }}
              value={cfg.labels.D} onChange={e => setLabel('D', e.target.value)}
            />
          </Labelled>
          <Labelled label="Unit">
            <input
              data-testid="pd-set-unit" style={{ ...field, width: '10rem' }}
              value={cfg.unit} onChange={e => patch({ unit: e.target.value })}
            />
          </Labelled>
        </div>
        <p style={hint}>
          The move names appear on the play screen, the history table and the knowledge
          check. The unit is one word printed after every number — &ldquo;years&rdquo;,
          &ldquo;points&rdquo;, &ldquo;dollars&rdquo;.
        </p>
      </Section>

      {/* ── Round range ─────────────────────────────────────────────────────── */}
      <Section title="Number of rounds">
        <div style={row}>
          <Labelled label="Minimum">
            <input
              data-testid="pd-set-min-rounds" type="number" style={numField}
              value={cfg.minRounds} onChange={e => patch({ minRounds: Number(e.target.value) })}
            />
          </Labelled>
          <Labelled label="Maximum">
            <input
              data-testid="pd-set-max-rounds" type="number" style={numField}
              value={cfg.maxRounds} onChange={e => patch({ maxRounds: Number(e.target.value) })}
            />
          </Labelled>
        </div>
        {rangeInvalid && (
          <p data-testid="pd-set-range-error" style={{ ...hint, color: colors.errorAction }}>
            The minimum must be at least 1 and cannot exceed the maximum.
          </p>
        )}
        <p style={hint}>
          The actual number of rounds is drawn at random inside this range, once per
          <strong> student</strong>, and is <strong>never shown to students</strong> —
          they are told the range and nothing more. Because each student draws their
          own, one who finishes early cannot tell the class how long the game is. Set
          both to the same number for a fixed-length game.
        </p>
        {cfg.anyRoundsDrawn && (
          <p data-testid="pd-set-rounds-drawn" style={{ ...hint, color: colors.warnBannerText }}>
            ⚠ Students have already started, and each has drawn their number of rounds.
            Changing the range here will <strong>not</strong> change theirs — students
            already playing keep the game they started. A new range applies to students
            who have not launched yet.
          </p>
        )}
      </Section>

      {/* ═══ THE KNOWLEDGE CHECK — the SHARED block (convergence spec §2) ════ */}
      {kcDraft && (
        <KnowledgeCheckSettings
          testIdPrefix="pd-kc"
          questions={kcQuestions(cfg)}
          stages={KC_STAGES}
          draft={kcDraft}
          onChange={setKcDraft}
          // ⚠ D12 — THE TOGGLE GATES GRADED QUESTIONS ONLY, and the copy says exactly that.
          // The debrief paragraph has its own visibility checkbox in the list below, so
          // switching the check off must not be read as switching the reflection off too.
          enableNote={(
            <>
              Off removes the four matrix questions and any graded question you have added.
              ⚠ It does <em>not</em> remove the debrief paragraph, or any free-text question
              you have added — those are ungraded, and each has its own visibility checkbox
              in the list below.
            </>
          )}
          // ⚠ NO STARTED-BANNER IS PASSED, DELIBERATELY. pd has an `anyRoundsDrawn` signal
          // and one warning that uses it, but that warning lives in the round-range section
          // and its copy is entirely about round ranges — it is not a page-level banner
          // like scorecard's. Writing new KC-specific banner copy here would be inventing a
          // mechanism this page does not have. Raised in the handoff for Elena's call.
        />
      )}

      {err && <p data-testid="pd-set-error" style={{ color: '#c00' }}>{err}</p>}
      {msg && <p data-testid="pd-set-saved" style={{ color: colors.successText }}>{msg}</p>}

      <button
        data-testid="pd-set-save"
        onClick={() => void save()}
        disabled={saving || rangeInvalid}
        style={{
          padding: '0.6rem 1.5rem', fontSize: '1rem', fontWeight: 600,
          cursor: (saving || rangeInvalid) ? 'not-allowed' : 'pointer',
          backgroundColor: (saving || rangeInvalid) ? colors.disabledBtnBg : colors.text,
          color: colors.white, border: 'none', borderRadius: 6,
        }}
      >
        {saving ? 'Saving…' : 'Save'}
      </button>
    </div>,
  )
}
