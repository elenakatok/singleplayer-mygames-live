import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { colors, typography } from '@mygames/game-ui'
import { InstructorChrome } from '../shared/InstructorChrome'
import { StartedBanner } from '../shared/StartedBanner'
import { useInstructorSession } from '../shared/useInstructorSession'
import {
  KnowledgeCheckSettings,
  type KcSettingsDraft, type KcSettingsQuestion, type KcSettingsStage,
} from '../shared/KnowledgeCheckSettings'
import {
  procurementGetConfig, procurementUpdateConfig, procurementInstructorSession,
  instructorErrorMessage, FORMAT_LABEL,
  type ProcurementConfigResult, type ProcurementFormat,
} from './api'

// ═══════════════════════════════════════════════════════════════════════════════
// Procurement Auction — instructor settings.
//
// ⚠⚠ TWO BEHAVIOURS THIS PAGE HAS FROM THE FIRST COMMIT, because retrofitting either
// would be expensive:
//
//  1. `format` LOCKS ONCE THE INSTANCE HAS ITS FIRST SUBMISSION (Part 1 §3, §14.1). The
//     control disables itself and says why. The lock is ALSO enforced server-side
//     (procurement/instructorConfig.ts) — this is the courtesy, not the guarantee, and a
//     stale tab that posts anyway is refused.
//
//  2. THE KC IS ONE MERGED POOL WITH PER-QUESTION VISIBILITY, and the live count is
//     rendered from the SAME derivation the grader uses. THE DENOMINATOR IS NEVER STORED,
//     so the number an instructor reads here is by construction the number a student's
//     score is out of.
//     ⚠ The count line and the question list now come from the SHARED block, which counts
//     `kc.poolTotal` / `kc.visibleCount` / `kc.gradedCount` — computed server-side by
//     `procurementScoringSet()`, the function `procurementSubmitKcAnswer` calls to build
//     its denominator. This page's own hand-rolled list and count line are gone; the count
//     LINE ITSELF came from here originally and returns unchanged.
//     ⚠⚠ `kcVisible` IS GONE (D18). Visibility is `kc_hidden` now, with the polarity the
//     other five games use — true means HIDDEN. The server converts a legacy instance on
//     read and deletes the old field on the first save; this page never sees it.
//
// ⚠ THE SEED IS WRITE-ONLY. `seedSet` says whether one is in force; the value never
// comes back. A Settings page is a normal web page, and a value on screen is a value in
// a screenshot — and this seed derives every rival cost draw.
//
// ⚠ TODO(build): the KC pool is EMPTY at spawn, so this page honestly reads "0 of 0".
// Content is Checkpoint 2 (procurement/questions.ts). The machinery around it is
// complete: populate the pool and this screen starts working with no change here.
// ═══════════════════════════════════════════════════════════════════════════════

const label = { display: 'block', fontSize: '0.8rem', fontWeight: 600, marginBottom: '0.25rem' }
const field = { marginBottom: '1rem', maxWidth: '22rem' }
const input = { width: '100%', padding: '0.35rem 0.5rem', fontSize: '0.9rem' }

/** `[{above:80,step:10},…]` ⇄ `"80:10, 50:5"`. One line is faster to retune between
 *  rounds than four pairs of number boxes, and — unlike fixed boxes — it lets the BAND
 *  BOUNDARIES move, which is the "coarser top band" lever open §10 asks for by name. */
const bandsToText = (bands: Record<string, number>[], valueKey: string) =>
  bands.map(b => `${b.above}:${b[valueKey]}`).join(', ')

function parseBandText(text: string, valueKey: string): Record<string, number>[] | null {
  const parts = text.split(',').map(p => p.trim()).filter(p => p !== '')
  if (parts.length === 0) return null
  const out: Record<string, number>[] = []
  for (const p of parts) {
    const m = /^(\d+)\s*:\s*(\d+)$/.exec(p)
    if (!m) return null
    out.push({ above: Number(m[1]), [valueKey]: Number(m[2]) })
  }
  return out
}

/**
 * One band schedule, edited as text.
 *
 * ⚠ IT REFUSES LOCALLY RATHER THAN POSTING SOMETHING THE SERVER WILL SILENTLY REPAIR.
 * `parseDecrementSchedule` on the server is a DEFENSIVE READER for half-written docs — it
 * substitutes the shipped default when it dislikes the input — so a mistyped band posted
 * blind would come back as "saved" with the shipped schedule in place of the instructor's.
 * The server's update path rejects by name for the same reason; this is the courtesy layer.
 */
