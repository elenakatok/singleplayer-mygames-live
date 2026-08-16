import { useEffect, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { colors } from '@mygames/game-ui'
import { InstructorChrome } from '../shared/InstructorChrome'
import { StartedBanner } from '../shared/StartedBanner'
import { useInstructorSession } from '../shared/useInstructorSession'
import {
  pdGetConfig, pdUpdateConfig, pdInstructorSession, CLASSROOM_URL,
  type PdConfigResult, type PdPayoffs, type PdMoveLabels, type PdStrategy,
} from './api'
import { PayoffMatrix } from './PayoffMatrix'
import { warnNotADilemma, NOT_A_DILEMMA_WARNING } from './dilemma'
import { derivedKcRow } from './derivedKc'
import { strategyDisplayName, strategyRuleSummary } from './strategyText'
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
//   • The payoff matrix — EIGHT values, four columns × two rows. One column per action
//     combination in the order (C,C) (C,D) (D,C) (D,D); the top row is Y (what YOU get)
//     and the second is O (what the OTHER player gets in that same cell). Both header
//     rows interpolate the wording fields, so nothing on this page hardcodes
//     “Cooperate” or “Defect” — they are the instructor's words, not identifiers.
//     ⚠ IT USED TO BE FOUR BOXES, with the other player's payoff DERIVED as the
//     transpose. That made every configurable matrix symmetric. The live preview below
//     is the same PayoffMatrix component the students see and its RENDERING is
//     unchanged — only its data source moved.
//     An advisory NOT-A-DILEMMA notice appears under the grid when the numbers are a
//     dilemma under neither reading (see dilemma.ts). It NEVER blocks Save.
//
//   • The move labels and the UNIT.
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
//   • THE OPPONENT POOL — one checkbox per strategy, and the checked set is what this
//     instance may assign. ⚠ ZERO CHECKED BLOCKS SAVE, here AND at the callable.
//     ⚠ Unchecking never disturbs a student already assigned that strategy.
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * PD's two stages, for the shared block.
 *
 * ⚠⚠ `post` READS "AFTER PLAY", NOT "AFTER THE REVEAL". PD HAS NO REVEAL — the bot's
 * assigned strategy is never shown to the student, because inferring it from play IS the
 * exercise (spec §5). Scorecard's wording names a screen this game does not have, which is
 * exactly why these labels are props and not baked into the shared block.
 *
 * ⚠⚠ BOTH STAGES NOW ACCEPT ADDED QUESTIONS, so the picker offers both. `post` used to be
 * `acceptsAdded: false`, which was right at the time: nothing rendered a post-play question
 * LIST, so a question assigned there would have been served before play instead. It renders
 * one now — the post-play position in Play.tsx walks the whole stage, the debrief row
 * included — so the heading an instructor reads as "a place to put things" is one.
 *
 * ⚠ NO SAVE-TIME WARNING ON EITHER STAGE, unlike scorecard. Scorecard warns on `pre_game`
 * because its §9.1 forbids hinting before play that a target can become unreachable. pd has
 * no equivalent rule and no reveal — the other player's strategy is never shown at all — so
 * there is nothing to caution about and a warning would be noise.
 */
const KC_STAGES: KcSettingsStage[] = [
  { id: 'pre', label: 'Before play', note: 'Asked before the first round.' },
  {
    id: 'post',
    label: 'After play',
    note: 'Asked once the last round is over. There is no reveal in this game — the other '
      + 'player’s strategy is never shown.',
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

// ── The eight-value payoff grid ────────────────────────────────────────────────
//
// ⚠ THE COLUMN ORDER IS THE CONTRACT: (C,C) (C,D) (D,C) (D,D), read as
// (your move, the other player's move). The two header rows above the grid say the same
// thing in the instructor's own wording, and these two key lists must stay in that
// order or a header will name a different cell than the box beneath it.
const PAYOFF_ROWS: { who: 'You' | 'Other'; keys: (keyof PdPayoffs)[] }[] = [
  { who: 'You', keys: ['you_cc', 'you_cd', 'you_dc', 'you_dd'] },
  { who: 'Other', keys: ['other_cc', 'other_cd', 'other_dc', 'other_dd'] },
]

const payoffGrid: CSSProperties = { borderCollapse: 'collapse' }
const gridCorner: CSSProperties = { padding: '0.2rem 0.5rem' }
const gridHead: CSSProperties = {
  padding: '0.15rem 0.5rem', fontSize: '0.78rem', fontWeight: 600,
  color: colors.fieldLabelColor, textAlign: 'center', whiteSpace: 'nowrap',
}
const gridRowHead: CSSProperties = {
  padding: '0.2rem 0.6rem 0.2rem 0', fontSize: '0.85rem', fontWeight: 600,
  color: colors.fieldLabelColor, textAlign: 'right', whiteSpace: 'nowrap',
}
const gridCell: CSSProperties = { padding: '0.15rem 0.25rem', textAlign: 'center' }

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
  /** Toggle one strategy in the pool, keeping the canonical library order. */
  const setStrategy = (id: PdStrategy, on: boolean) =>
    setCfg((c) => {
      if (!c) return c
      const next = new Set(c.strategies)
      if (on) next.add(id)
      else next.delete(id)
      return { ...c, strategies: c.strategyOptions.map(o => o.id).filter(s => next.has(s)) }
    })

  /**
   * The server's inventory in the shared block's shape — the debrief row included.
   *
   * ⚠⚠ THE FOUR DERIVED ROWS ARE RE-RENDERED FROM THE LIVE FORM, not shown as the server
   * last resolved them. That is the whole fix: `r.kc.builtIn` carries text resolved at
   * the last load or save, so renaming the moves left the knowledge-check list saying
   * "Cooperate"/"Defect" while the payoff preview two sections up had already switched to
   * the new words. An instructor reading that concludes the KC does not follow the
   * wording. It always did — server-side, on every serve and every grade — but only
   * after a save round-trip, and the page never said so.
   *
   * ⚠ THE STUDENT-FACING TEXT IS STILL THE SERVER'S, ALWAYS. Nothing here is served or
   * graded; `derivedKcRow` is a display mirror for unsaved form state, pinned against the
   * server's strings by the paired tests named in derivedKc.ts.
   *
   * ⚠ ONLY `prompt`, `options` and `correctValue` are replaced. `locked`, `lockReason`,
   * `graded`, `visible`, `order` and `originalPrompt` stay the server's — they are
   * classifications, not text, and the lock in particular is MEASURED server-side and
   * must not be second-guessed here.
   */
  function kcQuestions(r: PdConfigResult): KcSettingsQuestion[] {
    const live = (q: KcSettingsQuestion): KcSettingsQuestion => {
      const d = derivedKcRow(q.id, r.payoffs, r.unit, r.labels)
      return d === null ? q : { ...q, prompt: d.prompt, options: d.options, correctValue: d.correctValue }
    }
    return [...r.kc.builtIn.map(live), ...r.kc.added, r.kc.debrief]
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
        strategies: cfg.strategies,
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
  /**
   * ⚠⚠ ZERO CHECKED BLOCKS SAVE — a HARD block, and NOT the dilemma advisory's shape.
   * The advisory informs and lets the save through, because a non-dilemma matrix is a
   * legitimate thing to run. An empty pool is not: first touch would have nothing to
   * draw and no student could start.
   *
   * ⚠ THE CALLABLE REFUSES IT TOO, in the same edit (instructorConfig.ts). A
   * client-only rule is the accept-then-reject mismatch the negative-payoff floor
   * produced; a server-only rule is the same failure with the roles swapped.
   */
  const noStrategies = cfg.strategies.length === 0

  return chrome(
    <div data-testid="pd-settings">
      {/* ⚠ THE PAGE-LEVEL BANNER (KC convergence §10, Elena 08-10). Predicate: cfg.anyRoundsDrawn —
          the per-student horizon is DRAWN at first load (init.ts, via getState), so a student who
          only opened the game already has a game nobody else can be compared against.
          ⚠ The section-scoped notices below are NOT folded into this and must not be: they
          name what editing THAT section does, which this cannot. */}
      <StartedBanner started={cfg.anyRoundsDrawn} testIdPrefix="pd" />

      {/* ── Payoffs — EIGHT values, four cells × two players ─────────────────
          Column order is the action combination (C,C) (C,D) (D,C) (D,D); the two header
          rows spell out whose move is whose, in the instructor's OWN wording. */}
      <Section title="Payoff matrix">
        <div style={{ overflowX: 'auto', maxWidth: '100%' }}>
          <table style={payoffGrid}>
            <thead>
              {/* ⚠ BOTH HEADER ROWS INTERPOLATE THE WORDING FIELDS. Nothing here says
                  "Cooperate" or "Defect" — those are just what labels.C / labels.D
                  happen to be on a fresh instance. */}
              <tr>
                <th style={gridCorner} />
                <th style={gridHead}>You: {cfg.labels.C}</th>
                <th style={gridHead}>You: {cfg.labels.C}</th>
                <th style={gridHead}>You: {cfg.labels.D}</th>
                <th style={gridHead}>You: {cfg.labels.D}</th>
              </tr>
              <tr>
                <th style={gridCorner} />
                <th style={gridHead}>Other: {cfg.labels.C}</th>
                <th style={gridHead}>Other: {cfg.labels.D}</th>
                <th style={gridHead}>Other: {cfg.labels.C}</th>
                <th style={gridHead}>Other: {cfg.labels.D}</th>
              </tr>
            </thead>
            <tbody>
              {PAYOFF_ROWS.map(r => (
                <tr key={r.who}>
                  <th style={gridRowHead}>{r.who} get</th>
                  {r.keys.map(k => (
                    <td key={k} style={gridCell}>
                      <input
                        data-testid={`pd-set-${k}`} type="number" style={numField}
                        aria-label={`${r.who} get, ${k}`}
                        value={cfg.payoffs[k]}
                        onChange={e => setPayoff(k, Number(e.target.value))}
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p style={hint}>
          The top row is what <strong>you</strong> get in that cell; the second row is what
          the <strong>other player</strong> gets in the same cell. They do not have to
          mirror each other — an asymmetric matrix is a legitimate thing to run.
          The game states no direction: whether a bigger number is better is yours to frame.
        </p>

        {/* ⚠ ADVISORY ONLY, AND IT NEVER BLOCKS SAVE. See dilemma.ts. */}
        {warnNotADilemma(cfg.payoffs) && (
          <p data-testid="pd-set-not-a-dilemma" style={{ ...hint, color: colors.warnBannerText }}>
            ⚠ {NOT_A_DILEMMA_WARNING}
          </p>
        )}

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

      {/* ── The opponent pool ───────────────────────────────────────────────── */}
      <Section title="Available strategies">
        <p style={{ ...hint, margin: '0 0 0.6rem' }}>
          Each student is assigned <strong>one</strong> of the checked strategies at
          random when they first open the game, and plays it for every round. They are
          never told which — inferring it from play is the exercise.
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.45rem' }}>
          {cfg.strategyOptions.map(opt => {
            const checked = cfg.strategies.includes(opt.id)
            return (
              <label
                key={opt.id}
                data-testid={`pd-set-strategy-${opt.id}`}
                style={{ display: 'flex', alignItems: 'flex-start', gap: '0.55rem', cursor: 'pointer' }}
              >
                <input
                  type="checkbox" checked={checked}
                  onChange={e => setStrategy(opt.id, e.target.checked)}
                  style={{ marginTop: '0.25rem' }}
                />
                <span>
                  {/* ⚠ RELABELLED LIVE from the wording fields above, not from the
                      server's load-time text — "Always <second move>" must follow a
                      rename as the instructor types, exactly as the knowledge-check
                      list now does. See strategyText.ts. */}
                  <strong>{strategyDisplayName(opt.id, cfg.labels)}</strong>
                  <span style={{ color: colors.textSecondary }}>
                    {' — '}{strategyRuleSummary(opt.id, cfg.labels)}
                  </span>
                </span>
              </label>
            )
          })}
        </div>
        {noStrategies && (
          <p data-testid="pd-set-no-strategies" style={{ ...hint, color: colors.errorAction }}>
            Choose at least one strategy — an instance with none cannot be played.
          </p>
        )}
        {cfg.anyRoundsDrawn && (
          <p data-testid="pd-set-strategies-drawn" style={{ ...hint, color: colors.warnBannerText }}>
            ⚠ Students have already started, and each has been assigned an opponent.
            Unchecking a strategy here will <strong>not</strong> change theirs — a
            student already playing keeps the opponent they were given. A new selection
            applies to students who have not launched yet.
          </p>
        )}
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
        disabled={saving || rangeInvalid || noStrategies}
        style={{
          padding: '0.6rem 1.5rem', fontSize: '1rem', fontWeight: 600,
          cursor: (saving || rangeInvalid || noStrategies) ? 'not-allowed' : 'pointer',
          backgroundColor: (saving || rangeInvalid || noStrategies) ? colors.disabledBtnBg : colors.text,
          color: colors.white, border: 'none', borderRadius: 6,
        }}
      >
        {saving ? 'Saving…' : 'Save'}
      </button>
    </div>,
  )
}
