import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { colors } from '@mygames/game-ui'
import { InstructorChrome } from '../shared/InstructorChrome'
import { useInstructorSession } from '../shared/useInstructorSession'
import { pollGetConfig, pollUpdateConfig, pollInstructorSession, CLASSROOM_URL, type PollQuestionFull, type PollOption } from './api'

// ═══════════════════════════════════════════════════════════════════════════════
// Poll settings (spec §10) — the instructor's real work. Edit the question list:
// visible toggle (all defaults OFF initially), prompt, order, add a question (text or
// mc with ordered options), and delete — ENABLED ONLY for instructor-authored
// questions. The three shipped defaults are non-deletable; the UI shows a "Default"
// badge and offers Hide instead of Delete, so the instructor never hits a save error.
// `order` is derived from list position on save.
// ═══════════════════════════════════════════════════════════════════════════════

const shortId = () =>
  (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID().slice(0, 8) : Math.random().toString(36).slice(2, 10))

const fieldStyle = { width: '100%', fontSize: '0.95rem', padding: '0.45rem 0.55rem', borderRadius: 4, border: '1px solid #cbd5e1', boxSizing: 'border-box' as const }
const smallBtn = { padding: '0.25rem 0.55rem', fontSize: '0.85rem', cursor: 'pointer', borderRadius: 4, border: '1px solid #cbd5e1', background: '#fff' }

const TITLE = 'Poll — Settings'