function BandField({
  id, testId, label: labelText, help, valueKey, bands, busy, onSave,
}: {
  id: string
  testId: string
  label: string
  help: string
  valueKey: string
  bands: Record<string, number>[]
  busy: boolean
  onSave: (bands: Record<string, number>[]) => void
}) {
  const stored = bandsToText(bands, valueKey)
  const [text, setText] = useState(stored)
  const [bad, setBad] = useState(false)
  // Re-sync when a save lands (or another field's save reloads the config).
  const [lastStored, setLastStored] = useState(stored)
  if (lastStored !== stored) { setLastStored(stored); setText(stored); setBad(false) }

  return (
    <div style={{ ...field, maxWidth: '30rem' }}>
      <label style={label} htmlFor={id}>{labelText}</label>
      <input id={id} data-testid={testId} style={input} value={text} disabled={busy}
        onChange={e => { setText(e.target.value); setBad(false) }}
        onBlur={() => {
          if (text.trim() === stored.trim()) return
          const parsed = parseBandText(text, valueKey)
          if (parsed === null) { setBad(true); return }
          onSave(parsed)
        }} />
      {bad && (
        <p data-testid={`${testId}-bad`} style={{ fontSize: '0.75rem', color: colors.warnBannerText }}>
          ⚠ Not saved. Write whole-number <code>above:value</code> pairs separated by
          commas, for example <code>{stored}</code>.
        </p>
      )}
      <p style={{ fontSize: '0.75rem', color: colors.textSecondary }}>{help}</p>
    </div>
  )
}

/**
 * ⚠ THE STAGE LABELS ARE THIS GAME'S, passed as props — the shared block knows nothing about
 * auctions. Procurement has a RESULTS screen, so the second stage is "after the results"
 * rather than forecast's "before the reveal": nothing is withheld here.
 *
 * ⚠⚠ TWO STAGES, THREE POOL TAGS. The pool tags questions `kc`, `prep` and `debrief`; `kc`
 * and `prep` are both asked before the first round — the graded questions, then the written
 * plan — so they are ONE stage to configure. The server groups `prep` under `kc` for display
 * and never rewrites a built-in's own tag.
 */
const KC_STAGES: KcSettingsStage[] = [
  {
    id: 'kc',
    label: 'Before play',
    note: 'Asked before the first round — the graded questions and the written plan.',
  },
  {
    id: 'debrief',
    label: 'After the results',
    note: 'Asked once the auction is over. ⚠ Students have already seen their own results — '
      + 'their profit, how often they won, and how their bids compared with the benchmark.',
  },
]

