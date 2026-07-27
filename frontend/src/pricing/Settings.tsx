import { useEffect, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { colors } from '@mygames/game-ui'
import { InstructorChrome } from '../shared/InstructorChrome'
import { useInstructorSession } from '../shared/useInstructorSession'
import {
  pricingGetConfig, pricingUpdateConfig, pricingInstructorSession, CLASSROOM_URL,
  type PricingConfigResult, type PricingAddedKcQuestion, type PricingLabels,
} from './api'
import { MarketFacts, Formulas } from './MarketPanel'
import { formatPrice } from './format'

// ═══════════════════════════════════════════════════════════════════════════════
// Pricing settings (spec §3) — the instructor's real work, in PD's Settings shape:
// load the whole config, edit locally, Save writes it back and re-reads.
//
// WHAT IS EDITABLE, AND WHAT DELIBERATELY IS NOT:
//
//   • THE PMG TOGGLE — the switch that makes this ONE game serve TWO course
//     instances. Flipping it changes the market computation, the competitor rule, the
//     knowledge check, the rules screen, the debrief prompt and the Tier-3 reference,
//     all at once, because every one of those already reads the flag. There is
//     nothing else to configure for PMG; that is the design.
//
//   • THE MARKET — size, both base shares, both unit costs, the slope, the price
//     bounds. The live preview below is the same MarketFacts/Formulas the students
//     see, fed from the form, so the instructor reads their edit exactly as the class
//     will.
//
//   • The firm labels, the round RANGE, the KC (on/off + their own extra questions),
//     and the debrief (on/off + prompt).
//
//   ⚠ THE MODE'S OWN KC QUESTIONS ARE NOT EDITABLE, ON PURPOSE. They are derived from
//     the market every time they are served AND every time they are graded, so they
//     cannot drift from the market on the student's screen. Editing the market
//     rewrites them; that is the feature, not a missing one. They are shown read-only
//     so the instructor can see what their market produced. Added questions are a
//     SEPARATE list with their own answer keys and never merge with the derived ones.
//
//   • The COMPETITOR RULE is display-only, as PD's bot strategies are: the library
//     has one rule per mode and the mode already selects it, so a picker would offer
//     a choice of one.
// ═══════════════════════════════════════════════════════════════════════════════

const shortId = () =>
  (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID().slice(0, 8) : Math.random().toString(36).slice(2, 10))

const field: CSSProperties = {
  width: '100%', fontSize: '0.95rem', padding: '0.45rem 0.55rem',
  borderRadius: 4, border: `1px solid ${colors.inputBorder}`, boxSizing: 'border-box',
}
const numField: CSSProperties = { ...field, width: '7rem' }
const smallBtn: CSSProperties = {
  padding: '0.25rem 0.55rem', fontSize: '0.85rem', cursor: 'pointer',
  borderRadius: 4, border: `1px solid ${colors.inputBorder}`, background: '#fff',
}
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

const TITLE = 'Cheyenne Shipping — Settings'

export default function Settings() {
  const session = useInstructorSession(pricingInstructorSession)
  const navigate = useNavigate()

  const [cfg, setCfg] = useState<PricingConfigResult | null>(null)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  // Add-question form.
  const [newType, setNewType] = useState<'mc' | 'text'>('mc')
  const [newPrompt, setNewPrompt] = useState('')
  const [newOptions, setNewOptions] = useState<string[]>(['', ''])
  const [newCorrect, setNewCorrect] = useState(0)

  useEffect(() => {
    if (session.kind !== 'ready') return
    pricingGetConfig()
      .then(setCfg)
      .catch(e => setErr(e instanceof Error ? e.message : 'Failed to load settings.'))
  }, [session.kind])

  const patch = (p: Partial<PricingConfigResult>) => setCfg(c => (c ? { ...c, ...p } : c))
  const setMarket = (k: keyof PricingConfigResult['market'], v: number) =>
    setCfg(c => (c ? { ...c, market: { ...c.market, [k]: v } } : c))
  const setLabel = (k: keyof PricingLabels, v: string) =>
    setCfg(c => (c ? { ...c, labels: { ...c.labels, [k]: v } } : c))

  const addQuestion = () => {
    if (!cfg) return
    if (!newPrompt.trim()) { setErr('Enter a prompt for the new question.'); return }
    let options: { value: string; label: string }[] | undefined
    let correct_value: string | undefined
    if (newType === 'mc') {
      const labels = newOptions.map(o => o.trim()).filter(Boolean)
      if (labels.length < 2) { setErr('A multiple-choice question needs at least two options.'); return }
      options = labels.map(label => ({ value: `o_${shortId()}`, label }))
      correct_value = options[Math.min(newCorrect, options.length - 1)].value
    }
    const q: PricingAddedKcQuestion = {
      // `akc_` — never `kc_`, which the derived questions own. The server refuses that
      // prefix outright, because the grader looks up derived questions FIRST and an
      // added one taking a derived id would be silently shadowed.
      id: `akc_${shortId()}`,
      type: newType,
      prompt: newPrompt.trim(),
      ...(options ? { options } : {}),
      ...(correct_value ? { correct_value } : {}),
    }
    patch({ addedKcQuestions: [...cfg.addedKcQuestions, q] })
    setNewPrompt(''); setNewOptions(['', '']); setNewCorrect(0); setErr(null)
  }

  const save = async () => {
    if (!cfg) return
    setSaving(true); setErr(null); setMsg(null)
    try {
      const res = await pricingUpdateConfig({
        pmg: cfg.pmg,
        labels: cfg.labels,
        market: cfg.market,
        minRounds: cfg.minRounds,
        maxRounds: cfg.maxRounds,
        kcEnabled: cfg.kcEnabled,
        addedKcQuestions: cfg.addedKcQuestions,
        debriefEnabled: cfg.debriefEnabled,
        debriefPrompt: cfg.debriefPrompt,
      })
      // Show what was STORED (server-normalized), not what we hoped we sent — and the
      // re-derived KC preview and equilibrium the new market produces.
      setCfg(res)
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
      <div style={{ maxWidth: 820 }}>{body}</div>
    </InstructorChrome>
  )

  if (session.kind === 'loading') return chrome(<p>Loading…</p>)
  if (session.kind === 'no-token') return chrome(<p>Open settings from the classroom.</p>)
  if (session.kind === 'error') {
    return chrome(<><p style={{ color: '#c00' }}>{session.message}</p><p><a href={CLASSROOM_URL}>← Return to classroom</a></p></>)
  }
  if (err && !cfg) return chrome(<p style={{ color: '#c00' }}>{err}</p>)
  if (!cfg) return chrome(<p>Loading settings…</p>)

  const m = cfg.market
  const shareSum = m.studentBaseShare + m.competitorBaseShare
  const sharesInvalid = Math.abs(shareSum - 1) > 1e-9
    || m.studentBaseShare <= 0 || m.studentBaseShare >= 1
    || m.competitorBaseShare <= 0 || m.competitorBaseShare >= 1
  const boundsInvalid = m.minPrice >= m.maxPrice
    || !Number.isInteger(m.minPrice) || !Number.isInteger(m.maxPrice)
  const costsInvalid = m.studentUnitCost >= m.maxPrice || m.competitorUnitCost >= m.maxPrice
  const rangeInvalid = cfg.minRounds > cfg.maxRounds || cfg.minRounds < 1
  const anyInvalid = sharesInvalid || boundsInvalid || costsInvalid || rangeInvalid

  return chrome(
    <div data-testid="pricing-settings">
      {/* ── The mode ────────────────────────────────────────────────────────── */}
      <Section title="Rules">
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: '0.45rem', cursor: 'pointer', fontSize: '0.95rem' }}>
          <input
            data-testid="pricing-set-pmg" type="checkbox"
            checked={cfg.pmg} onChange={e => patch({ pmg: e.target.checked })}
          />
          Price Matching Guarantee (PMG) in force
        </label>
        <p style={hint}>
          One toggle, and everything follows it: how profit is computed, what the
          knowledge check asks, whether the rules screen appears before it, which
          debrief question is asked, and which reference line the class chart draws.
          Run <strong>two instances of this game</strong> in the same course — one with
          this off, one with it on.
        </p>
        <p data-testid="pricing-set-rule" style={{ ...hint, marginTop: '0.6rem' }}>
          Competitor rule in this mode: <strong>{cfg.competitorRule.description}</strong>.
          {' '}Not configurable — the library has one rule per mode, and the toggle above
          picks it.
        </p>
      </Section>

      {/* ── The market ──────────────────────────────────────────────────────── */}
      <Section title="The market">
        <div style={row}>
          <Labelled label="Market size (containers)">
            <input
              data-testid="pricing-set-market-size" type="number" style={numField}
              value={m.marketSize} onChange={e => setMarket('marketSize', Number(e.target.value))}
            />
          </Labelled>
          <Labelled label="Share slope k ($ per share point)">
            <input
              data-testid="pricing-set-slope" type="number" style={numField}
              value={m.slope} onChange={e => setMarket('slope', Number(e.target.value))}
            />
          </Labelled>
          <Labelled label="Minimum price ($)">
            <input
              data-testid="pricing-set-min-price" type="number" style={numField}
              value={m.minPrice} onChange={e => setMarket('minPrice', Number(e.target.value))}
            />
          </Labelled>
          <Labelled label="Maximum price ($)">
            <input
              data-testid="pricing-set-max-price" type="number" style={numField}
              value={m.maxPrice} onChange={e => setMarket('maxPrice', Number(e.target.value))}
            />
          </Labelled>
        </div>

        <div style={{ ...row, marginTop: '1rem' }}>
          <Labelled label="Your firm's name">
            <input
              data-testid="pricing-set-label-student" style={{ ...field, width: '10rem' }}
              value={cfg.labels.student} onChange={e => setLabel('student', e.target.value)}
            />
          </Labelled>
          <Labelled label="Your base share (0–1)">
            <input
              data-testid="pricing-set-student-share" type="number" step="0.01" style={numField}
              value={m.studentBaseShare} onChange={e => setMarket('studentBaseShare', Number(e.target.value))}
            />
          </Labelled>
          <Labelled label="Your unit cost ($)">
            <input
              data-testid="pricing-set-student-cost" type="number" style={numField}
              value={m.studentUnitCost} onChange={e => setMarket('studentUnitCost', Number(e.target.value))}
            />
          </Labelled>
        </div>

        <div style={{ ...row, marginTop: '0.75rem' }}>
          <Labelled label="Competitor firm's name">
            <input
              data-testid="pricing-set-label-competitor" style={{ ...field, width: '10rem' }}
              value={cfg.labels.competitor} onChange={e => setLabel('competitor', e.target.value)}
            />
          </Labelled>
          <Labelled label="Competitor base share (0–1)">
            <input
              data-testid="pricing-set-competitor-share" type="number" step="0.01" style={numField}
              value={m.competitorBaseShare} onChange={e => setMarket('competitorBaseShare', Number(e.target.value))}
            />
          </Labelled>
          <Labelled label="Competitor unit cost ($)">
            <input
              data-testid="pricing-set-competitor-cost" type="number" style={numField}
              value={m.competitorUnitCost} onChange={e => setMarket('competitorUnitCost', Number(e.target.value))}
            />
          </Labelled>
        </div>

        {sharesInvalid && (
          <p data-testid="pricing-set-shares-error" style={{ ...hint, color: colors.errorAction }}>
            The two base shares must each be between 0 and 1 and add up to exactly 1 —
            they currently add up to {shareSum.toFixed(4)}. They are two firms splitting
            one market.
          </p>
        )}
        {boundsInvalid && (
          <p data-testid="pricing-set-bounds-error" style={{ ...hint, color: colors.errorAction }}>
            The minimum price must be a whole dollar below the maximum.
          </p>
        )}
        {costsInvalid && (
          <p data-testid="pricing-set-costs-error" style={{ ...hint, color: colors.errorAction }}>
            Both unit costs must be below the maximum price, or no price could ever be
            profitable.
          </p>
        )}

        {/* ⚠ The market-edit warning. PD warns only about the round range; a market
            edit is worse, so it gets its own. It never BLOCKS — see instructorConfig.ts. */}
        {cfg.anyRoundsPlayed && (
          <p data-testid="pricing-set-played-warning" style={{ ...hint, color: colors.warnBannerText }}>
            ⚠ Students have already played rounds in this instance. Editing the market
            does <strong>not</strong> recompute what they have already done — their
            recorded prices and profits were produced by the OLD market, and the class
            reports will pool the two. Prefer a fresh instance unless you are fixing a
            typo before anyone has really started.
          </p>
        )}

        <div style={{ marginTop: '1rem' }}>
          <p style={{ ...hint, marginBottom: '0.5rem' }}>Preview — exactly what students see:</p>
          <MarketFacts market={m} labels={cfg.labels} />
          <Formulas market={m} labels={cfg.labels} pmg={cfg.pmg} />
          <p data-testid="pricing-set-equilibrium" style={hint}>
            This market&rsquo;s equilibrium reference (the dashed line on the class chart):{' '}
            <strong>{formatPrice(cfg.equilibrium.student)}</strong> for {cfg.labels.student},{' '}
            <strong>{formatPrice(cfg.equilibrium.competitor)}</strong> for {cfg.labels.competitor}.
            Derived from the numbers above — it moves when they do.
          </p>
        </div>
      </Section>

      {/* ── Round range ─────────────────────────────────────────────────────── */}
      <Section title="Number of rounds">
        <div style={row}>
          <Labelled label="Minimum">
            <input
              data-testid="pricing-set-min-rounds" type="number" style={numField}
              value={cfg.minRounds} onChange={e => patch({ minRounds: Number(e.target.value) })}
            />
          </Labelled>
          <Labelled label="Maximum">
            <input
              data-testid="pricing-set-max-rounds" type="number" style={numField}
              value={cfg.maxRounds} onChange={e => patch({ maxRounds: Number(e.target.value) })}
            />
          </Labelled>
        </div>
        {rangeInvalid && (
          <p data-testid="pricing-set-range-error" style={{ ...hint, color: colors.errorAction }}>
            The minimum must be at least 1 and cannot exceed the maximum.
          </p>
        )}
        <p style={hint}>
          The actual number of rounds is drawn at random inside this range, once per
          <strong> student</strong>, and is <strong>never shown to students</strong> —
          they are told the range and nothing more. Because each student draws their own,
          one who finishes early cannot tell the class how long the game is. Set both to
          the same number for a fixed-length game.
        </p>
        {cfg.anyRoundsDrawn && (
          <p data-testid="pricing-set-rounds-drawn" style={{ ...hint, color: colors.warnBannerText }}>
            ⚠ Students have already started, and each has drawn their number of rounds.
            Changing the range here will <strong>not</strong> change theirs — students
            already playing keep the game they started. A new range applies to students
            who have not launched yet.
          </p>
        )}
      </Section>

      {/* ── Knowledge check ─────────────────────────────────────────────────── */}
      <Section title="Knowledge check">
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: '0.45rem', cursor: 'pointer', fontSize: '0.9rem' }}>
          <input
            data-testid="pricing-set-kc-enabled" type="checkbox"
            checked={cfg.kcEnabled} onChange={e => patch({ kcEnabled: e.target.checked })}
          />
          Include the knowledge check
        </label>

        {cfg.kcEnabled && (
          <>
            <div style={{ marginTop: '1rem' }}>
              <p style={{ ...hint, marginTop: 0 }}>
                These {cfg.derivedKcPreview.length} question(s) are <strong>derived from the
                market above</strong> every time they are served and every time they are
                graded, so they can never disagree with the screen a student is looking at.
                They are not editable — change the market and they follow.
              </p>
              <ol data-testid="pricing-set-derived-kc" style={{ margin: '0.5rem 0 0', paddingLeft: '1.2rem', fontSize: '0.85rem', color: colors.text }}>
                {cfg.derivedKcPreview.map(q => (
                  <li key={q.field} style={{ marginBottom: '0.35rem', lineHeight: 1.5 }}>
                    {q.prompt}{' '}
                    <span style={{ color: colors.textSecondary }}>
                      (answer: {q.options.find(o => o.value === q.correct_value)?.label ?? q.correct_value})
                    </span>
                  </li>
                ))}
              </ol>
            </div>

            {/* Instructor's own questions — a SEPARATE list, own keys, own grading. */}
            <div style={{ marginTop: '1.25rem' }}>
              <p style={{ ...hint, marginTop: 0, fontWeight: 600 }}>Your own extra questions</p>
              {cfg.addedKcQuestions.length === 0 && <p style={hint}>None yet.</p>}
              {cfg.addedKcQuestions.map(q => (
                <div key={q.id} data-testid={`pricing-set-added-${q.id}`} style={{ border: `1px solid ${colors.borderMid}`, borderRadius: 6, padding: '0.5rem 0.7rem', marginTop: '0.4rem' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.75rem' }}>
                    <span style={{ fontSize: '0.88rem' }}>{q.prompt}</span>
                    <button
                      style={smallBtn}
                      onClick={() => patch({ addedKcQuestions: cfg.addedKcQuestions.filter(x => x.id !== q.id) })}
                    >
                      Remove
                    </button>
                  </div>
                  <div style={{ fontSize: '0.78rem', color: colors.textSecondary, marginTop: '0.2rem' }}>
                    {q.type === 'text'
                      ? 'Free text — recorded, never graded'
                      : `${(q.options ?? []).length} options · answer: ${(q.options ?? []).find(o => o.value === q.correct_value)?.label ?? '—'}`}
                  </div>
                </div>
              ))}

              <div style={{ marginTop: '0.8rem', border: `1px dashed ${colors.borderMid}`, borderRadius: 6, padding: '0.7rem 0.8rem' }}>
                <div style={row}>
                  <Labelled label="Type">
                    <select
                      data-testid="pricing-set-new-type" style={{ ...field, width: '10rem' }}
                      value={newType} onChange={e => setNewType(e.target.value as 'mc' | 'text')}
                    >
                      <option value="mc">Multiple choice</option>
                      <option value="text">Free text (ungraded)</option>
                    </select>
                  </Labelled>
                </div>
                <div style={{ marginTop: '0.5rem' }}>
                  <Labelled label="Prompt">
                    <input
                      data-testid="pricing-set-new-prompt" style={field}
                      value={newPrompt} onChange={e => setNewPrompt(e.target.value)}
                    />
                  </Labelled>
                </div>
                {newType === 'mc' && (
                  <div style={{ marginTop: '0.5rem' }}>
                    {newOptions.map((o, i) => (
                      <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '0.3rem' }}>
                        <input
                          type="radio" name="pricing-new-correct" checked={newCorrect === i}
                          onChange={() => setNewCorrect(i)} title="Correct answer"
                        />
                        <input
                          data-testid={`pricing-set-new-option-${i}`} style={field}
                          value={o}
                          onChange={e => setNewOptions(opts => opts.map((x, j) => (j === i ? e.target.value : x)))}
                        />
                      </div>
                    ))}
                    <button style={{ ...smallBtn, marginTop: '0.4rem' }} onClick={() => setNewOptions(o => [...o, ''])}>
                      Add option
                    </button>
                  </div>
                )}
                <button data-testid="pricing-set-add-question" style={{ ...smallBtn, marginTop: '0.6rem' }} onClick={addQuestion}>
                  Add question
                </button>
              </div>
            </div>
          </>
        )}
      </Section>

      {/* ── Debrief ─────────────────────────────────────────────────────────── */}
      <Section title="Debrief">
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: '0.45rem', cursor: 'pointer', fontSize: '0.9rem' }}>
          <input
            data-testid="pricing-set-debrief-enabled" type="checkbox"
            checked={cfg.debriefEnabled} onChange={e => patch({ debriefEnabled: e.target.checked })}
          />
          Ask for a debrief paragraph
        </label>
        {cfg.debriefEnabled && (
          <div style={{ marginTop: '0.7rem' }}>
            <Labelled label="Prompt">
              <textarea
                data-testid="pricing-set-debrief-prompt" style={{ ...field, minHeight: '5rem', resize: 'vertical' }}
                value={cfg.debriefPrompt} onChange={e => patch({ debriefPrompt: e.target.value })}
              />
            </Labelled>
            <p style={hint}>
              Ungraded. The default differs by mode — switch the PMG toggle on a fresh
              instance and this reverts to the price-matching version of the question.
            </p>
          </div>
        )}
      </Section>

      {/* ── Save ────────────────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '2rem' }}>
        <button
          data-testid="pricing-set-save"
          onClick={() => void save()}
          disabled={saving || anyInvalid}
          style={{
            padding: '0.6rem 1.5rem', fontSize: '1rem', fontWeight: 600,
            cursor: (saving || anyInvalid) ? 'not-allowed' : 'pointer',
            backgroundColor: (saving || anyInvalid) ? colors.disabledBtnBg : colors.text,
            color: colors.white, border: 'none', borderRadius: 6,
          }}
        >
          {saving ? 'Saving…' : 'Save settings'}
        </button>
        {msg && <span data-testid="pricing-set-msg" style={{ color: colors.successText }}>{msg}</span>}
        {err && <span data-testid="pricing-set-err" style={{ color: colors.errorAction }}>{err}</span>}
      </div>
    </div>,
  )
}
