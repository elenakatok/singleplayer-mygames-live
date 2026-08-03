import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { colors, typography } from '@mygames/game-ui'
import { InstructorChrome } from '../shared/InstructorChrome'
import { useInstructorSession } from '../shared/useInstructorSession'
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
//     rendered from the SAME derivation the grader uses. "8 of 17 questions visible, 8
//     graded" is `kcVisibleCount` / `kcPoolTotal` / `kcGradedCount`, all computed
//     server-side by `gradedFor()` — the function `procurementSubmitKcAnswer` calls to
//     build its denominator. THE DENOMINATOR IS NEVER STORED, so the number an
//     instructor reads here is by construction the number a student's score is out of.
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

export default function Settings() {
  const session = useInstructorSession(procurementInstructorSession)
  const navigate = useNavigate()
  const [data, setData] = useState<ProcurementConfigResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [seedInput, setSeedInput] = useState('')

  const load = useCallback(async () => {
    try { setData(await procurementGetConfig()); setError(null) } catch (err) {
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

          {/* ── the knowledge check ────────────────────────────────────────── */}
          <section style={{ marginBottom: '2rem' }}>
            <h2 style={{ fontSize: '0.95rem' }}>Knowledge check</h2>
            <label style={{ fontSize: '0.85rem' }}>
              <input type="checkbox" data-testid="proc-set-kc-enabled"
                checked={c.kcEnabled} disabled={busy}
                onChange={e => void save({ kcEnabled: e.target.checked })} />
              {' '}Ask the knowledge check
            </label>

            {/* ⚠ THE LIVE COUNT. Same derivation as the grader's denominator. */}
            <p data-testid="proc-set-kc-count" style={{ fontSize: '0.85rem', marginTop: '0.75rem' }}>
              <strong>{data.kcVisibleCount} of {data.kcPoolTotal}</strong> questions visible,
              {' '}<strong>{data.kcGradedCount}</strong> graded.
              {data.kcPoolTotal === 0 && (
                <span style={{ color: colors.textSecondary }}>
                  {' '}The question pool has not been written yet.
                </span>
              )}
            </p>
            <p style={{ fontSize: '0.75rem', color: colors.textSecondary }}>
              A student's score is out of the graded questions that are visible — the
              denominator follows this list and is never stored.
            </p>

            {(['kc', 'prep', 'debrief'] as const).map(stage => {
              const rows = data.kcPool.filter(q => q.stage === stage)
              if (rows.length === 0) return null
              return (
                <div key={stage} style={{ marginTop: '0.9rem' }}>
                  <h3 style={{ fontSize: '0.8rem', margin: '0 0 0.25rem', color: colors.textSecondary }}>
                    {stage === 'kc' ? 'Knowledge check'
                      : stage === 'prep' ? 'Before play — written answer'
                        : 'After the results — written answer'}
                  </h3>
                  {rows.map(q => (
                    <label key={q.id} style={{ display: 'block', fontSize: '0.85rem', marginTop: '0.3rem' }}>
                      <input type="checkbox" data-testid={`proc-set-q-${q.id}`}
                        checked={q.visible} disabled={busy}
                        onChange={e => {
                          const next = e.target.checked
                            ? [...c.kcVisible, q.id]
                            : c.kcVisible.filter(id => id !== q.id)
                          void save({ kcVisible: next })
                        }} />
                      {' '}<strong>{q.id}</strong> — {q.prompt.slice(0, 90)}{q.prompt.length > 90 ? '…' : ''}
                      {!q.graded && <em style={{ color: colors.textSecondary }}> (ungraded)</em>}
                    </label>
                  ))}
                </div>
              )
            })}
          </section>

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