export default function Settings() {
  const session = useInstructorSession(pollInstructorSession)
  const navigate = useNavigate()
  const [questions, setQuestions] = useState<PollQuestionFull[] | null>(null)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  // Add-question form.
  const [newType, setNewType] = useState<'text' | 'mc'>('text')
  const [newPrompt, setNewPrompt] = useState('')
  const [newOptions, setNewOptions] = useState<string[]>(['', ''])

  useEffect(() => {
    if (session.kind !== 'ready') return
    pollGetConfig()
      .then(cfg => setQuestions([...cfg.questions].sort((a, b) => a.order - b.order)))
      .catch(e => setErr(e instanceof Error ? e.message : 'Failed to load questions.'))
  }, [session.kind])

  const update = (i: number, patch: Partial<PollQuestionFull>) =>
    setQuestions(qs => qs!.map((q, j) => (j === i ? { ...q, ...patch } : q)))

  const move = (i: number, dir: -1 | 1) =>
    setQuestions(qs => {
      const next = [...qs!]
      const j = i + dir
      if (j < 0 || j >= next.length) return next
      ;[next[i], next[j]] = [next[j], next[i]]
      return next
    })

  const del = (i: number) => setQuestions(qs => qs!.filter((_, j) => j !== i))

  const setOptionLabel = (i: number, oi: number, label: string) =>
    setQuestions(qs => qs!.map((q, j) => {
      if (j !== i || !q.options) return q
      const options = q.options.map((o, k) => (k === oi ? { ...o, label } : o))
      return { ...q, options }
    }))

  const addOption = (i: number) =>
    setQuestions(qs => qs!.map((q, j) => (j === i && q.options ? { ...q, options: [...q.options, { value: `o_${shortId()}`, label: '' }] } : q)))

  const removeOption = (i: number, oi: number) =>
    setQuestions(qs => qs!.map((q, j) => (j === i && q.options ? { ...q, options: q.options.filter((_, k) => k !== oi) } : q)))

  const addQuestion = () => {
    if (!newPrompt.trim()) { setErr('Enter a prompt for the new question.'); return }
    let options: PollOption[] | undefined
    if (newType === 'mc') {
      const labels = newOptions.map(o => o.trim()).filter(Boolean)
      if (labels.length < 2) { setErr('A multiple-choice question needs at least two options.'); return }
      options = labels.map(label => ({ value: `o_${shortId()}`, label }))
    }
    const q: PollQuestionFull = {
      id: `q_${shortId()}`, type: newType, prompt: newPrompt.trim(),
      visible: false, order: (questions?.length ?? 0), system: false, options,
    }
    setQuestions(qs => [...(qs ?? []), q])
    setNewPrompt(''); setNewOptions(['', '']); setErr(null)
  }

  const save = async () => {
    if (!questions) return
    // Normalize order to list position.
    const normalized = questions.map((q, i) => ({ ...q, order: i }))
    setSaving(true); setErr(null); setMsg(null)
    try {
      const res = await pollUpdateConfig(normalized)
      setQuestions([...res.questions].sort((a, b) => a.order - b.order))
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
  const chrome = (body: React.ReactNode) => (
    <InstructorChrome title={TITLE} navLinks={navLinks} onNavigate={navigate}>
      <div style={{ maxWidth: 760 }}>{body}</div>
    </InstructorChrome>
  )

  if (session.kind === 'loading') return chrome(<p>Loading…</p>)
  if (session.kind === 'no-token') return chrome(<p>Open settings from the classroom.</p>)
  if (session.kind === 'error') {
    return chrome(<><p style={{ color: '#c00' }}>{session.message}</p><p><a href={CLASSROOM_URL}>← Return to classroom</a></p></>)
  }
  if (!questions) return chrome(<p>Loading questions…</p>)

  return chrome(
    <>
      <p style={{ color: colors.textSecondary, marginTop: 0, lineHeight: 1.5 }}>
        Turn on the questions you want (all default questions start hidden). Add your own of either type.
        Each visible question gets a report automatically.
      </p>

      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
        {questions.map((q, i) => (
          <li key={q.id} style={{ border: '1px solid #d0d7de', borderRadius: 8, padding: '0.75rem 1rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap', marginBottom: '0.5rem' }}>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.9rem', cursor: 'pointer' }}>
                <input type="checkbox" checked={q.visible} onChange={e => update(i, { visible: e.target.checked })} data-testid={`poll-visible-${q.id}`} />
                Visible
              </label>
              <span style={{ fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.03em', color: '#64748b', border: '1px solid #e2e8f0', borderRadius: 4, padding: '0.1rem 0.4rem' }}>
                {q.type}
              </span>
              {q.system && (
                <span style={{ fontSize: '0.75rem', color: '#8a6d00', border: '1px solid #f0dca9', background: '#fdf4e3', borderRadius: 4, padding: '0.1rem 0.4rem' }}>
                  Default — cannot delete
                </span>
              )}
              <span style={{ flex: 1 }} />
              <button onClick={() => move(i, -1)} disabled={i === 0} style={smallBtn} title="Move up">↑</button>
              <button onClick={() => move(i, 1)} disabled={i === questions.length - 1} style={smallBtn} title="Move down">↓</button>
              {!q.system && (
                <button onClick={() => del(i)} style={{ ...smallBtn, color: '#c5221f', borderColor: '#f5b5b0' }} data-testid={`poll-delete-${q.id}`}>Delete</button>
              )}
            </div>

            <input value={q.prompt} onChange={e => update(i, { prompt: e.target.value })} style={fieldStyle} aria-label="Prompt" />

            {q.type === 'mc' && q.options && (
              <div style={{ marginTop: '0.6rem', paddingLeft: '0.5rem', borderLeft: '2px solid #eef0f2', display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                {q.options.map((o, oi) => (
                  <div key={o.value} style={{ display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
                    <input
                      value={o.label}
                      onChange={e => setOptionLabel(i, oi, e.target.value)}
                      disabled={q.system}
                      style={{ ...fieldStyle, flex: 1 }}
                      aria-label="Option"
                    />
                    {!q.system && q.options!.length > 2 && (
                      <button onClick={() => removeOption(i, oi)} style={smallBtn} title="Remove option">✕</button>
                    )}
                  </div>
                ))}
                {!q.system && <button onClick={() => addOption(i)} style={{ ...smallBtn, alignSelf: 'flex-start' }}>+ Add option</button>}
              </div>
            )}
          </li>
        ))}
      </ul>

      {/* Add question */}
      <section style={{ marginTop: '1.5rem', border: '1px dashed #cbd5e1', borderRadius: 8, padding: '1rem' }}>
        <h2 style={{ margin: '0 0 0.75rem', fontSize: '1rem' }}>Add a question</h2>
        <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', marginBottom: '0.5rem', flexWrap: 'wrap' }}>
          <label style={{ fontSize: '0.9rem' }}>
            Type:{' '}
            <select value={newType} onChange={e => setNewType(e.target.value as 'text' | 'mc')}>
              <option value="text">Text</option>
              <option value="mc">Multiple choice</option>
            </select>
          </label>
        </div>
        <input value={newPrompt} onChange={e => setNewPrompt(e.target.value)} placeholder="Question prompt" style={fieldStyle} />
        {newType === 'mc' && (
          <div style={{ marginTop: '0.6rem', display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
            {newOptions.map((o, oi) => (
              <div key={oi} style={{ display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
                <input value={o} onChange={e => setNewOptions(opts => opts.map((x, k) => (k === oi ? e.target.value : x)))} placeholder={`Option ${oi + 1}`} style={{ ...fieldStyle, flex: 1 }} />
                {newOptions.length > 2 && <button onClick={() => setNewOptions(opts => opts.filter((_, k) => k !== oi))} style={smallBtn}>✕</button>}
              </div>
            ))}
            <button onClick={() => setNewOptions(opts => [...opts, ''])} style={{ ...smallBtn, alignSelf: 'flex-start' }}>+ Add option</button>
          </div>
        )}
        <div style={{ marginTop: '0.75rem' }}>
          <button onClick={addQuestion} style={{ ...smallBtn, fontWeight: 600 }} data-testid="poll-add-question">Add question</button>
        </div>
      </section>

      {err && <p style={{ color: '#c00' }}>{err}</p>}
      {msg && <p data-testid="poll-save-msg" style={{ color: '#137333' }}>{msg}</p>}

      <div style={{ marginTop: '1.25rem' }}>
        <button
          onClick={() => void save()}
          disabled={saving}
          style={{ padding: '0.6rem 1.5rem', fontSize: '1rem', fontWeight: 600, cursor: saving ? 'not-allowed' : 'pointer', backgroundColor: saving ? '#999' : colors.text, color: colors.white, border: 'none', borderRadius: 6 }}
          data-testid="poll-save"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </>,
  )
}