export default function Settings() {
  const session = useInstructorSession(procurementInstructorSession)
  const navigate = useNavigate()
  const [data, setData] = useState<ProcurementConfigResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [seedInput, setSeedInput] = useState('')
  // ═══════════════════════════════════════════════════════════════════════════
  // THE KNOWLEDGE CHECK — the SHARED block (convergence spec §2, §8.4).
  //
  // ⚠ Procurement's hand-rolled list and its own count line are GONE, replaced by the
  // block. It is the block's ORIGIN: this page's count line was copied OUT five passes ago
  // and shipped verbatim in the other five games, and it comes back here unchanged —
  // "<n> of <m> questions visible, <g> graded", then "A student's score is out of the
  // graded questions that are visible — the denominator follows this list and is never
  // stored." Checked against the original; the shared copy had not drifted.
  //
  // ⚠⚠ NO BOUNDARY TRANSLATION IN THIS GAME, unlike the other five. Their paragraph prompts
  // live in config keys (`prepPrompt` / `debriefPrompt`) and have to be translated to and
  // from `kc_overrides` here. Procurement's free-text questions are POOL ENTRIES — there is
  // no such key, deliberately (functions config.ts) — so they are edited through
  // `kc_overrides` like any other built-in and `kcPatch` has nothing to split out.
  // ═══════════════════════════════════════════════════════════════════════════
  const [kcDraft, setKcDraft] = useState<KcSettingsDraft | null>(null)

  /** The server's inventory in the shared block's shape. */
  function kcQuestions(r: ProcurementConfigResult): KcSettingsQuestion[] {
    return [...r.kc.builtIn, ...r.kc.added]
  }

  /**
   * ⚠⚠ D18 — THE DRAFT IS SEEDED FROM `kcHidden`, THE MIGRATED FIELD, AND `kcVisible` IS
   * NEVER READ HERE. The server converts a legacy instance on read, so by the time this page
   * sees it the polarity is already the family's: true means HIDDEN.
   */
  function seedKc(r: ProcurementConfigResult): KcSettingsDraft {
    return {
      enabled: r.config.kcEnabled,
      hidden: { ...r.kcHidden },
      order: { ...r.kcOrder },
      overrides: { ...r.kcOverrides },
      added: (r.addedKcQuestions as KcSettingsDraft['added']).map(q => ({ ...q })),
    }
  }

  /** The draft, in the callable's field names. ⚠ `kcVisible` is NOT sent — the callable
   *  deletes it from the document when `kcHidden` arrives. */
  function kcPatch(d: KcSettingsDraft) {
    return {
      kcEnabled: d.enabled,
      kcHidden: d.hidden,
      kcOrder: d.order,
      kcOverrides: d.overrides,
      addedKcQuestions: d.added.map(q => ({
        ...q,
        // The shared draft types `stage` as a plain string (generic across six games);
        // procurement's callable takes its own two-value union.
        stage: q.stage === 'debrief' ? ('debrief' as const) : ('kc' as const),
      })),
    }
  }

  const load = useCallback(async () => {
    try {
      const r = await procurementGetConfig()
      setData(r)
      setKcDraft(seedKc(r))
      setError(null)
    } catch (err) {
      setError(instructorErrorMessage(err))
    }
  }, [])

  useEffect(() => { if (session.kind === 'ready') void load() }, [session.kind, load])

  const save = async (patch: Parameters<typeof procurementUpdateConfig>[0]) => {
    setBusy(true); setNote(null)
    try {
      const r = await procurementUpdateConfig(patch)
      setNote(r.rejected.length > 0
        ? `Saved. Ignored: ${r.rejected.join(', ')}.`
        : 'Saved.')
      await load()
    } catch (err) {
      setNote(instructorErrorMessage(err))
    } finally { setBusy(false) }
  }

  const navLinks = [
    { label: '← Dashboard', href: `/dashboard${window.location.search}` },
    { label: 'Reports →', href: `/reports${window.location.search}` },
  ]

  if (session.kind !== 'ready') {
    return (
      <InstructorChrome title="Procurement Auction — settings">
        <p>{session.kind === 'loading' ? 'Loading…'
          : session.kind === 'no-token' ? 'Open this page from the classroom so the link carries your instructor session.'
            : session.message}</p>
      </InstructorChrome>
    )
  }

  const c = data?.config

  return (
    <InstructorChrome
      title="Procurement Auction — settings"
      actions={<span style={{ fontSize: '0.8rem', color: colors.textSecondary }}>
        {busy ? 'Saving…' : note ?? ''}
      </span>}
      navLinks={navLinks}
      onNavigate={navigate}
    >
      {error && <p style={{ color: '#b00' }}>{error}</p>}
      {!c && !error && <p>Loading…</p>}

      {c && data && (
        <div style={{ fontFamily: typography.fontFamily }}>

          {/* ⚠ THE PAGE-LEVEL BANNER (KC convergence §10, Elena 08-10). Predicate:
              data.formatLocked — ⚠ THE NAME IS ABOUT THE FORMAT CONTROL, THE SIGNAL IS NOT.
              It is `hasAnySubmission`, which queries participants for `rounds_played > 0`
              (instance.ts) — the same predicate newsvendor and forecast use, and a genuine
              "someone has bid", not "someone has been issued a format". A student who opened
              the game and left has no round and does not raise it.
              ⚠ The format-lock notice further down is NOT folded into this: it says what
              THAT control does, which this cannot. */}
          <StartedBanner started={data.formatLocked} testIdPrefix="proc" />

          {/* ── format ─────────────────────────────────────────────────────── */}
          <section style={{ marginBottom: '2rem' }}>
            <h2 style={{ fontSize: '0.95rem' }}>Bidding format</h2>
            <div style={field}>
              <select
                data-testid="proc-set-format"
                value={c.format}
                disabled={data.formatLocked || busy}
                style={input}
                onChange={e => void save({ format: e.target.value as ProcurementFormat })}
              >
                {(Object.keys(FORMAT_LABEL) as ProcurementFormat[]).map(f => (
                  <option key={f} value={f}>{FORMAT_LABEL[f]}</option>
                ))}
              </select>
            </div>
            {data.formatLocked && (
              <p data-testid="proc-set-format-locked" style={{ fontSize: '0.8rem', color: colors.textSecondary }}>
                Locked — a student has already played a round in this instance. Results
                from two different mechanisms cannot be read as one set. Create a second
                instance for the other format.
              </p>
            )}
          </section>

          {/* ── auction parameters ─────────────────────────────────────────── */}
          <section style={{ marginBottom: '2rem' }}>
            <h2 style={{ fontSize: '0.95rem' }}>Auction</h2>

            <div style={field}>
              <label style={label} htmlFor="proc-rounds">Rounds</label>
              <input id="proc-rounds" data-testid="proc-set-rounds" type="number" style={input}
                defaultValue={c.rounds} disabled={busy}
                onBlur={e => { const v = Number(e.target.value); if (v !== c.rounds) void save({ rounds: v }) }} />
            </div>

            <div style={field}>
              <label style={label} htmlFor="proc-rivals">Simulated rivals</label>
              <input id="proc-rivals" data-testid="proc-set-rivals" type="number" style={input}
                defaultValue={c.rivalCount} disabled={busy}
                onBlur={e => { const v = Number(e.target.value); if (v !== c.rivalCount) void save({ rivalCount: v }) }} />
              <p style={{ fontSize: '0.75rem', color: colors.textSecondary }}>
                Total bidders including the student: {c.rivalCount + 1}.
              </p>
            </div>

            {/* ── the two cost ranges (§3) ──────────────────────────────────
                ⚠ THE ASYMMETRY IS THE DESIGN, not an oversight: rivals draw U[10,110],
                the student U[10,60] (§5.2). It is what lifts the student's win rate to
                ~39%, and it is why the help text below calls the student range a
                DIFFICULTY DIAL rather than an economic parameter. */}
            <div style={field}>
              <label style={label}>Rival cost range ({c.currencyLabel})</label>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <input id="proc-rival-min" data-testid="proc-set-rival-cost-min" type="number" style={input}
                  defaultValue={c.rivalCostDist.min} disabled={busy}
                  onBlur={e => {
                    const min = Number(e.target.value)
                    if (min !== c.rivalCostDist.min) {
                      void save({ rivalCostDist: { ...c.rivalCostDist, min } })
                    }
                  }} />
                <span style={{ color: colors.textSecondary }}>to</span>
                <input id="proc-rival-max" data-testid="proc-set-rival-cost-max" type="number" style={input}
                  defaultValue={c.rivalCostDist.max} disabled={busy}
                  onBlur={e => {
                    const max = Number(e.target.value)
                    if (max !== c.rivalCostDist.max) {
                      void save({ rivalCostDist: { ...c.rivalCostDist, max } })
                    }
                  }} />
              </div>
              <p style={{ fontSize: '0.75rem', color: colors.textSecondary }}>
                What each simulated rival's cost is drawn from, independently, every round.
                ⚠ This is the ONE range students are told (§4), and it is the number the
                optimal bid is computed against — changing the top of it moves the
                benchmark line on every chart.
              </p>
              {c.reserveAuto ? (
                <p data-testid="proc-set-reserve-follows" style={{ fontSize: '0.75rem', color: colors.textSecondary }}>
                  The reserve is following this maximum ({c.rivalCostDist.max}). It stops
                  following as soon as you set a reserve yourself.
                </p>
              ) : (
                <p data-testid="proc-set-reserve-pinned" style={{ fontSize: '0.75rem', color: colors.warnBannerText }}>
                  ⚠ The reserve is pinned at {c.reserve} and will NOT follow this maximum.
                  {c.reserve < c.rivalCostDist.max && ' Rivals whose cost exceeds it make no bid at all.'}
                  {' '}Clear the reserve field and save to make it follow again.
                </p>
              )}
            </div>

            <div style={field}>
              <label style={label}>Student cost range ({c.currencyLabel})</label>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <input id="proc-player-min" data-testid="proc-set-player-cost-min" type="number" style={input}
                  defaultValue={c.playerCostDist.min} disabled={busy}
                  onBlur={e => {
                    const min = Number(e.target.value)
                    if (min !== c.playerCostDist.min) {
                      void save({ playerCostDist: { ...c.playerCostDist, min } })
                    }
                  }} />
                <span style={{ color: colors.textSecondary }}>to</span>
                <input id="proc-player-max" data-testid="proc-set-player-cost-max" type="number" style={input}
                  defaultValue={c.playerCostDist.max} disabled={busy}
                  onBlur={e => {
                    const max = Number(e.target.value)
                    if (max !== c.playerCostDist.max) {
                      void save({ playerCostDist: { ...c.playerCostDist, max } })
                    }
                  }} />
              </div>
              {/* ⚠ WHAT THIS ACTUALLY DOES, said plainly — it is easy to mistake for an
                  economic parameter and it is not one. */}
              <p style={{ fontSize: '0.75rem', color: colors.textSecondary }}>
                What each student's own cost is drawn from. <strong>This is a difficulty
                dial: it changes how often students win, not how they should bid.</strong>
                {' '}A narrower, lower range than the rivals' is what gives the student an
                edge — at the shipped 10–60 against rivals' 10–110 they win about 39% of
                rounds. It does <strong>not</strong> change the optimal bid, because that
                is computed against the RIVALS' range (§5.2): a bidder's own distribution
                does not enter their optimisation once their cost is drawn.
              </p>
              <p style={{ fontSize: '0.75rem', color: colors.textSecondary }}>
                ⚠ Students are never shown this range (§4) — only their own realized cost
                and the rivals' range.
              </p>
              {c.playerCostDist.max > c.rivalCostDist.max && (
                <p data-testid="proc-set-player-above-rival" style={{ fontSize: '0.75rem', color: colors.warnBannerText }}>
                  ⚠ The student range now reaches above the rivals'. That is legal, and it
                  makes the game HARDER than the rivals face — students will often draw
                  costs no rival can draw. Costs above the reserve leave no bid worth
                  making at all.
                </p>
              )}
            </div>

            <div style={field}>
              <label style={label} htmlFor="proc-reserve">Reserve ({c.currencyLabel})</label>
              <input id="proc-reserve" data-testid="proc-set-reserve" type="number" style={input}
                defaultValue={c.reserve} disabled={busy}
                onBlur={e => { const v = Number(e.target.value); if (v !== c.reserve) void save({ reserve: v }) }} />
              {/* ⚠ Part 1 §3.1 — lowering this below the rival cost max is a deliberate
                  teaching choice, not a misconfiguration. The server does not clamp it. */}
              <p style={{ fontSize: '0.75rem', color: colors.textSecondary }}>
                The incumbent's price: the bid ceiling in the sealed format, the opening
                price in the open one. Defaults to the top of the rival cost range
                ({c.rivalCostDist.max}). Lowering it prices some suppliers out — that is
                the entry decision from the lecture, and it is intentional.
              </p>
            </div>
          </section>

          {/* ── open-bid pacing (open §3) ──────────────────────────────────── */}
          <section style={{ marginBottom: '2rem' }}>
            <h2 style={{ fontSize: '0.95rem' }}>Open-bid pacing</h2>
            {/* ⚠⚠ THESE EXIST HERE BECAUSE TUNING THEM MUST NOT COST A DEPLOY. Open §2 and
                §10 name three levers for the first live run — shorter delays in the coarse
                bands, a COARSER TOP BAND (20 above 80, cutting the opening cascade from ten
                steps to seven), or a lower reserve — and require all three to be reachable
                between rounds while the feel is fresh. The reserve is above; these are the
                other two. */}
            <p style={{ fontSize: '0.8rem', color: colors.textSecondary, marginTop: 0 }}>
              Both are <strong>schedules read against the current price</strong>, written as
              {' '}<code>above:value</code> pairs. A band applies while the price is
              <em> strictly above</em> its threshold, so <code>80:10</code> means "a step of
              10 at any price over 80" — at exactly 80 the next band takes over.
              {c.format !== 'open_descending' && (
                <> <strong>This instance is sealed-bid, so these are inert.</strong></>
              )}
            </p>

            <BandField
              id="proc-decrement"
              testId="proc-set-decrement"
              label={`Decrement schedule — the minimum a bid must fall (${c.currencyLabel})`}
              valueKey="step"
              bands={c.decrementSchedule as unknown as Record<string, number>[]}
              busy={busy}
              help="How far each bid must undercut the standing price. Bots always move exactly this far; students may jump further. Coarser bands at the top make the opening cascade shorter."
              onSave={v => void save({ decrementSchedule: v as never })}
            />

            <BandField
              id="proc-delay"
              testId="proc-set-delay"
              label="Delay schedule — how long a bot waits before acting (ms)"
              valueKey="delayMs"
              bands={c.delaySchedule as unknown as Record<string, number>[]}
              busy={busy}
              help="Fast in the coarse bands, slow in the fine ones, so pacing follows tension automatically. It applies to a bot's answer to a student's bid as well — an instant reply reads as a machine."
              onSave={v => void save({ delaySchedule: v as never })}
            />

            <div style={field}>
              <label style={label} htmlFor="proc-jitter">Delay jitter (± ms)</label>
              <input id="proc-jitter" data-testid="proc-set-jitter" type="number" style={input}
                defaultValue={c.delayJitterMs} disabled={busy}
                onBlur={e => {
                  const v = Number(e.target.value)
                  if (v !== c.delayJitterMs) void save({ delayJitterMs: v })
                }} />
              <p style={{ fontSize: '0.75rem', color: colors.textSecondary }}>
                Randomised either way around each delay so the rhythm is not metronomic.
                Presentation only — it never reaches a bot's decision.
              </p>
            </div>
          </section>

          {/* ── the knowledge check — the SHARED block (convergence spec §2) ── */}
          {kcDraft && (
            <section style={{ marginBottom: '2rem' }}>
              <KnowledgeCheckSettings
                testIdPrefix="proc-kc"
                questions={kcQuestions(data)}
                stages={KC_STAGES}
                draft={kcDraft}
                onChange={setKcDraft}
                // ⚠⚠ D12 — THE TOGGLE GATES GRADED QUESTIONS ONLY, and in THIS game that was
                // already the shipped behaviour rather than a change: the `kc` stage was
                // wrapped in the ternary while `prep` and `debrief` resolved unconditionally.
                // Spec §9 recorded it as something the page must SAY; this is where it says it.
                enableNote={(
                  <>
                    Off removes the graded questions and any graded question you have added.
                    ⚠ It does <em>not</em> remove the two written answers — the plan before
                    play or the reflection after the results — or any free-text question you
                    have added. Those are ungraded, and each has its own visibility checkbox
                    below.
                  </>
                )}
                // ⚠ NO STARTED-BANNER IS PASSED, DELIBERATELY. Procurement has a signal
                // (`formatLocked`, from `hasAnySubmission`) and one section-scoped notice that
                // uses it — on the FORMAT control, saying results from two mechanisms cannot be
                // read as one set. That is not a page-level "students have already started"
                // banner like scorecard's. Spec §10 records this as a decision pending for
                // five games, to be swept once rather than invented separately in each.
              />
              <button
                data-testid="proc-save-kc"
                disabled={busy}
                onClick={() => void save(kcPatch(kcDraft))}
                style={{
                  marginTop: '0.75rem', padding: '0.5rem 1.1rem', fontSize: '0.85rem',
                  fontWeight: 600, cursor: 'pointer', background: colors.text,
                  color: colors.white, border: 'none', borderRadius: 6,
                }}
              >
                {busy ? 'Saving…' : 'Save the questions'}
              </button>
            </section>
          )}

          {/* ── determinism ───────────────────────────────────────────────── */}
          <section style={{ marginBottom: '2rem' }}>
            <h2 style={{ fontSize: '0.95rem' }}>Determinism seed</h2>
            <p style={{ fontSize: '0.8rem', color: colors.textSecondary }}>
              Blank means real randomness — the normal setting. A seed makes every cost
              draw reproducible, which is useful for a demo or for reproducing a report.
              {' '}<strong>{data.seedSet ? 'A seed is currently set.' : 'No seed is set.'}</strong>
              {' '}The value is never shown again once saved.
            </p>
            <div style={field}>
              <input data-testid="proc-set-seed" style={input} value={seedInput} disabled={busy}
                placeholder={data.seedSet ? '•••••• (set)' : 'blank = random'}
                onChange={e => setSeedInput(e.target.value)} />
            </div>
            <button data-testid="proc-set-seed-save" disabled={busy}
              onClick={() => { void save({ seed: seedInput.trim() === '' ? null : seedInput.trim() }); setSeedInput('') }}>
              {seedInput.trim() === '' ? 'Clear seed' : 'Set seed'}
            </button>
          </section>
        </div>
      )}
    </InstructorChrome>
  )
}
