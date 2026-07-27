import { useEffect, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { colors } from '@mygames/game-ui'
import { InstructorChrome } from '../shared/InstructorChrome'
import { useInstructorSession } from '../shared/useInstructorSession'
import {
  pdGetConfig, pdUpdateConfig, pdInstructorSession, CLASSROOM_URL,
  type PdConfigResult, type PdAddedKcQuestion, type PdPayoffs, type PdMoveLabels,
} from './api'
import { PayoffMatrix } from './PayoffMatrix'

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
//   • The knowledge check: on/off, plus the instructor's OWN extra questions.
//     ⚠ THE FOUR MATRIX QUESTIONS ARE NOT EDITABLE, ON PURPOSE. They are derived from
//     the payoff matrix every time they are served AND every time they are graded, so
//     they cannot drift from the matrix on the student's screen. Editing the matrix
//     rewrites them; that is the feature, not a missing one. They are shown read-only
//     so the instructor can see what their matrix produced. Added questions are a
//     SEPARATE list with their own answer keys and never merge with the derived four.
//
//   • The debrief: on/off and the prompt text.
//
//   • The bot strategies (tit-for-tat / GRIM) are NOT configurable — by decision.
// ═══════════════════════════════════════════════════════════════════════════════

const shortId = () =>
  (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID().slice(0, 8) : Math.random().toString(36).slice(2, 10))

const field: CSSProperties = {
  width: '100%', fontSize: '0.95rem', padding: '0.45rem 0.55rem',
  borderRadius: 4, border: `1px solid ${colors.inputBorder}`, boxSizing: 'border-box',
}
const numField: CSSProperties = { ...field, width: '6rem' }
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

const TITLE = 'Repeated Prisoner’s Dilemma — Settings'

export default function Settings() {
  const session = useInstructorSession(pdInstructorSession)
  const navigate = useNavigate()

  const [cfg, setCfg] = useState<PdConfigResult | null>(null)
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
    pdGetConfig()
      .then(setCfg)
      .catch(e => setErr(e instanceof Error ? e.message : 'Failed to load settings.'))
  }, [session.kind])

  const patch = (p: Partial<PdConfigResult>) => setCfg(c => (c ? { ...c, ...p } : c))
  const setPayoff = (k: keyof PdPayoffs, v: number) =>
    setCfg(c => (c ? { ...c, payoffs: { ...c.payoffs, [k]: v } } : c))
  const setLabel = (k: keyof PdMoveLabels, v: string) =>
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
    const q: PdAddedKcQuestion = {
      // `akc_` — never `kc_`, which the derived four own. The server refuses that
      // prefix outright, because the grader looks up derived questions FIRST and a
      // collision would grade the student against the matrix, not this key.
      id: `akc_${shortId()}`,
      type: newType,
      prompt: newPrompt.trim(),
      options,
      correct_value,
    }
    patch({ addedKcQuestions: [...cfg.addedKcQuestions, q] })
    setNewPrompt(''); setNewOptions(['', '']); setNewCorrect(0); setErr(null)
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
        kcEnabled: cfg.kcEnabled,
        addedKcQuestions: cfg.addedKcQuestions,
        debriefEnabled: cfg.debriefEnabled,
        debriefPrompt: cfg.debriefPrompt,
      })
      // Show what was STORED (server-normalized), not what we hoped we sent — and the
      // re-derived KC preview that the new matrix produces.
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

      {/* ── Knowledge check ─────────────────────────────────────────────────── */}
      <Section title="Knowledge check">
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: '0.45rem', cursor: 'pointer', fontSize: '0.9rem' }}>
          <input
            data-testid="pd-set-kc-enabled" type="checkbox"
            checked={cfg.kcEnabled} onChange={e => patch({ kcEnabled: e.target.checked })}
          />
          Include the knowledge check
        </label>

        {cfg.kcEnabled && (
          <>
            <div style={{ marginTop: '1rem' }}>
              <p style={{ ...hint, marginTop: 0 }}>
                <strong>These four are generated from your payoff matrix</strong> and update
                automatically when you change it, so they can never disagree with the matrix
                students are looking at. They are not editable — edit the matrix instead.
              </p>
              <ul data-testid="pd-set-derived-kc" style={{ listStyle: 'none', margin: '0.5rem 0 0', padding: 0, display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                {cfg.derivedKcPreview.map(q => (
                  <li key={q.field} style={{ border: `1px solid ${colors.borderMid}`, borderRadius: 6, padding: '0.5rem 0.7rem', background: colors.surfaceSubtle }}>
                    <div style={{ fontSize: '0.9rem', color: colors.text }}>{q.prompt}</div>
                    <div style={{ fontSize: '0.78rem', color: colors.textSecondary, marginTop: '0.2rem' }}>
                      Answer: <strong>{q.correct_value}</strong> · options {q.options.map(o => o.label).join(' / ')}
                    </div>
                  </li>
                ))}
              </ul>
            </div>

            <div style={{ marginTop: '1.25rem' }}>
              <p style={{ ...hint, marginTop: 0 }}>Your own extra questions, asked after those four:</p>
              {cfg.addedKcQuestions.length === 0 && (
                <p style={{ ...hint, fontStyle: 'italic' }}>None yet.</p>
              )}
              <ul style={{ listStyle: 'none', margin: '0.5rem 0 0', padding: 0, display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                {cfg.addedKcQuestions.map(q => (
                  <li key={q.id} data-testid={`pd-set-added-${q.id}`} style={{ border: `1px solid ${colors.borderMid}`, borderRadius: 6, padding: '0.6rem 0.8rem' }}>
                    <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginBottom: '0.3rem' }}>
                      <span style={{ fontSize: '0.72rem', textTransform: 'uppercase', letterSpacing: '0.03em', color: colors.badgeText, background: colors.badgeBg, borderRadius: 4, padding: '0.1rem 0.4rem' }}>
                        {q.type === 'mc' ? 'multiple choice' : 'free text (not graded)'}
                      </span>
                      <span style={{ flex: 1 }} />
                      <button
                        data-testid={`pd-set-delete-${q.id}`}
                        onClick={() => patch({ addedKcQuestions: cfg.addedKcQuestions.filter(x => x.id !== q.id) })}
                        style={{ ...smallBtn, color: colors.errorLink, borderColor: colors.errorBorder }}
                      >
                        Delete
                      </button>
                    </div>
                    <div style={{ fontSize: '0.9rem', color: colors.text }}>{q.prompt}</div>
                    {q.type === 'mc' && (
                      <div style={{ fontSize: '0.78rem', color: colors.textSecondary, marginTop: '0.2rem' }}>
                        {(q.options ?? []).map(o => (
                          <span key={o.value} style={{ marginRight: '0.6rem', fontWeight: o.value === q.correct_value ? 700 : 400 }}>
                            {o.label}{o.value === q.correct_value ? ' ✓' : ''}
                          </span>
                        ))}
                      </div>
                    )}
                  </li>
                ))}
              </ul>

              {/* Add-question form */}
              <div style={{ marginTop: '1rem', border: `1px dashed ${colors.inputBorder}`, borderRadius: 8, padding: '0.9rem' }}>
                <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', marginBottom: '0.5rem', flexWrap: 'wrap' }}>
                  <label style={{ fontSize: '0.85rem' }}>
                    Type:{' '}
                    <select data-testid="pd-set-new-type" value={newType} onChange={e => setNewType(e.target.value as 'mc' | 'text')}>
                      <option value="mc">Multiple choice (graded)</option>
                      <option value="text">Free text (not graded)</option>
                    </select>
                  </label>
                </div>
                <input
                  data-testid="pd-set-new-prompt" style={field} value={newPrompt}
                  onChange={e => setNewPrompt(e.target.value)} placeholder="Question prompt"
                />
                {newType === 'mc' && (
                  <div style={{ marginTop: '0.6rem', display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                    {newOptions.map((o, oi) => (
                      <div key={oi} style={{ display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
                        <input
                          type="radio" name="pd-new-correct" checked={newCorrect === oi}
                          onChange={() => setNewCorrect(oi)} title="Correct answer"
                          data-testid={`pd-set-new-correct-${oi}`}
                        />
                        <input
                          data-testid={`pd-set-new-option-${oi}`}
                          value={o} style={{ ...field, flex: 1 }} placeholder={`Option ${oi + 1}`}
                          onChange={e => setNewOptions(opts => opts.map((x, k) => (k === oi ? e.target.value : x)))}
                        />
                        {newOptions.length > 2 && (
                          <button onClick={() => setNewOptions(opts => opts.filter((_, k) => k !== oi))} style={smallBtn}>✕</button>
                        )}
                      </div>
                    ))}
                    <button onClick={() => setNewOptions(opts => [...opts, ''])} style={{ ...smallBtn, alignSelf: 'flex-start' }}>
                      + Add option
                    </button>
                    <p style={{ ...hint, marginTop: 0 }}>Select the radio beside the correct answer.</p>
                  </div>
                )}
                <div style={{ marginTop: '0.75rem' }}>
                  <button data-testid="pd-set-add-question" onClick={addQuestion} style={{ ...smallBtn, fontWeight: 600 }}>
                    Add question
                  </button>
                </div>
              </div>
            </div>
          </>
        )}
      </Section>

      {/* ── Debrief ─────────────────────────────────────────────────────────── */}
      <Section title="Debrief">
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: '0.45rem', cursor: 'pointer', fontSize: '0.9rem' }}>
          <input
            data-testid="pd-set-debrief-enabled" type="checkbox"
            checked={cfg.debriefEnabled} onChange={e => patch({ debriefEnabled: e.target.checked })}
          />
          Ask a debrief question after the last round
        </label>
        {cfg.debriefEnabled && (
          <div style={{ marginTop: '0.75rem' }}>
            <Labelled label="Prompt">
              <textarea
                data-testid="pd-set-debrief-prompt" rows={3}
                style={{ ...field, resize: 'vertical', fontFamily: 'inherit' }}
                value={cfg.debriefPrompt}
                onChange={e => patch({ debriefPrompt: e.target.value })}
              />
            </Labelled>
            <p style={hint}>Free text, never graded. The answers feed the debrief report.</p>
          </div>
        )}
      </Section>

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
