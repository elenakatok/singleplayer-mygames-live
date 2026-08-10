import { useMemo, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { colors } from '@mygames/game-ui'

// ═══════════════════════════════════════════════════════════════════════════════
// THE SHARED KNOWLEDGE-CHECK SETTINGS BLOCK — convergence spec §2.
//
// ⚠⚠ BUILT FOR SIX GAMES, WIRED TO ONE. Scorecard is the first adopter (spec §8); pd,
// pricing, newsvendor, forecast and procurement follow one at a time. NOTHING in this file
// knows what a contract, a market or a payoff matrix is — every game-specific fact arrives
// through props. Adding a `if (game === 'scorecard')` here defeats the entire point.
//
// ⚠ IT LIVES IN THE SINGLE-PLAYER REPO'S shared/, NOT IN @mygames/game-ui (Elena, 08-10):
// the single-player family stays separate from the negotiation and stage games.
//
// The row is the whole design (spec §1): every question, in every game, gets the same four
// controls — show/hide · move up/down · edit (or a reason it can't be edited) · delete
// (added questions only).
//
// ⚠⚠ THE LIST ITSELF IS THE MOST VALUABLE PART (spec §2). Scorecard's page used to state
// that its built-in ten could not be edited and then never show them, so an instructor
// could not read their own knowledge check. Every question renders here — both stages,
// with its answer — whether or not it can be edited.
//
// ⚠ A DISABLED CONTROL WITH NO EXPLANATION READS AS A BUG. A locked row never shows a
// greyed-out Edit button; it shows a badge carrying the server's own reason.
// ═══════════════════════════════════════════════════════════════════════════════

// ── The shape a game must supply ──────────────────────────────────────────────

export interface KcSettingsOption {
  value: string
  label: string
}

/**
 * One row. Both built-ins and added questions use this shape, so the row component has no
 * branch on `kind` beyond what is genuinely different (delete, edit-in-place vs override).
 */
export interface KcSettingsQuestion {
  id: string
  kind: 'builtin' | 'added'
  stage: string
  prompt: string
  options: KcSettingsOption[]
  /** The correct option's VALUE, or null for an ungraded question. */
  correctValue: string | null
  graded: boolean
  visible: boolean
  locked: boolean
  /** ⚠ Required whenever `locked`. Rendered verbatim — see the header. */
  lockReason: string | null
  overridden: boolean
  /** Built-ins only: the generated text, so a row can offer "revert to the original". */
  originalPrompt?: string
  originalOptions?: KcSettingsOption[]
  /** Added free-text questions have no options and are never graded. */
  type?: 'mc' | 'text'
}

export interface KcSettingsStage {
  id: string
  label: string
  /** Optional caution shown under the heading — e.g. scorecard's §9.1 rule. */
  note?: string
}

export interface KcSettingsDraft {
  enabled: boolean
  hidden: Record<string, boolean>
  order: Record<string, number>
  overrides: Record<string, { prompt?: string; options?: Record<string, string> }>
  added: {
    id: string
    type: 'mc' | 'text'
    prompt: string
    options?: { value: string; label: string }[]
    correct_value?: string
    stage?: string
  }[]
}

export interface KnowledgeCheckSettingsProps {
  /** The full pool, both kinds, in the server's resolved order. */
  questions: KcSettingsQuestion[]
  stages: KcSettingsStage[]
  draft: KcSettingsDraft
  onChange: (next: KcSettingsDraft) => void
  /** Copy under the enable toggle saying what OFF removes. ⚠ Game-specific (D12). */
  enableNote: ReactNode
  /** Shown at save time when a stage the game flags is chosen. Keyed by stage id. */
  stageWarnings?: Record<string, string>
  /** Rendered above the list once the visible GRADED set has changed (D2). */
  startedWarning?: ReactNode
  /** Prefix for data-testid, so each game's harness can address its own rows. */
  testIdPrefix: string
}

// ── Styling ───────────────────────────────────────────────────────────────────

const card: CSSProperties = {
  border: `1px solid ${colors.borderMid}`, borderRadius: 8, marginBottom: '1.25rem',
}
const summaryBar: CSSProperties = {
  display: 'flex', alignItems: 'center', gap: '0.6rem', cursor: 'pointer',
  padding: '0.75rem 1rem', fontSize: '0.95rem', fontWeight: 600, userSelect: 'none',
}
const body: CSSProperties = { padding: '0 1rem 1rem' }
const hint: CSSProperties = {
  fontSize: '0.8rem', color: colors.textSecondary, lineHeight: 1.55, margin: '0.35rem 0 0',
}
const stageHeading: CSSProperties = {
  fontSize: '0.78rem', fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase',
  color: colors.textSecondary, margin: '1.1rem 0 0.35rem',
}
const rowBox: CSSProperties = {
  border: `1px solid ${colors.borderLight}`, borderRadius: 6,
  padding: '0.55rem 0.7rem', marginTop: '0.4rem',
}
const smallBtn: CSSProperties = {
  padding: '0.2rem 0.5rem', fontSize: '0.8rem', cursor: 'pointer',
  borderRadius: 4, border: `1px solid ${colors.inputBorder}`, background: '#fff',
}
const badge: CSSProperties = {
  fontSize: '0.72rem', borderRadius: 4, padding: '0.1rem 0.4rem',
  border: `1px solid ${colors.borderMid}`, color: colors.textSecondary, whiteSpace: 'nowrap',
}
const field: CSSProperties = {
  width: '100%', fontSize: '0.9rem', padding: '0.4rem 0.5rem', borderRadius: 4,
  border: `1px solid ${colors.inputBorder}`, boxSizing: 'border-box',
}

const shortId = () =>
  (typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID().slice(0, 8)
    : Math.random().toString(36).slice(2, 10))

// ── One row ───────────────────────────────────────────────────────────────────

function QuestionRow({
  q, draft, onChange, testIdPrefix, canMoveUp, canMoveDown, onMove,
}: {
  q: KcSettingsQuestion
  draft: KcSettingsDraft
  onChange: (next: KcSettingsDraft) => void
  testIdPrefix: string
  canMoveUp: boolean
  canMoveDown: boolean
  onMove: (dir: -1 | 1) => void
}) {
  const [editing, setEditing] = useState(false)

  const visible = draft.hidden[q.id] !== true
  const added = draft.added.find(a => a.id === q.id)
  /** Live text: an in-flight override or edit wins over what the server last resolved. */
  const override = draft.overrides[q.id]
  const prompt = added?.prompt ?? override?.prompt ?? q.prompt
  const options: KcSettingsOption[] = added?.options
    ?? q.options.map(o => ({ value: o.value, label: override?.options?.[o.value] ?? o.label }))
  const correctValue = added ? (added.correct_value ?? null) : q.correctValue
  const graded = added ? added.type === 'mc' && added.correct_value != null : q.graded

  const setVisible = (v: boolean) => {
    const hidden = { ...draft.hidden }
    if (v) delete hidden[q.id]
    else hidden[q.id] = true
    onChange({ ...draft, hidden })
  }

  const setPrompt = (text: string) => {
    if (q.kind === 'added') {
      onChange({ ...draft, added: draft.added.map(a => (a.id === q.id ? { ...a, prompt: text } : a)) })
    } else {
      onChange({ ...draft, overrides: { ...draft.overrides, [q.id]: { ...override, prompt: text } } })
    }
  }

  const setOptionLabel = (value: string, label: string) => {
    if (q.kind === 'added') {
      onChange({
        ...draft,
        added: draft.added.map(a => (a.id === q.id
          ? { ...a, options: (a.options ?? []).map(o => (o.value === value ? { ...o, label } : o)) }
          : a)),
      })
    } else {
      onChange({
        ...draft,
        overrides: {
          ...draft.overrides,
          [q.id]: { ...override, options: { ...override?.options, [value]: label } },
        },
      })
    }
  }

  const revert = () => {
    const overrides = { ...draft.overrides }
    delete overrides[q.id]
    onChange({ ...draft, overrides })
    setEditing(false)
  }

  const remove = () => onChange({
    ...draft,
    added: draft.added.filter(a => a.id !== q.id),
    hidden: Object.fromEntries(Object.entries(draft.hidden).filter(([k]) => k !== q.id)),
    order: Object.fromEntries(Object.entries(draft.order).filter(([k]) => k !== q.id)),
  })

  const answerLabel = correctValue === null
    ? null
    : options.find(o => o.value === correctValue)?.label ?? correctValue

  return (
    <div style={{ ...rowBox, opacity: visible ? 1 : 0.55 }} data-testid={`${testIdPrefix}-row-${q.id}`}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.55rem' }}>
        <input
          type="checkbox"
          checked={visible}
          onChange={e => setVisible(e.target.checked)}
          data-testid={`${testIdPrefix}-visible-${q.id}`}
          title={visible ? 'Asked' : 'Not asked'}
          style={{ marginTop: '0.2rem' }}
        />

        <div style={{ flex: 1, minWidth: 0 }}>
          {editing ? (
            <textarea
              value={prompt}
              onChange={e => setPrompt(e.target.value)}
              rows={3}
              style={{ ...field, fontFamily: 'inherit', lineHeight: 1.5 }}
              data-testid={`${testIdPrefix}-prompt-${q.id}`}
            />
          ) : (
            <div style={{ fontSize: '0.88rem', lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>{prompt}</div>
          )}

          {/* ⚠ THE ANSWER, BENEATH THE PROMPT (spec §2). This is the instructor page — the
              key belongs here, and the student payload strips it. */}
          {graded && answerLabel !== null && (
            <div style={{ ...hint, marginTop: '0.25rem' }} data-testid={`${testIdPrefix}-answer-${q.id}`}>
              Answer: <strong>{answerLabel}</strong>
            </div>
          )}
          {!graded && (
            <div style={{ ...hint, marginTop: '0.25rem' }} data-testid={`${testIdPrefix}-ungraded-${q.id}`}>
              <em>(ungraded)</em>
            </div>
          )}

          {editing && options.length > 0 && (
            <div style={{ marginTop: '0.5rem', display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
              {options.map(o => (
                <div key={o.value} style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                  <span style={{ ...badge, minWidth: '3.2rem', textAlign: 'center' }}>
                    {o.value === correctValue ? '✓ answer' : 'option'}
                  </span>
                  <input
                    value={o.label}
                    onChange={e => setOptionLabel(o.value, e.target.value)}
                    style={{ ...field, flex: 1 }}
                    data-testid={`${testIdPrefix}-option-${q.id}-${o.value}`}
                  />
                </div>
              ))}
              {/* ⚠ Only LABELS are editable. The answer key, the option ids, the option
                  COUNT and the per-student shuffle are all untouched by an edit — the
                  server's override shape makes that structural, not a promise. */}
              <p style={hint}>
                Editing the wording only. You cannot add, remove or reorder options here, and
                the correct answer stays where it is.
              </p>
            </div>
          )}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', flexShrink: 0 }}>
          {q.overridden && !editing && (
            <span style={{ ...badge, color: colors.text }} data-testid={`${testIdPrefix}-edited-${q.id}`}>
              edited
            </span>
          )}

          {/* ⚠ A LOCKED ROW CARRIES ITS REASON. Never a greyed-out button on its own. */}
          {q.locked ? (
            <span
              style={{ ...badge, background: colors.surfaceSubtle }}
              data-testid={`${testIdPrefix}-locked-${q.id}`}
              title={q.lockReason ?? undefined}
            >
              🔒 {q.lockReason ?? 'Not editable'}
            </span>
          ) : (
            <button
              style={smallBtn}
              onClick={() => setEditing(v => !v)}
              data-testid={`${testIdPrefix}-edit-${q.id}`}
            >
              {editing ? 'Done' : 'Edit'}
            </button>
          )}

          {q.kind === 'builtin' && q.overridden && (
            <button style={smallBtn} onClick={revert} data-testid={`${testIdPrefix}-revert-${q.id}`}>
              Revert
            </button>
          )}

          <button
            style={smallBtn} onClick={() => onMove(-1)} disabled={!canMoveUp}
            title="Move up" data-testid={`${testIdPrefix}-up-${q.id}`}
          >
            ↑
          </button>
          <button
            style={smallBtn} onClick={() => onMove(1)} disabled={!canMoveDown}
            title="Move down" data-testid={`${testIdPrefix}-down-${q.id}`}
          >
            ↓
          </button>

          {/* ⚠ DELETE ON ADDED QUESTIONS ONLY (D6). Built-ins are never deletable; hide is
              the escape valve, and it is the checkbox on the left. */}
          {q.kind === 'added' && (
            <button
              style={{ ...smallBtn, color: colors.errorLink, borderColor: colors.errorBorder }}
              onClick={remove}
              data-testid={`${testIdPrefix}-delete-${q.id}`}
            >
              Delete
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

// ── The block ─────────────────────────────────────────────────────────────────

export function KnowledgeCheckSettings({
  questions, stages, draft, onChange, enableNote, stageWarnings = {},
  startedWarning, testIdPrefix,
}: KnowledgeCheckSettingsProps) {
  // ⚠ COLLAPSED BY DEFAULT (D8) — and the rest of the settings page is NOT an accordion.
  const [open, setOpen] = useState(false)

  const [newType, setNewType] = useState<'mc' | 'text'>('mc')
  const [newPrompt, setNewPrompt] = useState('')
  const [newOptions, setNewOptions] = useState<string[]>(['', ''])
  const [newCorrect, setNewCorrect] = useState(0)
  const [newStage, setNewStage] = useState(stages[0]?.id ?? '')
  const [addError, setAddError] = useState<string | null>(null)

  /**
   * The pool as the instructor is currently editing it: the server's questions, minus any
   * added ones deleted in this session, plus any added in it.
   *
   * ⚠ DERIVED FROM THE DRAFT, NOT FROM THE LAST SAVE. The count line has to move as boxes
   * are ticked (spec §2), so nothing here may wait for a round trip.
   */
  const pool: KcSettingsQuestion[] = useMemo(() => {
    const serverAdded = new Set(questions.filter(q => q.kind === 'added').map(q => q.id))
    const fresh: KcSettingsQuestion[] = draft.added
      .filter(a => !serverAdded.has(a.id))
      .map(a => ({
        id: a.id,
        kind: 'added' as const,
        stage: a.stage ?? stages[stages.length - 1]?.id ?? '',
        prompt: a.prompt,
        options: a.options ?? [],
        correctValue: a.correct_value ?? null,
        graded: a.type === 'mc' && a.correct_value != null,
        visible: true,
        locked: false,
        lockReason: null,
        overridden: false,
        type: a.type,
      }))
    const stillThere = questions.filter(
      q => q.kind === 'builtin' || draft.added.some(a => a.id === q.id),
    )
    return [...stillThere, ...fresh]
  }, [questions, draft.added, stages])

  const visibleCount = pool.filter(q => draft.hidden[q.id] !== true).length
  const gradedCount = pool.filter(q => draft.hidden[q.id] !== true && q.graded).length

  /** Rows for one stage, in the draft's order. */
  const rowsFor = (stageId: string) => {
    const inStage = pool.filter(q => (
      q.kind === 'added'
        ? (draft.added.find(a => a.id === q.id)?.stage ?? q.stage) === stageId
        : q.stage === stageId
    ))
    return inStage
      .map((q, i) => ({ q, i, key: draft.order[q.id] ?? i }))
      .sort((a, b) => (a.key - b.key) || (a.i - b.i))
      .map(x => x.q)
  }

  /** ⚠ Arrows reorder WITHIN a stage (spec §2). Moving between stages is the stage control. */
  const move = (stageId: string, id: string, dir: -1 | 1) => {
    const ids = rowsFor(stageId).map(q => q.id)
    const from = ids.indexOf(id)
    const to = from + dir
    if (from < 0 || to < 0 || to >= ids.length) return
    const next = [...ids]
    ;[next[from], next[to]] = [next[to], next[from]]
    // A COMPLETE map for this stage — a partial one leaves the server resolving ties
    // against authored indices, which is correct but not what the instructor just dragged.
    onChange({
      ...draft,
      order: { ...draft.order, ...Object.fromEntries(next.map((qid, i) => [qid, i])) },
    })
  }

  const addQuestion = () => {
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
    onChange({
      ...draft,
      added: [...draft.added, {
        // ⚠ `akc_` — the server refuses any id a built-in uses, and this prefix keeps an
        // instructor from ever colliding by accident.
        id: `akc_${shortId()}`,
        type: newType,
        prompt: newPrompt.trim(),
        ...(options ? { options } : {}),
        ...(correct_value ? { correct_value } : {}),
        stage: newStage,
      }],
    })
    setNewPrompt(''); setNewOptions(['', '']); setNewCorrect(0)
  }

  const pendingStageWarning = stageWarnings[newStage] ?? null

  return (
    <section style={card} data-testid={`${testIdPrefix}-block`}>
      <div
        style={summaryBar}
        onClick={() => setOpen(v => !v)}
        role="button"
        tabIndex={0}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') setOpen(v => !v) }}
        data-testid={`${testIdPrefix}-toggle`}
      >
        <span style={{ fontSize: '0.8rem' }}>{open ? '▾' : '▸'}</span>
        Knowledge check
        <span style={{ ...badge, fontWeight: 400 }}>
          {visibleCount} of {pool.length} visible · {gradedCount} graded
        </span>
      </div>

      {open && (
        <div style={body}>
          {/* 1 ── the enable toggle ─────────────────────────────────────────── */}
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: '0.45rem', cursor: 'pointer', fontSize: '0.9rem' }}>
            <input
              type="checkbox"
              checked={draft.enabled}
              onChange={e => onChange({ ...draft, enabled: e.target.checked })}
              data-testid={`${testIdPrefix}-enabled`}
            />
            Include the knowledge check
          </label>
          <div style={hint}>{enableNote}</div>

          {/* 2 ── the count line. ⚠ VERBATIM FROM PROCUREMENT (spec §8.4) — its wording is
                  what the other five adopt, and it updates as boxes are ticked, not on
                  save. */}
          <p
            style={{ fontSize: '0.85rem', marginTop: '0.9rem', marginBottom: '0.2rem' }}
            data-testid={`${testIdPrefix}-count`}
          >
            <strong>{visibleCount} of {pool.length}</strong> questions visible,{' '}
            <strong>{gradedCount}</strong> graded.
          </p>
          <p style={{ ...hint, marginTop: 0 }}>
            A student&rsquo;s score is out of the graded questions that are visible — the
            denominator follows this list and is never stored.
          </p>

          {startedWarning}

          {/* 3 ── the questions, grouped by stage ───────────────────────────── */}
          {stages.map(stage => {
            const rows = rowsFor(stage.id)
            if (rows.length === 0) return null
            return (
              <div key={stage.id} data-testid={`${testIdPrefix}-stage-${stage.id}`}>
                <h4 style={stageHeading}>{stage.label}</h4>
                {stage.note && <p style={{ ...hint, marginTop: 0 }}>{stage.note}</p>}
                {rows.map((q, i) => (
                  <QuestionRow
                    key={q.id}
                    q={q}
                    draft={draft}
                    onChange={onChange}
                    testIdPrefix={testIdPrefix}
                    canMoveUp={i > 0}
                    canMoveDown={i < rows.length - 1}
                    onMove={dir => move(stage.id, q.id, dir)}
                  />
                ))}
              </div>
            )
          })}

          {/* 4 ── the add form ──────────────────────────────────────────────── */}
          <div style={{ marginTop: '1.25rem', border: `1px dashed ${colors.borderMid}`, borderRadius: 6, padding: '0.75rem 0.85rem' }}>
            <p style={{ margin: '0 0 0.5rem', fontSize: '0.85rem', fontWeight: 600 }}>Add a question</p>

            <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', alignItems: 'flex-end' }}>
              <label style={{ fontSize: '0.82rem' }}>
                Type{' '}
                <select
                  value={newType}
                  onChange={e => setNewType(e.target.value as 'mc' | 'text')}
                  data-testid={`${testIdPrefix}-new-type`}
                >
                  <option value="mc">Multiple choice (graded)</option>
                  <option value="text">Free text (not graded)</option>
                </select>
              </label>

              {/* ⚠ The stage picker only appears where the game HAS more than one stage
                  (spec §2.4) — today that is scorecard alone. */}
              {stages.length > 1 && (
                <label style={{ fontSize: '0.82rem' }}>
                  Asked{' '}
                  <select
                    value={newStage}
                    onChange={e => setNewStage(e.target.value)}
                    data-testid={`${testIdPrefix}-new-stage`}
                  >
                    {stages.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
                  </select>
                </label>
              )}
            </div>

            <div style={{ marginTop: '0.5rem' }}>
              <input
                value={newPrompt}
                onChange={e => setNewPrompt(e.target.value)}
                placeholder="Question prompt"
                style={field}
                data-testid={`${testIdPrefix}-new-prompt`}
              />
            </div>

            {newType === 'mc' && (
              <div style={{ marginTop: '0.5rem', display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
                {newOptions.map((o, i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                    <input
                      type="radio" name={`${testIdPrefix}-new-correct`} checked={newCorrect === i}
                      onChange={() => setNewCorrect(i)} title="Correct answer"
                      data-testid={`${testIdPrefix}-new-correct-${i}`}
                    />
                    <input
                      value={o} placeholder={`Option ${i + 1}`} style={{ ...field, flex: 1 }}
                      onChange={e => setNewOptions(opts => opts.map((x, j) => (j === i ? e.target.value : x)))}
                      data-testid={`${testIdPrefix}-new-option-${i}`}
                    />
                    {newOptions.length > 2 && (
                      <button style={smallBtn} onClick={() => setNewOptions(opts => opts.filter((_, j) => j !== i))}>
                        ✕
                      </button>
                    )}
                  </div>
                ))}
                <button
                  style={{ ...smallBtn, alignSelf: 'flex-start' }}
                  onClick={() => setNewOptions(o => [...o, ''])}
                >
                  + Add option
                </button>
                <p style={{ ...hint, marginTop: 0 }}>Select the radio beside the correct answer.</p>
              </div>
            )}

            {/* ⚠ THE STAGE WARNING WARNS, IT DOES NOT BLOCK (§4.1, D2). It is shown here as
                soon as the stage is chosen AND again by the page at save time. */}
            {pendingStageWarning && (
              <p
                style={{ ...hint, color: colors.warnBannerText, marginTop: '0.6rem' }}
                data-testid={`${testIdPrefix}-stage-warning`}
              >
                ⚠ {pendingStageWarning}
              </p>
            )}

            {addError && <p style={{ ...hint, color: colors.errorAction }}>{addError}</p>}

            <button
              style={{ ...smallBtn, marginTop: '0.6rem', fontWeight: 600 }}
              onClick={addQuestion}
              data-testid={`${testIdPrefix}-new-add`}
            >
              Add question
            </button>
            <p style={{ ...hint }}>
              Added questions are saved with the rest of the page. Options are shown to
              students in a different order for each student, so the position of the right
              answer is never a hint.
            </p>
          </div>
        </div>
      )}
    </section>
  )
}

/**
 * Which question ids are visible AND graded — the set D2 watches.
 *
 * ⚠ Exported so a page can compare "what is graded now" against "what was graded when the
 * page loaded" and raise the started-students banner on a real change rather than on any
 * keystroke. Sorted, so it compares by value.
 */
export function visibleGradedIds(
  questions: KcSettingsQuestion[],
  draft: KcSettingsDraft,
): string[] {
  const fromServer = questions
    .filter(q => q.graded && draft.hidden[q.id] !== true)
    .filter(q => q.kind === 'builtin' || draft.added.some(a => a.id === q.id))
    .map(q => q.id)
  const fromDraft = draft.added
    .filter(a => a.type === 'mc' && a.correct_value != null && draft.hidden[a.id] !== true)
    .filter(a => !questions.some(q => q.id === a.id))
    .map(a => a.id)
  return [...fromServer, ...fromDraft].sort()
}
